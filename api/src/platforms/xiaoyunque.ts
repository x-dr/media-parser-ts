import { ProxyAttemptError, safeErrorDetails } from '../core/errors.js';
import type { MediaResult } from '../core/media-result.js';
import type { ParseContext } from '../core/parse-context.js';
import type { PlatformParser } from '../core/parser.js';
import { registerParser } from '../core/parser-registry.js';
import {
  at,
  author,
  record,
  result,
  string,
  stringAt,
  uniqueStrings,
  type JsonRecord,
} from './data.js';

const LANDING_API =
  'https://xiaoyunque.jianying.com/luckycat/cn/jianying/campaign/v1/pippit/share/landing_page';
const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const KNOWN_PAGE_KEYS = [
  'generate_page',
  'inspiration_page',
  'template_page',
  'share_page',
  'gugu_page',
] as const;

class XiaoyunqueParser implements PlatformParser {
  public readonly platform = 'xiaoyunque' as const;

  public constructor(private readonly context: ParseContext) {}

  public async parse(): Promise<MediaResult> {
    let sourceUrl = this.context.realUrl;
    if (sourceUrl.searchParams.size === 0 && sourceUrl.pathname.includes('/s/')) {
      try {
        const fetchTarget = new URL(sourceUrl.href);
        if (!fetchTarget.pathname.endsWith('/')) {
          fetchTarget.pathname = `${fetchTarget.pathname}/`;
        }
        const response = await this.context.session.request(fetchTarget, {
          headers: { 'user-agent': USER_AGENT },
          followRedirect: true,
          signal: this.context.signal,
          maxBodyBytes: 1024 * 1024,
        });
        sourceUrl = response.url;
      } catch (error) {
        if (error instanceof ProxyAttemptError) throw error;
        this.context.logger.warn(
          {
            platform_id: this.platform,
            error_category: 'xiaoyunque_redirect_failed',
            ...safeErrorDetails(error),
          },
          'xiaoyunque short-link redirect failed',
        );
        return result({});
      }
    }

    if (sourceUrl.searchParams.size === 0) return result({});

    const queryParams = Object.fromEntries(sourceUrl.searchParams.entries());
    let payload: unknown;
    try {
      payload = await this.context.session.getJson<unknown>(LANDING_API, {
        method: 'POST',
        headers: {
          accept: 'application/json, text/plain, */*',
          'user-agent': USER_AGENT,
        },
        json: { query_params: queryParams },
        signal: this.context.signal,
        timeoutMs: 30_000,
      });
    } catch (error) {
      if (error instanceof ProxyAttemptError) throw error;
      this.context.logger.warn(
        {
          platform_id: this.platform,
          error_category: 'xiaoyunque_api_failed',
          ...safeErrorDetails(error),
        },
        'xiaoyunque landing_page request failed',
      );
      return result({});
    }

    if (at(payload, 'err_no') !== 0) return result({});
    return formatXiaoyunqueData(record(at(payload, 'data')));
  }
}

function formatXiaoyunqueData(data: JsonRecord): MediaResult {
  const pageInfo = record(data.page_info);
  const targetPage = selectTargetPage(pageInfo);

  const itemList = Array.isArray(targetPage.item_list) ? targetPage.item_list : [];
  let itemInfo: JsonRecord;
  let userInfo: JsonRecord;

  if (itemList.length > 0) {
    const rawIdx = targetPage.current_index;
    const currIdx =
      typeof rawIdx === 'number' &&
      Number.isInteger(rawIdx) &&
      rawIdx >= 0 &&
      rawIdx < itemList.length
        ? rawIdx
        : 0;
    itemInfo = record(itemList[currIdx]);
    userInfo =
      nonEmptyRecord(itemInfo.author_info) ??
      nonEmptyRecord(itemInfo.user_info) ??
      record(targetPage.user_info);
  } else {
    userInfo =
      nonEmptyRecord(targetPage.user_info) ?? record(targetPage.author_info);
    itemInfo = record(targetPage.item_info);
  }

  const title = string(itemInfo.title);
  const desc = string(itemInfo.desc) || null;
  const imageList = extractImageList(itemInfo.image_info ?? itemInfo.images);
  const videoList = extractVideoList(itemInfo);
  const videoUrl = videoList[0] ?? null;
  const coverUrl = extractCoverUrl(itemInfo);
  const noMediaInContent =
    !videoUrl &&
    imageList.length === 0 &&
    Boolean(title.trim() || desc?.trim());

  return result({
    title,
    desc,
    videoUrl,
    videoList,
    coverUrl: coverUrl || null,
    imageList,
    author: author(
      userInfo.nick_name || userInfo.nickname,
      userInfo.user_id || userInfo.sec_uid,
      userInfo.avatar_url || userInfo.avatar,
    ),
    ...(noMediaInContent ? { noMediaInContent: true } : {}),
  });
}

