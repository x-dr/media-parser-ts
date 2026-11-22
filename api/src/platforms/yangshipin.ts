import { Buffer } from 'node:buffer';
import { createCipheriv, randomUUID } from 'node:crypto';
import { load } from 'cheerio';
import { DEFAULT_MOBILE_USER_AGENT } from '../config/user-agents.js';
import { ProxyAttemptError, safeErrorDetails } from '../core/errors.js';
import type { AuthorInfo, MediaResult } from '../core/media-result.js';
import type { ParseContext } from '../core/parse-context.js';
import type { PlatformParser } from '../core/parser.js';
import { registerParser } from '../core/parser-registry.js';
import {
  array,
  at,
  author,
  extractAssignedJson,
  idAt,
  parseJson,
  protocolUrl,
  record,
  result,
  stringAt,
  uniqueStrings,
} from './data.js';

const PLAYVINFO_API = 'https://playvv.yangshipin.cn/playvinfo';
const ARTICLE_INFO_APIS = [
  'https://comment.yangshipin.cn/web/article/article_info',
  'https://h5access.yangshipin.cn/web/article/article_info',
] as const;

const ARTICLE_VAPPID = '59306155';
const ARTICLE_VSECRET = 'b42702bf7309a179d102f3d51b1add2fda0bc7ada64cb801';

const CKEY_AES_KEY = Buffer.from('4e2918885fd98109869d14e0231a0bf4', 'hex');
const CKEY_AES_IV = Buffer.from('16b17e519ddd0ce5b79d7a63a4dd801c', 'hex');

