import {
  allPlatformAllowedHosts,
  detectPlatform,
  platformDefinitions,
  type PlatformDefinition,
} from '../config/platforms.js';
import { AppError, ProxyAttemptError, UpstreamError } from '../core/errors.js';
import { DEFAULT_DESKTOP_USER_AGENT } from '../config/user-agents.js';
import { HttpSession } from './http-session.js';
import { OutboundPolicy } from './outbound-policy.js';
import type { ProxyEndpoint } from './proxy-agent.js';
import { normalizePlatformUrl } from './url-tools.js';

const BLOCKED_REDIRECT_PATHS = ['/login', '/404', '/captcha', '/verify', '/error', '/visitor'];

const FORCE_REDIRECT_SHORT_DOMAINS = new Set([
  't.cn',
  'b23.tv',
  'xhslink.cn',
  'xhslink.com',
  'hy.fan',
  'dw4.co',
  'yspapp.cn',
  'www.yspapp.cn',
  'mapp.api.weibo.cn',
  's.izuiyou.com',
  'adshare.toutiao.com',
]);

export interface RedirectResolverOptions {
  timeoutMs: number;
  maxRedirects?: number;
}

export interface ResolveRedirectOptions {
  proxy?: ProxyEndpoint | null;
  onCookieChallenge?: () => void;
}

export class RedirectResolver {
  readonly #timeoutMs: number;
  readonly #maxRedirects: number;

  public constructor(options: RedirectResolverOptions) {
    this.#timeoutMs = options.timeoutMs;
    this.#maxRedirects = options.maxRedirects ?? 5;
  }

  public async resolve(
    input: URL,
    signal: AbortSignal,
    options: ResolveRedirectOptions = {},
  ): Promise<URL> {
    const initialPlatform = detectPlatform(input);
    if (!initialPlatform) throw new AppError('PLATFORM_NOT_SUPPORTED', 400, '该链接尚未支持提取');
    const definition: PlatformDefinition = platformDefinitions[initialPlatform];
    const hostname = input.hostname.toLowerCase().replace(/\.$/, '');
    try {
      new OutboundPolicy({ allowedHosts: allPlatformAllowedHosts }).assertUrl(input);
    } catch {
      throw new AppError('REDIRECT_FAILED', 400, '无法访问或识别该分享链接');
    }
    if (definition.bypassRedirectResolution && !FORCE_REDIRECT_SHORT_DOMAINS.has(hostname)) {
      return normalizePlatformUrl(input);
    }

    const session = new HttpSession({
      allowedHosts: allPlatformAllowedHosts,
      timeoutMs: this.#timeoutMs,
      maxBodyBytes: 256 * 1024,
      defaultHeaders: { 'user-agent': DEFAULT_DESKTOP_USER_AGENT },
      ...(options.proxy ? { proxy: options.proxy } : {}),
      ...(options.onCookieChallenge ? { onCookieChallenge: options.onCookieChallenge } : {}),
    });
    let current = new URL(input.href);
    let completed = false;
    for (let redirectCount = 0; redirectCount <= this.#maxRedirects; redirectCount += 1) {
      let response: Awaited<ReturnType<HttpSession['request']>>;
      try {
        response = await session.request(current, {
          method: 'GET',
          followRedirect: false,
          signal,
        });
      } catch (error) {
        if (error instanceof ProxyAttemptError) throw error;
        if (error instanceof UpstreamError && error.category === 'body_too_large' && error.statusCode === 200) {
          completed = true;
          break;
        }
        if (error instanceof AppError) throw error;
        throw new AppError('REDIRECT_FAILED', 400, '无法访问或识别该分享链接');
      }
      if (response.statusCode >= 400) {
        throw new AppError('REDIRECT_FAILED', 400, '无法访问或识别该分享链接');
      }
      const location = response.headers.location;
      let nextLocation = Array.isArray(location) ? location[0] : location;
      if (!nextLocation && response.statusCode === 200) {
        nextLocation = extractMetaRefreshUrl(response.body.toString('utf8'));
      }
      if (!nextLocation || (response.statusCode !== 200 && (response.statusCode < 300 || response.statusCode >= 400))) {
        completed = true;
        break;
      }
      let next: URL;
      try {
        next = new URL(nextLocation, current);
      } catch {
        throw new AppError('REDIRECT_FAILED', 400, '无法访问或识别该分享链接');
      }
      if (BLOCKED_REDIRECT_PATHS.some((path) => next.pathname.includes(path))) {
        completed = true;
        break;
      }
      if (!detectPlatform(next)) {
        throw new AppError('REDIRECT_FAILED', 400, '无法访问或识别该分享链接');
      }
      try {
        new OutboundPolicy({ allowedHosts: allPlatformAllowedHosts }).assertUrl(next);
      } catch {
        throw new AppError('REDIRECT_FAILED', 400, '无法访问或识别该分享链接');
      }
      current = next;
      if (redirectCount < this.#maxRedirects) {
        const resolvedPlatform = detectPlatform(current);
        const nextHost = current.hostname.toLowerCase().replace(/\.$/, '');
        if (
          resolvedPlatform &&
          (platformDefinitions[resolvedPlatform] as PlatformDefinition).bypassRedirectResolution &&
          !FORCE_REDIRECT_SHORT_DOMAINS.has(nextHost)
        ) {
          completed = true;
          break;
        }
      }
    }
    if (!completed) throw new AppError('REDIRECT_FAILED', 400, '无法访问或识别该分享链接');
    if (!detectPlatform(current)) {
      throw new AppError('REDIRECT_FAILED', 400, '无法访问或识别该分享链接');
    }
    return normalizePlatformUrl(current);
  }
}

function extractMetaRefreshUrl(html: string): string | undefined {
  const tagMatch = /<meta\b[^>]{0,512}>/giu.exec(html);
  if (!tagMatch) {
    return scanMetaRefreshTags(html);
  }
  return scanMetaRefreshTags(html);
}

function scanMetaRefreshTags(html: string): string | undefined {
  const tags = html.match(/<meta\b[^>]{0,1024}>/giu) ?? [];
  for (const tag of tags) {
    if (!/http-equiv\s*=\s*["']?refresh["']?/iu.test(tag)) continue;
    const urlMatch = /URL\s*=\s*['"]?([^'"\s>]+)/iu.exec(tag);
    if (urlMatch?.[1]) return urlMatch[1].replace(/^['"]|['"]$/gu, '');
  }
  return undefined;
}
