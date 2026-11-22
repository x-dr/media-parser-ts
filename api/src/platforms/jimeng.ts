import { ProxyAttemptError, safeErrorDetails } from '../core/errors.js';
import { hasMedia, type MediaResult } from '../core/media-result.js';
import type { ParseContext } from '../core/parse-context.js';
import type { PlatformParser } from '../core/parser.js';
import { registerParser } from '../core/parser-registry.js';
import {
  at,
  author,
  id,
  number,
  record,
  result,
  string,
  stringAt,
  uniqueStrings,
  type JsonRecord,
} from './data.js';

const ITEM_INFO_API = 'https://jimeng.jianying.com/mweb/v1/get_item_info';
const CAMPAIGN_API =
  'https://jimeng.jianying.com/luckycat/cn/jianying/campaign/v1/dreamina/share/landing_page';
const COMPETITION_PREVIEW_API = 'https://jimeng.jianying.com/competition/v1/preview_video';
const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36';
const ITEM_ID_QUERY_KEYS = [
  'published_item_id',
  'item_id',
  'id',
  'work_id',
  'feed_id',
  'projectId',
] as const;
const HTML_ITEM_ID_PATTERNS = [
  /["']published_item_id["']\s*:\s*["']?(\d{10,25})/u,
  /["']item_id["']\s*:\s*["']?(\d{10,25})/u,
  /["']itemId["']\s*:\s*["']?(\d{10,25})/u,
  /["']work_id["']\s*:\s*["']?(\d{10,25})/u,
  /["']feed_id["']\s*:\s*["']?(\d{10,25})/u,
  /["']id["']\s*:\s*["']?(\d{15,25})/u,
] as const;

class JimengParser implements PlatformParser {
  public readonly platform = 'jimeng' as const;

  public constructor(private readonly context: ParseContext) {}

  public async parse(): Promise<MediaResult> {
    let sourceUrl = this.context.realUrl;
    let itemId = extractJimengItemId(sourceUrl);

    if (!itemId || sourceUrl.pathname.includes('/s/')) {
      try {
        const response = await this.context.session.request(sourceUrl, {
          headers: { 'user-agent': USER_AGENT },
          followRedirect: true,
          signal: this.context.signal,
          maxBodyBytes: 2 * 1024 * 1024,
        });
        sourceUrl = response.url;
        if (!itemId) {
          itemId = extractJimengItemId(sourceUrl);
        }
        if (!itemId && response.body.length > 0) {
          itemId = extractJimengItemIdFromHtml(response.body.toString('utf8'));
        }
      } catch (error) {
        if (error instanceof ProxyAttemptError) throw error;
        this.context.logger.debug(
          {
            platform_id: this.platform,
            error_category: 'jimeng_redirect_failed',
            ...safeErrorDetails(error),
          },
          'jimeng short-link redirect failed',
        );
      }
    }

    if (itemId) {
      try {
        const payload = await this.context.session.getJson<unknown>(ITEM_INFO_API, {
          method: 'POST',
          headers: this.#baseHeaders(),
          json: { published_item_id: itemId },
          signal: this.context.signal,
          timeoutMs: 30_000,
        });
        const ret = id(at(payload, 'ret'));
        if (ret === '0') {
          const detail = record(at(payload, 'data'));
          let formatted = formatOfficialData(detail);
          if (!hasMedia(formatted)) {
            const compVid = string(detail.video_id) || stringAt(detail, 'video', 'video_id');
            if (compVid) {
              const preview = await this.#fetchCompetitionPreview(compVid);
              if (preview) {
                formatted = { ...formatted, ...preview };
              }
            }
          }
          return formatted;
        }

        const errmsg = stringAt(payload, 'errmsg');
        if (errmsg.includes('itemId not exist') || ret === '2032' || ret === '1000') {
          const campaignFallback = await this.#tryCampaignApi(sourceUrl, itemId);
          if (campaignFallback) return campaignFallback;
        }
      } catch (error) {
        if (error instanceof ProxyAttemptError) throw error;
        this.context.logger.debug(
          {
            platform_id: this.platform,
            error_category: 'jimeng_item_info_failed',
            ...safeErrorDetails(error),
          },
          'jimeng get_item_info request failed',
        );
      }
    }

    if (isJimengCampaignUrl(sourceUrl)) {
      const campaignResult = await this.#tryCampaignApi(sourceUrl, itemId);
      if (campaignResult) return campaignResult;
    }

    return result({});
  }

