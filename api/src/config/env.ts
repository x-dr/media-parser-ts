import { Buffer } from 'node:buffer';

export type LogLevel = 'fatal' | 'error' | 'warn' | 'info' | 'debug' | 'trace' | 'silent';
export type ParserEngine = 'typescript' | 'legacy-http';
export type TrustProxyConfig = false | number | readonly string[];

export interface AppConfig {
  port: number;
  logLevel: LogLevel;
  databasePath: string;
  parseTimeoutMs: number;
  upstreamTimeoutMs: number;
  globalParseConcurrency: number;
  logRetentionDays: number;
  adminBootstrapUsername: string | null;
  adminBootstrapPassword: string | null;
  encryptionKey: Buffer | null;
  previousEncryptionKey: Buffer | null;
  corsOrigins: readonly string[];
  trustProxy: TrustProxyConfig;
  parserEngine: ParserEngine;
  legacyPythonUrl: URL | null;
  publicWebApiKey: string | null;
  publicWebConcurrency: number;
  publicWebRateLimitPerMinute: number;
  credentialEnvironment: Readonly<Record<string, string>>;
}

const LOG_LEVELS = new Set<LogLevel>([
  'fatal',
  'error',
  'warn',
  'info',
  'debug',
  'trace',
  'silent',
]);

function integer(source: NodeJS.ProcessEnv, name: string, fallback: number, min: number, max: number): number {
  const raw = source[name];
  if (raw === undefined || raw === '') return fallback;
  if (!/^\d+$/.test(raw)) throw new Error(`${name} 必须是整数`);
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new Error(`${name} 必须介于 ${min} 和 ${max} 之间`);
  }
  return value;
}

function encryptionKey(source: NodeJS.ProcessEnv, name: string): Buffer | null {
  const raw = source[name]?.trim();
  if (!raw) return null;
  const decoded = Buffer.from(raw, 'base64');
  if (decoded.length !== 32 || decoded.toString('base64').replace(/=+$/, '') !== raw.replace(/=+$/, '')) {
    throw new Error(`${name} 必须是 Base64 编码的 32 字节密钥`);
  }
  return decoded;
}

function corsOrigins(source: NodeJS.ProcessEnv): readonly string[] {
  const raw = source.CORS_ORIGINS?.trim();
  if (!raw) return [];
  return raw.split(',').map((value) => {
    const origin = value.trim();
    const parsed = new URL(origin);
    if (!['http:', 'https:'].includes(parsed.protocol) || parsed.origin !== origin || origin.includes('*')) {
      throw new Error('CORS_ORIGINS 只能包含逗号分隔的精确 HTTP(S) Origin');
    }
    return origin;
  });
}

function trustProxy(source: NodeJS.ProcessEnv): TrustProxyConfig {
  const raw = source.TRUST_PROXY?.trim();
  if (!raw || raw === 'false') return false;
  if (/^[1-9]\d*$/.test(raw)) return Number(raw);
  const addresses = raw.split(',').map((value) => value.trim()).filter(Boolean);
  if (addresses.length === 0 || addresses.includes('true')) {
    throw new Error('TRUST_PROXY 必须为 false、可信代理跳数或地址列表');
  }
  return addresses;
}

function parserEngine(source: NodeJS.ProcessEnv): ParserEngine {
  const value = source.PARSER_ENGINE?.trim() || 'typescript';
  if (value !== 'typescript' && value !== 'legacy-http') {
    throw new Error('PARSER_ENGINE 必须是 typescript 或 legacy-http');
  }
  return value;
}

function legacyUrl(source: NodeJS.ProcessEnv, engine: ParserEngine): URL | null {
  const value = source.LEGACY_PYTHON_URL?.trim();
  if (!value) {
    if (engine === 'legacy-http') throw new Error('legacy-http 引擎需要 LEGACY_PYTHON_URL');
    return null;
  }
  const parsed = new URL(value);
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) {
    throw new Error('LEGACY_PYTHON_URL 必须是无凭据的 HTTP(S) URL');
  }
  return parsed;
}

function optionalSecret(source: NodeJS.ProcessEnv, name: string): string | null {
  return source[name]?.trim() || null;
}

function optionalPassword(source: NodeJS.ProcessEnv, name: string): string | null {
  const value = source[name];
  return value === undefined || value.length === 0 ? null : value;
}

export function loadConfig(source: NodeJS.ProcessEnv = process.env): AppConfig {
  const level = (source.LOG_LEVEL?.trim() || 'info') as LogLevel;
  if (!LOG_LEVELS.has(level)) throw new Error('LOG_LEVEL 无效');
  const engine = parserEngine(source);
  const credentialEnvironment = Object.fromEntries(
    ['DOUBAO_COOKIE', 'YUANBAO_COOKIE', 'KUAISHOU_COOKIE', 'XIAOHONGSHU_COOKIE']
      .map((name) => [name, source[name]?.trim() ?? ''] as const)
      .filter(([, value]) => value.length > 0),
  );

  return Object.freeze({
    port: integer(source, 'PORT', 8051, 1, 65_535),
    logLevel: level,
    databasePath: source.DATABASE_PATH?.trim() || '/app/data/media-parser.sqlite',
    parseTimeoutMs: integer(source, 'PARSE_TIMEOUT_MS', 25_000, 1_000, 120_000),
    upstreamTimeoutMs: integer(source, 'UPSTREAM_TIMEOUT_MS', 10_000, 500, 60_000),
    globalParseConcurrency: integer(source, 'GLOBAL_PARSE_CONCURRENCY', 20, 1, 1_000),
    logRetentionDays: integer(source, 'LOG_RETENTION_DAYS', 30, 1, 365),
    adminBootstrapUsername: source.ADMIN_BOOTSTRAP_USERNAME?.trim() || null,
    adminBootstrapPassword: optionalPassword(source, 'ADMIN_BOOTSTRAP_PASSWORD'),
    encryptionKey: encryptionKey(source, 'APP_ENCRYPTION_KEY'),
    previousEncryptionKey: encryptionKey(source, 'APP_ENCRYPTION_KEY_PREVIOUS'),
    corsOrigins: corsOrigins(source),
    trustProxy: trustProxy(source),
    parserEngine: engine,
    legacyPythonUrl: legacyUrl(source, engine),
    publicWebApiKey: optionalSecret(source, 'PUBLIC_WEB_API_KEY'),
    publicWebConcurrency: integer(source, 'PUBLIC_WEB_CONCURRENCY', 8, 1, 100),
    publicWebRateLimitPerMinute: integer(source, 'PUBLIC_WEB_RATE_LIMIT_PER_MINUTE', 6, 1, 1_000),
    credentialEnvironment,
  });
}
