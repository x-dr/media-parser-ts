import { load } from 'cheerio';
import type { ParseContext } from '../core/parse-context.js';
import type { ImageItem } from '../core/media-result.js';
import type { PlatformParser } from '../core/parser.js';
import { registerParser } from '../core/parser-registry.js';
import { DEFAULT_DESKTOP_USER_AGENT, DEFAULT_MOBILE_USER_AGENT } from '../config/user-agents.js';
import { readJson, readJsonp } from '../http/response-reader.js';
import {
  array,
  at,
  author,
  extractBalancedBraces,
  numberAt,
  parseJson,
  protocolUrl,
  record,
  result,
  string,
  stringAt,
  uniqueStrings,
} from './data.js';

const BASE62_ALPHABET = '0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ';

class WeiboParser implements PlatformParser {
  public readonly platform = 'weibo' as const;
  public constructor(private readonly context: ParseContext) {}

  public async parse(): Promise<ReturnType<typeof result>> {
    let targetUrl = this.context.realUrl;
    let videoOid = extractVideoOid(targetUrl);
    let numericId = extractWeiboId(targetUrl);

    if (!videoOid && !numericId && targetUrl.hostname === 't.cn') {
      targetUrl = await this.#resolveShortUrl(targetUrl);
      videoOid = extractVideoOid(targetUrl);
      numericId = extractWeiboId(targetUrl);
    }

    let post: unknown = {};
    if (videoOid) post = await this.#videoPageData(videoOid, targetUrl);
    if (Object.keys(record(post)).length === 0 && numericId) {
      post = await this.#statusData(numericId);
    }

    const videoUrls = extractPostVideos(post);
    const videoUrl = videoUrls[0] ?? '';
    const imageList = extractPostImages(post);
    const rawPostTitle = stringAt(post, 'title');
    const rawBody =
      stringAt(post, 'text_raw') ||
      stringAt(post, 'text') ||
      stringAt(post, 'content') ||
      rawPostTitle;
    const cleanTitle = stripHtml(rawPostTitle) || stripHtml(rawBody);
    const cleanDesc = stripHtml(rawBody);

    const coverCandidate = extractCoverUrl(post, imageList);
    const user = at(post, 'user');

    return result({
      title: cleanTitle,
      desc: cleanDesc || null,
      videoUrl: videoUrl ? protocolUrl(videoUrl) : null,
      videoList: videoUrls.length > 1 ? videoUrls.map(protocolUrl) : [],
      coverUrl: coverCandidate || null,
      imageList,
      author: author(
        at(user, 'screen_name') || at(user, 'screenName') || at(post, 'author'),
        at(user, 'id') || at(user, 'uid') || at(post, 'author_id'),
        protocolUrl(
          stringAt(user, 'avatar_hd') ||
            stringAt(user, 'profile_image_url') ||
            stringAt(user, 'avatar') ||
            stringAt(post, 'avatar'),
        ),
      ),
    });
  }