  async #tryCampaignApi(url: URL, itemId: string): Promise<MediaResult | null> {
    const queryParams = Object.fromEntries(url.searchParams.entries());
    const secUid = queryParams.share_sec_uid || queryParams.author_id || '';
    const headers = {
      ...this.#baseHeaders(),
      appid: '581595',
    };
    const body: Record<string, unknown> = {
      query_params: queryParams,
      ...(itemId ? { item_id: itemId } : {}),
      ...(secUid ? { sec_uid: secUid } : {}),
    };

    try {
      let resJson = await this.context.session.getJson<unknown>(CAMPAIGN_API, {
        method: 'POST',
        headers,
        json: body,
        timeoutMs: 30_000,
        signal: this.context.signal,
      });

      if (
        (at(resJson, 'err_no') !== 0 || !isNonEmptyRecord(at(resJson, 'data'))) &&
        itemId &&
        Object.keys(queryParams).length > 0
      ) {
        const retryBody: Record<string, unknown> = {
          query_params: queryParams,
          ...(secUid ? { sec_uid: secUid } : {}),
        };
        resJson = await this.context.session.getJson<unknown>(CAMPAIGN_API, {
          method: 'POST',
          headers,
          json: retryBody,
          timeoutMs: 30_000,
          signal: this.context.signal,
        });
      }

      if (at(resJson, 'err_no') === 0 && isNonEmptyRecord(at(resJson, 'data'))) {
        const formatted = formatCampaignData(record(at(resJson, 'data')));
        if (hasMedia(formatted)) return formatted;
      }
    } catch (error) {
      if (error instanceof ProxyAttemptError) throw error;
      this.context.logger.warn(
        {
          platform_id: this.platform,
          error_category: 'jimeng_campaign_failed',
          ...safeErrorDetails(error),
        },
        'jimeng campaign API parse failed',
      );
    }
    return null;
  }

  async #fetchCompetitionPreview(
    videoId: string,
  ): Promise<{ videoUrl: string | null; videoList: string[] } | null> {
    try {
      const payload = await this.context.session.getJson<unknown>(COMPETITION_PREVIEW_API, {
        method: 'POST',
        headers: this.#baseHeaders(),
        json: { video_id: videoId },
        timeoutMs: 15_000,
        signal: this.context.signal,
      });
      if (id(at(payload, 'ret')) !== '0') return null;
      const preview = record(at(payload, 'data', 'video_preview'));
      if (Object.keys(preview).length === 0) return null;
      const transcoded = record(preview.transcoded_video);
      const rawPrimary =
        stringAt(transcoded, 'origin', 'video_url') ||
        stringAt(preview, 'origin_video', 'video_url') ||
        bestTranscodedUrl(transcoded);
      const primary = sanitizeJimengVideoUrl(rawPrimary);
      const list = uniqueStrings([
        primary,
        ...Object.values(transcoded).map((entry) =>
          sanitizeJimengVideoUrl(stringAt(entry, 'video_url')),
        ),
      ]);
      return primary ? { videoUrl: primary, videoList: list } : null;
    } catch (error) {
      if (error instanceof ProxyAttemptError) throw error;
      return null;
    }
  }

  #baseHeaders(): Record<string, string> {
    const cookie = this.context.credentials.cookie;
    return {
      accept: 'application/json, text/plain, */*',
      'user-agent': USER_AGENT,
      ...(cookie ? { cookie, appid: '581595', 'device-platform': 'web' } : {}),
    };
  }
}

