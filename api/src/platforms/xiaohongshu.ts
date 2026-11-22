import type { ParseContext } from '../core/parse-context.js';
import type { ImageItem, TerminalErrorDetail } from '../core/media-result.js';
import type { PlatformParser } from '../core/parser.js';
import { registerParser } from '../core/parser-registry.js';
import { UpstreamError, safeErrorDetails } from '../core/errors.js';
import { DEFAULT_DESKTOP_USER_AGENT, DEFAULT_MOBILE_USER_AGENT } from '../config/user-agents.js';
import {
  array,
  at,
  author,
  extractBalancedBraces,
  numberAt,
  parseJson,
  record,
  result,
  stringAt,
} from './data.js';

const CANDIDATE_USER_AGENTS = [
  DEFAULT_DESKTOP_USER_AGENT,
  DEFAULT_MOBILE_USER_AGENT,
  DEFAULT_DESKTOP_USER_AGENT,
] as const;

class XiaohongshuParser implements PlatformParser {
  public readonly platform = 'xiaohongshu' as const;
  public constructor(private readonly context: ParseContext) {}

  public async parse(): Promise<ReturnType<typeof result>> {
    const initialCheck = inspectTargetUrl(this.context.realUrl.href);
    if (initialCheck) return result(initialCheck);

    let note: unknown = {};
    let terminalError: TerminalErrorDetail | null = null;
    let cookieRequired = false;
    const cookie = this.context.credentials.cookie;

    for (let index = 0; index < CANDIDATE_USER_AGENTS.length; index += 1) {
      const attempt = index + 1;
      const isLast = index === CANDIDATE_USER_AGENTS.length - 1;
      const userAgent = CANDIDATE_USER_AGENTS[index] ?? DEFAULT_DESKTOP_USER_AGENT;
      try {
        const html = await this.context.session.getText(this.context.realUrl, {
          headers: {
            'user-agent': userAgent,
            referer: 'https://www.xiaohongshu.com/',
            accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
            ...(cookie ? { cookie } : {}),
          },
          signal: this.context.signal,
        });
        const extracted = extractNoteFromHtml(html);
        if (extracted.terminalError) {
          terminalError = extracted.terminalError;
          break;
        }
        note = extracted.note;
        const videoUrl = extractVideoUrl(at(note, 'video'));
        if (videoUrl || array(at(note, 'imageList')).length > 0) {
          terminalError = null;
          break;
        }
        if (isLast && isDeletedNoteHtml(html)) {
          terminalError = {
            code: 'MEDIA_DELETED_OR_PRIVATE',
            message: '该小红书笔记已被作者删除或设置为私密不可见',
          };
        } else if (isLast && (html.includes('xhs_sec_server') || html.includes('xiaohongshu.com/login'))) {
          cookieRequired = true;
        }
      } catch (error) {
        if (error instanceof UpstreamError && error.statusCode === 404 && isLast) {
          terminalError = {
            code: 'MEDIA_DELETED_OR_PRIVATE',
            message: '该小红书笔记已被作者删除或不存在',
          };
        }
        this.context.logger.warn(
          {
            platform_id: this.platform,
            attempt,
            error_category: 'upstream_attempt_failed',
            ...safeErrorDetails(error),
          },
          'xiaohongshu parse attempt failed',
        );
      }
    }

    const images: ImageItem[] = [];
    for (const image of array(at(note, 'imageList'))) {
      const url = cleanImageUrl(image);
      if (!url) continue;
      const livePhotoUrl = extractLivePhotoStreamUrl(image);
      const isLivePhoto = at(image, 'livePhoto') === true ||
        (at(image, 'livePhoto') !== false && Boolean(livePhotoUrl));
      images.push(isLivePhoto && livePhotoUrl ? { url, livePhotoUrl } : url);
    }

    const videoUrl = extractVideoUrl(at(note, 'video'));
    const coverUrl = cleanImageUrl(at(note, 'cover')) ||
      cleanImageUrl(at(note, 'imageList', 0)) ||
      null;
    const user = at(note, 'user');
    const rawTitle = stringAt(note, 'title');
    const rawDesc = stringAt(note, 'desc');

    return result({
      title: rawTitle || rawDesc,
      desc: rawDesc || null,
      videoUrl,
      coverUrl,
      imageList: images,
      author: author(
        at(user, 'nickname') || at(user, 'nickName'),
        at(user, 'userId') || at(user, 'author_id') || at(user, 'id'),
        ensureHttps(stringAt(user, 'avatar')),
      ),
      ...(cookieRequired ? { cookieRequired: true } : {}),
      ...(terminalError ? { terminalError } : {}),
    });
  }
}

