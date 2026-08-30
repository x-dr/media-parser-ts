import { describe, expect, it } from 'vitest';
import { randomBytes } from 'node:crypto';
import { loadConfig } from '../../src/config/env.js';

describe('loadConfig', () => {
  it('parses safe defaults and a 32-byte encryption key', () => {
    const key = randomBytes(32).toString('base64');
    const config = loadConfig({ APP_ENCRYPTION_KEY: key });
    expect(config.port).toBe(8051);
    expect(config.encryptionKey).toHaveLength(32);
    expect(config.trustProxy).toBe(false);
    expect(config.publicWebConcurrency).toBe(8);
  });

  it('rejects malformed security configuration', () => {
    expect(() => loadConfig({ APP_ENCRYPTION_KEY: 'bad' })).toThrow(/32 字节/u);
    expect(() => loadConfig({ TRUST_PROXY: 'true' })).toThrow(/TRUST_PROXY/u);
    expect(() => loadConfig({ CORS_ORIGINS: 'https://*.example.com' })).toThrow(/CORS_ORIGINS/u);
    expect(() => loadConfig({ PARSER_ENGINE: 'legacy-http' })).toThrow(/LEGACY_PYTHON_URL/u);
  });
});