  async #resolveShortUrl(shortUrl: URL): Promise<URL> {
    try {
      const response = await this.context.session.request(shortUrl, {
        headers: {
          'user-agent': DEFAULT_MOBILE_USER_AGENT,
          referer: 'https://weibo.com/',
        },
        followRedirect: false,
        signal: this.context.signal,
      });
      const rawLocation = response.headers.location;
      const location = Array.isArray(rawLocation) ? rawLocation[0] : rawLocation;
      if (location) return new URL(location, shortUrl);
    } catch {
      // Keep original URL if t.cn redirect fails.
    }
    return shortUrl;
  }

  async #statusData(numericId: string): Promise<unknown> {
    const cookie = this.context.credentials.cookie;

    try {
      const url = new URL('https://m.weibo.cn/statuses/show');
      url.searchParams.set('id', numericId);
      const response = await this.context.session.getJson<unknown>(url, {
        headers: {
          'user-agent': DEFAULT_MOBILE_USER_AGENT,
          accept: 'application/json, text/plain, */*',
          'mweibo-pwa': '1',
          'x-requested-with': 'XMLHttpRequest',
          referer: `https://m.weibo.cn/detail/${numericId}`,
          ...(cookie ? { cookie } : {}),
        },
        signal: this.context.signal,
      });
      if (at(response, 'ok') === 1) return at(response, 'data');
    } catch {
      // Continue through public HTML and PC Ajax fallbacks.
    }

    try {
      const html = await this.context.session.getText(`https://m.weibo.cn/detail/${numericId}`, {
        headers: {
          'user-agent': DEFAULT_MOBILE_USER_AGENT,
          accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          ...(cookie ? { cookie } : {}),
        },
        signal: this.context.signal,
      });
      const renderStatus = extractRenderDataStatus(html);
      if (Object.keys(record(renderStatus)).length > 0) return renderStatus;
    } catch {
      // Continue to PC Ajax fallback.
    }

    const ajaxHeaders = {
      'user-agent': DEFAULT_DESKTOP_USER_AGENT,
      referer: 'https://weibo.com/',
      accept: 'application/json, text/plain, */*',
      ...(cookie ? { cookie } : {}),
    };
    try {
      const pcData = await this.context.session.getJson<unknown>(
        `https://weibo.com/ajax/statuses/show?id=${numericId}`,
        { headers: ajaxHeaders, signal: this.context.signal },
      );
      if (Object.keys(record(pcData)).length > 0 && at(pcData, 'ok') !== -100) {
        return pcData;
      }
    } catch {
      // Try initializing visitor session when unauthenticated PC Ajax fails.
    }

    if (!cookie && (await this.#initVisitorSession())) {
      try {
        return await this.context.session.getJson<unknown>(
          `https://weibo.com/ajax/statuses/show?id=${numericId}`,
          { headers: ajaxHeaders, signal: this.context.signal },
        );
      } catch {
        return {};
      }
    }

    return {};
  }

  async #initVisitorSession(): Promise<boolean> {
    const cookie = this.context.credentials.cookie;
    const headers = {
      'user-agent': DEFAULT_DESKTOP_USER_AGENT,
      referer: 'https://weibo.com/',
      ...(cookie ? { cookie } : {}),
    };
    const fingerprint = JSON.stringify({
      os: '1',
      browser: 'Chrome',
      fonts: 'undefined',
      screenInfo: '1440*900*24',
      plugins: '',
      ls: 'undefined',
      wh: '',
      version: '1.0.0',
      vendor: 'Google Inc.',
      ua: 'Mozilla/5.0',
    });
    try {
      const first = await this.context.session.request(
        'https://passport.weibo.com/visitor/genvisitor',
        {
          searchParams: { cb: 'parser_callback', fp: fingerprint },
          headers,
          signal: this.context.signal,
        },
      );
      const tid = stringAt(readJsonp<unknown>(first), 'data', 'tid');
      if (!tid) return false;
      const visitor = await this.context.session.request(
        'https://passport.weibo.com/visitor/visitor',
        {
          searchParams: {
            a: 'incarnate',
            t: tid,
            w: '2',
            c: '095',
            gc: '',
            cb: 'parser_callback',
            from: 'weibo',
            _rand: Math.random(),
          },
          headers,
          signal: this.context.signal,
        },
      );
      return at(readJsonp<unknown>(visitor), 'retcode') === 20_000_000;
    } catch {
      return false;
    }
  }

  async #videoPageData(videoOid: string, targetUrl: URL): Promise<unknown> {
    const cookie = this.context.credentials.cookie;
    if (!cookie) {
      const ok = await this.#initVisitorSession();
      if (!ok) return {};
    }

    const baseHeaders = {
      'user-agent': DEFAULT_DESKTOP_USER_AGENT,
      referer: targetUrl.href,
      ...(cookie ? { cookie } : {}),
    };

    try {
      const payload = JSON.stringify({ Component_Play_Playinfo: { oid: videoOid } });
      const component = await this.context.session.request('https://weibo.com/tv/api/component', {
        method: 'POST',
        headers: {
          ...baseHeaders,
          'page-referer': targetUrl.pathname,
          'content-type': 'application/x-www-form-urlencoded',
        },
        form: { data: payload },
        signal: this.context.signal,
      });
      const response = readJson<unknown>(component);
      if (at(response, 'code') === '100000') {
        const playInfo = at(response, 'data', 'Component_Play_Playinfo');
        if (Object.keys(record(playInfo)).length > 0) return playInfo;
      }
    } catch {
      // Fall through to live room endpoint when applicable.
    }

    if (videoOid.startsWith('1022:')) {
      try {
        const liveUrl = new URL('https://weibo.com/l/!/2/wblive/room/show_pc_live.json');
        liveUrl.searchParams.set('live_id', videoOid);
        const liveData = await this.context.session.getJson<unknown>(liveUrl, {
          headers: baseHeaders,
          signal: this.context.signal,
        });
        if (numberAt(liveData, 'code', -1) === 100_000 && Object.keys(record(at(liveData, 'data'))).length > 0) {
          return at(liveData, 'data');
        }
      } catch {
        // Ignore live fallback errors.
      }
    }

    return {};
  }
}

