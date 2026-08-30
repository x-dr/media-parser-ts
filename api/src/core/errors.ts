export type PublicErrorCode =
  | 'INVALID_REQUEST'
  | 'INVALID_TEXT'
  | 'TEXT_TOO_LONG'
  | 'URL_NOT_FOUND'
  | 'REDIRECT_FAILED'
  | 'PLATFORM_NOT_SUPPORTED'
  | 'MEDIA_NOT_FOUND'
  | 'XIAOHONGSHU_COOKIE_REQUIRED'
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

export function safeErrorDetails(error: unknown): Record<string, unknown> {
  if (error instanceof UpstreamError) {
    return { error_name: error.name, upstream_category: error.category };
  }
  return { error_name: error instanceof Error ? error.name : 'UnknownError' };
}
