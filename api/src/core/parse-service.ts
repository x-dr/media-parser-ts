import type { FastifyBaseLogger } from 'fastify';
import type { AppConfig } from '../config/env.js';
import {
  detectPlatform,
  getPlatformAllowedHosts,
  type PlatformId,
} from '../config/platforms.js';
import { presentError, presentSuccess, type LegacyResponse } from '../api/presenter.js';
import type { ApiKeyIdentity } from '../auth/api-key-service.js';
import type { CredentialService } from '../platform-admin/credential-service.js';
import type { PlatformService } from '../platform-admin/platform-service.js';
import type { RequestLogService } from '../logging/request-log-service.js';
import { HttpSession } from '../http/http-session.js';
import type { ProxyLease, ProxyManager } from '../http/proxy-manager.js';
import { RedirectResolver } from '../http/redirect-resolver.js';
import { extractShareUrl } from '../http/url-tools.js';
import { DEFAULT_DESKTOP_USER_AGENT } from '../config/user-agents.js';
import { AppError, ProxyAttemptError, safeErrorDetails, type PublicErrorCode } from './errors.js';
import { hasMedia, type MediaResult } from './media-result.js';
import { getParserRegistration } from './parser-registry.js';
import { LegacyParserClient } from '../legacy/legacy-parser-client.js';

const AI_TEXT_PLATFORMS = new Set<PlatformId>([
  'doubao',
  'qianwen',
  'yuanbao',
  'quark_ai',
  'xiaoyunque',
]);

const COOKIE_ERROR_CODES = new Set<PublicErrorCode>([
  'COOKIE_REQUIRED',
  'DOUYIN_COOKIE_REQUIRED',
  'XIAOHONGSHU_COOKIE_REQUIRED',
  'KUAISHOU_COOKIE_REQUIRED',
  'WECHAT_CHANNELS_COOKIE_REQUIRED',
  'PINDUODUO_COOKIE_REQUIRED',
]);

export interface ParseInput {
  requestId: string;
  identity: ApiKeyIdentity;
  text: string;
  requestIp: string;
  userAgent: string;
  signal: AbortSignal;
  logger: FastifyBaseLogger;
}

export interface ParseOutput {
  statusCode: number;
  body: LegacyResponse;
}

export class ParseService {
  readonly #redirectResolver: RedirectResolver;
  readonly #legacyClient: LegacyParserClient | null;

  public constructor(
    private readonly config: AppConfig,
    private readonly platformService: PlatformService,
    private readonly credentialService: CredentialService,
    private readonly requestLogService: RequestLogService,
    private readonly shutdownSignal: AbortSignal,
    private readonly proxyManager?: ProxyManager | undefined,
  ) {
    this.#redirectResolver = new RedirectResolver({ timeoutMs: config.upstreamTimeoutMs });
    this.#legacyClient = config.parserEngine === 'legacy-http' && config.legacyPythonUrl
      ? new LegacyParserClient(config.legacyPythonUrl)
      : null;
  }

