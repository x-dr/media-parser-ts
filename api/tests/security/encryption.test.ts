import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { EncryptionService } from '../../src/security/encryption.js';

describe('EncryptionService', () => {
  it('encrypts with unique IV and binds ciphertext to its record', () => {
    const service = new EncryptionService(randomBytes(32), null);
    const first = service.encrypt('doubao', 'cookie', 'session=value');
    const second = service.encrypt('doubao', 'cookie', 'session=value');
    expect(first.iv).not.toBe(second.iv);
    expect(service.decrypt('doubao', 'cookie', first).value).toBe('session=value');
    expect(() => service.decrypt('kuaishou', 'cookie', first)).toThrow();
  });

  it('detects values that need rewrapping after key rotation', () => {
    const previous = randomBytes(32);
    const oldService = new EncryptionService(previous, null);
    const encrypted = oldService.encrypt('doubao', 'cookie', 'value');
    const rotated = new EncryptionService(randomBytes(32), previous);
    expect(rotated.decrypt('doubao', 'cookie', encrypted)).toEqual({
      value: 'value',
      needsRewrap: true,
    });
  });
});
