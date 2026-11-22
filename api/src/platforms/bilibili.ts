import { createHash } from 'node:crypto';
import type { ParseContext } from '../core/parse-context.js';
import type { AuthorInfo, TerminalErrorDetail } from '../core/media-result.js';
import type { PlatformParser } from '../core/parser.js';
import { registerParser } from '../core/parser-registry.js';
import { DEFAULT_DESKTOP_USER_AGENT } from '../config/user-agents.js';
import {
  array,
  at,
  author,
  idAt,
  numberAt,
  parseJson,
  protocolUrl,
  record,
  result,
  stringAt,
  uniqueStrings,
} from './data.js';

const API_VIEW = 'https://api.bilibili.com/x/web-interface/view';
const API_WBI_VIEW = 'https://api.bilibili.com/x/web-interface/wbi/view';
const API_NAV = 'https://api.bilibili.com/x/web-interface/nav';
const API_PLAYURL = 'https://api.bilibili.com/x/player/playurl';
const API_PGC_PLAYURL = 'https://api.bilibili.com/pgc/player/web/playurl';
const API_SEASON_VIEW = 'https://api.bilibili.com/pgc/view/web/season';
const API_DYNAMIC_DETAIL = 'https://api.bilibili.com/x/polymer/web-dynamic/v1/detail';
const API_VC_DYNAMIC_DETAIL = 'https://api.vc.bilibili.com/dynamic_svr/v1/dynamic_svr/get_dynamic_detail';

const MIXIN_KEY_ENC_TAB = [
  46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35,
  27, 43, 5, 49, 33, 9, 42, 19, 29, 28, 14, 39, 12, 38, 41, 13,
  37, 48, 7, 16, 24, 55, 40, 61, 26, 17, 0, 1, 60, 51, 30, 4,
  22, 25, 54, 21, 56, 59, 6, 63, 57, 62, 11, 36, 20, 34, 44, 52,
] as const;

interface BilibiliIds {
  bvid: string;
  aid: string;
  epId: string;
  seasonId: string;
  dynamicId: string;
}

class BilibiliParser implements PlatformParser {
  public readonly platform = 'bilibili' as const;
  #terminalError: TerminalErrorDetail | null = null;
  #wbiMixinKey = '';

  public constructor(private readonly context: ParseContext) {}

