import { load } from 'cheerio';
import { DEFAULT_MOBILE_USER_AGENT } from '../config/user-agents.js';
import { ProxyAttemptError, safeErrorDetails } from '../core/errors.js';
import type { MediaResult } from '../core/media-result.js';
import type { ParseContext } from '../core/parse-context.js';
import type { PlatformParser } from '../core/parser.js';
import { registerParser } from '../core/parser-registry.js';
import {
  author,
  extractAssignedJson,
  idAt,
  parseJson,
  protocolUrl,
  record,
  result,
  string,
  unescapeHtml,
  unescapeUnicodeEscapes,
} from './data.js';
import { extractHtmlVideoPage } from './html-video-extractor.js';

type FanqiePlatformId = 'fanqie' | 'hongguo_duanju' | 'hongguo_manju';

const PLAYER_HOST = 'https://hongguoduanju.com';
const PREVIEW_MARK = /[?&]end=\d+/u;
const CONTENT_URL_PATTERN = /"contentUrl"\s*:\s*"(https[^"]+)"/u;
const VIDEO_ID_PATTERN = /"video_id"\s*:\s*"?(\d+)"?/u;
const CHAPTER_ID_PATTERN = /"used_chapter_id"\s*:\s*"?(\d+)"?/u;

const FANQIE_ALLOWED_HOSTS = [
  'hongguoduanju.com',
  'www.hongguoduanju.com',
  '*.hongguoduanju.com',
  'fqnovel.com',
  '*.fqnovel.com',
  'changdunovel.com',
  '*.changdunovel.com',
  'novelquickapp.com',
  '*.novelquickapp.com',
  'qznovel.com',
  '*.qznovel.com',
  'hainanyuyue.com',
  '*.hainanyuyue.com',
] as const;

export class FanqieParser implements PlatformParser {
  public constructor(
    public readonly platform: FanqiePlatformId,
    private readonly context: ParseContext,
  ) {}

  public async parse(): Promise<MediaResult> {
    let html: string;
    try {
      html = await this.context.session.getText(this.context.realUrl, {
        headers: {
          'user-agent': DEFAULT_MOBILE_USER_AGENT,
          accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        },
        signal: this.context.signal,
      });
    } catch (error) {
      if (error instanceof ProxyAttemptError) throw error;
      this.context.logger.error(
        {
          platform_id: this.platform,
          error_category: 'share_html_failed',
          ...safeErrorDetails(error),
        },
        'failed to fetch fanqie/hongguo share HTML',
      );
      return result({});
    }

    const parsed = extractHtmlVideoPage(html);
    const fullVideoUrl = await this.#fetchFullVideoUrl(html, parsed.videoUrl);
    const finalVideoUrl = fullVideoUrl ?? parsed.videoUrl;

    return result({
      title: parsed.title ?? '',
      videoUrl: finalVideoUrl,
      coverUrl: parsed.coverUrl,
      author: author(parsed.author, '', ''),
    });
  }

  async #fetchFullVideoUrl(html: string, shareVideoUrl: string | null): Promise<string | null> {
    if (!html || !shareVideoUrl || !PREVIEW_MARK.test(shareVideoUrl)) {
      return null;
    }

    const ids = extractSeriesAndChapterIds(html);
    if (!ids.seriesId || !ids.chapterId) {
      this.context.logger.warn(
        { platform_id: this.platform, error_category: 'preview_ids_missing' },
        'preview video detected without series/chapter IDs',
      );
      return null;
    }

    const playerUrl = `${PLAYER_HOST}/player/${ids.seriesId}/${ids.chapterId}`;
    let playerHtml: string;
    try {
      playerHtml = await this.context.session.getText(playerUrl, {
        headers: {
          'user-agent': DEFAULT_MOBILE_USER_AGENT,
          accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        },
        signal: this.context.signal,
        timeoutMs: 5_000,
      });
    } catch (error) {
      if (error instanceof ProxyAttemptError) throw error;
      this.context.logger.warn(
        {
          platform_id: this.platform,
          error_category: 'player_html_failed',
          player_url: playerUrl,
          ...safeErrorDetails(error),
        },
        'failed to fetch hongguo full player page',
      );
      return null;
    }

    const extracted = extractPlayerContentUrl(playerHtml);
    if (!extracted) {
      this.context.logger.warn(
        {
          platform_id: this.platform,
          error_category: 'player_content_url_missing',
          player_url: playerUrl,
        },
        'hongguo player page did not contain contentUrl',
      );
      return null;
    }
    return extracted;
  }
}

export function extractSeriesAndChapterIds(html: string): {
  seriesId: string;
  chapterId: string;
} {
  let seriesId = '';
  const schemeParams = extractAssignedJson(html, '"schemeParams"');
  if (Object.keys(record(schemeParams)).length > 0) {
    seriesId = idAt(schemeParams, 'video_id');
  }
  if (!seriesId) {
    seriesId = VIDEO_ID_PATTERN.exec(html)?.[1] ?? '';
  }
  const chapterId = CHAPTER_ID_PATTERN.exec(html)?.[1] ?? '';
  return { seriesId, chapterId };
}

export function extractPlayerContentUrl(playerHtml: string): string | null {
  if (!playerHtml) return null;

  const $ = load(playerHtml);
  let ldJsonUrl = '';
  $('script[type="application/ld+json"]').each((_index, element) => {
    if (ldJsonUrl) return;
    const raw = $(element).text().trim();
    if (!raw) return;
    try {
      const parsed = parseJson(raw);
      ldJsonUrl = findContentUrlInJson(parsed);
    } catch {
      // Fall back to pattern extraction below if JSON-LD contains raw control chars.
    }
  });
  if (ldJsonUrl) {
    const cleaned = cleanMediaUrl(ldJsonUrl);
    if (cleaned) return cleaned;
  }

  const match = CONTENT_URL_PATTERN.exec(playerHtml);
  if (!match?.[1]) return null;
  return cleanMediaUrl(match[1]);
}

function findContentUrlInJson(node: unknown): string {
  if (!node || typeof node !== 'object') return '';
  if (Array.isArray(node)) {
    for (const item of node) {
      const found = findContentUrlInJson(item);
      if (found) return found;
    }
    return '';
  }
  const obj = record(node);
  const direct = string(obj.contentUrl).trim();
  if (direct.startsWith('http://') || direct.startsWith('https://')) {
    return direct;
  }
  for (const child of Object.values(obj)) {
    const found = findContentUrlInJson(child);
    if (found) return found;
  }
  return '';
}

function cleanMediaUrl(raw: string): string | null {
  const cleaned = protocolUrl(unescapeHtml(unescapeUnicodeEscapes(raw)).trim());
  return cleaned || null;
}

const FANQIE_PLATFORM_IDS: readonly FanqiePlatformId[] = [
  'fanqie',
  'hongguo_duanju',
  'hongguo_manju',
];

for (const platformId of FANQIE_PLATFORM_IDS) {
  registerParser(platformId, {
    factory: (context) => new FanqieParser(platformId, context),
    allowedHosts: FANQIE_ALLOWED_HOSTS,
  });
}
