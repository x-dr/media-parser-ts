import type { PlatformId } from '../config/platforms.js';
import type { HttpSession } from '../http/http-session.js';

export type PlatformCredentials = Readonly<Record<string, string>>;

export interface ParserLogger {
  debug(fields: Record<string, unknown>, message: string): void;
  info(fields: Record<string, unknown>, message: string): void;
  warn(fields: Record<string, unknown>, message: string): void;
  error(fields: Record<string, unknown>, message: string): void;
}

export interface ParseContext {
  requestId: string;
  apiClientId: string;
  apiKeyId: string;
  platform: PlatformId;
  originalUrl: URL;
  realUrl: URL;
  session: HttpSession;
  signal: AbortSignal;
  logger: ParserLogger;
  credentials: PlatformCredentials;
}