  public async parse(input: ParseInput): Promise<ParseOutput> {
    const startedAt = Date.now();
    const timeoutSignal = AbortSignal.timeout(this.config.parseTimeoutMs);
    const signal = AbortSignal.any([
      input.signal,
      this.shutdownSignal,
      timeoutSignal,
    ]);
    let realUrl: URL | null = null;
    let platformId: PlatformId | null = null;
    const shareUrl = extractShareUrl(input.text);
    if (!shareUrl) throw new AppError('URL_NOT_FOUND', 400, '未找到有效的分享链接');
    try {
      this.requestLogService.createPending({
        requestId: input.requestId,
        clientId: input.identity.clientId,
        apiKeyId: input.identity.apiKeyId,
        inputText: input.text,
        shareUrl: shareUrl.href,
        requestIp: input.requestIp,
        userAgent: input.userAgent,
      });
    } catch {
      throw new AppError('LOG_STORAGE_UNAVAILABLE', 503, '调用日志存储不可用');
    }

    try {
      const resolved = await this.#executeWithProxyRetry(input, shareUrl, signal, timeoutSignal);
      realUrl = resolved.realUrl;
      platformId = resolved.platformId;
      if ('legacyOutput' in resolved) {
        this.#completeLog(input, resolved.legacyOutput, realUrl, platformId, startedAt, 'completed');
        return resolved.legacyOutput;
      }
      const output: ParseOutput = {
        statusCode: 200,
        body: presentSuccess(platformId, realUrl, resolved.result),
      };
      this.#completeLog(input, output, realUrl, platformId, startedAt, 'completed');
      return output;
    } catch (error) {
      if (error && typeof error === 'object') {
        const extra = error as { resolvedRealUrl?: URL | null; resolvedPlatformId?: PlatformId | null };
        if (extra.resolvedRealUrl !== undefined) realUrl = extra.resolvedRealUrl;
        if (extra.resolvedPlatformId !== undefined) platformId = extra.resolvedPlatformId;
      }
      const appError = error instanceof AppError
        ? error
        : timeoutSignal.aborted && !input.signal.aborted && !this.shutdownSignal.aborted
          ? new AppError('PARSE_TIMEOUT', 504, '解析超时，请稍后重试')
          : new AppError('INTERNAL_ERROR', 500, '功能太火爆啦，请稍后再试', false);
      const output: ParseOutput = {
        statusCode: appError.statusCode,
        body: presentError(appError.statusCode, appError.message, appError.code),
      };
      try {
        this.#completeLog(
          input,
          output,
          realUrl,
          platformId,
          startedAt,
          signal.aborted && input.signal.aborted ? 'client_aborted' : 'completed',
        );
      } catch (logError) {
        input.logger.error(
          { request_id: input.requestId, error_category: 'log_completion_failed', error: logError },
          'failed to complete parse request log',
        );
        return {
          statusCode: 500,
          body: presentError(500, '功能太火爆啦，请稍后再试', 'INTERNAL_ERROR'),
        };
      }
      if (!(error instanceof AppError)) {
        input.logger.error(
          {
            request_id: input.requestId,
            platform_id: platformId,
            error_category: 'unexpected',
            ...safeErrorDetails(error),
          },
          'parse failed unexpectedly',
        );
      }
      return output;
    }
  }

  async #executeWithProxyRetry(
    input: ParseInput,
    shareUrl: URL,
    signal: AbortSignal,
    timeoutSignal: AbortSignal,
  ): Promise<
    | { realUrl: URL; platformId: PlatformId; result: MediaResult }
    | { realUrl: URL; platformId: PlatformId; legacyOutput: ParseOutput }
  > {
    const proxyManager = this.proxyManager;
    const initialPlatform = detectPlatform(shareUrl);
    let currentPlatform: PlatformId | null = initialPlatform;
    let currentRealUrl: URL | null = null;
    let usingProxy = proxyManager?.active(initialPlatform) ?? false;
    const triedProxies = new Set<string>();
    let extractions = 0;
    let lastCookieError: AppError | null = null;

    const attachContext = <T>(err: T): T => {
      if (err && typeof err === 'object') {
        Object.assign(err, { resolvedRealUrl: currentRealUrl, resolvedPlatformId: currentPlatform });
      }
      return err;
    };

    for (;;) {
      if (timeoutSignal.aborted && !input.signal.aborted && !this.shutdownSignal.aborted) {
        throw attachContext(new AppError('PARSE_TIMEOUT', 504, '解析超时，请稍后重试'));
      }
      let proxy: ProxyLease | null = null;
      if (usingProxy && proxyManager) {
        if (triedProxies.size >= 3) {
          if (lastCookieError) throw attachContext(lastCookieError);
          throw attachContext(new AppError('PROXY_RETRY_EXHAUSTED', 502, '代理访问失败，已达到重试上限'));
        }
        proxy = proxyManager.available(triedProxies);
        while (!proxy && extractions < 3) {
          if (timeoutSignal.aborted) {
            throw attachContext(new AppError('PARSE_TIMEOUT', 504, '解析超时，请稍后重试'));
          }
          if (await proxyManager.replenish(signal)) {
            extractions += 1;
          }
          proxy = proxyManager.available(triedProxies);
          if (!proxy) {
            await delay(100, signal);
          }
        }
        if (!proxy) {
          if (timeoutSignal.aborted) {
            throw attachContext(new AppError('PARSE_TIMEOUT', 504, '解析超时，请稍后重试'));
          }
          throw attachContext(new AppError('PROXY_UNAVAILABLE', 503, '暂时无法获取可用代理，请稍后重试'));
        }
        triedProxies.add(proxy.address);
        lastCookieError = null;
      }

      let cookieChallenged = false;
      const onCookieChallenge = (): void => {
        cookieChallenged = true;
      };

      try {
        currentRealUrl = await this.#redirectResolver.resolve(shareUrl, signal, {
          proxy,
          onCookieChallenge,
        });
        const detectedPlatform = detectPlatform(currentRealUrl);
        currentPlatform = detectedPlatform;
        if (!detectedPlatform) {
          throw attachContext(new AppError('PLATFORM_NOT_SUPPORTED', 400, '该链接尚未支持提取'));
        }
        if (!this.platformService.isEnabled(detectedPlatform)) {
          throw attachContext(new AppError('PLATFORM_DISABLED', 503, '该平台暂不可用'));
        }
        if (!usingProxy && proxyManager?.active(detectedPlatform)) {
          usingProxy = true;
          continue;
        }
        if (this.config.parserEngine === 'legacy-http') {
          if (!this.#legacyClient) throw new Error('legacy parser client missing');
          const legacyOutput = await this.#legacyClient.parse(input.text, signal);
          return { realUrl: currentRealUrl, platformId: detectedPlatform, legacyOutput };
        }
        const registration = getParserRegistration(detectedPlatform);
        const session = new HttpSession({
          allowedHosts: [...getPlatformAllowedHosts(detectedPlatform), ...registration.allowedHosts],
          defaultHeaders: { 'user-agent': DEFAULT_DESKTOP_USER_AGENT },
          timeoutMs: this.config.upstreamTimeoutMs,
          proxy,
          onCookieChallenge,
        });
        const context = {
          requestId: input.requestId,
          apiClientId: input.identity.clientId,
          apiKeyId: input.identity.apiKeyId,
          platform: detectedPlatform,
          originalUrl: shareUrl,
          realUrl: currentRealUrl,
          session,
          signal,
          logger: input.logger,
          credentials: this.credentialService.getCredentials(detectedPlatform),
        };
        const result = await registration.factory(context).parse(context);
        if (hasMedia(result)) {
          return { realUrl: currentRealUrl, platformId: detectedPlatform, result };
        }
        const noMediaError = evaluateNoMediaError(detectedPlatform, result, cookieChallenged);
        if (COOKIE_ERROR_CODES.has(noMediaError.code) && proxyManager?.enabled) {
          lastCookieError = noMediaError;
          if (proxy) proxyManager.invalidate(proxy.address, '平台仍要求 Cookie 校验');
          proxyManager.activate(detectedPlatform);
          usingProxy = true;
          continue;
        }
        throw attachContext(noMediaError);
      } catch (error) {
        if (error instanceof ProxyAttemptError && proxyManager) {
          if (proxy) proxyManager.invalidate(proxy.address, error.reason);
          if ((error.cookieRequired || cookieChallenged) && triedProxies.size >= 3) {
            throw attachContext(cookieRequiredError(currentPlatform));
          }
          continue;
        }
        if (error instanceof AppError && error.code === 'REDIRECT_FAILED' && cookieChallenged && proxyManager?.enabled && currentPlatform) {
          if (proxy) proxyManager.invalidate(proxy.address, '分享链接访问触发校验');
          proxyManager.activate(currentPlatform);
          usingProxy = true;
          continue;
        }
        if (error instanceof AppError && COOKIE_ERROR_CODES.has(error.code) && proxyManager?.enabled && currentPlatform) {
          lastCookieError = error;
          if (proxy) proxyManager.invalidate(proxy.address, '平台要求 Cookie 校验');
          proxyManager.activate(currentPlatform);
          usingProxy = true;
          continue;
        }
        throw attachContext(error);
      }
    }
  }

  #completeLog(
    input: ParseInput,
    output: ParseOutput,
    realUrl: URL | null,
    platformId: PlatformId | null,
    startedAt: number,
    state: 'completed' | 'client_aborted',
  ): void {
    this.requestLogService.complete(input.requestId, {
      realUrl: realUrl?.href ?? null,
      platformId,
      state,
      httpStatus: output.statusCode,
      retcode: output.body.retcode,
      success: output.body.succ,
      errorCode: output.body.succ ? null : output.body.error_code,
      responseJson: JSON.stringify(output.body),
      durationMs: Date.now() - startedAt,
    });
  }
}

