import type { LegacyResponse } from '../api/presenter.js';
import { AppError } from '../core/errors.js';
import { record, string } from '../platforms/data.js';

const MAX_RESPONSE_BYTES = 10 * 1024 * 1024;

export interface LegacyParseResult {
  statusCode: number;
  body: LegacyResponse;
}

export class LegacyParserClient {
  readonly #parseUrl: URL;

  public constructor(baseUrl: URL) {
    this.#parseUrl = parseEndpoint(baseUrl);
  }

  public async parse(text: string, signal: AbortSignal): Promise<LegacyParseResult> {
    let response: Response;
    try {
      response = await fetch(this.#parseUrl, {
        method: 'POST',
        headers: { accept: 'application/json', 'content-type': 'application/json' },
        body: JSON.stringify({ text }),
        redirect: 'error',
        signal,
      });
    } catch {
      throw new AppError(
        'INTERNAL_ERROR',
        500,
        '功能太火爆啦，请稍后再试',
        false,
      );
    }
    const contentLength = Number(response.headers.get('content-length'));
    if (Number.isFinite(contentLength) && contentLength > MAX_RESPONSE_BYTES) {
      throw new AppError('INTERNAL_ERROR', 500, '功能太火爆啦，请稍后再试', false);
    }
    const bytes = await readLimited(response, MAX_RESPONSE_BYTES);
    let payload: unknown;
    try {
      payload = JSON.parse(Buffer.from(bytes).toString('utf8')) as unknown;
    } catch {
      throw new AppError('INTERNAL_ERROR', 500, '功能太火爆啦，请稍后再试', false);
    }
    return {
      statusCode: response.status,
      body: validateLegacyResponse(payload),
    };
  }
}

function parseEndpoint(baseUrl: URL): URL {
  const endpoint = new URL(baseUrl.href);
  if (!endpoint.pathname.endsWith('/api/parse')) {
    endpoint.pathname = `${endpoint.pathname.replace(/\/$/u, '')}/api/parse`;
  }
  endpoint.search = '';
  endpoint.hash = '';
  return endpoint;
}

async function readLimited(response: Response, limit: number): Promise<Uint8Array> {
  if (!response.body) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  while (true) {
    const item = await reader.read();
    if (item.done) break;
    const chunk: unknown = item.value;
    if (!(chunk instanceof Uint8Array)) {
      throw new AppError('INTERNAL_ERROR', 500, '功能太火爆啦，请稍后再试', false);
    }
    length += chunk.byteLength;
    if (length > limit) {
      await reader.cancel('legacy response too large');
      throw new AppError('INTERNAL_ERROR', 500, '功能太火爆啦，请稍后再试', false);
    }
    chunks.push(chunk);
  }
  const output = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return output;
}

function validateLegacyResponse(value: unknown): LegacyResponse {
  const payload = record(value);
  const retcode = payload.retcode;
  const retdesc = string(payload.retdesc);
  if (!Number.isInteger(retcode) || !retdesc || typeof payload.succ !== 'boolean') {
    throw new AppError('INTERNAL_ERROR', 500, '功能太火爆啦，请稍后再试', false);
  }
  if (payload.succ && retcode === 200 && record(payload.data) === payload.data) {
    return { retcode: 200, retdesc: '成功', data: record(payload.data), succ: true };
  }
  const errorCode = string(payload.error_code);
  if (!payload.succ && errorCode) {
    return {
      retcode: retcode as number,
      retdesc,
      data: null,
      succ: false,
      error_code: errorCode,
    };
  }
  throw new AppError('INTERNAL_ERROR', 500, '功能太火爆啦，请稍后再试', false);
}
