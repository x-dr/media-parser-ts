import type { FastifyBaseLogger } from 'fastify';
import type { AppConfig } from '../config/env.js';
import { detectPlatform, platformDefinitions, type PlatformId } from '../config/platforms.js';
import { presentError, presentSuccess, type LegacyResponse } from '../api/presenter.js';
import type { ApiKeyIdentity } from '../auth/api-key-service.js';
import type { CredentialService } from '../platform-admin/credential-service.js';
import type { PlatformService } from '../platform-admin/platform-service.js';
import type { RequestLogService } from '../logging/request-log-service.js';
import { HttpSession } from '../http/http-session.js';
import { RedirectResolver } from '../http/redirect-resolver.js';
import { extractShareUrl } from '../http/url-tools.js';
import { DEFAULT_DESKTOP_USER_AGENT } from '../config/user-agents.js';
import { AppError, safeErrorDetails } from './errors.js';
import { hasMedia } from './media-result.js';
import { getParserRegistration } from './parser-registry.js';
import { LegacyParserClient } from '../legacy/legacy-parser-client.js';

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
  ) {
    this.#redirectResolver = new RedirectResolver({ timeoutMs: config.upstreamTimeoutMs });
    this.#legacyClient = config.parserEngine === 'legacy-http' && config.legacyPythonUrl
      ? new LegacyParserClient(config.legacyPythonUrl)
      : null;
  }

  public async parse(input: ParseInput): Promise<ParseOutput> {
    const startedAt = Date.now();
    const signal = AbortSignal.any([
      input.signal,
      this.shutdownSignal,
      AbortSignal.timeout(this.config.parseTimeoutMs),
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
      realUrl = await this.#redirectResolver.resolve(shareUrl, signal);
      platformId = detectPlatform(realUrl);
      if (!platformId) throw new AppError('PLATFORM_NOT_SUPPORTED', 400, '该链接尚未支持提取');
      if (!this.platformService.isEnabled(platformId)) {
        throw new AppError('PLATFORM_DISABLED', 503, '该平台暂不可用');
      }
      if (this.config.parserEngine === 'legacy-http') {
        if (!this.#legacyClient) throw new Error('legacy parser client missing');
        const output = await this.#legacyClient.parse(input.text, signal);
        this.#completeLog(input, output, realUrl, platformId, startedAt, 'completed');
        return output;
      }
      const registration = getParserRegistration(platformId);
      const session = new HttpSession({
        allowedHosts: [...platformDefinitions[platformId].domains, ...registration.allowedHosts],
        defaultHeaders: { 'user-agent': DEFAULT_DESKTOP_USER_AGENT },
        timeoutMs: this.config.upstreamTimeoutMs,
      });
      const context = {
        requestId: input.requestId,
        apiClientId: input.identity.clientId,
        apiKeyId: input.identity.apiKeyId,
        platform: platformId,
        originalUrl: shareUrl,
        realUrl,
        session,
        signal,
        logger: input.logger,
        credentials: this.credentialService.getCredentials(platformId),
      };
      const result = await registration.factory(context).parse(context);
      if (!hasMedia(result)) {
        if (platformId === 'xiaohongshu') {
          throw new AppError(
            'XIAOHONGSHU_COOKIE_REQUIRED',
            400,
            '解析失败：该链接需要小红书登录 Cookie 校验，请在配置中提供有效 Cookie 后重试',
          );
        }
        throw new AppError('MEDIA_NOT_FOUND', 400, '提取媒体内容失败，请检查链接或稍后重试');
      }
      const output: ParseOutput = { statusCode: 200, body: presentSuccess(platformId, realUrl, result) };
      this.#completeLog(input, output, realUrl, platformId, startedAt, 'completed');
      return output;
    } catch (error) {
      const appError = error instanceof AppError
        ? error
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
