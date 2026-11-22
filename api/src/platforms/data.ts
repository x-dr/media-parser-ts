import type { AuthorInfo, MediaResult, SubtitleItem } from '../core/media-result.js';
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

export function number(value: unknown, fallback = 0): number {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return fallback;
}

export function id(value: unknown): string {
  return typeof value === 'string' || typeof value === 'number' ? String(value) : '';
}

export function stringAt(value: unknown, ...path: (string | number)[]): string {
  return string(at(value, ...path));
}

export function numberAt(value: unknown, ...path: (string | number)[]): number {
  return number(at(value, ...path));
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

export function subtitleSec(text: string, startSec?: number, endSec?: number): SubtitleItem {
  return {
    text,
    ...(startSec !== undefined && Number.isFinite(startSec) ? { startMs: Math.round(startSec * 1000) } : {}),
    ...(endSec !== undefined && Number.isFinite(endSec) ? { endMs: Math.round(endSec * 1000) } : {}),
  };
}

export function parseJson(text: string): unknown {
  return JSON.parse(text) as unknown;
}

export function sanitizeJsObjectLiteral(raw: string): string {
  return raw
    .replace(/:\s*undefined(?=\s*[,}\]])/gu, ': null')
    .replace(/:\s*NaN(?=\s*[,}\]])/gu, ': null')
    .replace(/:\s*Infinity(?=\s*[,}\]])/gu, ': null')
    .replace(/:\s*-Infinity(?=\s*[,}\]])/gu, ': null')
    .replace(/:\s*new\s+Date\(([^()]{0,64})\)/gu, ': $1')
    .replace(/:\s*BigInt\(([^()]{0,64})\)/gu, ': $1');
}

export function extractAssignedJson(html: string, marker: string): unknown {
  const markerIndex = html.indexOf(marker);
  if (markerIndex < 0) return {};
  const start = html.indexOf('{', markerIndex + marker.length);
  if (start < 0) return {};
  const slice = extractBalancedBraces(html, start);
  if (!slice) return {};
  try {
    return parseJson(sanitizeJsObjectLiteral(slice));
  } catch {
    return {};
  }
}

export function extractBalancedBraces(source: string, startIndex: number): string | null {
  if (source[startIndex] !== '{') return null;
  let depth = 0;
  let quote = '';
  let escaped = false;
  for (let index = startIndex; index < source.length; index += 1) {
    const character = source[index] ?? '';
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
        return source.slice(startIndex, index + 1);
      }
    }
  }
  return null;
}

export function unescapeHtml(input: string): string {
  return input
    .replace(/&amp;/giu, '&')
    .replace(/&lt;/giu, '<')
    .replace(/&gt;/giu, '>')
    .replace(/&quot;/giu, '"')
    .replace(/&#39;|&apos;/giu, "'")
    .replace(/&nbsp;/giu, ' ')
    .replace(/&#x([0-9a-fA-F]{1,6});/gu, (_match, hex: string) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d{1,7});/gu, (_match, dec: string) => String.fromCodePoint(parseInt(dec, 10)));
}

export function unescapeUnicodeEscapes(input: string): string {
  return input
    .replace(/\\u002F/giu, '/')
    .replace(/\\u0026/giu, '&')
    .replace(/\\u003D/giu, '=')
    .replace(/\\\//gu, '/');
}

export function parseCookiePairs(cookieHeader: string): Record<string, string> {
  const pairs: Record<string, string> = {};
  if (!cookieHeader) return pairs;
  for (const part of cookieHeader.split(';')) {
    const eqIndex = part.indexOf('=');
    if (eqIndex <= 0) continue;
    const key = part.slice(0, eqIndex).trim().replace(/^['"]|['"]$/gu, '');
    const val = part.slice(eqIndex + 1).trim().replace(/^['"]|['"]$/gu, '');
    if (key && val) pairs[key] = val;
  }
  return pairs;
}

export function parseLrcSubtitles(lrc: string): SubtitleItem[] {
  if (!lrc.trim()) return [];
  const entries: { startMs: number; text: string }[] = [];
  for (const rawLine of lrc.split(/\r?\n/u)) {
    let rest = rawLine.trim();
    if (!rest.startsWith('[')) continue;
    const timestamps: number[] = [];
    while (rest.startsWith('[')) {
      const closeIndex = rest.indexOf(']');
      if (closeIndex <= 1 || closeIndex > 12) break;
      const parsedMs = parseLrcTag(rest.slice(1, closeIndex));
      if (parsedMs === null) break;
      timestamps.push(parsedMs);
      rest = rest.slice(closeIndex + 1);
    }
    const text = rest.trim();
    if (!text || timestamps.length === 0) continue;
    for (const startMs of timestamps) {
      entries.push({ startMs, text });
    }
  }
  entries.sort((left, right) => left.startMs - right.startMs);
  return entries.map((entry, idx) => {
    const next = entries[idx + 1];
    return {
      text: entry.text,
      startMs: entry.startMs,
      ...(next ? { endMs: next.startMs } : {}),
    };
  });
}

function parseLrcTag(tag: string): number | null {
  const colonIndex = tag.indexOf(':');
  if (colonIndex <= 0) return null;
  const minPart = tag.slice(0, colonIndex);
  const secPart = tag.slice(colonIndex + 1);
  if (!/^\d{1,3}$/u.test(minPart)) return null;
  const sepIndex = secPart.includes('.') ? secPart.indexOf('.') : secPart.indexOf(':');
  const wholeSec = sepIndex >= 0 ? secPart.slice(0, sepIndex) : secPart;
  const fracSec = sepIndex >= 0 ? secPart.slice(sepIndex + 1) : '0';
  if (!/^\d{2}$/u.test(wholeSec) || !/^\d{1,3}$/u.test(fracSec)) return null;
  const fractionMs = fracSec.length === 1
    ? Number(fracSec) * 100
    : fracSec.length === 2
      ? Number(fracSec) * 10
      : Number(fracSec);
  return ((Number(minPart) * 60) + Number(wholeSec)) * 1000 + fractionMs;
}

export function protocolUrl(value: string): string {
  return value.startsWith('//') ? `https:${value}` : value;
}

export function uniqueStrings(values: readonly unknown[]): string[] {
  return [...new Set(values.map((value) => string(value)).filter(Boolean))];
}
