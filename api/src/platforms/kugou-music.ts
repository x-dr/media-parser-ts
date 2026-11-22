import { createHash } from 'node:crypto';
import { DEFAULT_MOBILE_USER_AGENT } from '../config/user-agents.js';
import { ProxyAttemptError } from '../core/errors.js';
import type { MediaResult } from '../core/media-result.js';
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
  record,
  result,
  sanitizeJsObjectLiteral,
  string,
  stringAt,
  uniqueStrings,
} from './data.js';

const MV_API_URL = 'https://m3ws.kugou.com/api/v1/mv/infov2';
const SIGNATURE_SALT = 'NVPh5oo715z5DIWAeQlhMDsWXXQV4hwt';
const DESKTOP_MV_RE = /\/mvweb\/html\/mv_([0-9a-f]{32})\.html/iu;
const SHARE_CHAIN_RE = /\/share\/([a-zA-Z0-9_-]+)\.html/u;

interface DetectedKugouMedia {
  mediaType: 'mv' | 'song' | null;
  contentId: string;
}

class KugouMusicParser implements PlatformParser {
  public readonly platform = 'kugou_music' as const;
  public constructor(private readonly context: ParseContext) {}

  public async parse(): Promise<MediaResult> {
    const { mediaType, contentId } = detectKugouMedia(this.context.realUrl);
    if (mediaType === 'mv' && contentId) {
      return this.#parseMv(contentId);
    }
    if (mediaType === 'song') {
      return this.#parseSongPage(contentId);
    }
    return result({});
  }

  async #parseMv(hash: string): Promise<MediaResult> {
    const timestamp = String(Date.now());
    const params: Record<string, string> = {
      cmd: '100',
      hash,
      ext: 'mp4',
      ismp3: '1',
      ssl: '1',
      srcappid: '2919',
      clientver: '20000',
      clienttime: timestamp,
      mid: timestamp,
      uuid: timestamp,
      dfid: '-',
    };
    params.signature = signKugouParams(params);

    let payload: unknown;
    try {
      payload = await this.context.session.getJson<unknown>(MV_API_URL, {
        searchParams: params,
        headers: kugouHeaders(),
        signal: this.context.signal,
      });
    } catch (error) {
      if (error instanceof ProxyAttemptError) throw error;
      return result({});
    }

    const root = record(payload);
    if (Object.keys(root).length === 0) return result({});
    const errcode = root.errcode;
    if (errcode !== undefined && errcode !== null && errcode !== 0) {
      return result({});
    }

    const title = string(root.songname);
    const rawCover = string(root.mvicon);
    const coverUrl = rawCover ? rawCover.replaceAll('{size}', '400') : null;
    const videoList = extractMvStreams(root.mvdata);

    return result({
      title,
      videoUrl: videoList[0] ?? null,
      videoList,
      coverUrl,
      author: author(root.singer, root.id, ''),
    });
  }

  async #parseSongPage(contentId: string): Promise<MediaResult> {
    let targetUrl = this.context.realUrl.href;
    if (contentId) {
      const shareUrl = new URL('https://m.kugou.com/share/song.html');
      shareUrl.searchParams.set('chain', contentId);
      targetUrl = shareUrl.href;
    }

    let html: string;
    try {
      html = await this.context.session.getText(targetUrl, {
        headers: kugouHeaders(),
        followRedirect: true,
        signal: this.context.signal,
      });
    } catch (error) {
      if (error instanceof ProxyAttemptError) throw error;
      if (targetUrl === this.context.realUrl.href) return result({});
      try {
        html = await this.context.session.getText(this.context.realUrl, {
          headers: kugouHeaders(),
          followRedirect: true,
          signal: this.context.signal,
        });
      } catch (fallbackError) {
        if (fallbackError instanceof ProxyAttemptError) throw fallbackError;
        return result({});
      }
    }

    const phpParam = record(extractPhpParam(html));
    if (Object.keys(phpParam).length > 0) {
      const data = record(at(phpParam, 'song_info', 'data'));
      const title = string(data.songName) || string(data.fileName);
      const rawCover = string(data.album_img) || string(data.imgUrl);
      const coverUrl = rawCover ? rawCover.replaceAll('{size}', '400') : null;

      let nickname = '';
      let authorId = '';
      let avatar = '';
      const firstAuthor = record(at(data, 'authors', 0));
      if (Object.keys(firstAuthor).length > 0) {
        nickname = string(firstAuthor.author_name) || string(firstAuthor.name);
        authorId = idAt(firstAuthor, 'author_id') || idAt(firstAuthor, 'id');
        avatar = string(firstAuthor.avatar).replaceAll('{size}', '400');
      } else if (string(data.singerName)) {
        nickname = string(data.singerName);
      }

      const hasError = Boolean(data.error);
      const payType = data.pay_type;
      const isFree = payType === undefined || payType === null || payType === 0 || payType === '0';
      const candidateUrl = string(data.url);
      const audioUrl = !hasError && isFree && isValidUrl(candidateUrl) ? candidateUrl : null;

      return result({
        title,
        audioUrl,
        coverUrl,
        author: author(nickname, authorId, avatar),
      });
    }

    const smartyList = extractAssignedArray(html, 'dataFromSmarty');
    const firstSmarty = record(smartyList[0]);
    if (Object.keys(firstSmarty).length > 0) {
      const title = string(firstSmarty.song_name) || string(firstSmarty.audio_name);
      return result({
        title,
        author: author(firstSmarty.author_name, firstSmarty.author_id, ''),
      });
    }

    return result({});
  }
}

