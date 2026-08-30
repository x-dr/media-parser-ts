import { randomBytes } from 'node:crypto';
import type { AppConfig } from '../src/config/env.js';

export const BOOTSTRAP_PASSWORD = 'initial-password-123';

export async function testConfig(overrides: Partial<AppConfig> = {}): Promise<AppConfig> {
  return {
    port: 8051,
    logLevel: 'silent',
    databasePath: ':memory:',
    parseTimeoutMs: 25_000,
    upstreamTimeoutMs: 10_000,
    globalParseConcurrency: 20,
    logRetentionDays: 30,
    adminBootstrapUsername: 'admin',
    adminBootstrapPassword: BOOTSTRAP_PASSWORD,
    encryptionKey: randomBytes(32),
    previousEncryptionKey: null,
    corsOrigins: [],
    trustProxy: false,
    parserEngine: 'typescript',
    legacyPythonUrl: null,
    publicWebApiKey: null,
    publicWebConcurrency: 8,
    publicWebRateLimitPerMinute: 6,
    credentialEnvironment: {},
    ...overrides,
  };
}