function extractRenderDataStatus(html: string): unknown {
  const markerIndex = html.indexOf('$render_data');
  if (markerIndex < 0) return {};
  const openBracket = html.indexOf('[', markerIndex);
  if (openBracket < 0) return {};
  const braceStart = html.indexOf('{', openBracket);
  if (braceStart < 0) return {};
  const objectLiteral = extractBalancedBraces(html, braceStart);
  if (!objectLiteral) return {};
  try {
    return at(parseJson(objectLiteral), 'status');
  } catch {
    return {};
  }
}

function extractPostVideos(post: unknown): string[] {
  const found: string[] = [];

  const liveUrl =
    stringAt(post, 'replay_origin_url') ||
    stringAt(post, 'live_origin_hls_url') ||
    stringAt(post, 'live_origin_flv_url');
  if (liveUrl) found.push(protocolUrl(liveUrl));

  const urlsMap = Object.values(record(at(post, 'urls')))
    .map((value) => string(value))
    .filter(Boolean);
  if (urlsMap[0]) found.push(protocolUrl(urlsMap[0]));

  const primaryMedia = extractMediaInfoVideoUrl(at(post, 'page_info', 'media_info'));
  if (primaryMedia) found.push(protocolUrl(primaryMedia));

  for (const mixItem of array(at(post, 'mix_media_info', 'items'))) {
    if (stringAt(mixItem, 'type') === 'video') {
      const mixVideo = extractMediaInfoVideoUrl(at(mixItem, 'data', 'media_info'));
      if (mixVideo) found.push(protocolUrl(mixVideo));
    }
  }

  return uniqueStrings(found);
}

function extractMediaInfoVideoUrl(media: unknown): string {
  const direct =
    stringAt(media, 'mp4_720p_mp4') ||
    stringAt(media, 'mp4_hd_url') ||
    stringAt(media, 'mp4_sd_url') ||
    stringAt(media, 'stream_url_hd') ||
    stringAt(media, 'stream_url');
  if (direct) return direct;
  for (const playback of array(at(media, 'playback_list'))) {
    const playUrl = stringAt(playback, 'play_info', 'url');
    if (playUrl) return playUrl;
  }
  return '';
}