function formatOfficialData(detail: JsonRecord): MediaResult {
  const common = record(detail.common_attr);
  const creator = record(detail.author);
  const video = record(detail.video);
  const transcoded = record(video.transcoded_video);

  const rawPrimaryVideo =
    stringAt(transcoded, 'origin', 'video_url') ||
    stringAt(video, 'origin_video', 'video_url') ||
    bestTranscodedUrl(transcoded);
  const primaryVideo = sanitizeJimengVideoUrl(rawPrimaryVideo);

  const videoList = uniqueStrings([
    primaryVideo,
    ...Object.values(transcoded).map((entry) =>
      sanitizeJimengVideoUrl(stringAt(entry, 'video_url')),
    ),
  ]);

  const coverMap = record(common.cover_url_map);
  const mappedCover =
    ['4096', '2400', '1080', '720', '480', '360', 'original']
      .map((key) => string(coverMap[key]))
      .find(Boolean) ??
    Object.values(coverMap)
      .map((value) => string(value))
      .find(Boolean);
  const coverUrl =
    (mappedCover ?? string(common.cover_url)) || string(video.cover_url) || null;

  const rawImages =
    nonEmptyArray(detail.image_infos) ??
    nonEmptyArray(detail.image_list) ??
    nonEmptyArray(detail.images) ??
    [];
  const parsedImages: string[] = [];
  for (const rawImg of rawImages) {
    if (typeof rawImg === 'string' && rawImg.startsWith('http')) {
      parsedImages.push(rawImg);
      continue;
    }
    const img = record(rawImg);
    const urlMap = nonEmptyRecord(img.image_url_map) ?? record(img.cover_url_map);
    const mappedImg =
      ['original', '4096', '2400', '1080', '720']
        .map((key) => string(urlMap[key]))
        .find(Boolean) ??
      Object.values(urlMap)
        .map((value) => string(value))
        .find(Boolean);
    const finalImg =
      (mappedImg ?? string(img.image_url)) ||
      string(img.url) ||
      string(img.origin_url) ||
      string(img.main_url);
    if (finalImg) parsedImages.push(finalImg);
  }
  let imageList = uniqueStrings(parsedImages);
  if (!primaryVideo && imageList.length === 0 && coverUrl) {
    imageList = [coverUrl];
  }

  return result({
    title: string(common.title),
    desc: string(common.description) || null,
    videoUrl: primaryVideo || null,
    videoList,
    coverUrl,
    imageList,
    author: author(creator.name, creator.uid || creator.sec_uid, creator.avatar_url),
  });
}

function formatCampaignData(data: JsonRecord): MediaResult {
  const pageInfo = record(data.page_info);
  const creation = record(pageInfo.creation);
  const meta = record(creation.metadata);
  const userInfo = nonEmptyRecord(pageInfo.user_info) ?? record(creation.author);
  const downloadInfo = record(meta.download_info);

  const candidates = [
    string(downloadInfo.watermark_ending_url),
    string(meta.video_url) || string(creation.video_url),
    string(downloadInfo.url),
  ];
  const videoList = uniqueStrings(
    candidates
      .filter((entry) => entry.startsWith('http'))
      .map((entry) => sanitizeJimengVideoUrl(entry)),
  );
  const primaryVideo = videoList[0] ?? '';

  const coverUrl =
    string(meta.cover_url) ||
    string(creation.cover_url) ||
    string(pageInfo.cover_url) ||
    null;

  const rawImages =
    nonEmptyArray(creation.image_list) ??
    nonEmptyArray(meta.image_list) ??
    nonEmptyArray(creation.images) ??
    [];
  const parsedImages: string[] = [];
  for (const rawImg of rawImages) {
    if (typeof rawImg === 'string' && rawImg.startsWith('http')) {
      parsedImages.push(rawImg);
    } else {
      const img = record(rawImg);
      const imgUrl = string(img.image_url) || string(img.url) || string(img.origin_url);
      if (imgUrl) parsedImages.push(imgUrl);
    }
  }
  let imageList = uniqueStrings(parsedImages);
  if (!primaryVideo && imageList.length === 0 && coverUrl) {
    imageList = [coverUrl];
  }

  return result({
    title: string(meta.title) || string(creation.prompt) || string(pageInfo.title),
    desc:
      string(meta.description) ||
      string(creation.desc) ||
      string(pageInfo.desc) ||
      null,
    videoUrl: primaryVideo || null,
    videoList,
    coverUrl,
    imageList,
    author: author(
      userInfo.name || userInfo.nickname,
      userInfo.uid || userInfo.sec_uid || userInfo.author_id,
      userInfo.avatar_url || userInfo.avatar,
    ),
  });
}

