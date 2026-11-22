import { createHash } from 'node:crypto';
import { load } from 'cheerio';
import type { ParseContext } from '../core/parse-context.js';
import type { AuthorInfo, TerminalErrorDetail } from '../core/media-result.js';
import type { PlatformParser } from '../core/parser.js';
import { registerParser } from '../core/parser-registry.js';
import { DEFAULT_MOBILE_USER_AGENT } from '../config/user-agents.js';
import {
  array,
  at,
  author,
  extractAssignedJson,
  idAt,
  parseJson,
  record,
  result,
  string,
  stringAt,
  uniqueStrings,
} from './data.js';

const MTOP_APP_KEY = '12574478';
const MTOP_JSV = '2.7.3';
const MTOP_ITEM_INFO_API = 'mtop.taobao.idle.item.info';
const MTOP_AWESOME_DETAIL_API = 'mtop.taobao.idle.awesome.detail';

const MTOP_HEADERS = {
  'user-agent': DEFAULT_MOBILE_USER_AGENT,
  referer: 'https://h5.m.goofish.com/',
  accept: 'application/json',
} as const;

class XianyuParser implements PlatformParser {
  public readonly platform = 'xianyu' as const;
  #mtopToken = '';
  #cookieHeader = '';
  #terminalError: TerminalErrorDetail | null = null;
  #cookieRequired = false;

  public constructor(private readonly context: ParseContext) {}