function extractPostImages(post: unknown): ImageItem[] {
  const pics = array(at(post, 'pics'));
  const livePhotoList = array(at(post, 'live_photo'));

  if (pics.length > 0) {
    const items: ImageItem[] = [];
    for (let index = 0; index < pics.length; index += 1) {
      const picture = pics[index];
      const rawImg =
        stringAt(picture, 'largest', 'url') ||
        stringAt(picture, 'mw2000', 'url') ||
        stringAt(picture, 'large', 'url') ||
        stringAt(picture, 'url');
      const imgUrl = toHdWeiboImageUrl(rawImg);
      if (!imgUrl) continue;

      const rawLive =
        stringAt(picture, 'videoSrc') ||
        stringAt(picture, 'video_hd') ||
        stringAt(picture, 'video') ||
        string(livePhotoList[index]);
      const isLive = stringAt(picture, 'type') === 'livephoto' || Boolean(rawLive);
      if (isLive && rawLive) {
        items.push({ url: imgUrl, livePhotoUrl: protocolUrl(rawLive) });
      } else {
        items.push(imgUrl);
      }
    }
    if (items.length > 0) return dedupeImageItems(items);
  }

  const picInfos = record(at(post, 'pic_infos'));
  const picIds = array(at(post, 'pic_ids')).map((id) => string(id)).filter(Boolean);
  const orderedIds = picIds.length > 0 ? picIds : Object.keys(picInfos);

  if (orderedIds.length > 0 && Object.keys(picInfos).length > 0) {
    const items: ImageItem[] = [];
    for (const picId of orderedIds) {
      const info = picInfos[picId];
      if (!info) continue;
      const rawImg =
        stringAt(info, 'largest', 'url') ||
        stringAt(info, 'mw2000', 'url') ||
        stringAt(info, 'original', 'url') ||
        stringAt(info, 'large', 'url') ||
        stringAt(info, 'bmiddle', 'url') ||
        stringAt(info, 'url');
      const imgUrl = toHdWeiboImageUrl(rawImg);
      if (!imgUrl) continue;

      const rawLive =
        stringAt(info, 'video_hd') ||
        stringAt(info, 'video') ||
        stringAt(info, 'videoSrc');
      const isLive = stringAt(info, 'type') === 'livephoto' || Boolean(rawLive);
      if (isLive && rawLive) {
        items.push({ url: imgUrl, livePhotoUrl: protocolUrl(rawLive) });
      } else {
        items.push(imgUrl);
      }
    }
    if (items.length > 0) return dedupeImageItems(items);
  }

  const mixItems = array(at(post, 'mix_media_info', 'items'));
  if (mixItems.length > 0) {
    const items: ImageItem[] = [];
    for (const mixItem of mixItems) {
      if (stringAt(mixItem, 'type') !== 'pic') continue;
      const data = at(mixItem, 'data');
      const rawImg =
        stringAt(data, 'largest', 'url') ||
        stringAt(data, 'mw2000', 'url') ||
        stringAt(data, 'large', 'url') ||
        stringAt(data, 'url');
      const imgUrl = toHdWeiboImageUrl(rawImg);
      if (!imgUrl) continue;
      const rawLive = stringAt(data, 'video_hd') || stringAt(data, 'video');
      items.push(rawLive ? { url: imgUrl, livePhotoUrl: protocolUrl(rawLive) } : imgUrl);
    }
    if (items.length > 0) return dedupeImageItems(items);
  }

  if (picIds.length > 0) {
    return uniqueStrings(picIds.map((pid) => `https://wx1.sinaimg.cn/osj1080/${pid}.jpg`));
  }

  return [];
}

function dedupeImageItems(items: readonly ImageItem[]): ImageItem[] {
  const seen = new Set<string>();
  const output: ImageItem[] = [];
  for (const item of items) {
    const key = typeof item === 'string' ? item : `${item.url ?? ''}|${item.livePhotoUrl ?? ''}`;
    if (!key || seen.has(key)) continue;
    seen.add(key);
    output.push(item);
  }
  return output;
}

function extractCoverUrl(post: unknown, imageList: readonly ImageItem[]): string {
  const directCover = stringAt(post, 'cover') || stringAt(post, 'cover_image');
  if (directCover) return toHdWeiboImageUrl(directCover);

  const pageInfo = record(at(post, 'page_info'));
  const pageType = string(pageInfo.type);
  if (pageType !== 'topic' && pageType !== 'search' && pageType !== 'place') {
    const pagePic =
      stringAt(pageInfo, 'page_pic', 'url') ||
      (typeof pageInfo.page_pic === 'string' ? pageInfo.page_pic : '');
    if (pagePic) return toHdWeiboImageUrl(pagePic);
  }

  const firstImg = imageList[0];
  if (typeof firstImg === 'string') return firstImg;
  if (firstImg?.url) return firstImg.url;
  return '';
}

