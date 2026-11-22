import { load } from 'cheerio';
import { DEFAULT_DESKTOP_USER_AGENT } from '../config/user-agents.js';
import { ProxyAttemptError, safeErrorDetails } from '../core/errors.js';
import type { MediaResult } from '../core/media-result.js';
import type { ParseContext } from '../core/parse-context.js';
import type { PlatformParser } from '../core/parser.js';
import { registerParser } from '../core/parser-registry.js';
import {
  array,
  at,
  author,
  extractBalancedBraces,
  id,
  parseJson,
  record,
  result,
  string,
  stringAt,
  uniqueStrings,
  type JsonRecord,
} from './data.js';

class HailuoParser implements PlatformParser {
  public readonly platform = 'hailuo' as const;
  public constructor(private readonly context: ParseContext) {}

  public async parse(): Promise<MediaResult> {
    let htmlContent: string;
    try {
      htmlContent = await this.context.session.getText(this.context.realUrl, {
        headers: {
          'user-agent': DEFAULT_DESKTOP_USER_AGENT,
          accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
          'accept-language': 'zh-CN,zh;q=0.9,en;q=0.8',
        },
        followRedirect: true,
        signal: this.context.signal,
      });
    } catch (error) {
      if (error instanceof ProxyAttemptError) throw error;
      this.context.logger.warn(
        {
          platform_id: this.platform,
          error_category: 'upstream_fetch_failed',
          ...safeErrorDetails(error),
        },
        'failed to fetch Hailuo share page',
      );
      return result({});
    }

    if (!htmlContent.trim()) return result({});

    const asset = extractFlightVideoAsset(htmlContent);
    if (asset) {
      return applyVideoAsset(asset);
    }

    const ldVideo = extractLdJsonVideo(htmlContent);
    if (ldVideo) {
      return applyLdVideo(ldVideo);
    }

    return result({});
  }
}

function extractFlightVideoAsset(htmlContent: string): JsonRecord | null {
  const pushMarker = 'self.__next_f.push(';
  let cursor = 0;
  while (cursor < htmlContent.length) {
    const found = htmlContent.indexOf(pushMarker, cursor);
    if (found < 0) break;
    cursor = found + pushMarker.length;
    const quoteIdx = htmlContent.indexOf('"', cursor);
    const closeParenIdx = htmlContent.indexOf(')', cursor);
    if (quoteIdx < 0 || (closeParenIdx >= 0 && quoteIdx > closeParenIdx)) continue;
    const parsedLiteral = readDoubleQuotedJsonString(htmlContent, quoteIdx);
    if (!parsedLiteral) continue;
    cursor = parsedLiteral.endIndex;
    if (!parsedLiteral.value.includes('videoAsset')) continue;

    for (const candidate of [parsedLiteral.value, ...parsedLiteral.value.split('\n')]) {
      const colonIdx = candidate.indexOf(':');
      if (colonIdx < 0) continue;
      const jsonStr = candidate.slice(colonIdx + 1).trim();
      if (!jsonStr) continue;
      try {
        const parsed = parseJson(jsonStr);
        const asset = findKeyInTree(parsed, 'videoAsset', 0);
        if (asset) return asset;
      } catch {
        // Continue trying remaining Flight rows.
      }
    }
  }

  const directIdx = htmlContent.indexOf('"videoAsset"');
  if (directIdx >= 0) {
    const braceStart = htmlContent.indexOf('{', directIdx + '"videoAsset"'.length);
    if (braceStart >= 0 && braceStart - directIdx < 40) {
      const rawObject = extractBalancedBraces(htmlContent, braceStart);
      if (rawObject) {
        try {
          const parsed = record(parseJson(rawObject));
          if (Object.keys(parsed).length > 0) return parsed;
        } catch {
          // Ignore malformed fallback block.
        }
      }
    }
  }

  return null;
}

