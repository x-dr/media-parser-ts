import { load } from 'cheerio';
import { DEFAULT_MOBILE_USER_AGENT } from '../config/user-agents.js';
import { ProxyAttemptError, safeErrorDetails } from '../core/errors.js';
import { hasMedia, type MediaResult } from '../core/media-result.js';
import type { ParseContext } from '../core/parse-context.js';
import type { PlatformParser } from '../core/parser.js';
import { registerParser } from '../core/parser-registry.js';
import { getVideoId } from '../http/url-tools.js';
import {
  at,
  author,
  extractAssignedJson,
  parseJson,
  record,
  result,
  string,
  stringAt,
  type JsonRecord,
} from './data.js';
import { DouyinSharedParser, resolveBytedanceVod } from './douyin-shared.js';

class XiguaParser implements PlatformParser {
  public readonly platform = 'xigua' as const;

  public constructor(private readonly context: ParseContext) {}

  public async parse(): Promise<MediaResult> {
    const itemId = extractXiguaItemId(this.context.realUrl);
    if (itemId) {
      const xiguaResult = await this.#fetchMobileSsr(itemId);
      if (xiguaResult && hasMedia(xiguaResult)) {
        return xiguaResult;
      }
    }
    return new DouyinSharedParser('xigua', this.context).parse();
  }

  async #fetchMobileSsr(itemId: string): Promise<MediaResult | null> {
    const candidateUrls = [
      `https://m.ixigua.com/video/${itemId}/`,
      `https://m.ixigua.com/group/${itemId}/`,
      `https://www.ixigua.com/${itemId}`,
    ];

    for (const targetUrl of candidateUrls) {
      try {
        const html = await this.context.session.getText(targetUrl, {
          headers: {
            'user-agent': DEFAULT_MOBILE_USER_AGENT,
            accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
            'accept-language': 'zh-CN,zh-Hans;q=0.9',
          },
          followRedirect: true,
          timeoutMs: 5_000,
          signal: this.context.signal,
        });
        if (!html.trim()) continue;

        const articleInfo = extractXiguaArticleInfo(html);
        if (!articleInfo) continue;

        const vod = await resolveBytedanceVod(this.context.session, this.context.signal, {
          playAuthTokenV2: string(articleInfo.playAuthTokenV2),
          playUrlList: articleInfo.playUrlList,
          videoId:
            string(articleInfo.videoId) ||
            string(articleInfo.video_id) ||
            string(articleInfo.vid) ||
            stringAt(articleInfo, 'videoPlayInfo', 'video_id'),
        });

        const mediaUser = nonEmptyRecord(articleInfo.mediaUser) ?? record(articleInfo.user);
        const authorName =
          string(mediaUser.screenName) ||
          string(mediaUser.name) ||
          string(articleInfo.userName) ||
          string(articleInfo.source);
        const avatarUrl = string(mediaUser.avatarUrl) || string(mediaUser.avatar);

        return result({
          title: string(articleInfo.title),
          desc: string(articleInfo.content) || null,
          videoUrl: vod.videoUrl || null,
          videoList: vod.videoList,
          coverUrl: string(articleInfo.posterUrl) || vod.coverUrl || null,
          author: author(
            authorName,
            mediaUser.id || mediaUser.userId || mediaUser.user_id,
            avatarUrl,
          ),
        });
      } catch (error) {
        if (error instanceof ProxyAttemptError) throw error;
        this.context.logger.debug(
          {
            platform_id: this.platform,
            error_category: 'xigua_mobile_ssr_failed',
            ...safeErrorDetails(error),
          },
          'xigua mobile SSR attempt failed',
        );
      }
    }
    return null;
  }
}

function extractXiguaItemId(url: URL): string {
  const raw = getVideoId(url);
  const prefixed = /^[ia](\d{10,25})$/u.exec(raw);
  return prefixed?.[1] ?? raw;
}

function extractXiguaArticleInfo(html: string): JsonRecord | null {
  const $ = load(html);
  for (const selector of ['script#RENDER_DATA', 'script#_SSR_DATA', 'script#TT_DATA']) {
    const rawText = $(selector).first().text().trim();
    if (!rawText) continue;
    const parsed = parseEncodedJson(rawText);
    const info = pickArticleInfo(parsed);
    if (info) return info;
  }

  for (const marker of ['window._SSR_DATA', '_SSR_DATA', 'TT_DATA']) {
    const assigned = extractAssignedJson(html, marker);
    const info = pickArticleInfo(assigned);
    if (info) return info;
  }
  return null;
}

function pickArticleInfo(payload: unknown): JsonRecord | null {
  const candidate =
    nonEmptyRecord(at(payload, 'articleInfo')) ??
    nonEmptyRecord(at(payload, 'videoInfo')) ??
    nonEmptyRecord(at(payload, 'anyVideo', 'gidInformation', 'packerData', 'video'));
  return candidate;
}

function parseEncodedJson(rawText: string): unknown {
  let decoded = rawText;
  if (decoded.includes('%')) {
    try {
      decoded = decodeURIComponent(decoded);
    } catch {
      // Keep original text when percent signs are literal.
    }
  }
  try {
    return parseJson(decoded);
  } catch {
    return {};
  }
}

function nonEmptyRecord(value: unknown): JsonRecord | null {
  return value !== null &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    Object.keys(value).length > 0
    ? (value as JsonRecord)
    : null;
}

registerParser('xigua', {
  factory: (context) => new XiguaParser(context),
  allowedHosts: [
    'www.douyin.com',
    'douyin.com',
    'm.douyin.com',
    'www.iesdouyin.com',
    'iesdouyin.com',
    'ttwid.bytedance.com',
    'vod.bytedanceapi.com',
    'ib.365yg.com',
    'vas.snssdk.com',
    'api5-normal-c-hl.amemv.com',
    'aweme.snssdk.com',
    '*.ixigua.com',
    '*.365yg.com',
    '*.snssdk.com',
    '*.amemv.com',
    '*.douyinpic.com',
    '*.douyinstatic.com',
    '*.douyinvod.com',
    '*.byteimg.com',
  ],
});
