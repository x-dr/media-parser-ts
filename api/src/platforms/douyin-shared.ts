import { Buffer } from 'node:buffer';
import { createHash, randomInt } from 'node:crypto';
import { crc32 } from 'node:zlib';
import { load } from 'cheerio';
import { DEFAULT_MOBILE_USER_AGENT } from '../config/user-agents.js';
import type { PlatformId } from '../config/platforms.js';
import { ProxyAttemptError, safeErrorDetails } from '../core/errors.js';
import type {
  AuthorInfo,
  ImageItem,
  MediaResult,
  SubtitleItem,
  TerminalErrorDetail,
} from '../core/media-result.js';
import type { ParseContext } from '../core/parse-context.js';
import type { PlatformParser } from '../core/parser.js';
import type { HttpSession } from '../http/http-session.js';
import { convertMediaUrlToHttps, getVideoId } from '../http/url-tools.js';
import { LocalByteDanceSigner } from '../signers/bytedance/signer.js';
import {
  array,
  at,
  author,
  extractAssignedJson,
  id,
  number,
  numberAt,
  parseJson,
  record,
  result,
  string,
  stringAt,
  subtitleSec,
  uniqueStrings,
  type JsonRecord,
} from './data.js';

const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36';
const MOBILE_FEED_USER_AGENT =
  'com.ss.android.ugc.aweme/290101 (Linux; U; Android 10; zh_CN; Pixel 4; ' +
  'Build/QQ3A.200805.001; Cronet/TTNetVersion:5f9037be 2023-01-13 QuicVersion:4668bb42 2022-11-21)';
const SHARE_MOBILE_USER_AGENT =
  'Mozilla/5.0 (Linux; Android 8.0.0; SM-G955U Build/R16NW) ' +
  'AppleWebKit/537.36 (KHTML, like Gecko) Chrome/116.0.0.0 Mobile Safari/537.36';
const MOBILE_FEED_ENDPOINTS = [
  'https://api5-normal-c-hl.amemv.com/aweme/v1/feed/',
  'https://aweme.snssdk.com/aweme/v1/feed/',
] as const;
const SECSDK_WEBSIGN_CONST = 'A96D855A08C0A9707F8BEF0D9A527E4E';
const UNDER_REVIEW_MAX_AGE_SEC = 7200;
const UNDER_REVIEW_MESSAGE = '该作品刚发布，正在抖音审核中，暂时无法查看，请几分钟后重试';
const TERMINAL_KEYWORDS = ['已删除', '不存在', '私密', '权限', '无法查看', '不见了'] as const;
const CHINESE_SUBTITLE_LANGS = new Set(['zh-Hans', 'zh', 'zh-CN', 'cmn-Hans']);

const signer = new LocalByteDanceSigner();

export interface DouyinRouteFlags {
  awemeId: string;
  epId: string;
  albumId: string;
  hasExplicitAlbumId: boolean;
  isMusic: boolean;
  isCollection: boolean;
  isLvdetail: boolean;
  isNote: boolean;
}

export interface DouyinSsrOptions {
  awemeId: string;
  isMusic: boolean;
  isLvdetail: boolean;
}

export interface BytedanceVodResult {
  videoUrl: string;
  videoList: string[];
  coverUrl: string;
}

export interface BytedanceVodInput {
  playAuthTokenV2?: string;
  playUrlList?: unknown;
  videoId?: string;
}

interface RankedVideoStream {
  urls: string[];
  isH265: boolean;
  pixels: number;
  bitRate: number;
  dataSize: number;
  qualityType: number;
  hasWeba: number;
  isDirect: number;
}

export class DouyinSharedParser implements PlatformParser {
  #cachedTtwid: string | null = null;
  #terminalError: TerminalErrorDetail | null = null;

  public constructor(
    public readonly platform: PlatformId,
    private readonly context: ParseContext,
  ) {}

  public async parse(): Promise<MediaResult> {
    const flags = inspectDouyinRoute(this.context.realUrl);
    if (!flags.awemeId && !flags.epId && !flags.albumId) {
      return result({});
    }

    const payload = await this.#fetchPayload(flags);
    if (!payload || Object.keys(record(payload)).length === 0) {
      return result({
        ...(this.#terminalError ? { terminalError: this.#terminalError } : {}),
      });
    }

    if (flags.isMusic) {
      return this.#buildMusicResult(payload);
    }

    const { videoUrl, videoList } = extractDouyinVideos(payload, flags);
    const imageList = extractDouyinImages(payload, flags);
    const title = extractDouyinTitle(payload, flags, this.context.realUrl);
    const desc = extractDouyinDescription(payload);
    const coverUrl = extractDouyinCover(payload, flags, imageList);
    const audioUrl = extractDouyinAudio(payload, flags, videoUrl, imageList);
    const authorInfo = extractDouyinAuthor(payload, flags);
    const subtitles = await this.#fetchSubtitles(payload, flags);

    return result({
      title,
      desc,
      videoUrl: videoUrl || null,
      videoList,
      audioUrl: audioUrl || null,
      coverUrl: coverUrl || null,
      imageList,
      author: authorInfo,
      subtitles,
    });
  }

  async #fetchPayload(flags: DouyinRouteFlags): Promise<unknown> {
    if (flags.isMusic) {
      const apiData = await this.#requestWebApi(
        'https://www.douyin.com/aweme/v1/web/music/detail/',
        {
          music_id: flags.awemeId,
          device_platform: 'webapp',
          aid: '6383',
          channel: 'channel_pc_web',
        },
        `https://www.douyin.com/music/${flags.awemeId}`,
        flags.awemeId,
        false,
        (data) => isNonEmptyRecord(at(data, 'music_info')),
      );
      if (apiData) return apiData;
      if (this.#terminalError) return null;
      return this.#fetchSsrFallback(flags);
    }

    if (flags.isCollection) {
      const apiData = await this.#requestWebApi(
        'https://www.douyin.com/aweme/v1/web/mix/aweme/',
        {
          mix_id: flags.awemeId,
          cursor: '0',
          count: '20',
          device_platform: 'webapp',
          aid: '6383',
          channel: 'channel_pc_web',
        },
        `https://www.douyin.com/collection/${flags.awemeId}`,
        flags.awemeId,
        false,
        (data) => array(at(data, 'aweme_list')).length > 0 || isNonEmptyRecord(at(data, 'mix_info')),
      );
      if (apiData) {
        const mapped = { ...record(apiData) };
        const awemeList = array(mapped.aweme_list);
        if (!isNonEmptyRecord(mapped.aweme_detail) && awemeList.length > 0) {
          mapped.aweme_detail = awemeList[0];
        }
        return mapped;
      }
      if (this.#terminalError) return null;
      return this.#fetchSsrFallback(flags);
    }

    if (flags.isLvdetail) {
      const epId = flags.epId || flags.awemeId;
      const albumId = flags.albumId || flags.awemeId;
      const isPlayletUrl = this.context.realUrl.href.includes('playlet');
      const referer = isPlayletUrl
        ? `https://www.douyin.com/share/playlet/detail/${albumId}`
        : `https://www.douyin.com/lvdetail/${epId}`;

      const candidates: { endpoint: string; params: Record<string, string> }[] = [];
      if (flags.hasExplicitAlbumId && albumId) {
        candidates.push({
          endpoint: 'https://www.douyin.com/aweme/v1/web/series/aweme/',
          params: {
            series_id: albumId,
            cursor: '0',
            count: '20',
            device_platform: 'webapp',
            aid: '6383',
            channel: 'channel_pc_web',
          },
        });
      }
      if (epId && (!flags.hasExplicitAlbumId || epId !== albumId)) {
        candidates.push({
          endpoint: 'https://www.douyin.com/aweme/v1/web/lvideo/aweme/',
          params: {
            episode_id: epId,
            device_platform: 'webapp',
            aid: '6383',
            channel: 'channel_pc_web',
          },
        });
      }
      if (!flags.hasExplicitAlbumId && albumId) {
        candidates.push({
          endpoint: 'https://www.douyin.com/aweme/v1/web/series/aweme/',
          params: {
            series_id: albumId,
            cursor: '0',
            count: '20',
            device_platform: 'webapp',
            aid: '6383',
            channel: 'channel_pc_web',
          },
        });
      }

      for (const candidate of candidates) {
        const apiData = await this.#requestWebApi(
          candidate.endpoint,
          candidate.params,
          referer,
          epId || albumId,
          true,
          isValidLvdetailPayload,
        );
        if (apiData) return apiData;
        if (this.#terminalError) return null;
      }
      return this.#fetchSsrFallback(flags);
    }

    const pageType = flags.isNote ? 'note' : 'video';
    const webDetail = await this.#requestWebApi(
      'https://www.douyin.com/aweme/v1/web/aweme/detail/',
      {
        device_platform: 'webapp',
        aid: '6383',
        channel: 'channel_pc_web',
        pc_client_type: '1',
        version_code: '190500',
        version_name: '19.5.0',
        aweme_id: flags.awemeId,
      },
      `https://www.douyin.com/${pageType}/${flags.awemeId}?previous_page=web_code_link`,
      flags.awemeId,
      false,
      (data) => isNonEmptyRecord(at(data, 'aweme_detail')),
    );
    if (webDetail) return webDetail;
    if (this.#terminalError) return null;

    const ssrDetail = await this.#fetchSsrFallback(flags);
    if (ssrDetail) return ssrDetail;

    if (!flags.isNote) {
      const mobileDetail = await this.#requestMobileFeed(flags.awemeId);
      if (mobileDetail) return mobileDetail;
    }

    return null;
  }