const ARTICLE_ID_IN_URL_PATTERN = /article(?:id)?=([0-9a-zA-Z_]+)/iu;
const VID_IN_URL_PATTERN = /[?&]vid=([0-9a-zA-Z_]+)/u;
const VID_IN_HTML_PATTERN = /["']vid["']\s*:\s*["']([0-9a-zA-Z_]+)["']/u;

export interface YangshipinParserOptions {
  uuid?: () => string;
  now?: () => number;
}

interface MutableYangshipinState {
  vid: string;
  articleId: string;
  title: string;
  desc: string | null;
  coverUrl: string;
  videoUrl: string;
  videoList: string[];
  audioUrl: string;
  imageList: string[];
  author: AuthorInfo | null;
}

export class YangshipinParser implements PlatformParser {
  public readonly platform = 'yangshipin' as const;
  readonly #uuid: () => string;
  readonly #now: () => number;

  public constructor(
    private readonly context: ParseContext,
    options: YangshipinParserOptions = {},
  ) {
    this.#uuid = options.uuid ?? (() => randomUUID().replaceAll('-', ''));
    this.#now = options.now ?? Date.now;
  }

  public async parse(): Promise<MediaResult> {
    let currentUrl = new URL(this.context.realUrl.href);
    const state: MutableYangshipinState = {
      vid: extractVidParam(currentUrl),
      articleId: extractArticleIdParam(currentUrl),
      title: '',
      desc: null,
      coverUrl: '',
      videoUrl: '',
      videoList: [],
      audioUrl: '',
      imageList: [],
      author: null,
    };

    let html = await this.#fetchPageHtml(currentUrl);
    if (!html) {
      if (state.articleId) {
        await this.#fetchArticleInfo(state.articleId, state);
      } else if (state.vid) {
        await this.#fetchVideoUrlByVid(state.vid, state);
      }
      return finalizeResult(state);
    }

    const metaRedirect = extractMetaRefreshUrl(html);
    if (metaRedirect) {
      const resolvedRedirect = metaRedirect.startsWith('/')
        ? new URL(metaRedirect, 'https://m.yangshipin.cn')
        : safeParseUrl(metaRedirect);
      if (resolvedRedirect) {
        currentUrl = resolvedRedirect;
        if (!state.vid || state.vid === '5Sqx') {
          state.vid = extractVidParam(currentUrl);
        }
        if (!state.articleId) {
          state.articleId = extractArticleIdParam(currentUrl);
        }
        html = await this.#fetchPageHtml(currentUrl);
        if (!html) {
          if (state.articleId) {
            await this.#fetchArticleInfo(state.articleId, state);
          } else if (state.vid) {
            await this.#fetchVideoUrlByVid(state.vid, state);
          }
          return finalizeResult(state);
        }
      }
    }

    if (!state.articleId && currentUrl.pathname.includes('article')) {
      state.articleId = ARTICLE_ID_IN_URL_PATTERN.exec(currentUrl.href)?.[1] ?? '';
    }

    if (state.articleId) {
      await this.#fetchArticleInfo(state.articleId, state);
    }

    this.#parseHtmlMetadata(html, currentUrl, state);

    if (state.vid && !state.videoUrl) {
      await this.#fetchVideoUrlByVid(state.vid, state);
    }

    return finalizeResult(state);
  }

  async #fetchPageHtml(url: URL): Promise<string> {
    try {
      return await this.context.session.getText(url, {
        headers: {
          'user-agent': DEFAULT_MOBILE_USER_AGENT,
          referer: 'https://m.yangshipin.cn/',
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
          error_category: 'page_html_failed',
          upstream_host: url.hostname,
          ...safeErrorDetails(error),
        },
        'failed to fetch Yangshipin HTML content',
      );
      return '';
    }
  }

  #parseHtmlMetadata(html: string, currentUrl: URL, state: MutableYangshipinState): void {
    const landscapeState = extractAssignedJson(html, 'window.__STATE_video__');
    const shareVideo = at(landscapeState, 'payloads', 'sharevideo');
    if (Object.keys(record(shareVideo)).length > 0) {
      if (!state.vid) state.vid = stringAt(shareVideo, 'vid');
      if (!state.title) state.title = stringAt(shareVideo, 'title').trim();
      if (!state.coverUrl) state.coverUrl = stringAt(shareVideo, 'cover_pic');
      const authorName = stringAt(shareVideo, 'om_info', 'title');
      if (authorName && !state.author) {
        state.author = author(authorName, '', '');
      }
    }

    const portraitState = extractAssignedJson(html, 'window.__STATE_portrait_video__');
    const portraitItems = array(at(portraitState, 'payloads', 'videoDataList', 'items'));
    if (portraitItems.length > 0) {
      const videoData = at(portraitItems[0], 'videoData');
      if (!state.vid) state.vid = stringAt(videoData, 'vid');
      if (!state.title) state.title = stringAt(videoData, 'title').trim();
      if (!state.coverUrl) {
        state.coverUrl =
          stringAt(videoData, 'shareItem', 'shareImgUrl') ||
          stringAt(videoData, 'poster', 'poster', 'imageUrl');
      }
      const actor = at(videoData, 'detailFollowItem', 'actorItem');
      if (Object.keys(record(actor)).length > 0 && !state.author) {
        const nickName = stringAt(actor, 'nickName', 'text') || stringAt(actor, 'nickName');
        const headUrl = stringAt(actor, 'headUrl');
        state.author = author(nickName, '', headUrl);
      }
    }

    if (!state.title || !state.coverUrl) {
      const $ = load(html);
      if (!state.title) {
        const ogTitle = ($('meta[property="og:title"]').attr('content') ?? '').trim();
        const pageTitle = $('title').first().text().trim();
        state.title = ogTitle || pageTitle;
      }
      if (!state.coverUrl) {
        const ogImg = ($('meta[property="og:image"]').attr('content') ?? '').trim();
        if (ogImg) state.coverUrl = ogImg;
      }
    }

    if (!state.vid && !state.articleId) {
      state.vid =
        VID_IN_URL_PATTERN.exec(currentUrl.href)?.[1] ??
        VID_IN_HTML_PATTERN.exec(html)?.[1] ??
        '';
    }
  }

  async #fetchVideoUrlByVid(vid: string, state: MutableYangshipinState): Promise<void> {
    if (!vid) return;

    const guid = this.#uuid();
    const headers = {
      'user-agent': DEFAULT_MOBILE_USER_AGENT,
      referer: 'https://m.yangshipin.cn/',
      accept: '*/*',
    };

    try {
      const probeRaw = await this.context.session.getText(PLAYVINFO_API, {
        searchParams: {
          vid,
          platform: '4330701',
          otype: 'json',
        },
        headers,
        signal: this.context.signal,
        timeoutMs: 5_000,
      });
      const probeData = parsePlayvinfoJson(probeRaw);
      const curTime = idAt(probeData, 'curTime') || String(Math.floor(this.#now() / 1000));

      const cKey = generateYangshipinCkey(vid, curTime, guid);
      const vinfoRaw = await this.context.session.getText(PLAYVINFO_API, {
        searchParams: {
          charge: '0',
          defaultfmt: 'auto',
          otype: 'json',
          guid,
          flowid: `${guid}_4330701`,
          platform: '4330701',
          sdtfrom: 'v7007',
          defnpayver: '1',
          appVer: '1.3.5',
          host: 'm.yangshipin.cn',
          ehost: `https://m.yangshipin.cn/portrait_video?vid=${vid}`,
          refer: 'm.yangshipin.cn',
          sphttps: '1',
          sphls: '1',
          _rnd: curTime,
          spwm: '4',
          vid,
          defn: 'fhd',
          encryptVer: '8.1',
          cKey,
        },
        headers,
        signal: this.context.signal,
        timeoutMs: 5_000,
      });

      const data = parsePlayvinfoJson(vinfoRaw);
      const viList = array(at(data, 'vl', 'vi'));
      if (viList.length === 0) return;

      const vi = viList[0];
      const baseUrl = stringAt(vi, 'ul', 'ui', 0, 'url').trim();
      const fn = stringAt(vi, 'fn').trim();
      const fvkey = stringAt(vi, 'fvkey').trim();

      if (baseUrl && fn && fvkey) {
        state.videoUrl = `${baseUrl}${fn}?vkey=${fvkey}&platform=2`;
      } else if (baseUrl && (baseUrl.includes('.m3u8') || baseUrl.includes('.mp4'))) {
        state.videoUrl = baseUrl;
      }

      if (!state.title) {
        const videoTitle = stringAt(vi, 'ti').trim();
        if (videoTitle) state.title = videoTitle;
      }
    } catch (error) {
      if (error instanceof ProxyAttemptError) throw error;
      this.context.logger.warn(
        {
          platform_id: this.platform,
          error_category: 'playvinfo_failed',
          vid,
          ...safeErrorDetails(error),
        },
        'failed to fetch video stream from Yangshipin playvinfo',
      );
    }
  }

  async #fetchArticleInfo(articleId: string, state: MutableYangshipinState): Promise<void> {
    if (!articleId) return;

    const params = {
      vappid: ARTICLE_VAPPID,
      vsecret: ARTICLE_VSECRET,
      raw: '1',
      targetId: '1',
      id: articleId,
    };
    const headers = {
      'user-agent': DEFAULT_MOBILE_USER_AGENT,
      referer: 'https://m.yangshipin.cn/',
      accept: 'application/json, text/plain, */*',
    };

    for (const apiUrl of ARTICLE_INFO_APIS) {
      try {
        const resJson = await this.context.session.getJson<unknown>(apiUrl, {
          searchParams: params,
          headers,
          signal: this.context.signal,
          timeoutMs: 5_000,
        });
        const data = at(resJson, 'data');
        if (Object.keys(record(data)).length === 0 || at(data, 'errCode') !== 0) {
          continue;
        }

        const head = at(data, 'head');
        if (!state.title) {
          state.title = stringAt(head, 'title').trim();
        }
        if (!state.coverUrl) {
          state.coverUrl = stringAt(head, 'coverImage').trim();
        }
        const source = stringAt(head, 'source').trim();
        if (source && !state.author) {
          state.author = author(source, '', '');
        }

        const contentObj = at(data, 'content');
        for (const img of array(at(contentObj, 'images'))) {
          if (typeof img === 'string') {
            const cleaned = protocolUrl(img.trim());
            if (cleaned && !state.imageList.includes(cleaned)) {
              state.imageList.push(cleaned);
            }
          }
        }

        const rawHtml = stringAt(contentObj, 'content');
        if (rawHtml) {
          state.desc = cleanYangshipinArticleHtml(rawHtml);
        }

        const audioCapsule = at(data, 'audioCapsule');
        const capsuleUrl = stringAt(audioCapsule, 'audioUrl').trim();
        if (capsuleUrl) {
          state.audioUrl = protocolUrl(capsuleUrl);
        } else if (typeof audioCapsule === 'string' && audioCapsule.startsWith('http')) {
          state.audioUrl = audioCapsule.trim();
        }

        const embeddedVids = extractEmbeddedVids(at(contentObj, 'videos'), rawHtml);
        if (embeddedVids.length > 0) {
          if (!state.vid) {
            state.vid = embeddedVids[0] ?? '';
          }
          for (const embeddedVid of embeddedVids) {
            await this.#fetchVideoUrlByVid(embeddedVid, state);
            if (state.videoUrl && !state.videoList.includes(state.videoUrl)) {
              state.videoList.push(state.videoUrl);
            }
          }
          if (state.videoList[0]) {
            state.videoUrl = state.videoList[0];
          }
        }
        return;
      } catch (error) {
        if (error instanceof ProxyAttemptError) throw error;
        this.context.logger.warn(
          {
            platform_id: this.platform,
            error_category: 'article_info_failed',
            article_id: articleId,
            upstream_endpoint: apiUrl,
            ...safeErrorDetails(error),
          },
          'failed to fetch Yangshipin article info',
        );
      }
    }
  }
}

