import { describe, expect, it } from 'vitest';
import { LocalByteDanceSigner } from '../../src/signers/bytedance/signer.js';

describe('local ByteDance signer wrapper', () => {
  it('loads trusted local algorithms through a narrow deterministic wrapper', () => {
    const signer = new LocalByteDanceSigner({ random: () => 0.5, now: () => 1_700_000_000_000 });
    const url = new URL('https://www.douyin.com/aweme/v1/web/aweme/detail/?aid=6383');
    expect(signer.getABogus(url, 'test-user-agent')).not.toBe('');
    expect(signer.getXBogus(url, 'test-user-agent')).not.toBe('');
    expect(signer.getMsToken(8)).toHaveLength(8);
  });
});