  async #requestWebApi(
    endpoint: string,
    params: Record<string, string>,
    referer: string,
    targetId: string,
    isLvdetail: boolean,
    validate: (data: unknown) => boolean,
  ): Promise<unknown> {
    const rawCookie = this.context.credentials.cookie;
    const uifid = extractDouyinUifid(rawCookie, this.context.credentials.uifid);

    for (let attempt = 1; attempt <= 2; attempt += 1) {
      try {
        const ttwid = await this.#getTtwid();
        const url = new URL(endpoint);
        for (const [key, value] of Object.entries(params)) {
          url.searchParams.set(key, value);
        }
        url.searchParams.set('msToken', signer.getMsToken());
        url.searchParams.set('a_bogus', signer.getABogus(url, USER_AGENT));

        const signedHref = uifid ? signDouyinSecsdk(url.href, uifid) : url.href;
        const cookieHeader = buildDouyinCookieHeader(rawCookie, ttwid, isLvdetail);

        const payload = await this.context.session.getJson<unknown>(signedHref, {
          headers: {
            accept: 'application/json, text/plain, */*',
            'sec-ch-ua': '"Google Chrome";v="123", "Not:A-Brand";v="8", "Chromium";v="123"',
            'sec-ch-ua-mobile': '?0',
            'sec-ch-ua-platform': '"Windows"',
            'sec-fetch-site': 'same-origin',
            'sec-fetch-mode': 'cors',
            'sec-fetch-dest': 'empty',
            'accept-language': 'zh-CN,zh;q=0.9,en;q=0.8',
            referer,
            ...(cookieHeader ? { cookie: cookieHeader } : {}),
            ...(uifid ? { uifid } : {}),
            'user-agent': USER_AGENT,
          },
          signal: this.context.signal,
        });

        if (validate(payload)) {
          return payload;
        }

        const terminal = detectDouyinTerminalError(payload, targetId);
        if (terminal) {
          this.#terminalError = terminal;
          return null;
        }
      } catch (error) {
        if (error instanceof ProxyAttemptError) throw error;
        this.context.logger.warn(
          {
            platform_id: this.platform,
            attempt,
            error_category: 'upstream_attempt_failed',
            ...safeErrorDetails(error),
          },
          'douyin detail attempt failed',
        );
      }
    }
    return null;
  }

  async #fetchSsrFallback(flags: DouyinRouteFlags): Promise<unknown> {
    const rawCookie = this.context.credentials.cookie;
    const uifid = extractDouyinUifid(rawCookie, this.context.credentials.uifid);
    const ttwid = await this.#getTtwid();
    const cookieHeader = buildDouyinCookieHeader(rawCookie, ttwid, flags.isLvdetail);

    const targets = buildSsrCandidateUrls(this.context.realUrl, flags);
    for (const target of targets) {
      try {
        const html = await this.context.session.getText(target.url, {
          headers: {
            accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
            'accept-language': 'zh-CN,zh;q=0.9,en;q=0.8',
            'user-agent': target.mobileUa ? SHARE_MOBILE_USER_AGENT : USER_AGENT,
            referer: target.mobileUa
              ? 'https://www.douyin.com/?is_from_mobile_home=1&recommend=1'
              : 'https://www.douyin.com/',
            ...(cookieHeader ? { cookie: cookieHeader } : {}),
            ...(uifid ? { uifid } : {}),
          },
          followRedirect: true,
          signal: this.context.signal,
        });
        const parsed = parseDouyinSsrHtml(html, {
          awemeId: flags.awemeId,
          isMusic: flags.isMusic,
          isLvdetail: flags.isLvdetail,
        });
        if (parsed) return parsed;
      } catch (error) {
        if (error instanceof ProxyAttemptError) throw error;
        this.context.logger.debug(
          {
            platform_id: this.platform,
            error_category: 'ssr_fallback_failed',
            ...safeErrorDetails(error),
          },
          'douyin SSR fallback request failed',
        );
      }
    }
    return null;
  }

  async #requestMobileFeed(awemeId: string): Promise<unknown> {
    if (!awemeId) return null;
    for (const endpoint of MOBILE_FEED_ENDPOINTS) {
      try {
        const payload = await this.context.session.getJson<unknown>(endpoint, {
          searchParams: { aweme_id: awemeId, aid: '1128' },
          headers: {
            'user-agent': MOBILE_FEED_USER_AGENT,
            accept: 'application/json, text/plain, */*',
          },
          timeoutMs: 4_000,
          signal: this.context.signal,
        });
        const matched = array(at(payload, 'aweme_list')).find(
          (item) => (id(at(item, 'aweme_id')) || id(at(item, 'id'))) === awemeId,
        );
        if (matched && isNonEmptyRecord(matched)) {
          return { aweme_detail: matched };
        }
      } catch (error) {
        if (error instanceof ProxyAttemptError) throw error;
        this.context.logger.debug(
          {
            platform_id: this.platform,
            error_category: 'mobile_feed_failed',
            ...safeErrorDetails(error),
          },
          'douyin mobile feed fallback failed',
        );
      }
    }
    return null;
  }

  async #fetchSubtitles(payload: unknown, flags: DouyinRouteFlags): Promise<SubtitleItem[] | null> {
    if (flags.isMusic) return null;
    const subUrl = findDouyinSubtitleUrl(payload, flags);
    if (!subUrl) return null;
    const httpsSubUrl = convertMediaUrlToHttps(subUrl);
    if (!httpsSubUrl) return null;

    try {
      const vttText = await this.context.session.getText(httpsSubUrl, {
        headers: { 'user-agent': USER_AGENT },
        timeoutMs: 5_000,
        signal: this.context.signal,
      });
      return parseWebVttSubtitles(vttText);
    } catch (error) {
      if (error instanceof ProxyAttemptError) throw error;
      this.context.logger.debug(
        {
          platform_id: this.platform,
          error_category: 'subtitle_fetch_failed',
          ...safeErrorDetails(error),
        },
        'failed to fetch Douyin subtitle track',
      );
      return null;
    }
  }

  #buildMusicResult(payload: unknown): MediaResult {
    const musicInfo = record(at(payload, 'music_info'));
    const title = string(musicInfo.title);
    const audioUrl = stringAt(musicInfo, 'play_url', 'url_list', 0) || null;
    let coverUrl: string | null = null;
    for (const key of ['cover_large', 'cover_hd', 'cover_medium', 'cover_thumb']) {
      const candidate = stringAt(musicInfo, key, 'url_list', 0);
      if (candidate) {
        coverUrl = candidate;
        break;
      }
    }
    const avatar =
      stringAt(musicInfo, 'avatar_large', 'url_list', 0) ||
      stringAt(musicInfo, 'avatar_medium', 'url_list', 0);
    const authorInfo = author(
      musicInfo.author || musicInfo.owner_nickname,
      musicInfo.owner_id || musicInfo.sec_uid,
      avatar,
    );
    return result({
      title,
      audioUrl,
      coverUrl,
      author: authorInfo,
    });
  }

  async #getTtwid(): Promise<string> {
    if (this.#cachedTtwid !== null) return this.#cachedTtwid;
    try {
      const response = await this.context.session.request(
        'https://ttwid.bytedance.com/ttwid/union/register/',
        {
          method: 'POST',
          json: {
            region: 'cn',
            aid: 6383,
            need_t: 1,
            service: 'www.douyin.com',
            migrate_priority: 0,
            cb_url_protocol: 'https',
            domain: '.douyin.com',
          },
          signal: this.context.signal,
          maxBodyBytes: 1024 * 1024,
        },
      );
      const cookies = response.headers['set-cookie'];
      const values = Array.isArray(cookies) ? cookies : cookies ? [cookies] : [];
      for (const value of values) {
        const match = /(?:^|;\s*)ttwid=([^;]+)/u.exec(value);
        if (match?.[1]) {
          this.#cachedTtwid = match[1];
          return match[1];
        }
      }
    } catch (error) {
      if (error instanceof ProxyAttemptError) throw error;
      this.context.logger.debug(
        {
          platform_id: this.platform,
          error_category: 'ttwid_register_failed',
          ...safeErrorDetails(error),
        },
        'douyin ttwid registration failed',
      );
    }
    this.#cachedTtwid = '';
    return '';
  }
}

