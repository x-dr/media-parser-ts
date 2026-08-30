import { afterEach, describe, expect, it, vi } from 'vitest';
import { LegacyParserClient } from '../../src/legacy/legacy-parser-client.js';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('legacy parser client', () => {
  it('forwards to the global Python endpoint and validates the compatibility envelope', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({
      retcode: 200, retdesc: '成功', data: { platform: '测试' }, succ: true,
    }), { status: 200, headers: { 'content-type': 'application/json' } }));
    vi.stubGlobal('fetch', fetchMock);
    const client = new LegacyParserClient(new URL('http://legacy-parser:8051'));
    const output = await client.parse('share text', AbortSignal.timeout(2_000));
    expect(output.body.succ).toBe(true);
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchMock.mock.calls[0]?.[0]).toEqual(new URL('http://legacy-parser:8051/api/parse'));
    expect(fetchMock.mock.calls[0]?.[1]?.body).toBe(JSON.stringify({ text: 'share text' }));
  });
});
