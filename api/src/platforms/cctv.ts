import { Buffer } from 'node:buffer';
import { createHmac } from 'node:crypto';
import { DEFAULT_DESKTOP_USER_AGENT } from '../config/user-agents.js';
import { ProxyAttemptError, safeErrorDetails } from '../core/errors.js';
import type { MediaResult } from '../core/media-result.js';
import type { ParseContext } from '../core/parse-context.js';
import type { PlatformParser } from '../core/parser.js';
import { registerParser } from '../core/parser-registry.js';
import {
  array,
  at,
  author,
  parseJson,
  protocolUrl,
  result,
  stringAt,
  uniqueStrings,
} from './data.js';

const CCTVNEWS_APP_KEY = '204133710';
const CCTVNEWS_APP_SECRET = 'etyEuNdA7GvQU7iPZHqnrBpSFfRyKQTD';
const CCTVNEWS_HOST = 'https://api.cctvnews.cctv.com';
const CCTVNEWS_ARTICLE_PATH = '/1.0.0/feed/article/server/getArticle';
const CNTV_VIDEO_INFO_API = 'https://vdn.apps.cntv.cn/api/getHttpVideoInfo.do';

const ITEM_ID_PATTERN = /(?:item_id|articleId)=([0-9a-zA-Z_-]+)/u;
const GUID_IN_HTML_PATTERN = /(?:guid|pid|videoCenterId)["']?\s*[:=]\s*["']([0-9a-fA-F]{32})["']/u;

export interface CctvParserOptions {
  now?: () => number;
}

export class CctvParser implements PlatformParser {
  public readonly platform = 'cctv' as const;
  readonly #now: () => number;

  public constructor(
    private readonly context: ParseContext,
    options: CctvParserOptions = {},
  ) {
    this.#now = options.now ?? Date.now;
  }

  public async parse(): Promise<MediaResult> {
    const url = this.context.realUrl;
    const hostname = url.hostname.toLowerCase();
    if (hostname.includes('cctvnews') || url.pathname.includes('snow-book')) {
      return this.#parseCctvNews(url);
    }
    return this.#parseCctvWeb(url);
  }

  async #parseCctvNews(url: URL): Promise<MediaResult> {
    const itemId = (
      url.searchParams.get('item_id') ||
      url.searchParams.get('articleId') ||
      ITEM_ID_PATTERN.exec(url.href)?.[1] ||
      ''
    ).trim();

    if (!itemId) {
      this.context.logger.warn(
        { platform_id: this.platform, error_category: 'item_id_missing' },
        'could not extract articleId/item_id from CCTV News URL',
      );
      return result({});
    }

    const timestamp = String(Math.trunc(this.#now()));
    const signedRequest = buildCctvNewsSignedRequest(itemId, timestamp);

    try {
      const respJson = await this.context.session.getJson<unknown>(signedRequest.url, {
        headers: signedRequest.headers,
        signal: this.context.signal,
        timeoutMs: 5_000,
      });

      const b64Response = stringAt(respJson, 'response');
      if (!b64Response) {
        this.context.logger.warn(
          { platform_id: this.platform, error_category: 'missing_encoded_payload' },
          'CCTV News response missing encoded payload',
        );
        return result({});
      }

      const decodedText = Buffer.from(b64Response, 'base64').toString('utf8');
      const payload = at(parseJson(decodedText), 'data');
      const title = stripHtmlTags(stringAt(payload, 'title')).trim();

      const videos = array(at(payload, 'videos'));
      const videoUrls = uniqueStrings(
        videos.map((item) => protocolUrl(stringAt(item, 'url').trim())),
      );
      const videoUrl = videoUrls[0] ?? null;

      let coverUrl = '';
      if (videos.length > 0) {
        const coverNode = at(videos[0], 'cover');
        coverUrl = typeof coverNode === 'string'
          ? coverNode
          : stringAt(coverNode, 'url');
      }
      if (!coverUrl) {
        coverUrl = stringAt(payload, 'thumbnails', 0, 'url');
      }

      const authorName = stringAt(payload, 'source') || stringAt(payload, 'author') || '央视新闻';
      return result({
        title,
        videoUrl,
        videoList: videoUrls.length > 1 ? videoUrls : [],
        coverUrl: protocolUrl(coverUrl.trim()) || null,
        author: author(authorName, '', ''),
      });
    } catch (error) {
      if (error instanceof ProxyAttemptError) throw error;
      this.context.logger.error(
        {
          platform_id: this.platform,
          error_category: 'cctvnews_request_failed',
          ...safeErrorDetails(error),
        },
        'failed to parse CCTV News article',
      );
      return result({});
    }
  }

  async #parseCctvWeb(url: URL): Promise<MediaResult> {
    let pid = (url.searchParams.get('pid') || url.searchParams.get('guid') || '').trim();
    if (!pid) {
      try {
        const html = await this.context.session.getText(url, {
          headers: {
            'user-agent': DEFAULT_DESKTOP_USER_AGENT,
            referer: 'https://tv.cctv.com/',
            accept: '*/*',
          },
          signal: this.context.signal,
          timeoutMs: 5_000,
        });
        pid = GUID_IN_HTML_PATTERN.exec(html)?.[1] ?? '';
      } catch (error) {
        if (error instanceof ProxyAttemptError) throw error;
        this.context.logger.error(
          {
            platform_id: this.platform,
            error_category: 'cctv_html_failed',
            ...safeErrorDetails(error),
          },
          'failed to fetch CCTV page HTML',
        );
        return result({});
      }
    }

    if (!pid) {
      this.context.logger.warn(
        { platform_id: this.platform, error_category: 'pid_missing' },
        'could not extract video pid/guid from CCTV URL',
      );
      return result({});
    }

    const apiUrl = new URL(CNTV_VIDEO_INFO_API);
    apiUrl.searchParams.set('pid', pid);

    let data: unknown;
    try {
      data = await this.context.session.getJson<unknown>(apiUrl, {
        headers: {
          'user-agent': DEFAULT_DESKTOP_USER_AGENT,
          referer: 'https://tv.cctv.com/',
          accept: '*/*',
        },
        signal: this.context.signal,
        timeoutMs: 5_000,
      });
    } catch (error) {
      if (error instanceof ProxyAttemptError) throw error;
      this.context.logger.error(
        {
          platform_id: this.platform,
          error_category: 'cntv_video_info_failed',
          pid,
          ...safeErrorDetails(error),
        },
        'failed to fetch CNTV video info',
      );
      return result({});
    }

    const title = stripHtmlTags(stringAt(data, 'title')).trim();
    const selected = selectCntvStream(data);
    const coverUrl = protocolUrl(
      (stringAt(data, 'image') || selected.chapterCover).trim(),
    );
    const columnName = stringAt(data, 'column') || stringAt(data, 'produce') || '央视网';

    return result({
      title,
      videoUrl: selected.videoUrl,
      videoList: selected.videoList,
      coverUrl: coverUrl || null,
      author: author(columnName, '', ''),
    });
  }
}