export function inspectDouyinRoute(url: URL): DouyinRouteFlags {
  const pathname = url.pathname;
  const href = url.href;
  const isMusic = pathname.includes('/music/') || pathname.includes('/share/music/');
  const isCollection = pathname.includes('/collection/') || pathname.includes('/mix/');
  const isLvdetail =
    pathname.includes('/lvdetail/') ||
    pathname.includes('/playlet/') ||
    url.searchParams.has('ep_id') ||
    url.searchParams.has('episode_id') ||
    url.searchParams.has('album_id') ||
    url.searchParams.has('playlet_id') ||
    url.searchParams.has('series_id');
  const isNote = pathname.includes('/note/') || pathname.includes('/slides/');
  const awemeId = getVideoId(url);
  let epId = url.searchParams.get('ep_id') ?? url.searchParams.get('episode_id') ?? '';
  let albumId =
    url.searchParams.get('album_id') ??
    url.searchParams.get('playlet_id') ??
    url.searchParams.get('series_id') ??
    '';
  if (!albumId) {
    const playletMatch = /\/playlet\/detail\/(\d+)/u.exec(href);
    if (playletMatch?.[1]) {
      albumId = playletMatch[1];
    }
  }
  const hasExplicitAlbumId = Boolean(albumId);
  if (isLvdetail && !epId && awemeId && !albumId) {
    epId = awemeId;
  }
  return {
    awemeId,
    epId,
    albumId,
    hasExplicitAlbumId,
    isMusic,
    isCollection,
    isLvdetail,
    isNote,
  };
}

export function extractDouyinUifid(
  rawCookie: string | undefined,
  explicitUifid?: string,
): string {
  if (explicitUifid) {
    const trimmed = stripOuterQuotes(explicitUifid.trim());
    if (trimmed) return trimmed;
  }
  if (!rawCookie) return '';
  const stripped = stripOuterQuotes(rawCookie.trim());
  if (!stripped.includes('=') && stripped.length >= 32) {
    return stripped;
  }
  for (const item of rawCookie.split(';')) {
    const eqIdx = item.indexOf('=');
    if (eqIdx <= 0) continue;
    const key = stripOuterQuotes(item.slice(0, eqIdx).trim());
    const val = stripOuterQuotes(item.slice(eqIdx + 1).trim());
    if (key.toUpperCase() === 'UIFID' && val) {
      return val;
    }
  }
  return '';
}

export function buildDouyinCookieHeader(
  rawCookie: string | undefined,
  ttwid: string,
  isLvdetail = false,
): string {
  const parts: string[] = [];
  const seen = new Set<string>();
  if (rawCookie) {
    for (const item of rawCookie.split(';')) {
      const eqIdx = item.indexOf('=');
      if (eqIdx <= 0) continue;
      const key = stripOuterQuotes(item.slice(0, eqIdx).trim());
      const val = stripOuterQuotes(item.slice(eqIdx + 1).trim());
      if (!key) continue;
      if (key === '__ac_nonce' || key === '__ac_signature') continue;
      if (
        key.startsWith('bd_ticket_guard') ||
        key.startsWith('__security') ||
        key.startsWith('fpk') ||
        key === '_bd_ticket_crypt_cookie' ||
        key === 'x_tt_token' ||
        key === 'sdk_source_info'
      ) {
        continue;
      }
      if (key === 's_v_web_id' && val.startsWith('verify_') && !isLvdetail) {
        continue;
      }
      if (!seen.has(key)) {
        parts.push(`${key}=${val}`);
        seen.add(key);
      }
    }
  }
  if (ttwid && !seen.has('ttwid')) {
    parts.push(`ttwid=${ttwid}`);
    seen.add('ttwid');
  }
  return parts.join('; ');
}

export function signDouyinSecsdk(
  rawUrl: string,
  uifid: string,
  timestampSec?: number,
): string {
  if (!uifid) return rawUrl;
  const ts = timestampSec ?? Math.floor(Date.now() / 1000);
  const qIdx = rawUrl.indexOf('?');
  const base = qIdx >= 0 ? rawUrl.slice(0, qIdx) : rawUrl;
  const query = qIdx >= 0 ? rawUrl.slice(qIdx + 1) : '';

  const parts: string[] = [];
  const names = new Set<string>();
  for (const pair of query.split('&')) {
    if (!pair) continue;
    const eqIdx = pair.indexOf('=');
    const rawKey = eqIdx >= 0 ? pair.slice(0, eqIdx) : pair;
    const rawVal = eqIdx >= 0 ? pair.slice(eqIdx + 1) : '';
    const key = unquotePlus(rawKey);
    const val = unquotePlus(rawVal);
    parts.push(`${key}=${encodeURIComponent(val)}`);
    names.add(key);
  }
  if (!names.has('uifid')) {
    parts.push(`uifid=${encodeURIComponent(uifid)}`);
  }
  const canon = parts.join('&');
  const signedQuery = canon ? `${canon}&timestamp=${ts}` : `timestamp=${ts}`;
  const plain = `${uifid}_${ts}_${SECSDK_WEBSIGN_CONST}_${signedQuery}`;
  const signature = createHash('md5').update(plain, 'utf8').digest('hex');
  return `${base}?${signedQuery}&x-secsdk-web-signature=${signature}`;
}

export function buildPlayEndpointUrl(videoId: string, ratio = '1080p'): string {
  const cleanVid = videoId.trim();
  if (!cleanVid || cleanVid.toLowerCase().startsWith('http') || cleanVid.toLowerCase().includes('mp3')) {
    return cleanVid;
  }
  const cleanRatio = ratio.trim() || 'default';
  return (
    `https://www.iesdouyin.com/aweme/v1/play/` +
    `?video_id=${encodeURIComponent(cleanVid)}&ratio=${encodeURIComponent(cleanRatio)}&line=0` +
    `&is_play_url=1&watermark=0&source=PackSourceEnum_PUBLISH`
  );
}

export function sanitizeDouyinPlayUrl(rawUrl: string): string {
  const trimmed = rawUrl.trim();
  if (!trimmed) return '';
  const wasPlaywm = trimmed.includes('/playwm/');
  let cleaned = wasPlaywm ? trimmed.replaceAll('/playwm/', '/play/') : trimmed;
  if (cleaned.includes('ratio=720p')) {
    cleaned = cleaned.replaceAll('ratio=720p', 'ratio=1080p');
  }
  if (wasPlaywm) {
    try {
      const parsed = new URL(cleaned);
      if (!parsed.searchParams.has('ratio')) {
        parsed.searchParams.set('ratio', '1080p');
      }
      if (!parsed.searchParams.has('line')) {
        parsed.searchParams.set('line', '0');
      }
      return parsed.href;
    } catch {
      return cleaned;
    }
  }
  return cleaned;
}

export function parseDouyinSsrHtml(html: string, options: DouyinSsrOptions): JsonRecord | null {
  if (!html.trim()) return null;
  const $ = load(html);

  const universalRaw = $('script#__UNIVERSAL_DATA_FOR_REHYDRATION__').first().text().trim();
  if (universalRaw) {
    const extracted = extractSsrEntityFromJsonText(universalRaw, options, false);
    if (extracted) return extracted;
  }

  const renderRaw = $('script#RENDER_DATA').first().text().trim();
  if (renderRaw) {
    const extracted = extractSsrEntityFromJsonText(renderRaw, options, true);
    if (extracted) return extracted;
  }

  for (const marker of ['_ROUTER_DATA', '_SSR_DATA', '__INIT_PROPS__']) {
    const rawJson = extractAssignedJson(html, marker);
    if (isNonEmptyRecord(rawJson)) {
      const mapped = mapSsrRoot(rawJson, options);
      if (mapped) return mapped;
    }
  }

  for (const chunk of extractPaceChunks(html)) {
    if (!chunk.includes('defaultAwemeInfo') && !chunk.includes('lvideoBrief')) continue;
    const colonIdx = chunk.indexOf(':');
    if (colonIdx < 0) continue;
    const jsonPart = chunk
      .slice(colonIdx + 1)
      .replace(/:\s*"\$undefined"/gu, ': null')
      .replace(/:\s*"\$L[0-9a-zA-Z_]+"/gu, ': null');
    try {
      const parsedArr = parseJson(jsonPart);
      if (Array.isArray(parsedArr) && parsedArr.length >= 4 && isNonEmptyRecord(parsedArr[3])) {
        const awemeInfo = record(at(parsedArr[3], 'defaultAwemeInfo'));
        if (Object.keys(awemeInfo).length > 0) {
          const albumInfo =
            nonEmptyRecord(at(awemeInfo, 'lvideoBrief', 'albumInfo')) ??
            nonEmptyRecord(at(awemeInfo, 'lvideo_brief', 'album_info'));
          const epInfo =
            nonEmptyRecord(at(awemeInfo, 'lvideoBrief', 'episodeInfo')) ??
            nonEmptyRecord(at(awemeInfo, 'lvideo_brief', 'episode_info')) ??
            awemeInfo;
          return {
            aweme_detail: awemeInfo,
            ...(albumInfo ? { album_info: albumInfo } : {}),
            episode_info: epInfo,
          };
        }
      }
    } catch {
      // Ignore malformed streaming chunks.
    }
  }

  return null;
}

