import { detectPlatform, platformDefinitions } from '../config/platforms.js';
import { AppError } from '../core/errors.js';
import { DEFAULT_DESKTOP_USER_AGENT } from '../config/user-agents.js';
import { HttpSession } from './http-session.js';
import { OutboundPolicy } from './outbound-policy.js';
import { normalizePlatformUrl } from './url-tools.js';

const BLOCKED_REDIRECT_PATHS = ['/login', '/404', '/captcha', '/verify', '/error', '/visitor'];

export interface RedirectResolverOptions {
  timeoutMs: number;
  maxRedirects?: number;
}

export class RedirectResolver {
  readonly #timeoutMs: number;
  readonly #maxRedirects: number;

  public constructor(options: RedirectResolverOptions) {
    this.#timeoutMs = options.timeoutMs;
    this.#maxRedirects = options.maxRedirects ?? 5;
  }

  public async resolve(input: URL, signal: AbortSignal): Promise<URL> {
    const initialPlatform = detectPlatform(input);
    if (!initialPlatform) throw new AppError('PLATFORM_NOT_SUPPORTED', 400, '该链接尚未支持提取');
    const definition = platformDefinitions[initialPlatform];
    const initialAllowedHosts = [
      ...definition.domains,
      ...(initialPlatform === 'kuaishou' ? ['*.m.chenzhongtech.com'] : []),
    ];
    try {
      new OutboundPolicy({ allowedHosts: initialAllowedHosts }).assertUrl(input);
    } catch {
      throw new AppError('REDIRECT_FAILED', 400, '无法访问或识别该分享链接');
    }
    if ('bypassRedirectResolution' in definition && definition.bypassRedirectResolution) {
      return normalizePlatformUrl(input);
    }

    const session = new HttpSession({
      allowedHosts: initialAllowedHosts,
      timeoutMs: this.#timeoutMs,
      maxBodyBytes: 1024 * 1024,
      defaultHeaders: { 'user-agent': DEFAULT_DESKTOP_USER_AGENT },
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
          discardBody: true,
        });
      } catch (error) {
        if (error instanceof AppError) throw error;
        throw new AppError('REDIRECT_FAILED', 400, '无法访问或识别该分享链接');
      }
      if (response.statusCode >= 400) {
        throw new AppError('REDIRECT_FAILED', 400, '无法访问或识别该分享链接');
      }
      const location = response.headers.location;
      const firstLocation = Array.isArray(location) ? location[0] : location;
      if (!firstLocation || response.statusCode < 300 || response.statusCode >= 400) {
        completed = true;
        break;
      }
      const next = new URL(firstLocation, current);
      if (BLOCKED_REDIRECT_PATHS.some((path) => next.pathname.includes(path))) {
        completed = true;
        break;
      }
      if (detectPlatform(next) !== initialPlatform) {
        throw new AppError('REDIRECT_FAILED', 400, '无法访问或识别该分享链接');
      }
      current = next;
    }
    if (!completed) throw new AppError('REDIRECT_FAILED', 400, '无法访问或识别该分享链接');
    if (detectPlatform(current) !== initialPlatform) {
      throw new AppError('REDIRECT_FAILED', 400, '无法访问或识别该分享链接');
    }
    return normalizePlatformUrl(current);
  }
}
