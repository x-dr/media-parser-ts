import { randomBytes } from 'node:crypto';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AppConfig } from '../src/config/env.js';

export const BOOTSTRAP_PASSWORD = 'initial-password-123';

export async function testConfig(overrides: Partial<AppConfig> = {}): Promise<AppConfig> {
  const directory = await mkdtemp(join(tmpdir(), 'media-parser-ts-test-'));
  const passwordFile = join(directory, 'admin-password');
  // The test owns this freshly created temporary path.
  // eslint-disable-next-line security/detect-non-literal-fs-filename
  await writeFile(passwordFile, `${BOOTSTRAP_PASSWORD}\n`, { mode: 0o600 });
  return {
    port: 8051,
    logLevel: 'silent',
    databasePath: ':memory:',
    parseTimeoutMs: 25_000,
    upstreamTimeoutMs: 10_000,
    globalParseConcurrency: 20,
    logRetentionDays: 30,
    adminBootstrapUsername: 'admin',
    adminBootstrapPasswordFile: passwordFile,
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