function readDoubleQuotedJsonString(
  source: string,
  quoteStart: number,
): { value: string; endIndex: number } | null {
  if (source[quoteStart] !== '"') return null;
  let index = quoteStart + 1;
  let escaped = false;
  while (index < source.length) {
    const ch = source[index] ?? '';
    if (escaped) {
      escaped = false;
    } else if (ch === '\\') {
      escaped = true;
    } else if (ch === '"') {
      const rawSlice = source.slice(quoteStart, index + 1);
      try {
        const decoded = parseJson(rawSlice);
        return typeof decoded === 'string' ? { value: decoded, endIndex: index + 1 } : null;
      } catch {
        return null;
      }
    }
    index += 1;
  }
  return null;
}

function findKeyInTree(node: unknown, targetKey: string, depth: number): JsonRecord | null {
  if (depth > 24 || node === null || typeof node !== 'object') return null;
  if (Array.isArray(node)) {
    for (const item of node) {
      const found = findKeyInTree(item, targetKey, depth + 1);
      if (found) return found;
    }
    return null;
  }
  const obj = record(node);
  for (const [key, value] of Object.entries(obj)) {
    if (key === targetKey && value !== null && typeof value === 'object' && !Array.isArray(value)) {
      return record(value);
    }
    const nested = findKeyInTree(value, targetKey, depth + 1);
    if (nested) return nested;
  }
  return null;
}

function applyVideoAsset(asset: JsonRecord): MediaResult {
  const title = string(asset.title);
  const description = string(asset.desc) || null;
  const videoUrlsObj = record(asset.videoURLs);
  const candidateVideo =
    string(videoUrlsObj.downloadURLWithAIWatermark) ||
    string(asset.downloadURL) ||
    string(asset.videoURL) ||
    string(videoUrlsObj.downloadURLWithHailuoWatermark);

  const coverUrl = string(asset.coverURL) || string(asset.promptImgURL) || null;
  const userId = id(asset.userIDStr) || id(asset.userID);
  const imageList = uniqueStrings(
    array(asset.originFiles).map((item) => stringAt(item, 'url') || stringAt(item, 'coverUrl')),
  );

  return result({
    title,
    desc: description,
    videoUrl: candidateVideo || null,
    videoList: candidateVideo ? [candidateVideo] : [],
    coverUrl,
    author: userId ? author('', userId, '') : null,
    imageList,
  });
}

function extractLdJsonVideo(htmlContent: string): JsonRecord | null {
  const $ = load(htmlContent);
  let matched: JsonRecord | null = null;

  $('script[type="application/ld+json"]').each((_index, element) => {
    if (matched) return;
    let raw = ($(element).html() ?? $(element).text()).trim();
    if (!raw) return;

    if (raw.includes('"children"')) {
      const childrenIdx = raw.indexOf('"children"');
      const quoteStart = raw.indexOf('"', childrenIdx + '"children"'.length);
      if (quoteStart >= 0) {
        const unwrapped = readDoubleQuotedJsonString(raw, quoteStart);
        if (unwrapped) raw = unwrapped.value;
      }
    }

    try {
      const parsed = parseJson(raw);
      const graph = Array.isArray(at(parsed, '@graph'))
        ? array(at(parsed, '@graph'))
        : Array.isArray(parsed)
          ? parsed
          : [parsed];
      for (const item of graph) {
        const obj = record(item);
        if (string(obj['@type']) === 'VideoObject') {
          matched = obj;
          return;
        }
      }
    } catch {
      // Ignore malformed JSON-LD blocks.
    }
  });

  return matched;
}

function applyLdVideo(ldVideo: JsonRecord): MediaResult {
  const title = string(ldVideo.name);
  const description = string(ldVideo.description) || null;
  const videoUrl = string(ldVideo.contentUrl) || null;
  const coverUrl = string(ldVideo.thumbnailUrl) || null;
  const authorObj = record(ldVideo.author);
  const authorName = string(authorObj.name).trim();

  return result({
    title,
    desc: description,
    videoUrl,
    videoList: videoUrl ? [videoUrl] : [],
    coverUrl,
    author: author(authorName, '', ''),
  });
}

registerParser('hailuo', {
  factory: (context) => new HailuoParser(context),
  allowedHosts: ['hailuoai.com', 'www.hailuoai.com', 'hailuoai.video', 'www.hailuoai.video'],
});