export function detectKugouMedia(url: URL): DetectedKugouMedia {
  const desktopMv = DESKTOP_MV_RE.exec(url.pathname)?.[1];
  if (desktopMv) {
    return { mediaType: 'mv', contentId: desktopMv };
  }
  const pathLower = url.pathname.toLowerCase();
  if (pathLower.includes('/mv')) {
    return { mediaType: 'mv', contentId: url.searchParams.get('hash') ?? '' };
  }
  const chainPath = SHARE_CHAIN_RE.exec(url.pathname)?.[1];
  if (chainPath && !['song', 'default', 'index'].includes(chainPath.toLowerCase())) {
    return { mediaType: 'song', contentId: chainPath };
  }
  const chain = url.searchParams.get('chain') ?? '';
  if (chain) {
    return { mediaType: 'song', contentId: chain };
  }
  if (
    pathLower.includes('/share/song') ||
    pathLower.includes('/song') ||
    pathLower.includes('/share/default')
  ) {
    return { mediaType: 'song', contentId: '' };
  }
  return { mediaType: null, contentId: '' };
}

export function signKugouParams(params: Readonly<Record<string, string>>): string {
  const joined = Object.keys(params)
    .sort()
    .map((key) => `${key}=${params[key] ?? ''}`)
    .join('');
  return createHash('md5').update(`${SIGNATURE_SALT}${joined}${SIGNATURE_SALT}`).digest('hex');
}

function extractMvStreams(mvdata: unknown): string[] {
  const streams: string[] = [];
  for (const key of ['sq', 'rq', 'le', 'sd'] as const) {
    const item = record(at(mvdata, key));
    if (Object.keys(item).length === 0) continue;
    const candidates = [
      stringAt(item, 'downurl'),
      ...array(item.backupdownurl).map((entry) => string(entry)),
    ];
    const valid = candidates.find(isValidUrl);
    if (valid) streams.push(valid);
  }
  return uniqueStrings(streams);
}

function extractPhpParam(html: string): unknown {
  for (const marker of ['var phpParam', 'let phpParam', 'window.phpParam', 'phpParam']) {
    const parsed = extractAssignedJson(html, marker);
    if (Object.keys(record(parsed)).length > 0) return parsed;
  }
  return {};
}

function extractAssignedArray(html: string, marker: string): unknown[] {
  const markerIdx = html.indexOf(marker);
  if (markerIdx < 0) return [];
  const start = html.indexOf('[', markerIdx + marker.length);
  if (start < 0) return [];
  const slice = extractBalancedBrackets(html, start);
  if (!slice) return [];
  try {
    return array(parseJson(sanitizeJsObjectLiteral(slice)));
  } catch {
    return [];
  }
}

function extractBalancedBrackets(source: string, startIndex: number): string | null {
  if (source[startIndex] !== '[') return null;
  let depth = 0;
  let quote = '';
  let escaped = false;
  for (let idx = startIndex; idx < source.length; idx += 1) {
    const ch = source[idx] ?? '';
    if (quote) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === quote) quote = '';
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
    } else if (ch === '[') {
      depth += 1;
    } else if (ch === ']') {
      depth -= 1;
      if (depth === 0) return source.slice(startIndex, idx + 1);
    }
  }
  return null;
}

function isValidUrl(url: string): boolean {
  return url.startsWith('http://') || url.startsWith('https://');
}

function kugouHeaders(): Record<string, string> {
  return {
    'user-agent': DEFAULT_MOBILE_USER_AGENT,
    referer: 'https://m.kugou.com/',
  };
}

registerParser('kugou_music', {
  factory: (context) => new KugouMusicParser(context),
  allowedHosts: ['m3ws.kugou.com', 'gateway.kugou.com', '*.kugou.com'],
});
