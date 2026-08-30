import type { AuthorInfo, MediaResult } from '../core/media-result.js';
import { emptyMediaResult } from '../core/media-result.js';

export type JsonRecord = Record<string, unknown>;

export function record(value: unknown): JsonRecord {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as JsonRecord
    : {};
}

export function array(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

export function at(value: unknown, ...path: (string | number)[]): unknown {
  let current = value;
  for (const segment of path) {
    if (typeof segment === 'number') {
      current = array(current)[segment];
    } else {
      current = record(current)[segment];
    }
  }
  return current;
}

export function string(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback;
}

export function id(value: unknown): string {
  return typeof value === 'string' || typeof value === 'number' ? String(value) : '';
}

export function stringAt(value: unknown, ...path: (string | number)[]): string {
  return string(at(value, ...path));
}

export function idAt(value: unknown, ...path: (string | number)[]): string {
  return id(at(value, ...path));
}

export function result(overrides: Partial<MediaResult>): MediaResult {
  return { ...emptyMediaResult(), ...overrides };
}

export function author(
  nickname: unknown,
  authorId: unknown,
  avatar: unknown,
): AuthorInfo | null {
  const mapped = { nickname: string(nickname), authorId: id(authorId), avatar: string(avatar) };
  return mapped.nickname || mapped.authorId || mapped.avatar ? mapped : null;
}

export function parseJson(text: string): unknown {
  return JSON.parse(text) as unknown;
}

export function extractAssignedJson(html: string, marker: string): unknown {
  const markerIndex = html.indexOf(marker);
  if (markerIndex < 0) return {};
  const start = html.indexOf('{', markerIndex + marker.length);
  if (start < 0) return {};
  let depth = 0;
  let quote = '';
  let escaped = false;
  for (let index = start; index < html.length; index += 1) {
    const character = html[index] ?? '';
    if (quote) {
      if (escaped) escaped = false;
      else if (character === '\\') escaped = true;
      else if (character === quote) quote = '';
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
    } else if (character === '{') {
      depth += 1;
    } else if (character === '}') {
      depth -= 1;
      if (depth === 0) {
        const json = html.slice(start, index + 1).replace(/:\s*undefined(?=\s*[,}])/gu, ': null');
        return parseJson(json);
      }
    }
  }
  return {};
}

export function protocolUrl(value: string): string {
  return value.startsWith('//') ? `https:${value}` : value;
}

export function uniqueStrings(values: readonly unknown[]): string[] {
  return [...new Set(values.map((value) => string(value)).filter(Boolean))];
}
