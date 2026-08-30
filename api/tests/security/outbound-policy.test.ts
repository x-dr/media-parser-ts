import { describe, expect, it } from 'vitest';
import { isBlockedAddress, OutboundPolicy } from '../../src/http/outbound-policy.js';

describe('OutboundPolicy', () => {
  it.each([
    '127.0.0.1',
    '10.0.0.1',
    '169.254.169.254',
    '172.16.0.1',
    '192.168.1.1',
    '::1',
    'fe80::1',
    'fd00::1',
    'ff02::1',
  ])('blocks non-public address %s', (address) => {
    expect(isBlockedAddress(address)).toBe(true);
  });

  it('allows public addresses', () => {
    expect(isBlockedAddress('1.1.1.1')).toBe(false);
    expect(isBlockedAddress('2606:4700:4700::1111')).toBe(false);
  });

  it('rejects credentials, abnormal ports, IP literals and unknown hosts', () => {
    const policy = new OutboundPolicy({ allowedHosts: ['example.com'] });
    expect(() => policy.assertUrl(new URL('https://user:pass@example.com'))).toThrow();
    expect(() => policy.assertUrl(new URL('https://example.com:8443'))).toThrow();
    expect(() => policy.assertUrl(new URL('https://127.0.0.1'))).toThrow();
    expect(() => policy.assertUrl(new URL('https://example.com.evil.test'))).toThrow();
  });
});