export function generateYangshipinCkey(
  vid: string,
  rnd: string,
  guid: string,
  platform = '4330701',
  appVer = '1.3.5',
): string {
  const part1 = `|${vid}|${rnd}|mg3c3b04ba|${appVer}|${guid}|${platform}|`;
  const part2 = 'https://m.yangshipin.cn/|mozilla/5.0 (iphone; cpu||Mozilla|Netscape|iPhone|';
  const tr = part1 + part2;

  let pr = 0;
  for (const ch of tr) {
    pr = (((pr << 5) - pr) + (ch.codePointAt(0) ?? 0)) | 0;
  }

  const ur = `|${pr}${tr}`;
  const cipher = createCipheriv('aes-128-cbc', CKEY_AES_KEY, CKEY_AES_IV);
  const encrypted = Buffer.concat([cipher.update(ur, 'utf8'), cipher.final()]);
  return `--01${encrypted.toString('hex').toUpperCase()}`;
}

export function cleanYangshipinArticleHtml(htmlContent: string): string | null {
  if (!htmlContent) return null;
  const $ = load(htmlContent);
  $('script, style').remove();
  $('br').replaceWith('\n');
  $('p, div, h1, h2, h3, h4, h5, h6, li, section, article').append('\n');

  const lines: string[] = [];
  for (const line of $.text().replaceAll('\u00a0', ' ').split(/\r?\n/u)) {
    const cleanLine = line.replace(/[\t\f\v ]+/gu, ' ').trim();
    if (cleanLine) lines.push(cleanLine);
  }
  return lines.length > 0 ? lines.join('\n\n') : null;
}

