export type PublicErrorCode =
  | 'INVALID_REQUEST'
  | 'INVALID_TEXT'
  | 'TEXT_TOO_LONG'
  | 'URL_NOT_FOUND'
  | 'REDIRECT_FAILED'
  | 'PLATFORM_NOT_SUPPORTED'
  | 'MEDIA_NOT_FOUND'
  | 'MEDIA_DELETED_OR_PRIVATE'
  | 'NO_MEDIA_IN_CONTENT'
  | 'COOKIE_REQUIRED'
  | 'DOUYIN_COOKIE_REQUIRED'
  | 'XIAOHONGSHU_COOKIE_REQUIRED'
  | 'KUAISHOU_COOKIE_REQUIRED'
  | 'WECHAT_CHANNELS_COOKIE_REQUIRED'
  | 'PINDUODUO_COOKIE_REQUIRED'
  | 'PARSE_TIMEOUT'
  | 'PROXY_UNAVAILABLE'
  | 'PROXY_RETRY_EXHAUSTED'
  | 'UNAUTHORIZED'
  | 'RATE_LIMITED'
  | 'CONCURRENCY_LIMITED'
  | 'PUBLIC_WEB_UNAVAILABLE'
  | 'PLATFORM_DISABLED'
  | 'LOG_STORAGE_UNAVAILABLE'
  | 'INTERNAL_ERROR';

export class AppError extends Error {
  public constructor(
    public readonly code: PublicErrorCode,
    public readonly statusCode: number,
    message: string,
    public readonly expose = true,
  ) {
    super(message);
    this.name = 'AppError';
  }
}

export class UpstreamError extends Error {
  public constructor(
    public readonly category: 'timeout' | 'network' | 'http' | 'invalid_response' | 'body_too_large',
    message: string,
    public readonly statusCode?: number,
  ) {
    super(message);
    this.name = 'UpstreamError';
  }
}

export class ProxyAttemptError extends Error {
  public constructor(
    public readonly reason: string,
    public readonly cookieRequired = false,
  ) {
    super(reason);
    this.name = 'ProxyAttemptError';
  }
}

export function safeErrorDetails(error: unknown): Record<string, unknown> {
  if (error instanceof UpstreamError) {
    return { error_name: error.name, upstream_category: error.category };
  }
  return { error_name: error instanceof Error ? error.name : 'UnknownError' };
}