export function evaluateNoMediaError(
  platformId: PlatformId,
  result: MediaResult,
  cookieChallenged = false,
): AppError {
  if (result.terminalError) {
    return new AppError(result.terminalError.code, 400, result.terminalError.message);
  }
  if (
    result.noMediaInContent === true ||
    (AI_TEXT_PLATFORMS.has(platformId) && Boolean(result.title.trim() || result.desc?.trim()))
  ) {
    return new AppError('NO_MEDIA_IN_CONTENT', 400, '该分享内容仅包含文本对话，未包含图片或视频资源');
  }
  if (
    result.cookieRequired === true ||
    cookieChallenged ||
    platformId === 'xiaohongshu' ||
    platformId === 'pinduoduo' ||
    platformId === 'wechat_channels'
  ) {
    return cookieRequiredError(platformId);
  }
  return new AppError('MEDIA_NOT_FOUND', 400, '提取媒体内容失败，请检查链接或稍后重试');
}

function cookieRequiredError(platformId: PlatformId | null): AppError {
  switch (platformId) {
    case 'xiaohongshu':
      return new AppError(
        'XIAOHONGSHU_COOKIE_REQUIRED',
        400,
        '解析失败：该链接需要小红书登录 Cookie 校验，请在配置中提供有效 Cookie 后重试',
      );
    case 'pinduoduo':
      return new AppError(
        'PINDUODUO_COOKIE_REQUIRED',
        400,
        '解析失败：该链接需要拼多多登录 Cookie 校验，请在配置中提供有效 Cookie 后重试',
      );
    case 'wechat_channels':
      return new AppError(
        'WECHAT_CHANNELS_COOKIE_REQUIRED',
        400,
        '解析失败：该链接需要配置腾讯元宝 YUANBAO_COOKIE 凭证后重试',
      );
    case 'kuaishou':
      return new AppError(
        'KUAISHOU_COOKIE_REQUIRED',
        400,
        '解析失败：该链接触发快手安全校验，请在配置中提供有效快手 Cookie 后重试',
      );
    case 'douyin':
      return new AppError(
        'DOUYIN_COOKIE_REQUIRED',
        400,
        '解析失败：该链接需要配置有效抖音 Cookie 凭证后重试',
      );
    default:
      return new AppError(
        'COOKIE_REQUIRED',
        400,
        '平台要求 Cookie 或登录校验，请配置有效 Cookie 后重试',
      );
  }
}

async function delay(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return;
  await new Promise<void>((resolve) => {
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = (): void => {
      clearTimeout(timer);
      resolve();
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });
}
