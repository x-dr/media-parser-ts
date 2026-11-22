import { describe, expect, it } from 'vitest';
import { decodeProxyPayload, ProxyManager } from '../../src/http/proxy-manager.js';

describe('ProxyManager and decodeProxyPayload', () => {
  it('decodes plain text and multi-vendor JSON proxy responses', () => {
    const now = Date.now();
    const textProxy = decodeProxyPayload('203.0.113.10:8080\r\n', now);
    expect(textProxy.address).toBe('203.0.113.10:8080');
    expect(textProxy.host).toBe('203.0.113.10');
    expect(textProxy.port).toBe(8080);

    const jsonProxy = decodeProxyPayload(
      {
        code: 200,
        data: {
          proxy_list: [{ ip: '198.51.100.25', port: '9001', ttl: 180 }],
        },
      },
      now,
    );
    expect(jsonProxy.address).toBe('198.51.100.25:9001');
    expect(jsonProxy.expiresAtMs).toBe(now + 180_000);
  });

  it('rejects private/loopback proxy addresses and vendor error codes', () => {
    const now = Date.now();
    expect(() => decodeProxyPayload('127.0.0.1:8080', now)).toThrow(/公网 IPv4/u);
    expect(() => decodeProxyPayload('10.0.0.5:8080', now)).toThrow(/公网 IPv4/u);
    expect(() => decodeProxyPayload({ code: 500, msg: 'quota exceeded' }, now)).toThrow(/失败/u);
  });

  it('supports auto platform window activation, rotation and invalidation', async () => {
    const responses = ['203.0.113.11:8001', '203.0.113.12:8002'];
    const manager = new ProxyManager({
      apiUrl: new URL('https://proxy.example.com/extract'),
      mode: 'auto',
      poolSize: 2,
      fetchPerSecond: 20,
      fetcher: async () => responses.shift() ?? '203.0.113.13:8003',
    });

    expect(manager.active('xiaohongshu')).toBe(false);
    manager.activate('xiaohongshu');
    expect(manager.active('xiaohongshu')).toBe(true);
    expect(manager.active('douyin')).toBe(false);

    await manager.replenish(AbortSignal.timeout(1_000));
    const first = manager.available();
    expect(first?.address).toBe('203.0.113.11:8001');

    manager.invalidate('203.0.113.11:8001', 'HTTP 403');
    expect(manager.isValid('203.0.113.11:8001')).toBe(false);
    expect(manager.available()).toBeNull();
  });
});
