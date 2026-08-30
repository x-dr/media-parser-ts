import { describe, expect, it } from 'vitest';
import {
  AnonymousConcurrencyGate,
  AnonymousRateLimiter,
} from '../../src/public-web/anonymous-guards.js';

describe('anonymous public web guards', () => {
  it('limits each IP inside a minute window and reports a retry delay', () => {
    const limiter = new AnonymousRateLimiter(2);
    expect(limiter.consume('203.0.113.1', 1_000)).toEqual({ allowed: true });
    expect(limiter.consume('203.0.113.1', 2_000)).toEqual({ allowed: true });
    expect(limiter.consume('203.0.113.1', 3_000)).toEqual({ allowed: false, retryAfter: 58 });
    expect(limiter.consume('203.0.113.2', 3_000)).toEqual({ allowed: true });
    expect(limiter.consume('203.0.113.1', 61_000)).toEqual({ allowed: true });
  });

  it('releases anonymous concurrency slots idempotently', () => {
    const gate = new AnonymousConcurrencyGate(1);
    const lease = gate.acquire();
    expect(lease).not.toBeNull();
    expect(gate.acquire()).toBeNull();
    lease?.release();
    lease?.release();
    expect(gate.acquire()).not.toBeNull();
  });
});