export function parseWebVttSubtitles(vttText: string): SubtitleItem[] | null {
  if (!vttText.trim()) return null;
  const segments: SubtitleItem[] = [];
  let currentStart: number | undefined;
  let currentEnd: number | undefined;
  let currentLines: string[] = [];

  const flush = (): void => {
    if (currentStart !== undefined && currentLines.length > 0) {
      const joined = currentLines.map((line) => line.trim()).filter(Boolean).join(' ');
      const cleaned = stripVttTags(joined).trim();
      if (cleaned) {
        segments.push(subtitleSec(cleaned, currentStart, currentEnd));
      }
    }
    currentStart = undefined;
    currentEnd = undefined;
    currentLines = [];
  };

  for (const rawLine of vttText.split(/\r?\n/u)) {
    const stripped = rawLine.trim();
    if (!stripped) {
      flush();
      continue;
    }
    if (
      stripped.startsWith('WEBVTT') ||
      stripped.startsWith('NOTE') ||
      stripped.startsWith('STYLE')
    ) {
      continue;
    }
    const cue = parseVttCueHeader(stripped);
    if (cue) {
      flush();
      currentStart = cue.startSec;
      currentEnd = cue.endSec;
      currentLines = [];
    } else if (currentStart !== undefined) {
      currentLines.push(stripped);
    }
  }
  flush();
  return segments.length > 0 ? segments : null;
}

export async function resolveBytedanceVod(
  session: HttpSession,
  signal: AbortSignal,
  input: BytedanceVodInput,
): Promise<BytedanceVodResult> {
  const resultState: BytedanceVodResult = { videoUrl: '', videoList: [], coverUrl: '' };

  if (input.playAuthTokenV2) {
    try {
      const decoded = Buffer.from(input.playAuthTokenV2, 'base64').toString('utf8');
      const tokenObj = record(parseJson(decoded));
      const queryStr = string(tokenObj.GetPlayInfoToken);
      if (queryStr) {
        const vodUrl = `https://vod.bytedanceapi.com/?${queryStr}`;
        const vodResp = await session.getJson<unknown>(vodUrl, {
          timeoutMs: 5_000,
          signal,
        });
        const vodData = record(at(vodResp, 'Result', 'Data'));
        resultState.coverUrl = string(vodData.CoverUrl);
        const ranked = array(vodData.PlayInfoList)
          .map((entry) => ({
            bitrate: numberAt(entry, 'Bitrate'),
            url: decodeVodStreamUrl(
              stringAt(entry, 'MainPlayUrl') || stringAt(entry, 'BackupPlayUrl'),
            ),
          }))
          .filter((item) => Boolean(item.url))
          .sort((left, right) => right.bitrate - left.bitrate);
        if (ranked[0]) {
          resultState.videoUrl = ranked[0].url;
          resultState.videoList = [ranked[0].url];
          return resultState;
        }
      }
    } catch (error) {
      if (error instanceof ProxyAttemptError) throw error;
    }
  }

  for (const item of array(input.playUrlList)) {
    const candidate = decodeVodStreamUrl(
      stringAt(item, 'mainUrl') ||
        stringAt(item, 'backupUrl') ||
        stringAt(item, 'main_url') ||
        stringAt(item, 'backup_url_1'),
    );
    if (candidate) {
      resultState.videoUrl = candidate;
      resultState.videoList = [candidate];
      return resultState;
    }
  }

  const videoId = input.videoId?.trim() ?? '';
  if (!videoId) return resultState;

  try {
    const vasResp = await session.getJson<unknown>('https://vas.snssdk.com/video/openapi/v1/', {
      searchParams: {
        action: 'GetPlayInfo',
        video_id: videoId,
        nobase64: '1',
      },
      headers: { 'user-agent': DEFAULT_MOBILE_USER_AGENT },
      timeoutMs: 5_000,
      signal,
    });
    const parsedVas = extractLegacyVodList(at(vasResp, 'data'));
    if (parsedVas.videoUrl) {
      return parsedVas;
    }
  } catch (error) {
    if (error instanceof ProxyAttemptError) throw error;
  }

  try {
    const randDigits = `${randomInt(10_000_000, 99_999_999)}${randomInt(10_000_000, 99_999_999)}`;
    const pathWithRand = `/video/urls/v/1/toutiao/mp4/${encodeURIComponent(videoId)}?r=${randDigits}`;
    const checksum = crc32(Buffer.from(pathWithRand, 'utf8')) >>> 0;
    const ibResp = await session.getJson<unknown>(`https://ib.365yg.com${pathWithRand}&s=${checksum}`, {
      headers: { 'user-agent': DEFAULT_MOBILE_USER_AGENT },
      timeoutMs: 5_000,
      signal,
    });
    const parsedIb = extractLegacyVodList(at(ibResp, 'data'));
    if (parsedIb.videoUrl) {
      return parsedIb;
    }
  } catch (error) {
    if (error instanceof ProxyAttemptError) throw error;
  }

  return resultState;
}

function extractLegacyVodList(data: unknown): BytedanceVodResult {
  const mapped = record(data);
  const coverUrl = string(mapped.poster_url) || string(mapped.cover_url);
  const rawList = mapped.video_list;
  const entries = Array.isArray(rawList) ? rawList : Object.values(record(rawList));
  const ranked = entries
    .map((entry) => ({
      bitrate: numberAt(entry, 'bitrate') || numberAt(entry, 'size'),
      url: decodeVodStreamUrl(
        stringAt(entry, 'main_url') ||
          stringAt(entry, 'backup_url_1') ||
          stringAt(entry, 'backup_url'),
      ),
    }))
    .filter((entry) => Boolean(entry.url))
    .sort((left, right) => right.bitrate - left.bitrate);
  const best = ranked[0]?.url ?? '';
  return {
    videoUrl: best,
    videoList: best ? [best] : [],
    coverUrl,
  };
}

function decodeVodStreamUrl(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return '';
  if (trimmed.startsWith('http://') || trimmed.startsWith('https://')) {
    return trimmed;
  }
  if (trimmed.startsWith('//')) {
    return `https:${trimmed}`;
  }
  try {
    const decoded = Buffer.from(trimmed, 'base64').toString('utf8').trim();
    if (decoded.startsWith('http://') || decoded.startsWith('https://')) {
      return decoded;
    }
  } catch {
    // Ignore non-base64 values.
  }
  return '';
}

function extractDouyinVideos(
  payload: unknown,
  flags: DouyinRouteFlags,
): { videoUrl: string; videoList: string[] } {
  if (flags.isCollection) {
    const awemeList = array(at(payload, 'aweme_list'));
    if (awemeList.length > 0) {
      const episodeUrls = uniqueStrings(
        awemeList.map((item) => extractSingleDetailStreams(item)[0] ?? ''),
      );
      if (episodeUrls.length > 0) {
        return { videoUrl: episodeUrls[0] ?? '', videoList: episodeUrls };
      }
    }
  }

  if (flags.isLvdetail) {
    const epList =
      nonEmptyArray(at(payload, 'episode_list')) ??
      nonEmptyArray(at(payload, 'aweme_list')) ??
      nonEmptyArray(at(payload, 'album_info', 'episode_list')) ??
      [];
    const primaryDetail = resolvePrimaryDetail(payload, flags);
    const primaryStreams = extractSingleDetailStreams(primaryDetail);
    if (epList.length > 0) {
      const episodeUrls = uniqueStrings(
        epList.map((item) => extractSingleDetailStreams(item)[0] ?? ''),
      );
      if (episodeUrls.length > 0) {
        const videoUrl = primaryStreams[0] ?? episodeUrls[0] ?? '';
        return { videoUrl, videoList: episodeUrls };
      }
    }
    if (primaryStreams.length > 0) {
      return { videoUrl: primaryStreams[0] ?? '', videoList: primaryStreams };
    }
  }

  const detail = resolvePrimaryDetail(payload, flags);
  const streams = extractSingleDetailStreams(detail);
  return {
    videoUrl: streams[0] ?? '',
    videoList: streams,
  };
}