function inspectTargetUrl(
  href: string,
): { cookieRequired?: boolean; terminalError?: TerminalErrorDetail } | null {
  if (
    href.includes('xiaohongshu.com/404') &&
    (href.includes('/404/sec_') || href.includes('xhs_sec_server') || href.includes('error_code=300031'))
  ) {
    return {
      cookieRequired: true,
      terminalError: {
        code: 'XIAOHONGSHU_COOKIE_REQUIRED',
        message: '访问被小红书安全风控拦截（当前笔记暂时无法浏览），请更新小红书 Cookie 或稍后重试',
      },
    };
  }
  if (href.includes('xiaohongshu.com/404') || href.includes('undertake_note_error')) {
    return {
      terminalError: {
        code: 'MEDIA_DELETED_OR_PRIVATE',
        message: '该小红书笔记已被作者删除或不存在',
      },
    };
  }
  if (href.includes('xiaohongshu.com/login')) {
    return { cookieRequired: true };
  }
  return null;
}

function isDeletedNoteHtml(html: string): boolean {
  return (
    html.includes('该笔记已被删除') ||
    html.includes('笔记不存在') ||
    html.includes('仅作者可见') ||
    html.includes('已被作者删除')
  );
}

function extractNoteFromHtml(
  html: string,
): { note: unknown; terminalError: TerminalErrorDetail | null } {
  const state = extractXhsInitialState(html);
  const firstNoteId = stringAt(state, 'note', 'firstNoteId');
  if (firstNoteId) {
    const noteItem = record(at(state, 'note', 'noteDetailMap', firstNoteId));
    if (Object.hasOwn(noteItem, 'note')) {
      const candidate = noteItem.note;
      const mapped = record(candidate);
      if (Object.keys(mapped).length > 0) {
        return { note: mapped, terminalError: null };
      }
      if (candidate !== null && typeof candidate === 'object' && !Array.isArray(candidate)) {
        return {
          note: {},
          terminalError: {
            code: 'MEDIA_DELETED_OR_PRIVATE',
            message: '该小红书笔记已被作者删除或设置为私密不可见',
          },
        };
      }
    }
  }

  const mobileNote = record(at(state, 'noteData', 'data', 'noteData'));
  if (Object.keys(mobileNote).length > 0) {
    return { note: mobileNote, terminalError: null };
  }

  const fallbackA = record(at(state, 'noteData', 'note'));
  if (Object.keys(fallbackA).length > 0) {
    return { note: fallbackA, terminalError: null };
  }

  const fallbackB = record(at(state, 'note', 'note'));
  if (Object.keys(fallbackB).length > 0) {
    return { note: fallbackB, terminalError: null };
  }

  return { note: {}, terminalError: null };
}

function extractXhsInitialState(html: string): unknown {
  const marker = 'window.__INITIAL_STATE__';
  const markerIndex = html.indexOf(marker);
  if (markerIndex < 0) return {};
  const start = html.indexOf('{', markerIndex + marker.length);
  if (start < 0) return {};
  const slice = extractBalancedBraces(html, start);
  if (!slice) return {};
  try {
    return parseJson(sanitizeXhsJsLiteral(slice));
  } catch {
    return {};
  }
}

function sanitizeXhsJsLiteral(source: string): string {
  let output = '';
  let quote = '';
  let escaped = false;
  let index = 0;

  while (index < source.length) {
    const ch = source[index] ?? '';
    if (quote) {
      output += ch;
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === quote) quote = '';
      index += 1;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      output += ch;
      index += 1;
      continue;
    }

    if (isIdentifierStart(ch) && (index === 0 || !isIdentifierPart(source[index - 1] ?? ''))) {
      const ident = readIdentifier(source, index);
      if (ident === 'undefined' || ident === 'NaN' || ident === 'Infinity') {
        output += 'null';
        index += ident.length;
        continue;
      }
      if (ident === 'BigInt') {
        const callEnd = skipParenthesizedCall(source, index + ident.length);
        if (callEnd > 0) {
          output += 'null';
          index = callEnd;
          continue;
        }
      }
      if (ident === 'new') {
        const constructorMatch = matchNewExpression(source, index);
        if (constructorMatch) {
          output += constructorMatch.replacement;
          index = constructorMatch.endIndex;
          continue;
        }
      }
      output += ident;
      index += ident.length;
      continue;
    }

    if (ch === '-' && source.slice(index + 1, index + 9) === 'Infinity' && !isIdentifierPart(source[index + 9] ?? '')) {
      output += 'null';
      index += 9;
      continue;
    }

    output += ch;
    index += 1;
  }

  return output;
}