export function sanitizeJimengVideoUrl(rawUrl: string): string {
  if (!rawUrl) return '';
  const hashIdx = rawUrl.indexOf('#');
  const withoutHash = hashIdx >= 0 ? rawUrl.slice(0, hashIdx) : rawUrl;
  const fragment = hashIdx >= 0 ? rawUrl.slice(hashIdx) : '';

  const qIdx = withoutHash.indexOf('?');
  if (qIdx < 0) return rawUrl;

  const base = withoutHash.slice(0, qIdx);
  const query = withoutHash.slice(qIdx + 1);
  const keptPairs: string[] = [];
  for (const pair of query.split('&')) {
    if (!pair) continue;
    if (pair === 'lr' || pair.startsWith('lr=')) continue;
    keptPairs.push(sanitizeCdWatermarkFlag(pair));
  }
  const rebuilt = keptPairs.length > 0 ? `${base}?${keptPairs.join('&')}` : base;
  return `${rebuilt}${fragment}`;
}

function sanitizeCdWatermarkFlag(pair: string): string {
  if (pair.startsWith('cd=0|0|1|')) {
    const rest = pair.slice('cd=0|0|1|'.length);
    if (/^\d+$/u.test(rest)) {
      return `cd=0|0|0|${rest}`;
    }
  }
  const lower = pair.toLowerCase();
  if (lower.startsWith('cd=0%7c0%7c1%7c')) {
    const sep1 = pair.slice(4, 7);
    const sep2 = pair.slice(8, 11);
    const sep3 = pair.slice(12, 15);
    const rest = pair.slice(15);
    if (/^\d+$/u.test(rest)) {
      return `cd=0${sep1}0${sep2}0${sep3}${rest}`;
    }
  }
  return pair;
}

function extractJimengItemId(url: URL): string {
  for (const key of ITEM_ID_QUERY_KEYS) {
    const value = url.searchParams.get(key);
    if (value && /^\d+$/u.test(value)) return value;
  }
  const parts = url.pathname.split('/').filter(Boolean);
  for (let idx = parts.length - 1; idx >= 0; idx -= 1) {
    const part = parts[idx] ?? '';
    if (part.length >= 10 && /^\d+$/u.test(part)) {
      return part;
    }
  }
  return '';
}

function extractJimengItemIdFromHtml(html: string): string {
  if (!html) return '';
  for (const pattern of HTML_ITEM_ID_PATTERNS) {
    const match = pattern.exec(html);
    if (match?.[1]) return match[1];
  }
  return '';
}

function isJimengCampaignUrl(url: URL): boolean {
  const href = url.href;
  return (
    href.includes('reflux') ||
    href.includes('mproject') ||
    href.includes('share_token') ||
    href.includes('share_campaign_key') ||
    href.includes('act_key') ||
    url.pathname.includes('/activities/') ||
    url.pathname.includes('/campaign/')
  );
}

function bestTranscodedUrl(value: unknown): string {
  let best = { score: 0, bitrate: 0, url: '' };
  for (const entry of Object.values(record(value))) {
    const url = stringAt(entry, 'video_url');
    if (!url) continue;
    const width = number(at(entry, 'width'));
    const height = number(at(entry, 'height'));
    const bitrate = number(at(entry, 'br')) || number(at(entry, 'bitrate'));
    const score = width * height;
    if (score > best.score || (score === best.score && bitrate > best.bitrate)) {
      best = { score, bitrate, url };
    }
  }
  return best.url;
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

function nonEmptyArray(value: unknown): unknown[] | null {
  return Array.isArray(value) && value.length > 0 ? value : null;
}

registerParser('jimeng', {
  factory: (context) => new JimengParser(context),
  allowedHosts: ['jimeng.jianying.com', '*.jianying.com', '*.jimeng.com', '*.jimeng.ai'],
});
