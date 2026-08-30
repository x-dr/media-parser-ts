import type { HttpResponse } from './http-session.js';
import { UpstreamError } from '../core/errors.js';

export function readText(response: HttpResponse): string {
  return response.body.toString('utf8');
}

export function readJson<T>(response: HttpResponse): T {
  try {
    return JSON.parse(readText(response)) as T;
  } catch {
    throw new UpstreamError('invalid_response', '上游未返回有效 JSON');
  }
}

export function readJsonp<T>(response: HttpResponse): T {
  const text = readText(response).trim();
  const start = text.indexOf('(');
  const end = text.lastIndexOf(')');
  if (start < 1 || end <= start) throw new UpstreamError('invalid_response', '上游 JSONP 格式无效');
  try {
    return JSON.parse(text.slice(start + 1, end)) as T;
  } catch {
    throw new UpstreamError('invalid_response', '上游 JSONP 负载无效');
  }
}