  public async parse(): Promise<ReturnType<typeof result>> {
    let html = '';
    try {
      html = await this.context.session.getText(this.context.realUrl, {
        headers: {
          'user-agent': DEFAULT_MOBILE_USER_AGENT,
          referer: 'https://e.tb.cn/',
        },
        signal: this.context.signal,
      });
    } catch {
      // Proceed if itemId is already present in query parameters.
    }

    const targetValue = extractShortlinkTarget(html);
    const targetUrl = safeParseUrl(targetValue);
    const itemId =
      targetUrl?.searchParams.get('id') ??
      targetUrl?.searchParams.get('itemId') ??
      this.context.realUrl.searchParams.get('itemId') ??
      this.context.realUrl.searchParams.get('id') ??
      this.context.realUrl.searchParams.get('item_id') ??
      '';
    const initialPrice = targetUrl?.searchParams.get('price') ?? this.context.realUrl.searchParams.get('price') ?? '';

    let title = itemId
      ? `闲鱼商品 (商品ID: ${itemId}${initialPrice ? `, 标价: ¥${initialPrice}` : ''})`
      : '';
    let desc = '';
    let coverUrl = '';
    let videoUrl = '';
    const images: string[] = [];
    let authorInfo: AuthorInfo | null = null;

    if (itemId) {
      const itemInfo = await this.#fetchMtop(MTOP_ITEM_INFO_API, { itemId });
      const infoData = record(at(itemInfo, 'data'));
      if (Object.keys(infoData).length > 0) {
        const infoTitle = stringAt(infoData, 'title');
        const reservePrice = idAt(infoData, 'reservePrice') || idAt(infoData, 'soldPrice');
        if (infoTitle) {
          title = infoTitle;
        } else if (reservePrice) {
          title = `闲鱼商品 (商品ID: ${itemId}, 标价: ¥${reservePrice})`;
        }
        const infoDesc = stringAt(infoData, 'description') || stringAt(infoData, 'desc');
        if (infoDesc) desc = infoDesc;

        images.push(...extractImageInfos(at(infoData, 'imageInfos')));
        const majorPic = stripTaobaoThumbSuffix(ensureHttps(stringAt(infoData, 'absoluteMajorPicture')));
        if (majorPic) coverUrl = majorPic;
        else if (images[0]) coverUrl = images[0];

        videoUrl = extractDeepVideoUrl(infoData);
        authorInfo = extractSellerAuthor(infoData);
      }

      if (!this.#terminalError && (!authorInfo || !videoUrl || images.length === 0)) {
        const detail = await this.#fetchMtop(MTOP_AWESOME_DETAIL_API, { itemId });
        const detailData = record(at(detail, 'data'));
        if (Object.keys(detailData).length > 0) {
          const itemDo = record(detailData.itemDO);
          if ((!title || title.startsWith('闲鱼商品 (')) && stringAt(itemDo, 'title')) {
            title = stringAt(itemDo, 'title');
          }
          if (!desc) {
            desc = stringAt(itemDo, 'desc') || stringAt(itemDo, 'description');
          }
          if (images.length === 0) {
            images.push(...extractImageInfos(at(itemDo, 'imageInfos')));
          }
          if (!coverUrl && images[0]) {
            coverUrl = images[0];
          }
          if (!authorInfo) {
            authorInfo = extractSellerAuthor(detailData);
          }
          if (!videoUrl) {
            videoUrl = extractDeepVideoUrl(detailData);
          }
        }
      }
    }

    if (html && images.length === 0 && !videoUrl && !this.#terminalError) {
      const ssrFallback = extractSsrFallback(html);
      if (ssrFallback.title && (!title || title.startsWith('闲鱼商品 ('))) {
        title = ssrFallback.title;
      }
      if (!desc && ssrFallback.desc) desc = ssrFallback.desc;
      if (ssrFallback.images.length > 0) images.push(...ssrFallback.images);
      if (!coverUrl && ssrFallback.coverUrl) coverUrl = ssrFallback.coverUrl;
      if (!videoUrl && ssrFallback.videoUrl) videoUrl = ssrFallback.videoUrl;
      if (!authorInfo && ssrFallback.author) authorInfo = ssrFallback.author;
    }

    const imageList = uniqueStrings(images);
    const resolvedCover = coverUrl || imageList[0] || '';

    return result({
      title: title || desc,
      desc: desc || null,
      videoUrl: videoUrl || null,
      videoList: videoUrl ? [videoUrl] : [],
      coverUrl: resolvedCover || null,
      imageList,
      author: authorInfo,
      ...(this.#cookieRequired ? { cookieRequired: true } : {}),
      ...(this.#terminalError ? { terminalError: this.#terminalError } : {}),
    });
  }

  async #fetchMtop(api: string, payload: Record<string, string>): Promise<unknown> {
    const dataStr = JSON.stringify(payload);
    for (const host of ['h5api.m.goofish.com', 'acs.m.goofish.com'] as const) {
      const mtopUrl = `https://${host}/h5/${api}/1.0/`;
      try {
        if (!this.#mtopToken) {
          await this.#refreshMtopToken(mtopUrl, api, dataStr);
        }
        let response = await this.#signedMtopRequest(mtopUrl, api, dataStr);
        const firstRet = stringAt(response, 'ret', 0);
        if (isTokenExpiredRet(firstRet)) {
          await this.#refreshMtopToken(mtopUrl, api, dataStr);
          response = await this.#signedMtopRequest(mtopUrl, api, dataStr);
        }
        const retCode = stringAt(response, 'ret', 0);
        if (
          retCode.includes('FAIL_BIZ_ITEM_DEL_NOT_FOUND') ||
          retCode.includes('FAIL_BIZ_ITEM_QUERY_FAILED')
        ) {
          this.#terminalError = {
            code: 'MEDIA_DELETED_OR_PRIVATE',
            message: '该宝贝不存在或已被卖家删除/下架',
          };
          return {};
        }
        if (retCode.includes('RGV587_ERROR') || retCode.includes('FAIL_SYS_USER_VALIDATE')) {
          this.#cookieRequired = true;
          return {};
        }
        if (Object.keys(record(at(response, 'data'))).length > 0) {
          return response;
        }
      } catch {
        // Try alternate MTOP gateway host if primary fails.
      }
    }
    return {};
  }