function extractSingleDetailStreams(detail: unknown): string[] {
  const detailRecord = record(detail);
  const video = isNonEmptyRecord(detailRecord.video)
    ? record(detailRecord.video)
    : ('play_addr' in detailRecord || 'bit_rate' in detailRecord ? detailRecord : {});

  const bitRateItems = array(video.bit_rate);
  const images =
    nonEmptyArray(at(detailRecord, 'image_post_info', 'images')) ??
    nonEmptyArray(detailRecord.images) ??
    nonEmptyArray(detailRecord.image_list) ??
    [];
  const mediaType = number(detailRecord.media_type, -1);
  const awemeType = number(detailRecord.aweme_type, -1);

  const rankedStreams: RankedVideoStream[] = [];
  for (const rawItem of bitRateItems) {
    const item = record(rawItem);
    const playAddr = record(item.play_addr);
    const urls = extractOrderedPlayAddrUrls(playAddr);
    if (urls.length === 0) continue;
    const width = number(playAddr.width) || number(item.width);
    const height = number(playAddr.height) || number(item.height);
    rankedStreams.push({
      urls,
      isH265: Boolean(number(item.is_h265)),
      pixels: width * height,
      bitRate: number(item.bit_rate),
      dataSize: number(playAddr.data_size) || number(item.data_size),
      qualityType: number(item.quality_type) || number(playAddr.quality_type),
      hasWeba: urls.some(isWebaHost) ? 1 : 0,
      isDirect: urls[0]?.includes('/aweme/v1/play/') ? 0 : 1,
    });
  }

  if (rankedStreams.length > 0) {
    const h264Pool = rankedStreams.filter((stream) => !stream.isH265);
    const pool = h264Pool.length > 0 ? h264Pool : rankedStreams;
    pool.sort(
      (left, right) =>
        right.pixels - left.pixels ||
        right.bitRate - left.bitRate ||
        right.dataSize - left.dataSize ||
        right.qualityType - left.qualityType ||
        right.hasWeba - left.hasWeba ||
        right.isDirect - left.isDirect,
    );
    return pool[0]?.urls ?? [];
  }

  if (images.length > 0 || mediaType === 2 || awemeType === 2 || awemeType === 68) {
    return [];
  }

  const dynamicVideo =
    nonEmptyRecord(at(video, 'videoModel', 'dynamicVideo')) ??
    nonEmptyRecord(at(video, 'video_model', 'dynamic_video')) ??
    {};
  const dynList =
    nonEmptyArray(dynamicVideo.dynamic_video_list) ??
    nonEmptyArray(dynamicVideo.dynamicVideoList) ??
    [];
  if (dynList.length > 0) {
    const h264Dyn = dynList.filter(
      (entry) => stringAt(entry, 'video_meta', 'codec_type') === 'h264',
    );
    const dynPool = [...(h264Dyn.length > 0 ? h264Dyn : dynList)];
    dynPool.sort(
      (left, right) =>
        numberAt(right, 'video_meta', 'bitrate') - numberAt(left, 'video_meta', 'bitrate'),
    );
    const dynUrl =
      stringAt(dynPool[0], 'main_url') || stringAt(dynPool[0], 'backup_url');
    if (dynUrl) return [sanitizeDouyinPlayUrl(dynUrl)];
  }

  const downloadAddr = record(video.download_addr);
  if (Object.keys(downloadAddr).length > 0) {
    const dlUri = string(downloadAddr.uri).trim();
    if (dlUri && !dlUri.toLowerCase().startsWith('http') && !dlUri.toLowerCase().includes('mp3')) {
      const built = buildPlayEndpointUrl(dlUri, 'default');
      if (built) return [built];
    }
    const dlUrls = extractOrderedPlayAddrUrls(downloadAddr);
    const validDlUrls = dlUrls.filter((candidate) => !isAudioStreamUrl(candidate));
    if (validDlUrls.length > 0) return validDlUrls;
  }

  for (const fallbackKey of ['play_addr_h264', 'play_addr', 'play_addr_265']) {
    const fallbackUrls = extractOrderedPlayAddrUrls(at(video, fallbackKey)).filter(
      (candidate) => !isAudioStreamUrl(candidate),
    );
    if (fallbackUrls.length > 0) {
      return fallbackUrls;
    }
  }

  return [];
}

function extractOrderedPlayAddrUrls(playAddr: unknown): string[] {
  const mapped = record(playAddr);
  if (Object.keys(mapped).length === 0) return [];
  const rawList = nonEmptyArray(mapped.url_list) ?? nonEmptyArray(mapped.download_url_list) ?? [];
  const sanitized = rawList
    .map((entry) => sanitizeDouyinPlayUrl(string(entry)))
    .filter(Boolean);
  if (sanitized.length > 0) {
    return orderVideoUrls(sanitized);
  }
  const uri = string(mapped.uri).trim();
  if (!uri) return [];
  if (uri.toLowerCase().startsWith('http')) {
    return [sanitizeDouyinPlayUrl(uri)];
  }
  if (!uri.toLowerCase().includes('mp3')) {
    const endpoint = buildPlayEndpointUrl(uri, '1080p');
    return endpoint ? [endpoint] : [];
  }
  return [];
}

function extractDouyinImages(payload: unknown, flags: DouyinRouteFlags): ImageItem[] {
  if (flags.isMusic || flags.isLvdetail) return [];
  const detail = resolvePrimaryDetail(payload, flags);
  const imagePostInfo = record(at(detail, 'image_post_info'));
  const source =
    nonEmptyArray(imagePostInfo.images) ??
    nonEmptyArray(imagePostInfo.image_list) ??
    nonEmptyArray(at(detail, 'images')) ??
    nonEmptyArray(at(detail, 'image_list')) ??
    nonEmptyArray(at(detail, 'image_infos')) ??
    nonEmptyArray(at(detail, 'original_images')) ??
    [];

  const imageList: ImageItem[] = [];
  for (const rawImg of source) {
    const img = record(rawImg);
    if (Object.keys(img).length === 0) continue;

    const directUrls = array(img.url_list)
      .map((entry) => string(entry).trim())
      .filter(Boolean);
    let imageUrl = directUrls.at(-1) ?? '';

    if (!imageUrl) {
      for (const fallbackKey of [
        'display_image',
        'image_url',
        'image',
        'origin_cover',
        'cover',
        'download_url_list',
        'download_url',
      ]) {
        const candidate = img[fallbackKey];
        if (typeof candidate === 'string' && candidate.trim()) {
          imageUrl = candidate.trim();
          break;
        }
        if (Array.isArray(candidate)) {
          const first = candidate.map((entry) => string(entry).trim()).find(Boolean);
          if (first) {
            imageUrl = first;
            break;
          }
        }
        const nestedUrls = array(at(candidate, 'url_list'))
          .map((entry) => string(entry).trim())
          .filter(Boolean);
        if (nestedUrls[0]) {
          imageUrl = nestedUrls[0];
          break;
        }
      }
    }

    const livePhotoUrl = extractImageLivePhotoUrl(img);
    if (!imageUrl && !livePhotoUrl) continue;
    if (livePhotoUrl) {
      imageList.push({ url: imageUrl || null, livePhotoUrl });
    } else if (imageUrl) {
      imageList.push(imageUrl);
    }
  }
  return imageList;
}