function selectTargetPage(pageInfo: JsonRecord): JsonRecord {
  for (const key of KNOWN_PAGE_KEYS) {
    const candidate = nonEmptyRecord(pageInfo[key]);
    if (candidate) return candidate;
  }
  for (const val of Object.values(pageInfo)) {
    if (
      isNonEmptyRecord(val) &&
      ('item_info' in val || 'user_info' in val || 'item_list' in val)
    ) {
      return val;
    }
  }
  return {};
}

function extractImageList(rawImageInfo: unknown): string[] {
  if (Array.isArray(rawImageInfo)) {
    return uniqueStrings(
      rawImageInfo.map((img) =>
        typeof img === 'string'
          ? img
          : stringAt(img, 'image_url') || stringAt(img, 'url'),
      ),
    );
  }
  if (isNonEmptyRecord(rawImageInfo)) {
    const single = string(rawImageInfo.image_url) || string(rawImageInfo.url);
    return single ? [single] : [];
  }
  return [];
}

function extractVideoList(itemInfo: JsonRecord): string[] {
  const urls: string[] = [];
  const rawVideoUrl = string(itemInfo.video_url) || string(itemInfo.video_play_url);
  if (rawVideoUrl) urls.push(rawVideoUrl);

  const videoInfo = itemInfo.video_info ?? itemInfo.video;
  if (Array.isArray(videoInfo)) {
    for (const entry of videoInfo) {
      if (typeof entry === 'string') {
        if (entry) urls.push(entry);
      } else {
        const candidate =
          stringAt(entry, 'video_url') ||
          stringAt(entry, 'main_url') ||
          stringAt(entry, 'url');
        if (candidate) urls.push(candidate);
      }
    }
  } else if (isNonEmptyRecord(videoInfo)) {
    const candidate =
      string(videoInfo.main_url) ||
      string(videoInfo.video_url) ||
      string(videoInfo.url);
    if (candidate) urls.push(candidate);
  }
  return uniqueStrings(urls);
}

function extractCoverUrl(itemInfo: JsonRecord): string {
  const direct =
    string(itemInfo.cover_url) || string(itemInfo.poster) || string(itemInfo.cover);
  if (direct) return direct;

  const videoInfo = itemInfo.video_info ?? itemInfo.video;
  if (Array.isArray(videoInfo)) {
    for (const entry of videoInfo) {
      const candidate =
        stringAt(entry, 'cover_url') ||
        stringAt(entry, 'poster') ||
        stringAt(entry, 'cover');
      if (candidate) return candidate;
    }
  } else if (isNonEmptyRecord(videoInfo)) {
    return (
      string(videoInfo.cover_url) ||
      string(videoInfo.poster) ||
      string(videoInfo.cover)
    );
  }
  return '';
}

function isNonEmptyRecord(value: unknown): value is JsonRecord {
  return (
    value !== null &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    Object.keys(value).length > 0
  );
}

function nonEmptyRecord(value: unknown): JsonRecord | null {
  return isNonEmptyRecord(value) ? value : null;
}

registerParser('xiaoyunque', {
  factory: (context) => new XiaoyunqueParser(context),
  allowedHosts: ['xiaoyunque.jianying.com', '*.jianying.com'],
});
