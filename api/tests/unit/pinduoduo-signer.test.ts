import { describe, expect, it } from 'vitest';
import { LocalPinduoduoSigner } from '../../src/signers/pinduoduo/signer.js';

describe('LocalPinduoduoSigner', () => {
  it('generates a non-empty Pinduoduo anti_content token locally', () => {
    const signer = new LocalPinduoduoSigner({
      now: () => 1_760_000_000_000,
      random: () => 0.42,
    });
    const token = signer.getAntiContent();
    expect(token.length).toBeGreaterThan(200);
    expect(token.startsWith('0a')).toBe(true);
  });
});