  public async parse(): Promise<ReturnType<typeof result>> {
    let targetUrl = this.context.realUrl;
    let ids = extractIds(targetUrl);

    if (!hasAnyId(ids) && targetUrl.hostname === 'b23.tv') {
      targetUrl = await this.#resolveShortUrl(targetUrl);
      ids = extractIds(targetUrl);
    }

    if (!hasAnyId(ids)) return result({});

    let { bvid } = ids;
    const { aid, epId, seasonId, dynamicId } = ids;
    let seasonInfo: unknown = {};
    let bangumiEpInfo: unknown = {};
    let dynamicInfo: unknown = {};

    if (epId || seasonId) {
      seasonInfo = await this.#fetchSeasonInfo(epId, seasonId);
      if (Object.keys(record(seasonInfo)).length > 0) {
        const allEpisodes = [
          ...array(at(seasonInfo, 'episodes')),
          ...array(at(seasonInfo, 'section')).flatMap((sec) => array(at(sec, 'episodes'))),
        ];
        if (epId) {
          bangumiEpInfo = allEpisodes.find((ep) => idAt(ep, 'id') === epId) ?? {};
        }
        if (Object.keys(record(bangumiEpInfo)).length === 0 && allEpisodes.length > 0) {
          bangumiEpInfo = allEpisodes[0] ?? {};
        }
        const epBvid = stringAt(bangumiEpInfo, 'bvid');
        if (epBvid) bvid = epBvid;
      }
    }

    if (!bvid && !aid && dynamicId) {
      dynamicInfo = await this.#fetchDynamicInfo(dynamicId);
      const dynamicBvid = extractBvidFromDynamic(dynamicInfo);
      if (dynamicBvid) bvid = dynamicBvid;
    }

    let videoInfo: unknown = {};
    if (bvid || aid) {
      videoInfo = await this.#fetchVideoInfo(bvid, aid);
      const resolvedBvid = stringAt(videoInfo, 'bvid');
      if (!bvid && resolvedBvid) bvid = resolvedBvid;
    }

    const pages = getPages(bangumiEpInfo, videoInfo);
    const urls: string[] = [];
    for (const page of pages) {
      const cid = idAt(page, 'cid');
      if (!cid) continue;
      const playUrl = await this.#fetchPlayUrl(cid, bvid, epId, bangumiEpInfo, seasonInfo);
      if (playUrl) urls.push(playUrl);
    }

    const videoList = uniqueStrings(urls);
    const imageList = uniqueStrings(extractDynamicPics(dynamicInfo).map(protocolUrl));
    const title = resolveTitle(seasonInfo, bangumiEpInfo, videoInfo, dynamicInfo);
    const desc = resolveDescription(seasonInfo, videoInfo, dynamicInfo);
    const coverUrl = resolveCover(seasonInfo, bangumiEpInfo, videoInfo, imageList);
    const authorInfo = resolveAuthor(seasonInfo, videoInfo, dynamicInfo);
    const isTextOnlyDynamic =
      Object.keys(record(dynamicInfo)).length > 0 &&
      videoList.length === 0 &&
      imageList.length === 0 &&
      !this.#terminalError &&
      Boolean(title || desc);

    return result({
      title: title || desc || '',
      desc: desc || null,
      videoUrl: videoList[0] ?? null,
      videoList: pages.length > 1 ? videoList : [],
      coverUrl: coverUrl ? protocolUrl(coverUrl) : null,
      imageList,
      author: authorInfo,
      ...(isTextOnlyDynamic ? { noMediaInContent: true } : {}),
      ...(this.#terminalError ? { terminalError: this.#terminalError } : {}),
    });
  }

  async #resolveShortUrl(shortUrl: URL): Promise<URL> {
    try {
      const response = await this.context.session.request(shortUrl, {
        headers: {
          'user-agent': DEFAULT_DESKTOP_USER_AGENT,
          referer: 'https://www.bilibili.com/',
        },
        followRedirect: false,
        signal: this.context.signal,
      });
      const rawLocation = response.headers.location;
      const location = Array.isArray(rawLocation) ? rawLocation[0] : rawLocation;
      if (location) return new URL(location, shortUrl);
    } catch {
      // Keep original URL if shortlink resolution fails.
    }
    return shortUrl;
  }

  async #fetchVideoInfo(bvid: string, aid: string): Promise<unknown> {
    const params: Record<string, string> = bvid ? { bvid } : { aid };
    // Use client User-Agent to avoid HTTP 412 datacenter blocks on x/web-interface/view.
    const clientHeaders = {
      'user-agent': 'okhttp/4.9.3',
      referer: 'https://www.bilibili.com/',
    };

    try {
      const viewUrl = new URL(API_VIEW);
      for (const [key, value] of Object.entries(params)) viewUrl.searchParams.set(key, value);
      const view = await this.context.session.getJson<unknown>(viewUrl, {
        headers: clientHeaders,
        signal: this.context.signal,
      });
      const parsed = this.#inspectViewResponse(view);
      if (parsed !== null) return parsed;
    } catch {
      // Fall back to WBI signed web endpoint on HTTP 412 / network error.
    }