function isIdentifierStart(ch: string): boolean {
  return (ch >= 'a' && ch <= 'z') || (ch >= 'A' && ch <= 'Z') || ch === '_' || ch === '$';
}

function isIdentifierPart(ch: string): boolean {
  return isIdentifierStart(ch) || (ch >= '0' && ch <= '9');
}

function readIdentifier(source: string, start: number): string {
  let end = start;
  while (end < source.length && isIdentifierPart(source[end] ?? '')) end += 1;
  return source.slice(start, end);
}

function matchNewExpression(
  source: string,
  newStart: number,
): { replacement: string; endIndex: number } | null {
  let cursor = newStart + 3;
  while (cursor < source.length && /\s/u.test(source[cursor] ?? '')) cursor += 1;
  if (cursor === newStart + 3) return null;
  const ctor = readIdentifier(source, cursor);
  if (ctor !== 'Map' && ctor !== 'Set' && ctor !== 'Date') return null;
  const callEnd = skipParenthesizedCall(source, cursor + ctor.length);
  if (callEnd < 0) return null;
  const replacement = ctor === 'Map' ? '{}' : ctor === 'Set' ? '[]' : 'null';
  return { replacement, endIndex: callEnd };
}

function skipParenthesizedCall(source: string, fromIndex: number): number {
  let cursor = fromIndex;
  while (cursor < source.length && /\s/u.test(source[cursor] ?? '')) cursor += 1;
  if (source[cursor] !== '(') return -1;
  let depth = 0;
  let quote = '';
  let escaped = false;
  for (let index = cursor; index < source.length; index += 1) {
    const ch = source[index] ?? '';
    if (quote) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === quote) quote = '';
      continue;
    }
    if (ch === '"' || ch === "'") quote = ch;
    else if (ch === '(') depth += 1;
    else if (ch === ')') {
      depth -= 1;
      if (depth === 0) return index + 1;
    }
  }
  return -1;
}

function extractVideoUrl(videoNode: unknown): string | null {
  const video = record(videoNode);
  if (Object.keys(video).length === 0) return null;

  const consumer = record(video.consumer);
  const originKey = stringAt(consumer, 'originVideoKey') ||
    stringAt(consumer, 'origin_video_key') ||
    stringAt(video, 'originVideoKey') ||
    stringAt(video, 'origin_video_key');
  if (originKey) return resolveOriginVideoKey(originKey);

  const mediaV2Raw = stringAt(video, 'mediaV2');
  if (mediaV2Raw) {
    try {
      const mv2 = parseJson(mediaV2Raw);
      const opaque1 = at(mv2, 'video', 'opaque1');
      const hdStream = stringAt(opaque1, 'hd_screencast_stream') ||
        stringAt(opaque1, 'default_screencast_stream');
      if (hdStream) return ensureHttps(hdStream);
      const mv2Consumer = Object.keys(record(at(mv2, 'video', 'consumer'))).length > 0
        ? at(mv2, 'video', 'consumer')
        : at(mv2, 'consumer');
      const mv2Key = stringAt(mv2Consumer, 'originVideoKey') ||
        stringAt(mv2Consumer, 'origin_video_key');
      if (mv2Key) return resolveOriginVideoKey(mv2Key);
    } catch {
      // Fall through to media.stream inspection.
    }
  }

  const stream = Object.keys(record(at(video, 'media', 'stream'))).length > 0
    ? at(video, 'media', 'stream')
    : at(video, 'stream');
  const preferred: string[] = [];
  const clean: string[] = [];
  const fallback: string[] = [];

  for (const codec of ['h264', 'h265', 'av1'] as const) {
    for (const item of array(at(stream, codec))) {
      const rawUrl = stringAt(item, 'masterUrl') || stringAt(item, 'backupUrls', 0);
      if (!rawUrl) continue;
      const cleanUrl = ensureHttps(rawUrl);
      const streamType = numberAt(item, 'streamType', -1);
      const streamDesc = stringAt(item, 'streamDesc');
      if (streamType === 258 || streamType === 301 || streamDesc.includes('X264_MP4')) {
        preferred.push(cleanUrl);
      } else if (streamType !== 259 && streamType !== 309) {
        clean.push(cleanUrl);
      } else {
        fallback.push(cleanUrl);
      }
    }
  }

  return preferred[0] ?? clean[0] ?? fallback[0] ?? null;
}