function extractImageLivePhotoUrl(img: JsonRecord): string {
  const candidates: unknown[] = [];
  if (isNonEmptyRecord(img.video)) candidates.push(img.video);
  if (isNonEmptyRecord(img.clip_video)) candidates.push(img.clip_video);
  if (isNonEmptyRecord(img.live_photo)) candidates.push(img.live_photo);
  if (isNonEmptyRecord(img.livePhoto)) candidates.push(img.livePhoto);
  if (typeof img.live_photo === 'string' && img.live_photo.startsWith('http')) {
    return sanitizeDouyinPlayUrl(img.live_photo);
  }
  if (isNonEmptyRecord(img.video_play_addr)) candidates.push({ play_addr: img.video_play_addr });
  if (isNonEmptyRecord(img.video_download_addr)) {
    candidates.push({ play_addr: img.video_download_addr });
  }

  for (const rawVideo of candidates) {
    const liveVideo = record(rawVideo);
    if (isNonEmptyRecord(liveVideo.video)) {
      candidates.push(liveVideo.video);
    }
    for (const addrKey of ['play_addr', 'play_addr_h264', 'play_addr_lowbr', 'download_addr']) {
      const addrObj = record(liveVideo[addrKey]);
      if (Object.keys(addrObj).length === 0) continue;
      const list = nonEmptyArray(addrObj.url_list) ?? nonEmptyArray(addrObj.download_url_list) ?? [];
      const urls = orderVideoUrls(
        list
          .map((entry) => sanitizeDouyinPlayUrl(string(entry)))
          .filter((entry) => Boolean(entry) && !isAudioStreamUrl(entry)),
      );
      if (urls[0]) return urls[0];
    }

    const directList = orderVideoUrls(
      array(liveVideo.url_list)
        .map((entry) => sanitizeDouyinPlayUrl(string(entry)))
        .filter((entry) => Boolean(entry) && !isAudioStreamUrl(entry)),
    );
    if (directList[0]) return directList[0];

    const directUrl = sanitizeDouyinPlayUrl(string(liveVideo.url) || string(liveVideo.main_url));
    if (directUrl && directUrl.startsWith('http') && !isAudioStreamUrl(directUrl)) {
      return directUrl;
    }

    const vid =
      stringAt(liveVideo, 'play_addr', 'uri') ||
      stringAt(liveVideo, 'download_addr', 'uri') ||
      string(liveVideo.vid) ||
      string(liveVideo.uri);
    const cleanVid = vid.trim();
    if (cleanVid) {
      if (cleanVid.toLowerCase().startsWith('http')) {
        return sanitizeDouyinPlayUrl(cleanVid);
      }
      if (!cleanVid.toLowerCase().includes('mp3')) {
        return buildPlayEndpointUrl(cleanVid, '1080p');
      }
    }
  }
  return '';
}

function extractDouyinTitle(payload: unknown, flags: DouyinRouteFlags, realUrl: URL): string {
  if (flags.isCollection) {
    const mixName = stringAt(payload, 'mix_info', 'mix_name');
    if (mixName) return `【合集】${mixName}`;
  }

  if (flags.isLvdetail) {
    const seriesInfo =
      nonEmptyRecord(at(payload, 'series_info')) ??
      nonEmptyRecord(at(payload, 'lvideo_detail', 'series_info')) ??
      nonEmptyRecord(at(payload, 'playlet_info')) ??
      {};
    const seriesTitle =
      string(seriesInfo.series_name) || string(seriesInfo.title) || string(seriesInfo.name);

    const albumInfo =
      nonEmptyRecord(at(payload, 'album_info')) ??
      nonEmptyRecord(at(payload, 'lvideo_detail', 'album_info')) ??
      {};
    const albumTitle =
      string(albumInfo.album_name) || string(albumInfo.title) || string(albumInfo.name);

    let epInfo =
      nonEmptyRecord(at(payload, 'episode_info')) ??
      nonEmptyRecord(at(payload, 'lvideo_detail', 'episode_info'));
    if (!epInfo) {
      const ep0 = at(payload, 'episode_list', 0);
      if (isNonEmptyRecord(ep0)) epInfo = ep0;
    }
    if (!epInfo) {
      const aw0 = at(payload, 'aweme_list', 0);
      if (isNonEmptyRecord(aw0)) {
        epInfo = nonEmptyRecord(at(aw0, 'episode_info')) ?? aw0;
      }
    }
    const epTitle = epInfo
      ? string(epInfo.episode_name) || string(epInfo.title) || string(epInfo.itemTitle)
      : '';

    const prefix = realUrl.href.includes('playlet') || Boolean(seriesTitle) ? '【短剧】' : '【放映厅】';
    const mainTitle = seriesTitle || albumTitle;
    if (mainTitle && epTitle && mainTitle !== epTitle) {
      return `${prefix}${mainTitle} - ${epTitle}`;
    }
    if (mainTitle) return `${prefix}${mainTitle}`;
    if (epTitle) return `${prefix}${epTitle}`;
  }

  const detail = nonEmptyRecord(at(payload, 'aweme_detail'));
  if (!detail) {
    const aw0 = at(payload, 'aweme_list', 0);
    return stringAt(aw0, 'itemTitle') || stringAt(aw0, 'desc');
  }
  const itemTitle = string(detail.itemTitle).trim();
  const desc = string(detail.desc).trim();
  if (itemTitle && (!desc || itemTitle !== desc)) {
    return itemTitle;
  }
  return '';
}

function extractDouyinDescription(payload: unknown): string | null {
  const desc = stringAt(payload, 'aweme_detail', 'desc');
  return desc || null;
}

function extractDouyinCover(
  payload: unknown,
  flags: DouyinRouteFlags,
  imageList: readonly ImageItem[],
): string {
  if (flags.isCollection) {
    const mixCover = stringAt(payload, 'mix_info', 'cover_url', 'url_list', 0);
    if (mixCover) return mixCover;
  }

  if (flags.isLvdetail) {
    const seriesInfo =
      nonEmptyRecord(at(payload, 'series_info')) ??
      nonEmptyRecord(at(payload, 'lvideo_detail', 'series_info')) ??
      nonEmptyRecord(at(payload, 'playlet_info')) ??
      {};
    const seriesCover = firstCoverField(seriesInfo, [
      'cover_url',
      'poster_url',
      'horizontal_cover',
      'vertical_cover',
      'verticalCover',
      'cover',
    ]);
    if (seriesCover) return seriesCover;

    const albumInfo =
      nonEmptyRecord(at(payload, 'album_info')) ??
      nonEmptyRecord(at(payload, 'lvideo_detail', 'album_info')) ??
      {};
    const albumCover = firstCoverField(albumInfo, [
      'cover_url',
      'poster_url',
      'horizontal_cover',
      'vertical_cover',
      'verticalCover',
      'cover',
    ]);
    if (albumCover) return albumCover;

    const epInfo =
      nonEmptyRecord(at(payload, 'episode_info')) ??
      nonEmptyRecord(at(payload, 'lvideo_detail', 'episode_info')) ??
      nonEmptyRecord(at(payload, 'episode_list', 0)) ??
      nonEmptyRecord(at(payload, 'aweme_list', 0)) ??
      {};
    const epCover = firstCoverField(epInfo, [
      'cover_url',
      'poster_url',
      'origin_cover',
      'cover',
      'dynamic_cover',
    ]);
    if (epCover) return epCover;
  }

  const detail = resolvePrimaryDetail(payload, flags);
  const video = record(at(detail, 'video'));
  const videoCover = firstCoverField(video, ['origin_cover', 'cover', 'dynamic_cover']);
  if (videoCover) return videoCover;

  const firstRawImage = stringAt(detail, 'images', 0, 'url_list', 0);
  if (firstRawImage) return firstRawImage;

  const firstImage = imageList[0];
  if (typeof firstImage === 'string') return firstImage;
  if (firstImage?.url) return firstImage.url;
  return '';
}

function firstCoverField(source: JsonRecord, keys: readonly string[]): string {
  for (const key of keys) {
    const val = source[key];
    if (typeof val === 'string' && val.trim()) return val.trim();
    const listUrl = stringAt(val, 'url_list', 0) || stringAt(val, 'urlList', 0);
    if (listUrl) return listUrl;
  }
  return '';
}

function extractDouyinAudio(
  payload: unknown,
  flags: DouyinRouteFlags,
  videoUrl: string,
  imageList: readonly ImageItem[],
): string {
  if (flags.isLvdetail) {
    const epInfo =
      nonEmptyRecord(at(payload, 'episode_info')) ??
      nonEmptyRecord(at(payload, 'lvideo_detail', 'episode_info')) ??
      {};
    const awemeDetail = record(at(payload, 'aweme_detail'));
    const music = nonEmptyRecord(epInfo.music) ?? record(awemeDetail.music);
    const playUrlObj = nonEmptyRecord(music.play_url) ?? record(music.playUrl);
    const musicTrack = stringAt(playUrlObj, 'url_list', 0) || stringAt(playUrlObj, 'urlList', 0);
    if (musicTrack) return musicTrack;

    const video = nonEmptyRecord(awemeDetail.video) ?? record(epInfo.video);
    const dynamicVideo =
      nonEmptyRecord(at(video, 'videoModel', 'dynamicVideo')) ??
      record(at(video, 'video_model', 'dynamic_video'));
    const dynAudio =
      nonEmptyArray(dynamicVideo.dynamic_audio_list) ??
      nonEmptyArray(dynamicVideo.dynamicAudioList) ??
      [];
    for (const item of dynAudio) {
      const audioCandidate = stringAt(item, 'main_url') || stringAt(item, 'backup_url');
      if (audioCandidate) return audioCandidate;
    }
  }

  const detail = record(at(payload, 'aweme_detail'));
  if (Object.keys(detail).length === 0) return '';

  const awemeType = number(detail.aweme_type, -1);
  const mediaType = number(detail.media_type, -1);
  if (
    flags.isNote ||
    awemeType === 2 ||
    awemeType === 68 ||
    mediaType === 2 ||
    (imageList.length > 0 && !videoUrl)
  ) {
    return '';
  }

  return stringAt(detail, 'music', 'play_url', 'url_list', 0);
}