export function buildCctvNewsSignedRequest(
  itemId: string,
  timestamp: string,
): { url: string; headers: Record<string, string> } {
  const caHeaders: Readonly<Record<string, string>> = {
    'x-ca-key': CCTVNEWS_APP_KEY,
    'x-ca-stage': 'RELEASE',
    'x-ca-timestamp': timestamp,
  };
  const caHeaderNames = Object.keys(caHeaders).sort();
  const headerStr = caHeaderNames
    .map((name) => `${name}:${caHeaders[name] ?? ''}`)
    .join('\n');

  const queryParams = new URLSearchParams();
  queryParams.set('appcode', 'video_web');
  queryParams.set('articleId', itemId);
  const fullPath = `${CCTVNEWS_ARTICLE_PATH}?${queryParams.toString()}`;
  const accept = 'application/json';
  const stringToSign = `GET\n${accept}\n\n\n\n${headerStr}\n${fullPath}`;
  const signature = createHmac('sha256', CCTVNEWS_APP_SECRET)
    .update(stringToSign, 'utf8')
    .digest('base64');

  return {
    url: `${CCTVNEWS_HOST}${fullPath}`,
    headers: {
      ...caHeaders,
      'x-ca-signature-headers': caHeaderNames.join(','),
      'x-ca-signature': signature,
      accept,
      'user-agent': DEFAULT_DESKTOP_USER_AGENT,
    },
  };
}

function selectCntvStream(data: unknown): {
  videoUrl: string | null;
  videoList: string[];
  chapterCover: string;
} {
  const hlsUrl = protocolUrl(
    (
      stringAt(data, 'hls_url') ||
      stringAt(data, 'manifest', 'hls_url') ||
      stringAt(data, 'manifest', 'hls_enc_url')
    ).trim(),
  );
  if (hlsUrl) {
    return { videoUrl: hlsUrl, videoList: [], chapterCover: '' };
  }

  const videoNode = at(data, 'video');
  const chapterTiers = ['chapters4', 'chapters3', 'chapters2', 'chapters', 'lowChapters'] as const;
  for (const tier of chapterTiers) {
    const chapters = array(at(videoNode, tier));
    const urls = uniqueStrings(
      chapters.map((chapter) => protocolUrl(stringAt(chapter, 'url').trim())),
    );
    if (urls.length > 0) {
      const chapterCover = stringAt(chapters[0], 'image');
      return {
        videoUrl: urls[0] ?? null,
        videoList: urls.length > 1 ? urls : [],
        chapterCover,
      };
    }
  }

  return { videoUrl: null, videoList: [], chapterCover: '' };
}

function stripHtmlTags(input: string): string {
  return input.replace(/<[^>]+>/gu, '');
}

registerParser('cctv', {
  factory: (context) => new CctvParser(context),
  allowedHosts: [
    'vdn.apps.cntv.cn',
    'api.cntv.cn',
    '*.cntv.cn',
    'api.cctvnews.cctv.com',
    '*.cctv.com',
    '*.cctv.cn',
  ],
});