  async #refreshMtopToken(mtopUrl: string, api: string, dataStr: string): Promise<void> {
    const preflight = await this.context.session.request(mtopUrl, {
      searchParams: {
        jsv: MTOP_JSV,
        appKey: MTOP_APP_KEY,
        t: String(Date.now()),
        sign: 'dummy',
        api,
        v: '1.0',
        type: 'originaljson',
        dataType: 'json',
        data: dataStr,
      },
      headers: MTOP_HEADERS,
      signal: this.context.signal,
    });
    const setCookies = preflight.headers['set-cookie'];
    const rawList = Array.isArray(setCookies) ? setCookies : setCookies ? [setCookies] : [];
    const pairs: string[] = [];
    for (const entry of rawList) {
      const firstPart = entry.split(';')[0]?.trim() ?? '';
      if (!firstPart) continue;
      pairs.push(firstPart);
      if (firstPart.startsWith('_m_h5_tk=')) {
        const cookieVal = firstPart.slice('_m_h5_tk='.length);
        this.#mtopToken = cookieVal.split('_')[0] ?? '';
        await this.#safeSetCookie(entry, mtopUrl);
      } else if (firstPart.startsWith('_m_h5_tk_enc=')) {
        await this.#safeSetCookie(entry, mtopUrl);
      }
    }
    if (pairs.length > 0) {
      this.#cookieHeader = pairs.join('; ');
    }
  }

  async #safeSetCookie(rawCookie: string, url: string): Promise<void> {
    const maybeSession = this.context.session as unknown as {
      setCookie?: (cookie: string, targetUrl: string) => Promise<void>;
    };
    if (typeof maybeSession.setCookie === 'function') {
      try {
        await maybeSession.setCookie(rawCookie, url);
      } catch {
        // Ignore cookie jar errors on mock sessions.
      }
    }
  }

  async #signedMtopRequest(mtopUrl: string, api: string, dataStr: string): Promise<unknown> {
    const timestamp = String(Date.now());
    const signInput = `${this.#mtopToken}&${timestamp}&${MTOP_APP_KEY}&${dataStr}`;
    const sign = createHash('md5').update(signInput, 'utf8').digest('hex');
    return this.context.session.getJson<unknown>(mtopUrl, {
      searchParams: {
        jsv: MTOP_JSV,
        appKey: MTOP_APP_KEY,
        t: timestamp,
        sign,
        api,
        v: '1.0',
        type: 'originaljson',
        dataType: 'json',
        data: dataStr,
      },
      headers: {
        ...MTOP_HEADERS,
        ...(this.#cookieHeader ? { cookie: this.#cookieHeader } : {}),
      },
      signal: this.context.signal,
    });
  }
}

function isTokenExpiredRet(retCode: string): boolean {
  return (
    retCode.includes('TOKEN_EMPTY') ||
    retCode.includes('TOKEN_EXOIRED') ||
    retCode.includes('TOKEN_EXPIRED') ||
    retCode.includes('ILLEGAL_ACCESS')
  );
}

function extractShortlinkTarget(html: string): string {
  if (!html) return '';
  return /var\s+url\s*=\s*['"]([^'"]+)['"]/u.exec(html)?.[1] ?? '';
}

function safeParseUrl(raw: string): URL | null {
  if (!raw) return null;
  try {
    return new URL(raw);
  } catch {
    return null;
  }
}

function extractImageInfos(imageInfosNode: unknown): string[] {
  const urls: string[] = [];
  for (const item of array(imageInfosNode)) {
    const rawUrl = typeof item === 'string'
      ? item
      : stringAt(item, 'url') || stringAt(item, 'imageUrl');
    if (!rawUrl) continue;
    const cleaned = stripTaobaoThumbSuffix(ensureHttps(rawUrl));
    if (cleaned) urls.push(cleaned);
  }
  return urls;
}

function stripTaobaoThumbSuffix(url: string): string {
  if (!url) return '';
  const queryIndex = url.indexOf('?');
  const pathPart = queryIndex >= 0 ? url.slice(0, queryIndex) : url;
  const queryPart = queryIndex >= 0 ? url.slice(queryIndex) : '';
  const underscoreIndex = pathPart.lastIndexOf('_');
  if (underscoreIndex < 0) return url;
  const tail = pathPart.slice(underscoreIndex + 1);
  if (/^\d+x\d+[a-z0-9]{0,16}\.(?:jpg|jpeg|png|webp)$/iu.test(tail)) {
    const before = pathPart.slice(0, underscoreIndex);
    if (/\.(?:jpg|jpeg|png|webp)$/iu.test(before)) {
      return `${before}${queryPart}`;
    }
  }
  return url;
}

