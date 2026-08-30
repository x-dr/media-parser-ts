import { load } from 'cheerio';
import type { ParseContext } from '../core/parse-context.js';
import type { PlatformParser } from '../core/parser.js';
import { registerParser } from '../core/parser-registry.js';
import { readJson, readJsonp } from '../http/response-reader.js';
import { array, at, author, protocolUrl, record, result, string, stringAt, uniqueStrings } from './data.js';

const BASE62_ALPHABET = '0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ';

class WeiboParser implements PlatformParser {
  public readonly platform = 'weibo' as const;
  public constructor(private readonly context: ParseContext) {}

  public async parse(): Promise<ReturnType<typeof result>> {
    const videoOid = extractVideoOid(this.context.realUrl);
    const numericId = extractWeiboId(this.context.realUrl);
    let post: unknown = {};
    if (videoOid) post = await this.#videoPageData(videoOid);
    if (Object.keys(record(post)).length === 0 && numericId) post = await this.#statusData(numericId);
    const urls = Object.values(record(at(post, 'urls'))).map((value) => string(value)).filter(Boolean);
    const media = at(post, 'page_info', 'media_info');
    let videoUrl = (urls[0] ?? stringAt(media, 'mp4_hd_url')) || stringAt(media, 'mp4_sd_url') ||
      stringAt(media, 'stream_url_hd') || stringAt(media, 'stream_url');
    if (!videoUrl) {
      for (const playback of array(at(media, 'playback_list'))) {
        videoUrl = stringAt(playback, 'play_info', 'url');
        if (videoUrl) break;
      }
    }
    const rawTitle = stringAt(post, 'text_raw') || stringAt(post, 'text') ||
      stringAt(post, 'content') || stringAt(post, 'title');
    const user = at(post, 'user');
    return result({
      title: load(rawTitle).text(),
      videoUrl: videoUrl ? protocolUrl(videoUrl) : null,
      coverUrl: protocolUrl(stringAt(post, 'cover_image')) ||
        stringAt(post, 'page_info', 'page_pic', 'url') || null,
      imageList: uniqueStrings(array(at(post, 'pics')).map((picture) => stringAt(picture, 'large', 'url'))),
      author: author(
        at(user, 'screen_name') || at(post, 'author'),
        at(user, 'id') || at(post, 'author_id'),
        at(user, 'avatar_hd') || at(user, 'profile_image_url') || at(post, 'avatar'),
      ),
    });
  }

  async #statusData(numericId: string): Promise<unknown> {
    try {
      const url = new URL('https://m.weibo.cn/statuses/show');
      url.searchParams.set('id', numericId);
      const response = await this.context.session.getJson<unknown>(url, {
        headers: {
          accept: 'application/json, text/plain, */*', 'mweibo-pwa': '1',
          'x-requested-with': 'XMLHttpRequest', referer: `https://m.weibo.cn/detail/${numericId}`,
        },
        signal: this.context.signal,
      });
      if (at(response, 'ok') === 1) return at(response, 'data');
    } catch {
      // Continue through the public HTML and PC Ajax fallbacks.
    }
    try {
      const html = await this.context.session.getText(`https://m.weibo.cn/detail/${numericId}`, {
        signal: this.context.signal,
      });
      const match = /\$render_data\s*=\s*\[(.*?)\]\[0\]\s*\|\|/su.exec(html)?.[1];
      if (match) return at(JSON.parse(match) as unknown, 'status');
    } catch {
      // Continue to the final PC Ajax fallback.
    }
    try {
      return await this.context.session.getJson<unknown>(
        `https://weibo.com/ajax/statuses/show?id=${numericId}`,
        { headers: { referer: 'https://weibo.com/' }, signal: this.context.signal },
      );
    } catch {
      return {};
    }
  }

  async #videoPageData(videoOid: string): Promise<unknown> {
    const headers = { referer: 'https://weibo.com/' };
    const fingerprint = JSON.stringify({
      os: '1', browser: 'Chrome', fonts: 'undefined', screenInfo: '1440*900*24', plugins: '',
      ls: 'undefined', wh: '', version: '1.0.0', vendor: 'Google Inc.', ua: 'Mozilla/5.0',
    });
    try {
      const first = await this.context.session.request('https://passport.weibo.com/visitor/genvisitor', {
        searchParams: { cb: 'parser_callback', fp: fingerprint }, headers, signal: this.context.signal,
      });
      const tid = stringAt(readJsonp<unknown>(first), 'data', 'tid');
      if (!tid) return {};
      const visitor = await this.context.session.request('https://passport.weibo.com/visitor/visitor', {
        searchParams: {
          a: 'incarnate', t: tid, w: '2', c: '095', gc: '', cb: 'parser_callback',
          from: 'weibo', _rand: Math.random(),
        },
        headers,
        signal: this.context.signal,
      });
      if (at(readJsonp<unknown>(visitor), 'retcode') !== 20_000_000) return {};
      const payload = JSON.stringify({ Component_Play_Playinfo: { oid: videoOid } });
      const component = await this.context.session.request('https://weibo.com/tv/api/component', {
        method: 'POST',
        headers: {
          referer: this.context.realUrl.href,
          'page-referer': this.context.realUrl.pathname,
          'content-type': 'application/x-www-form-urlencoded',
        },
        form: { data: payload },
        signal: this.context.signal,
      });
      const response = readJson<unknown>(component);
      return at(response, 'code') === '100000' ? at(response, 'data', 'Component_Play_Playinfo') : {};
    } catch {
      return {};
    }
  }
}

export function extractVideoOid(url: URL): string {
  const fid = url.searchParams.get('fid') ?? '';
  if (/^\d+:\d+$/u.test(fid)) return fid;
  return /\/(?:tv\/)?show\/(\d+:\d+)/u.exec(url.pathname)?.[1] ?? '';
}

export function extractWeiboId(url: URL): string {
  const fid = url.searchParams.get('fid') ?? '';
  const fidId = /^\d+:(\d+)$/u.exec(fid)?.[1];
  if (fidId) return fidId;
  const videoId = /\/(?:tv\/)?show\/\d+:(\d+)/u.exec(url.pathname)?.[1];
  if (videoId) return videoId;
  const pathParts = url.pathname.split('/').filter(Boolean);
  let segment = '';
  if (url.hostname.endsWith('weibo.com') && pathParts.length >= 2 && /^\d+$/u.test(pathParts[0] ?? '')) {
    segment = pathParts[1] ?? '';
  } else if (['status', 'detail'].includes(pathParts[0] ?? '')) {
    segment = pathParts[1] ?? '';
  }
  segment ||= url.searchParams.get('id') ?? '';
  if (!segment) segment = pathParts.find((part) => /^[A-Za-z0-9]{9}$/u.test(part)) ?? '';
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