    try {
      const signedParams = await this.#signWbiParams(params);
      const wbiUrl = new URL(API_WBI_VIEW);
      for (const [key, value] of Object.entries(signedParams)) wbiUrl.searchParams.set(key, value);
      const view = await this.context.session.getJson<unknown>(wbiUrl, {
        headers: {
          'user-agent': DEFAULT_DESKTOP_USER_AGENT,
          referer: 'https://www.bilibili.com/',
        },
        signal: this.context.signal,
      });
      return this.#inspectViewResponse(view) ?? {};
    } catch {
      return {};
    }
  }

  #inspectViewResponse(view: unknown): unknown {
    const code = numberAt(view, 'code', -1);
    if (code === 0) return at(view, 'data') ?? {};
    const msg = stringAt(view, 'message');
    if (
      code === 62002 ||
      code === 62004 ||
      code === -404 ||
      msg.includes('不可见') ||
      msg.includes('不存在')
    ) {
      this.#terminalError = {
        code: 'MEDIA_DELETED_OR_PRIVATE',
        message: '该B站稿件不存在、已被作者删除或不可见',
      };
      return {};
    }
    return null;
  }

  async #fetchSeasonInfo(epId: string, seasonId: string): Promise<unknown> {
    const url = new URL(API_SEASON_VIEW);
    if (epId) url.searchParams.set('ep_id', epId);
    else if (seasonId) url.searchParams.set('season_id', seasonId);
    else return {};

    try {
      const response = await this.context.session.getJson<unknown>(url, {
        headers: {
          'user-agent': DEFAULT_DESKTOP_USER_AGENT,
          referer: 'https://www.bilibili.com/',
        },
        signal: this.context.signal,
      });
      const code = numberAt(response, 'code', -1);
      if (code === 0) {
        return at(response, 'result') ?? at(response, 'data') ?? {};
      }
      const msg = stringAt(response, 'message');
      if (code === -404 || msg.includes('不存在') || msg.includes('下架')) {
        this.#terminalError = {
          code: 'MEDIA_DELETED_OR_PRIVATE',
          message: '该B站番剧或剧集不存在或已下架',
        };
      }
    } catch {
      // Ignore season API failures.
    }
    return {};
  }

  async #fetchDynamicInfo(dynamicId: string): Promise<unknown> {
    const headers = {
      'user-agent': DEFAULT_DESKTOP_USER_AGENT,
      referer: 'https://t.bilibili.com/',
    };

    try {
      const url = new URL(API_DYNAMIC_DETAIL);
      url.searchParams.set('id', dynamicId);
      const response = await this.context.session.getJson<unknown>(url, {
        headers,
        signal: this.context.signal,
      });
      const code = numberAt(response, 'code', -1);
      if (code === 0) {
        const item = at(response, 'data', 'item');
        if (Object.keys(record(item)).length > 0) return item;
      }
      const msg = stringAt(response, 'message');
      if (code === 4101152 || code === 4101153 || msg.includes('不可见') || msg.includes('不存在')) {
        this.#terminalError = {
          code: 'MEDIA_DELETED_OR_PRIVATE',
          message: '该B站动态不存在、已被删除或不可见',
        };
        return {};
      }
    } catch {
      // Fall through to api.vc.bilibili.com fallback when polymer returns HTTP 412.
    }

    try {
      const vcUrl = new URL(API_VC_DYNAMIC_DETAIL);
      vcUrl.searchParams.set('dynamic_id', dynamicId);
      const vcResponse = await this.context.session.getJson<unknown>(vcUrl, {
        headers: {
          'user-agent': 'okhttp/4.9.3',
          referer: 'https://t.bilibili.com/',
        },
        signal: this.context.signal,
      });
      if (numberAt(vcResponse, 'code', -1) === 0) {
        return normalizeVcDynamicCard(at(vcResponse, 'data', 'card'));
      }
    } catch {
      // Ignore fallback error.
    }

    return {};
  }

  async #fetchPlayUrl(
    cid: string,
    bvid: string,
    epId: string,
    bangumiEpInfo: unknown,
    seasonInfo: unknown,
  ): Promise<string> {
    const headers = {
      'user-agent': DEFAULT_DESKTOP_USER_AGENT,
      referer: 'https://www.bilibili.com/',
    };

    if (
      Object.keys(record(bangumiEpInfo)).length > 0 ||
      Object.keys(record(seasonInfo)).length > 0
    ) {
      try {
        const pgcUrl = new URL(API_PGC_PLAYURL);
        pgcUrl.searchParams.set('otype', 'json');
        pgcUrl.searchParams.set('qn', '80');
        pgcUrl.searchParams.set('fnval', '1');
        pgcUrl.searchParams.set('cid', cid);
        const resolvedEpId = idAt(bangumiEpInfo, 'id') || epId;
        if (resolvedEpId) pgcUrl.searchParams.set('ep_id', resolvedEpId);
        if (bvid) pgcUrl.searchParams.set('bvid', bvid);

        const pgcResponse = await this.context.session.getJson<unknown>(pgcUrl, {
          headers,
          signal: this.context.signal,
        });
        if (numberAt(pgcResponse, 'code', -1) === 0) {
          const playInfo = Object.keys(record(at(pgcResponse, 'result'))).length > 0
            ? at(pgcResponse, 'result')
            : at(pgcResponse, 'data');
          const durl = stringAt(playInfo, 'durl', 0, 'url');
          if (durl) return durl;
        } else if (numberAt(pgcResponse, 'code', -1) === -10403) {
          this.#terminalError = {
            code: 'MEDIA_DELETED_OR_PRIVATE',
            message: '该番剧为B站大会员或地区受限专享，无法直接提取',
          };
        }
      } catch {
        // Fall through to UGC playurl endpoint.
      }
    }

    if (!bvid) return '';

    try {
      const playUrl = new URL(API_PLAYURL);
      for (const [key, value] of Object.entries({
        otype: 'json',
        fnver: '0',
        fnval: '3',
        player: '3',
        qn: '112',
        bvid,
        cid,
        platform: 'html5',
        high_quality: '1',
      })) {
        playUrl.searchParams.set(key, value);
      }
      const play = await this.context.session.getJson<unknown>(playUrl, {
        headers,
        signal: this.context.signal,
      });
      const code = numberAt(play, 'code', -1);
      if (code === 0) {
        return stringAt(play, 'data', 'durl', 0, 'url');
      }
      const msg = stringAt(play, 'message');
      if (code === 87008 || msg.includes('充电') || msg.includes('付费')) {
        this.#terminalError = {
          code: 'MEDIA_DELETED_OR_PRIVATE',
          message: '该视频为B站充电专属或付费视频，无法直接提取',
        };
      }
    } catch {
      // Ignore playurl errors.
    }
    return '';
  }

  async #signWbiParams(params: Record<string, string>): Promise<Record<string, string>> {
    if (!this.#wbiMixinKey) {
      try {
        const nav = await this.context.session.getJson<unknown>(API_NAV, {
          headers: {
            'user-agent': DEFAULT_DESKTOP_USER_AGENT,
            referer: 'https://www.bilibili.com/',
          },
          signal: this.context.signal,
        });
        const imgUrl = stringAt(nav, 'data', 'wbi_img', 'img_url');
        const subUrl = stringAt(nav, 'data', 'wbi_img', 'sub_url');
        const imgKey = extractStem(imgUrl);
        const subKey = extractStem(subUrl);
        if (imgKey && subKey) {
          const raw = `${imgKey}${subKey}`;
          this.#wbiMixinKey = MIXIN_KEY_ENC_TAB.map((idx) => raw[idx] ?? '').join('').slice(0, 32);
        }
      } catch {
        return params;
      }
    }
    if (!this.#wbiMixinKey) return params;

    const wts = String(Math.floor(Date.now() / 1000));
    const entries: Record<string, string> = { ...params, wts };
    const sortedQuery = Object.keys(entries)
      .sort()
      .map((key) => {
        const cleaned = (entries[key] ?? '').replace(/[!'()*]/gu, '');
        return `${encodeURIComponent(key)}=${encodeURIComponent(cleaned)}`;
      })
      .join('&');
    const wRid = createHash('md5').update(`${sortedQuery}${this.#wbiMixinKey}`, 'utf8').digest('hex');
    return { ...entries, w_rid: wRid };
  }
}

function extractStem(url: string): string {
  const filename = url.split('/').at(-1) ?? '';
  const dotIndex = filename.indexOf('.');
  return dotIndex >= 0 ? filename.slice(0, dotIndex) : filename;
}

function hasAnyId(ids: BilibiliIds): boolean {
  return Boolean(ids.bvid || ids.aid || ids.epId || ids.seasonId || ids.dynamicId);
}

function extractIds(url: URL): BilibiliIds {
  const href = url.href;
  const pathname = url.pathname;
  const bvid = /(BV[a-zA-Z0-9]+)/u.exec(href)?.[1] ?? '';
  const aid = bvid
    ? ''
    : url.searchParams.get('aid') ??
      /(?:\/video\/av|\/av)(\d+)/iu.exec(pathname)?.[1] ??
      '';
  const epId = url.searchParams.get('ep_id') ??
    /(?:\/bangumi\/play\/ep|\/ep)(\d+)/iu.exec(pathname)?.[1] ??
    '';
  const seasonId = epId
    ? ''
    : url.searchParams.get('season_id') ??
      /(?:\/bangumi\/play\/ss|\/ss)(\d+)/iu.exec(pathname)?.[1] ??
      '';
  const dynamicId = bvid || aid || epId || seasonId
    ? ''
    : extractDynamicId(url);
  return { bvid, aid, epId, seasonId, dynamicId };
}

function extractDynamicId(url: URL): string {
  const queryId = url.searchParams.get('dynamic_id') ?? '';
  if (/^\d{15,22}$/u.test(queryId)) return queryId;
  const opusMatch = /\/(?:opus|dynamic)\/(\d{15,22})/u.exec(url.pathname)?.[1];
  if (opusMatch) return opusMatch;
  if (url.hostname === 't.bilibili.com') {
    const firstPart = url.pathname.split('/').find(Boolean) ?? '';
    if (/^\d{15,22}$/u.test(firstPart)) return firstPart;
  }
  return '';
}

function extractBvidFromDynamic(dynamicInfo: unknown): string {
  const major = at(dynamicInfo, 'modules', 'module_dynamic', 'major');
  if (stringAt(major, 'type') === 'MAJOR_TYPE_ARCHIVE') {
    return stringAt(major, 'archive', 'bvid');
  }
  return stringAt(dynamicInfo, 'bvid');
}

function normalizeVcDynamicCard(cardNode: unknown): unknown {
  const rawCard = stringAt(cardNode, 'card');
  const parsedCard = rawCard ? safeParseJson(rawCard) : {};
  const userProfile = at(cardNode, 'desc', 'user_profile', 'info');
  const bvid = stringAt(cardNode, 'desc', 'bvid') || stringAt(parsedCard, 'bvid');
  const itemNode = Object.keys(record(at(parsedCard, 'item'))).length > 0
    ? at(parsedCard, 'item')
    : parsedCard;
  const pictures = array(at(itemNode, 'pictures')).map((pic) => ({
    src: stringAt(pic, 'img_src') || stringAt(pic, 'img_url'),
  })).filter((pic) => Boolean(pic.src));
  const text = stringAt(itemNode, 'description') ||
    stringAt(itemNode, 'content') ||
    stringAt(parsedCard, 'dynamic');
  const title = stringAt(parsedCard, 'title') || stringAt(itemNode, 'title');

  return {
    bvid,
    modules: {
      module_author: {
        name: stringAt(userProfile, 'uname'),
        mid: idAt(userProfile, 'uid'),
        face: stringAt(userProfile, 'face'),
      },
      module_dynamic: {
        desc: { text },
        major: {
          ...(bvid ? { type: 'MAJOR_TYPE_ARCHIVE', archive: { bvid } } : {}),
          ...(title ? { opus: { title, summary: { text }, pics: pictures.map((p) => ({ url: p.src })) } } : {}),
          ...(!title && pictures.length > 0 ? { draw: { items: pictures } } : {}),
        },
      },
    },
  };
}

function safeParseJson(raw: string): unknown {
  try {
    return parseJson(raw);
  } catch {
    return {};
  }
}

function getPages(bangumiEpInfo: unknown, videoInfo: unknown): unknown[] {
  const epCid = idAt(bangumiEpInfo, 'cid');
  if (epCid) {
    return [{ cid: epCid, page: 1, part: stringAt(bangumiEpInfo, 'title') }];
  }
  return array(at(videoInfo, 'pages'));
}

function extractDynamicPics(dynamicInfo: unknown): string[] {
  const major = at(dynamicInfo, 'modules', 'module_dynamic', 'major');
  const opusPics = array(at(major, 'opus', 'pics'))
    .map((pic) => stringAt(pic, 'url'))
    .filter(Boolean);
  if (opusPics.length > 0) return opusPics;
  return array(at(major, 'draw', 'items'))
    .map((item) => stringAt(item, 'src') || stringAt(item, 'url'))
    .filter(Boolean);
}

function resolveTitle(
  seasonInfo: unknown,
  bangumiEpInfo: unknown,
  videoInfo: unknown,
  dynamicInfo: unknown,
): string {
  if (
    Object.keys(record(seasonInfo)).length > 0 &&
    Object.keys(record(bangumiEpInfo)).length > 0
  ) {
    const fullTitle = [
      stringAt(seasonInfo, 'title'),
      stringAt(bangumiEpInfo, 'title'),
      stringAt(bangumiEpInfo, 'long_title'),
    ].filter(Boolean).join(' ').trim();
    if (fullTitle) return fullTitle;
  }
  const videoTitle = stringAt(videoInfo, 'title');
  if (videoTitle) return videoTitle;
  return stringAt(dynamicInfo, 'modules', 'module_dynamic', 'major', 'opus', 'title');
}

function resolveDescription(
  seasonInfo: unknown,
  videoInfo: unknown,
  dynamicInfo: unknown,
): string {
  if (Object.keys(record(seasonInfo)).length > 0) {
    const seasonDesc = stringAt(seasonInfo, 'evaluate') ||
      stringAt(seasonInfo, 'subtitle') ||
      stringAt(videoInfo, 'desc');
    if (seasonDesc) return seasonDesc;
  }
  const videoDesc = stringAt(videoInfo, 'desc');
  if (videoDesc) return videoDesc;
  const dynamicMod = at(dynamicInfo, 'modules', 'module_dynamic');
  return stringAt(dynamicMod, 'major', 'opus', 'summary', 'text') ||
    stringAt(dynamicMod, 'desc', 'text');
}

function resolveCover(
  seasonInfo: unknown,
  bangumiEpInfo: unknown,
  videoInfo: unknown,
  imageList: readonly string[],
): string {
  return stringAt(bangumiEpInfo, 'cover') ||
    stringAt(seasonInfo, 'cover') ||
    stringAt(videoInfo, 'pic') ||
    (imageList[0] ?? '');
}

function resolveAuthor(
  seasonInfo: unknown,
  videoInfo: unknown,
  dynamicInfo: unknown,
): AuthorInfo | null {
  const upInfo = at(seasonInfo, 'up_info');
  if (Object.keys(record(upInfo)).length > 0) {
    return author(
      at(upInfo, 'uname'),
      at(upInfo, 'mid'),
      protocolUrl(stringAt(upInfo, 'avatar')),
    );
  }
  const owner = at(videoInfo, 'owner');
  if (Object.keys(record(owner)).length > 0) {
    return author(
      at(owner, 'name'),
      at(owner, 'mid'),
      protocolUrl(stringAt(owner, 'face')),
    );
  }
  const dynAuthor = at(dynamicInfo, 'modules', 'module_author');
  if (Object.keys(record(dynAuthor)).length > 0) {
    return author(
      at(dynAuthor, 'name'),
      at(dynAuthor, 'mid'),
      protocolUrl(stringAt(dynAuthor, 'face')),
    );
  }
  return null;
}

registerParser('bilibili', {
  factory: (context) => new BilibiliParser(context),
  allowedHosts: ['api.bilibili.com', 'api.vc.bilibili.com', 'app.bilibili.com'],
});