function toHdWeiboImageUrl(rawUrl: string): string {
  if (!rawUrl) return '';
  const normalized = protocolUrl(rawUrl.trim());
  const hostMarker = 'sinaimg.cn/';
  const markerIndex = normalized.indexOf(hostMarker);
  if (markerIndex < 0) return normalized;

  const bucketStart = markerIndex + hostMarker.length;
  const nextSlash = normalized.indexOf('/', bucketStart);
  if (nextSlash < 0) return normalized;

  const bucket = normalized.slice(bucketStart, nextSlash);
  if (isWatermarkedSinaBucket(bucket)) {
    return `${normalized.slice(0, bucketStart)}osj1080${normalized.slice(nextSlash)}`;
  }
  return normalized;
}

function isWatermarkedSinaBucket(bucket: string): boolean {
  if (
    bucket === 'large' ||
    bucket === 'bmiddle' ||
    bucket === 'thumbnail' ||
    bucket === 'woriginal'
  ) {
    return true;
  }
  return /^(?:mw|thumb|orj|wap)\d+$/u.test(bucket);
}

function stripHtml(value: string): string {
  return value ? load(value).text().trim() : '';
}

export function extractVideoOid(url: URL): string {
  const fid = url.searchParams.get('fid') ?? '';
  if (/^\d+:[A-Za-z0-9]+$/u.test(fid)) return fid;
  return (
    /\/(?:tv\/|l\/wblive\/p\/)?show\/(\d+:[A-Za-z0-9]+)/u.exec(url.pathname)?.[1] ??
    /\/show\/(\d+:[A-Za-z0-9]+)/u.exec(url.href)?.[1] ??
    ''
  );
}

export function extractWeiboId(url: URL): string {
  const fid = url.searchParams.get('fid') ?? '';
  const fidId = /^\d+:([A-Za-z0-9]+)$/u.exec(fid)?.[1];
  if (fidId) return fidId;

  const videoId =
    /\/(?:tv\/|l\/wblive\/p\/)?show\/\d+:([A-Za-z0-9]+)/u.exec(url.pathname)?.[1] ??
    /\/show\/\d+:([A-Za-z0-9]+)/u.exec(url.href)?.[1];
  if (videoId) return videoId;

  const pathParts = url.pathname.split('/').filter(Boolean);
  let segment = '';
  if (
    (url.hostname.endsWith('weibo.com') || url.hostname.endsWith('weibo.cn')) &&
    pathParts.length >= 2 &&
    /^\d+$/u.test(pathParts[0] ?? '')
  ) {
    if (pathParts[1] === 'detail' || pathParts[1] === 'status') {
      segment = pathParts[2] ?? '';
    } else {
      segment = pathParts[1] ?? '';
    }
  } else if (pathParts[0] === 'status' || pathParts[0] === 'detail') {
    segment = pathParts[1] ?? '';
  }
  segment ||= url.searchParams.get('id') ?? '';
  if (!segment) {
    segment = pathParts.find((part) => /^[A-Za-z0-9]{9}$/u.test(part)) ?? '';
  }
  if (!segment) return '';
  return /^\d+$/u.test(segment) ? segment : midToId(segment);
}

function midToId(mid: string): string {
  const chunks: string[] = [];
  for (let end = mid.length; end > 0; end -= 4) {
    const start = Math.max(0, end - 4);
    const part = mid.slice(start, end);
    let decoded = 0n;
    for (const character of part) {
      const position = BASE62_ALPHABET.indexOf(character);
      if (position < 0) return '';
      decoded = decoded * 62n + BigInt(position);
    }
    chunks.push(start > 0 ? decoded.toString().padStart(7, '0') : decoded.toString());
  }
  return BigInt(chunks.reverse().join('')).toString();
}

registerParser('weibo', {
  factory: (context) => new WeiboParser(context),
  allowedHosts: ['passport.weibo.com'],
});