function extractDouyinAuthor(payload: unknown, flags: DouyinRouteFlags): AuthorInfo | null {
  if (flags.isCollection) {
    const creator =
      nonEmptyRecord(at(payload, 'mix_info', 'author')) ??
      nonEmptyRecord(at(payload, 'aweme_detail', 'author'));
    if (creator) {
      return author(
        creator.nickname,
        creator.unique_id || creator.short_id,
        at(creator, 'avatar_thumb', 'url_list', 0),
      );
    }
  }

  if (flags.isLvdetail) {
    const albumInfo =
      nonEmptyRecord(at(payload, 'album_info')) ??
      nonEmptyRecord(at(payload, 'lvideo_detail', 'album_info')) ??
      {};
    const epInfo =
      nonEmptyRecord(at(payload, 'episode_info')) ??
      nonEmptyRecord(at(payload, 'lvideo_detail', 'episode_info')) ??
      {};
    const awemeDetail = record(at(payload, 'aweme_detail'));
    const creator =
      nonEmptyRecord(albumInfo.author) ??
      nonEmptyRecord(albumInfo.owner) ??
      nonEmptyRecord(epInfo.author) ??
      nonEmptyRecord(awemeDetail.authorInfo) ??
      nonEmptyRecord(awemeDetail.author);
    if (creator) {
      const avatarRaw =
        creator.avatar_thumb ?? creator.avatarThumb ?? creator.avatar ?? creator.avatarUri;
      const avatarUrl =
        typeof avatarRaw === 'string'
          ? avatarRaw
          : stringAt(avatarRaw, 'url_list', 0) || stringAt(avatarRaw, 'urlList', 0);
      return author(
        creator.nickname || creator.name,
        creator.unique_id || creator.short_id || creator.uid || creator.id,
        avatarUrl,
      );
    }
  }

  const creator = nonEmptyRecord(at(payload, 'aweme_detail', 'author'));
  if (!creator) return null;
  return author(
    creator.nickname,
    creator.unique_id || creator.short_id,
    at(creator, 'avatar_thumb', 'url_list', 0),
  );
}

function findDouyinSubtitleUrl(payload: unknown, flags: DouyinRouteFlags): string {
  const detail = resolvePrimaryDetail(payload, flags);
  const detailRecord = record(detail);
  const video = isNonEmptyRecord(detailRecord.video)
    ? record(detailRecord.video)
    : ('cla_info' in detailRecord || 'subtitle_infos' in detailRecord || 'claInfo' in detailRecord
        ? detailRecord
        : {});

  const claInfo =
    nonEmptyRecord(video.cla_info) ??
    nonEmptyRecord(video.claInfo) ??
    nonEmptyRecord(detailRecord.claInfo) ??
    {};
  const captions =
    nonEmptyArray(claInfo.caption_infos) ??
    nonEmptyArray(claInfo.captionInfos) ??
    nonEmptyArray(claInfo.captions) ??
    nonEmptyArray(video.subtitle_infos) ??
    nonEmptyArray(video.subtitleInfos) ??
    [];
  if (captions.length === 0) return '';

  const pickUrl = (cap: unknown): string =>
    stringAt(cap, 'url') ||
    stringAt(cap, 'url_list', 0) ||
    stringAt(cap, 'urlList', 0);

  for (const cap of captions) {
    const lang = stringAt(cap, 'language_code') || stringAt(cap, 'lang');
    if (CHINESE_SUBTITLE_LANGS.has(lang)) {
      const found = pickUrl(cap);
      if (found) return found;
    }
  }
  for (const cap of captions) {
    const found = pickUrl(cap);
    if (found) return found;
  }
  return '';
}

function resolvePrimaryDetail(payload: unknown, flags: DouyinRouteFlags): unknown {
  const awemeDetail = at(payload, 'aweme_detail');
  if (isNonEmptyRecord(awemeDetail)) return awemeDetail;

  if (flags.isCollection) {
    const first = at(payload, 'aweme_list', 0);
    if (isNonEmptyRecord(first)) return first;
  }

  if (flags.isLvdetail) {
    return (
      nonEmptyRecord(at(payload, 'episode_info')) ??
      nonEmptyRecord(at(payload, 'lvideo_detail', 'episode_info')) ??
      nonEmptyRecord(at(payload, 'lvideo_detail')) ??
      nonEmptyRecord(at(payload, 'episode_list', 0)) ??
      nonEmptyRecord(at(payload, 'aweme_list', 0)) ??
      {}
    );
  }

  return {};
}

function detectDouyinTerminalError(
  payload: unknown,
  awemeId: string,
): TerminalErrorDetail | null {
  const data = record(payload);
  if (Object.keys(data).length === 0) return null;

  const filterDetail = record(data.filter_detail);
  const filterReason = string(filterDetail.filter_reason);
  const detailMsg = string(filterDetail.detail_msg);
  const notice = string(filterDetail.notice);
  const statusMsg = string(data.status_msg);

  const hasFilterDetailReason = Boolean(filterReason || detailMsg || notice);
  const hasExplicitFilterField =
    data.status_code === 0 && 'filter_detail' in data && data.filter_detail !== null && data.filter_detail !== undefined;
  const hasTerminalKeyword = TERMINAL_KEYWORDS.some(
    (kw) => statusMsg.includes(kw) || detailMsg.includes(kw),
  );

  if (!hasFilterDetailReason && !hasExplicitFilterField && !hasTerminalKeyword) {
    return null;
  }

  if (isUnderReview(awemeId, filterReason)) {
    return {
      code: 'MEDIA_DELETED_OR_PRIVATE',
      message: UNDER_REVIEW_MESSAGE,
    };
  }

  const message =
    detailMsg || notice || statusMsg || '该内容可能为私密/日常作品或已被作者删除';
  return {
    code: 'MEDIA_DELETED_OR_PRIVATE',
    message,
  };
}

function isUnderReview(awemeId: string, filterReason: string): boolean {
  if (filterReason !== 'status_self_see' || !/^\d+$/u.test(awemeId)) return false;
  try {
    const publishedSec = Number(BigInt(awemeId) >> 32n);
    const ageSec = Math.floor(Date.now() / 1000) - publishedSec;
    return ageSec >= -300 && ageSec <= UNDER_REVIEW_MAX_AGE_SEC;
  } catch {
    return false;
  }
}

function isValidLvdetailPayload(data: unknown): boolean {
  const mapped = record(data);
  if (mapped.status_code !== undefined && mapped.status_code !== 0) return false;
  return (
    isNonEmptyRecord(mapped.lvideo_detail) ||
    isNonEmptyRecord(mapped.episode_info) ||
    isNonEmptyRecord(mapped.album_info) ||
    isNonEmptyRecord(mapped.series_info) ||
    isNonEmptyRecord(mapped.playlet_info) ||
    array(mapped.aweme_list).length > 0 ||
    array(mapped.episode_list).length > 0
  );
}

function buildSsrCandidateUrls(
  realUrl: URL,
  flags: DouyinRouteFlags,
): { url: string; mobileUa: boolean }[] {
  const candidates: { url: string; mobileUa: boolean }[] = [];
  const pushUnique = (url: string, mobileUa: boolean): void => {
    if (!candidates.some((entry) => entry.url === url)) {
      candidates.push({ url, mobileUa });
    }
  };

  const hostname = realUrl.hostname.toLowerCase();
  if (flags.isLvdetail && flags.epId) {
    pushUnique(`https://www.douyin.com/lvdetail/${flags.epId}`, false);
  } else if (flags.isLvdetail && flags.albumId) {
    pushUnique(`https://www.douyin.com/share/playlet/detail/${flags.albumId}`, false);
  } else if (flags.isCollection && flags.awemeId) {
    pushUnique(`https://www.douyin.com/collection/${flags.awemeId}`, false);
  } else if (flags.awemeId && !flags.isMusic) {
    if (hostname.endsWith('iesdouyin.com') || hostname === 'm.douyin.com') {
      pushUnique(realUrl.href, true);
    }
    pushUnique(`https://www.iesdouyin.com/share/video/${flags.awemeId}`, true);
  }

  if (
    hostname.endsWith('douyin.com') ||
    hostname.endsWith('iesdouyin.com')
  ) {
    pushUnique(realUrl.href, hostname === 'm.douyin.com' || hostname.endsWith('iesdouyin.com'));
  }
  return candidates;
}