function extractSellerAuthor(data: Record<string, unknown>): AuthorInfo | null {
  const sellerDo = record(data.sellerDO);
  let unmaskedNick = '';
  const components = array(at(data, 'flowData', 'floating', 'components'));
  for (const comp of components) {
    const compData = record(at(comp, 'data'));
    const candidate = string(compData.nick) || string(compData.userNick);
    if (candidate && !candidate.includes('*')) {
      unmaskedNick = candidate;
      break;
    }
  }
  const nickname = unmaskedNick ||
    string(sellerDo.nick) ||
    string(sellerDo.sellerNick) ||
    string(data.userNick);
  const sellerId = idAt(sellerDo, 'sellerId') || idAt(sellerDo, 'userId') || idAt(data, 'sellerId');
  const avatar = ensureHttps(
    string(sellerDo.portraitUrl) || string(sellerDo.avatar) || string(data.sellerAvatar),
  );
  return author(nickname, sellerId, avatar);
}

function extractDeepVideoUrl(value: unknown): string {
  const stack: unknown[] = [value];
  const videoKeys = new Set(['videoUrl', 'mainVideoUrl', 'video_url', 'video', 'playUrl']);

  while (stack.length > 0) {
    const current = stack.pop();
    if (Array.isArray(current)) {
      for (let idx = current.length - 1; idx >= 0; idx -= 1) {
        stack.push(current[idx]);
      }
      continue;
    }
    if (!current || typeof current !== 'object') continue;
    for (const [key, child] of Object.entries(current)) {
      if (videoKeys.has(key) && typeof child === 'string') {
        const normalized = ensureHttps(child);
        if (normalized.startsWith('https://')) return normalized;
      }
      if (child && typeof child === 'object') {
        stack.push(child);
      }
    }
  }
  return '';
}

function extractSsrFallback(html: string): {
  title: string;
  desc: string;
  coverUrl: string;
  videoUrl: string;
  images: string[];
  author: AuthorInfo | null;
} {
  const $ = load(html);
  let ssrState: unknown = {};
  const nextRaw = $('#__NEXT_DATA__').html();
  if (nextRaw) {
    try {
      ssrState = parseJson(nextRaw);
    } catch {
      ssrState = {};
    }
  }
  if (Object.keys(record(ssrState)).length === 0 && html.includes('window.__INITIAL_STATE__')) {
    ssrState = extractAssignedJson(html, 'window.__INITIAL_STATE__');
  }

  const itemNode = Object.keys(record(at(ssrState, 'props', 'pageProps', 'item'))).length > 0
    ? record(at(ssrState, 'props', 'pageProps', 'item'))
    : record(at(ssrState, 'itemDO'));

  const ogTitle = $('meta[property="og:title"]').attr('content')?.trim() ?? '';
  const ogDesc = $('meta[property="og:description"]').attr('content')?.trim() ?? '';
  const ogImage = ensureHttps($('meta[property="og:image"]').attr('content')?.trim() ?? '');

  const images = extractImageInfos(itemNode.imageInfos);
  if (images.length === 0 && ogImage.startsWith('https://')) {
    images.push(stripTaobaoThumbSuffix(ogImage));
  }

  return {
    title: string(itemNode.title) || ogTitle,
    desc: string(itemNode.desc) || string(itemNode.description) || ogDesc,
    coverUrl: images[0] ?? ogImage,
    videoUrl: extractDeepVideoUrl(ssrState),
    images,
    author: extractSellerAuthor(record(ssrState)),
  };
}

function ensureHttps(value: string): string {
  const trimmed = value.trim().replaceAll('\\u002F', '/');
  if (trimmed.startsWith('//')) return `https:${trimmed}`;
  if (trimmed.startsWith('http://')) return `https://${trimmed.slice(7)}`;
  return trimmed;
}

registerParser('xianyu', {
  factory: (context) => new XianyuParser(context),
  allowedHosts: ['h5api.m.goofish.com', 'acs.m.goofish.com', 'h5api.m.taobao.com'],
});
