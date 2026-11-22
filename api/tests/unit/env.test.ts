import { describe, expect, it } from 'vitest';
import { randomBytes } from 'node:crypto';
import { loadConfig } from '../../src/config/env.js';

describe('loadConfig', () => {
  it('parses safe defaults, 32-byte encryption key, proxy settings and Douyin UIFID merge', () => {
    const key = randomBytes(32).toString('base64');
    const config = loadConfig({
      APP_ENCRYPTION_KEY: key,
      ADMIN_BOOTSTRAP_PASSWORD: ' initial-password-123 ',
      DYNAMIC_PROXY_API_URL: 'https://proxy.example.com/get',
      PROXY_MODE: 'always',
      PROXY_POOL_SIZE: '8',
      PROXY_FETCH_PER_SECOND: '2',
      DOUYIN_COOKIE: 'sessionid=abc',
      DOUYIN_UIFID: 'uifid-token',
      XHS_COOKIE: 'a1=xyz',
    });
    expect(config.port).toBe(8051);
    expect(config.encryptionKey).toHaveLength(32);
    expect(config.trustProxy).toBe(false);
    expect(config.publicWebConcurrency).toBe(8);
    expect(config.adminBootstrapPassword).toBe(' initial-password-123 ');
    expect(config.dynamicProxyApiUrl?.href).toBe('https://proxy.example.com/get');
    expect(config.proxyMode).toBe('always');
    expect(config.proxyPoolSize).toBe(8);
    expect(config.proxyFetchPerSecond).toBe(2);
    expect(config.credentialEnvironment.DOUYIN_COOKIE).toBe('UIFID=uifid-token; sessionid=abc');
    expect(config.credentialEnvironment.XHS_COOKIE).toBe('a1=xyz');
  });

  it('rejects malformed security and proxy configuration', () => {
    expect(() => loadConfig({ APP_ENCRYPTION_KEY: 'bad' })).toThrow(/32 字节/u);
    expect(() => loadConfig({ TRUST_PROXY: 'true' })).toThrow(/TRUST_PROXY/u);
    expect(() => loadConfig({ CORS_ORIGINS: 'https://*.example.com' })).toThrow(/CORS_ORIGINS/u);
    expect(() => loadConfig({ PARSER_ENGINE: 'legacy-http' })).toThrow(/LEGACY_PYTHON_URL/u);
    expect(() => loadConfig({ PROXY_MODE: 'invalid' })).toThrow(/PROXY_MODE/u);
    expect(() => loadConfig({ DYNAMIC_PROXY_API_URL: 'ftp://proxy.example' })).toThrow(/DYNAMIC_PROXY_API_URL/u);
  });
});
