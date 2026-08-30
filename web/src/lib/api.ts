import type {
  ParseFailure,
  ParseResponse,
  PlatformResponse,
  ServiceStatus,
} from '../types';

export async function getStatus(signal?: AbortSignal): Promise<ServiceStatus> {
  return requestJson<ServiceStatus>('/web-api/status', { signal });
}

export async function getPlatforms(signal?: AbortSignal): Promise<PlatformResponse> {
  return requestJson<PlatformResponse>('/web-api/platforms', { signal });
}

export async function parseMedia(
  text: string,
  signal: AbortSignal,
): Promise<{ response: ParseResponse; retryAfter: number | null }> {
  const response = await fetch('/web-api/parse', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ text }),
    signal,
  });
  const retryAfterHeader = response.headers.get('retry-after');
  const retryAfter = retryAfterHeader && /^\d+$/u.test(retryAfterHeader)
    ? Number(retryAfterHeader)
    : null;
  const body = await readJson<ParseResponse>(response);
  return { response: body, retryAfter };
}

export function networkFailure(message = '无法连接公开解析服务'): ParseFailure {
  return {
    retcode: 0,
    retdesc: message,
    data: null,
    succ: false,
    error_code: 'NETWORK_ERROR',
  };
}

async function requestJson<T>(input: string, init?: RequestInit): Promise<T> {
  const response = await fetch(input, init);
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return readJson<T>(response);
}

async function readJson<T>(response: Response): Promise<T> {
  const contentType = response.headers.get('content-type') ?? '';
  if (!contentType.includes('application/json')) throw new Error('响应不是 JSON');
  return response.json() as Promise<T>;
}