function finalizeResult(state: MutableYangshipinState): MediaResult {
  const title = stripHtmlTags(state.title).trim();
  const coverUrl = protocolUrl(state.coverUrl.trim());
  const videoUrl = protocolUrl(state.videoUrl.trim());
  const audioUrl = protocolUrl(state.audioUrl.trim());
  const videoList = uniqueStrings(state.videoList.map((item) => protocolUrl(item.trim())));
  const imageList = uniqueStrings(state.imageList.map((item) => protocolUrl(item.trim())));

  if (!videoUrl && imageList.length === 0 && coverUrl) {
    imageList.push(coverUrl);
  }

  return result({
    title,
    desc: state.desc,
    videoUrl: videoUrl || null,
    videoList,
    audioUrl: audioUrl || null,
    coverUrl: coverUrl || null,
    author: state.author,
    imageList,
  });
}

function extractVidParam(url: URL): string {
  return (url.searchParams.get('vid') ?? '').trim();
}

function extractArticleIdParam(url: URL): string {
  return (
    url.searchParams.get('articleid') ||
    url.searchParams.get('articleId') ||
    url.searchParams.get('id') ||
    ''
  ).trim();
}

function extractMetaRefreshUrl(html: string): string {
  if (!html) return '';
  const $ = load(html);
  let redirectUrl = '';
  $('meta').each((_index, element) => {
    if (redirectUrl) return;
    const equiv = ($(element).attr('http-equiv') ?? '').toLowerCase();
    if (equiv !== 'refresh') return;
    const content = $(element).attr('content') ?? '';
    const match = /;\s*url\s*=\s*(.+)$/iu.exec(content);
    if (match?.[1]) {
      redirectUrl = match[1].trim().replace(/^['"]|['"]$/gu, '').trim();
    }
  });
  return redirectUrl;
}

function extractEmbeddedVids(rawVideos: unknown, rawHtml: string): string[] {
  const vids: string[] = [];
  for (const item of array(rawVideos)) {
    if (typeof item === 'string' && item.trim()) {
      vids.push(item.trim());
    } else {
      const vid = stringAt(item, 'vid').trim();
      if (vid) vids.push(vid);
    }
  }
  if (vids.length === 0 && rawHtml) {
    const $ = load(rawHtml);
    $('cctv_video').each((_index, element) => {
      const vid = ($(element).attr('id') ?? '').trim();
      if (vid) vids.push(vid);
    });
  }
  return uniqueStrings(vids);
}

function parsePlayvinfoJson(raw: string): unknown {
  let text = raw.trim().replace(/;+$/u, '').trim();
  const openParen = text.indexOf('(');
  const closeParen = text.lastIndexOf(')');
  if (!text.startsWith('{') && openParen >= 0 && closeParen > openParen) {
    text = text.slice(openParen + 1, closeParen).trim();
  }
  return parseJson(text);
}

function safeParseUrl(raw: string): URL | null {
  try {
    return new URL(raw);
  } catch {
    return null;
  }
}

function stripHtmlTags(input: string): string {
  return input.replace(/<[^>]+>/gu, '');
}

registerParser('yangshipin', {
  factory: (context) => new YangshipinParser(context),
  allowedHosts: [
    'playvv.yangshipin.cn',
    'play.yangshipin.cn',
    'comment.yangshipin.cn',
    'h5access.yangshipin.cn',
    'capi.yangshipin.cn',
    'm.yangshipin.cn',
    'yangshipin.cn',
    'www.yangshipin.cn',
    'yspapp.cn',
    'www.yspapp.cn',
    '*.yangshipin.cn',
    '*.yspapp.cn',
  ],
});