function extractSsrEntityFromJsonText(
  rawText: string,
  options: DouyinSsrOptions,
  allowUrlDecode: boolean,
): JsonRecord | null {
  let candidate = rawText;
  if (allowUrlDecode && candidate.includes('%')) {
    try {
      candidate = decodeURIComponent(candidate);
    } catch {
      // Keep raw string if percentage characters are not URI escapes.
    }
  }
  try {
    const parsed = parseJson(candidate);
    return mapSsrRoot(parsed, options);
  } catch {
    return null;
  }
}

function mapSsrRoot(root: unknown, options: DouyinSsrOptions): JsonRecord | null {
  if (options.isMusic) {
    const musicInfo = findMusicInfo(root);
    if (musicInfo) return { music_info: musicInfo };
  }
  if (options.isLvdetail) {
    const lvideo = findLvideoDetail(root);
    if (lvideo) return lvideo;
  }
  const detail = findAwemeDetail(root, options.awemeId || null);
  if (detail) return { aweme_detail: detail };
  return null;
}

function findMusicInfo(node: unknown): JsonRecord | null {
  if (Array.isArray(node)) {
    for (const item of node) {
      const found = findMusicInfo(item);
      if (found) return found;
    }
    return null;
  }
  if (!isNonEmptyRecord(node)) return null;
  if (isNonEmptyRecord(node.music_info)) return node.music_info;
  if (isNonEmptyRecord(node.musicInfo)) return node.musicInfo;
  if (
    isNonEmptyRecord(node.music) &&
    ('play_url' in node.music || 'title' in node.music)
  ) {
    return node.music;
  }
  if (
    'play_url' in node &&
    ('author' in node || 'owner_nickname' in node || 'title' in node)
  ) {
    return node;
  }
  for (const child of Object.values(node)) {
    const found = findMusicInfo(child);
    if (found) return found;
  }
  return null;
}

function findLvideoDetail(node: unknown): JsonRecord | null {
  if (Array.isArray(node)) {
    for (const item of node) {
      const found = findLvideoDetail(item);
      if (found) return found;
    }
    return null;
  }
  if (!isNonEmptyRecord(node)) return null;
  if (isNonEmptyRecord(node.lvideo_detail)) return node.lvideo_detail;
  if (
    isNonEmptyRecord(node.episode_info) ||
    isNonEmptyRecord(node.album_info) ||
    array(node.episode_list).length > 0
  ) {
    return node;
  }
  if (
    ('video' in node || 'play_addr' in node) &&
    ('episode_id' in node || 'episode_name' in node || 'album_id' in node)
  ) {
    return { episode_info: node };
  }
  for (const child of Object.values(node)) {
    const found = findLvideoDetail(child);
    if (found) return found;
  }
  return null;
}

function findAwemeDetail(node: unknown, targetId: string | null): JsonRecord | null {
  if (Array.isArray(node)) {
    for (const item of node) {
      const found = findAwemeDetail(item, targetId);
      if (found) return found;
    }
    return null;
  }
  if (!isNonEmptyRecord(node)) return null;

  const videoInfoRes = nonEmptyRecord(node.videoInfoRes);
  if (videoInfoRes) {
    const itemList = nonEmptyArray(videoInfoRes.item_list) ?? nonEmptyArray(videoInfoRes.itemList) ?? [];
    for (const rawItem of itemList) {
      if (!isNonEmptyRecord(rawItem)) continue;
      if (matchesAwemeId(rawItem, targetId)) return rawItem;
    }
    if (itemList.length > 0 && isNonEmptyRecord(itemList[0]) && !targetId) {
      return itemList[0];
    }
  }

  for (const key of ['aweme_detail', 'itemStruct']) {
    const detail = nonEmptyRecord(node[key]);
    if (detail && matchesAwemeId(detail, targetId)) {
      return detail;
    }
  }

  if (
    ('video' in node || 'images' in node || 'image_post_info' in node) &&
    ('desc' in node || 'author' in node) &&
    matchesAwemeId(node, targetId)
  ) {
    return node;
  }

  for (const child of Object.values(node)) {
    const found = findAwemeDetail(child, targetId);
    if (found) return found;
  }
  return null;
}

function matchesAwemeId(detail: JsonRecord, targetId: string | null): boolean {
  if (!targetId) return true;
  const candidateId = id(detail.aweme_id) || id(detail.id);
  return !candidateId || candidateId === targetId;
}

function extractPaceChunks(html: string): string[] {
  const chunks: string[] = [];
  const marker = 'self.__pace_f.push([1,';
  let cursor = 0;
  while (cursor < html.length) {
    const foundIdx = html.indexOf(marker, cursor);
    if (foundIdx < 0) break;
    let quoteStart = foundIdx + marker.length;
    while (quoteStart < html.length && (html[quoteStart] === ' ' || html[quoteStart] === '\t')) {
      quoteStart += 1;
    }
    if (html[quoteStart] !== '"') {
      cursor = quoteStart + 1;
      continue;
    }
    let idx = quoteStart + 1;
    let escaped = false;
    while (idx < html.length) {
      const ch = html[idx];
      if (escaped) {
        escaped = false;
      } else if (ch === '\\') {
        escaped = true;
      } else if (ch === '"') {
        try {
          const decoded = parseJson(html.slice(quoteStart, idx + 1));
          if (typeof decoded === 'string') chunks.push(decoded);
        } catch {
          // Ignore malformed string literal.
        }
        break;
      }
      idx += 1;
    }
    cursor = idx + 1;
  }
  return chunks;
}

function parseVttCueHeader(line: string): { startSec: number; endSec: number } | null {
  const arrowIdx = line.indexOf('-->');
  if (arrowIdx <= 0) return null;
  const left = line.slice(0, arrowIdx).trim();
  const rightRest = line.slice(arrowIdx + 3).trim();
  const spaceIdx = rightRest.search(/\s/u);
  const right = spaceIdx >= 0 ? rightRest.slice(0, spaceIdx) : rightRest;
  const startSec = parseVttTimestampSeconds(left);
  const endSec = parseVttTimestampSeconds(right);
  if (startSec === null || endSec === null) return null;
  return { startSec, endSec };
}

function parseVttTimestampSeconds(raw: string): number | null {
  const normalized = raw.trim().replaceAll(',', '.');
  if (!normalized) return null;
  const parts = normalized.split(':');
  if (parts.length < 2 || parts.length > 3) return null;
  const nums = parts.map((part) => (isDecimalToken(part) ? Number(part) : Number.NaN));
  if (nums.some((val) => !Number.isFinite(val))) return null;
  if (nums.length === 3) {
    return Math.round(((nums[0] ?? 0) * 3600 + (nums[1] ?? 0) * 60 + (nums[2] ?? 0)) * 1000) / 1000;
  }
  return Math.round(((nums[0] ?? 0) * 60 + (nums[1] ?? 0)) * 1000) / 1000;
}

function isDecimalToken(value: string): boolean {
  if (!value || value === '.') return false;
  let dots = 0;
  for (const ch of value) {
    if (ch === '.') {
      dots += 1;
      if (dots > 1) return false;
    } else if (ch < '0' || ch > '9') {
      return false;
    }
  }
  return true;
}

function stripVttTags(input: string): string {
  let out = '';
  let insideTag = false;
  for (const ch of input) {
    if (ch === '<') {
      insideTag = true;
    } else if (ch === '>' && insideTag) {
      insideTag = false;
    } else if (!insideTag) {
      out += ch;
    }
  }
  return out;
}

function orderVideoUrls(urls: readonly string[]): string[] {
  const preferred: string[] = [];
  const fallbacks: string[] = [];
  for (const value of new Set(urls)) {
    if (isWebaHost(value)) {
      preferred.push(value);
    } else {
      fallbacks.push(value);
    }
  }
  return [...preferred, ...fallbacks];
}

function isWebaHost(url: string): boolean {
  try {
    return new URL(url).hostname.toLowerCase().endsWith('-weba.douyinvod.com');
  } catch {
    return false;
  }
}

function isAudioStreamUrl(url: string): boolean {
  const qIdx = url.indexOf('?');
  const cleanPath = (qIdx >= 0 ? url.slice(0, qIdx) : url).toLowerCase();
  return (
    cleanPath.endsWith('.mp3') ||
    cleanPath.endsWith('.m4a') ||
    cleanPath.endsWith('.aac') ||
    cleanPath.endsWith('.wav') ||
    url.toLowerCase().includes('ies-music')
  );
}

function stripOuterQuotes(value: string): string {
  let out = value;
  while (
    out.length >= 2 &&
    ((out.startsWith('"') && out.endsWith('"')) || (out.startsWith("'") && out.endsWith("'")))
  ) {
    out = out.slice(1, -1).trim();
  }
  return out;
}

function unquotePlus(value: string): string {
  const withSpaces = value.replaceAll('+', ' ');
  try {
    return decodeURIComponent(withSpaces);
  } catch {
    return withSpaces;
  }
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