function resolveOriginVideoKey(originKey: string): string {
  const normalized = ensureHttps(originKey);
  if (normalized.startsWith('https://') || normalized.startsWith('http://')) {
    return normalized;
  }
  return `https://sns-video-bd.xhscdn.com/${normalized.replace(/^\/+/u, '')}`;
}

function extractLivePhotoStreamUrl(image: unknown): string {
  const stream = at(image, 'stream');
  for (const codec of ['h264', 'h265', 'av1'] as const) {
    const rawUrl = stringAt(stream, codec, 0, 'masterUrl') ||
      stringAt(stream, codec, 0, 'backupUrls', 0);
    if (rawUrl) return ensureHttps(rawUrl);
  }
  return '';
}

function cleanImageUrl(imageOrUrl: unknown): string {
  if (!imageOrUrl) return '';
  let rawUrl: string;

  if (typeof imageOrUrl === 'string') {
    rawUrl = imageOrUrl;
  } else {
    const fileId = stringAt(imageOrUrl, 'fileId') || stringAt(imageOrUrl, 'traceId');
    if (fileId) {
      return buildXhsOriginalImageUrl(fileId);
    }
    rawUrl = stringAt(imageOrUrl, 'urlDefault') ||
      stringAt(imageOrUrl, 'urlPre') ||
      stringAt(imageOrUrl, 'url');
    if (!rawUrl) {
      const infoList = array(at(imageOrUrl, 'infoList'));
      const last = infoList.at(-1);
      rawUrl = stringAt(last, 'url') || stringAt(infoList[0], 'url');
    }
  }
  if (!rawUrl) return '';

  const normalized = ensureHttps(rawUrl);
  const extractedToken = extractXhsCdnToken(normalized);
  if (extractedToken) {
    return buildXhsOriginalImageUrl(extractedToken);
  }

  return stripBangStyleSuffix(normalized);
}

function buildXhsOriginalImageUrl(fileId: string): string {
  const cleanId = fileId.replace(/^\/+/u, '');
  return `https://sns-img-qc.xhscdn.com/${cleanId}?imageView2/2/w/1920/format/jpg`;
}

function extractXhsCdnToken(url: string): string {
  try {
    const parsed = new URL(url);
    const segments = parsed.pathname.split('/').filter(Boolean);
    const hexIndex = segments.findIndex((seg) => /^[0-9a-f]{32}$/iu.test(seg));
    if (hexIndex >= 0 && hexIndex + 1 < segments.length) {
      const tail = segments.slice(hexIndex + 1).join('/');
      const bangIndex = tail.indexOf('!');
      const token = bangIndex >= 0 ? tail.slice(0, bangIndex) : tail;
      if (token) return token;
    }
    if (parsed.hostname.endsWith('.xhscdn.com')) {
      const spectrumIndex = segments.indexOf('spectrum');
      if (spectrumIndex >= 0 && spectrumIndex + 1 < segments.length) {
        const tail = segments.slice(spectrumIndex).join('/');
        const bangIndex = tail.indexOf('!');
        const token = bangIndex >= 0 ? tail.slice(0, bangIndex) : tail;
        if (token) return token;
      }
    }
  } catch {
    // Ignore invalid URL formatting.
  }
  return '';
}

function stripBangStyleSuffix(url: string): string {
  const queryIndex = url.indexOf('?');
  const pathPart = queryIndex >= 0 ? url.slice(0, queryIndex) : url;
  const queryPart = queryIndex >= 0 ? url.slice(queryIndex) : '';
  const bangIndex = pathPart.indexOf('!');
  if (bangIndex < 0) return url;
  return `${pathPart.slice(0, bangIndex)}${queryPart}`;
}

function ensureHttps(value: string): string {
  const unescaped = value.replaceAll('\\u002F', '/');
  if (unescaped.startsWith('http://')) return `https://${unescaped.slice(7)}`;
  if (unescaped.startsWith('//')) return `https:${unescaped}`;
  return unescaped;
}

registerParser('xiaohongshu', {
  factory: (context) => new XiaohongshuParser(context),
  allowedHosts: [],
});
