import { Buffer } from 'node:buffer';
import { load } from 'cheerio';
import { DEFAULT_MOBILE_USER_AGENT } from '../config/user-agents.js';
import { ProxyAttemptError, safeErrorDetails } from '../core/errors.js';
import { hasMedia, type MediaResult } from '../core/media-result.js';
import type { ParseContext } from '../core/parse-context.js';
import type { PlatformParser } from '../core/parser.js';
import { registerParser } from '../core/parser-registry.js';
import { getVideoId } from '../http/url-tools.js';
import {
  array,
  at,
  author,
  extractAssignedJson,
  parseJson,
  record,
  result,
  string,
  stringAt,
  uniqueStrings,
  type JsonRecord,
} from './data.js';
import { DouyinSharedParser, resolveBytedanceVod } from './douyin-shared.js';

const TOUTIAO_TITLE_SUFFIX = '-今日头条';

class ToutiaoParser implements PlatformParser {
  public readonly platform = 'toutiao' as const;

  public constructor(private readonly context: ParseContext) {}

  public async parse(): Promise<MediaResult> {
    const itemId = extractToutiaoItemId(this.context.realUrl);
    const ssrResult = await this.#fetchToutiaoMobileSsr(itemId);
    if (ssrResult && hasMedia(ssrResult)) {
      return ssrResult;
    }
    const douyinFallback = await new DouyinSharedParser('toutiao', this.context).parse();
    if (hasMedia(douyinFallback) || douyinFallback.terminalError) {
      return douyinFallback;
    }
    return ssrResult ?? douyinFallback;
  }

  async #fetchToutiaoMobileSsr(itemId: string): Promise<MediaResult | null> {
    const candidateUrls = itemId
      ? [
          `https://m.toutiao.com/w/${itemId}/`,
          `https://m.toutiao.com/video/${itemId}/`,
          `https://m.toutiao.com/i${itemId}/`,
          `https://m.toutiao.com/group/${itemId}/`,
          `https://m.toutiao.com/item/${itemId}/`,
        ]
      : [this.context.realUrl.href];

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

        const articleInfo = extractToutiaoArticleFromHtml(html);
        if (!articleInfo) continue;

        const vod = await resolveBytedanceVod(this.context.session, this.context.signal, {
          playAuthTokenV2: string(articleInfo.playAuthTokenV2),
          playUrlList: articleInfo.playUrlList,
          videoId:
            string(articleInfo.videoId) ||
            string(articleInfo.video_id) ||
            string(articleInfo.vid) ||
            stringAt(articleInfo, 'subInfo', 'videoId') ||
            stringAt(articleInfo, 'posterInfo', 'videoId') ||
            stringAt(articleInfo, 'videoPlayInfo', 'video_id'),
        });

        const rawContent = articleInfo.content;
        const desc = cleanToutiaoDescription(rawContent);
        const imageList = extractToutiaoImages(articleInfo);
        const mediaUser = record(articleInfo.mediaUser);
        const authorName =
          string(mediaUser.screenName) ||
          string(mediaUser.name) ||
          string(articleInfo.userName) ||
          string(articleInfo.source);
        const avatarUrl = string(mediaUser.avatarUrl) || string(mediaUser.avatar);

        return result({
          title: string(articleInfo.title),
          desc,
          videoUrl: vod.videoUrl || null,
          videoList: vod.videoList,
          coverUrl: string(articleInfo.posterUrl) || vod.coverUrl || null,
          imageList,
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
            error_category: 'toutiao_mobile_ssr_failed',
            ...safeErrorDetails(error),
          },
          'toutiao mobile SSR attempt failed',
        );
      }
    }
    return null;
  }
}

export function cleanToutiaoDescription(content: unknown): string | null {
  if (typeof content !== 'string' || !content.trim()) return null;
  const $ = load(content, null, false);
  $('script, style, template').remove();
  $('br').replaceWith('\n');
  $('address, article, blockquote, div, h1, h2, h3, h4, h5, h6, li, p, section').append('\n');

  const lines: string[] = [];
  for (const rawLine of $.text().replaceAll('\u00a0', ' ').split(/\r?\n/u)) {
    const normalized = rawLine.replace(/[\t\f\v ]+/gu, ' ').trim();
    if (normalized) {
      lines.push(normalized);
    }
  }
  return lines.length > 0 ? lines.join('\n') : null;
}

export function normalizeToutiaoArticle(rawJson: unknown): JsonRecord | null {
  const root = record(rawJson);
  const sourceArticle =
    nonEmptyRecord(root.articleInfo) ??
    nonEmptyRecord(root.data) ??
    (isNonEmptyRecord(root.thread) ? root : null);
  if (!sourceArticle) return null;

  const articleInfo: JsonRecord = { ...sourceArticle };
  const threadBase =
    nonEmptyRecord(at(articleInfo, 'thread', 'threadBase')) ??
    nonEmptyRecord(at(root, 'thread', 'threadBase'));

  if (threadBase) {
    const user = record(at(threadBase, 'user', 'info'));
    if (!string(articleInfo.title)) {
      const rawSeoTitle = stringAt(root, 'seoTDK', 'title');
      const seoTitle = (
        rawSeoTitle.endsWith(TOUTIAO_TITLE_SUFFIX)
          ? rawSeoTitle.slice(0, -TOUTIAO_TITLE_SUFFIX.length)
          : rawSeoTitle
      ).trim();
      articleInfo.title = seoTitle || string(threadBase.title);
    }
    if (!string(articleInfo.content)) {
      articleInfo.content = string(threadBase.content) || string(threadBase.richContent);
    }
    if (!isNonEmptyRecord(articleInfo.mediaUser) && Object.keys(user).length > 0) {
      articleInfo.mediaUser = {
        screenName: user.name,
        avatarUrl: user.avatarUrl,
        ...(user.userId || user.id ? { id: user.userId ?? user.id } : {}),
      };
    }
    const rawThreadImages =
      array(threadBase.largeImageList).length > 0
        ? array(threadBase.largeImageList)
        : array(threadBase.originImageList);
    articleInfo.threadImageList = rawThreadImages
      .map((img) => (typeof img === 'string' ? img : stringAt(img, 'url')))
      .filter(Boolean);
  }

  return articleInfo;
}

function extractToutiaoImages(articleInfo: JsonRecord): string[] {
  const images: string[] = [
    ...array(articleInfo.threadImageList).map((entry) => string(entry)),
    ...array(articleInfo.ugcImages).map((entry) =>
      typeof entry === 'string' ? entry : stringAt(entry, 'url'),
    ),
    ...array(articleInfo.imageList).map((entry) =>
      typeof entry === 'string' ? entry : stringAt(entry, 'url'),
    ),
  ];

  const content = articleInfo.content;
  if (typeof content === 'string' && content.includes('<img')) {
    const $ = load(content, null, false);
    for (const element of $('img').toArray()) {
      const src =
        $(element).attr('src') ??
        $(element).attr('data-src') ??
        $(element).attr('alt-src') ??
        '';
      if (src.trim()) {
        images.push(src.trim());
      }
    }
  }
  return uniqueStrings(images);
}

function extractToutiaoArticleFromHtml(html: string): JsonRecord | null {
  const $ = load(html);
  for (const selector of ['script#RENDER_DATA', 'script#TT_DATA', 'script#_SSR_DATA']) {
    const rawText = $(selector).first().text().trim();
    if (!rawText) continue;
    const parsed = decodeToutiaoScriptPayload(rawText);
    const normalized = normalizeToutiaoArticle(parsed);
    if (normalized) return normalized;
  }

  for (const marker of ['TT_DATA', 'window.TT_DATA', '_SSR_DATA', 'RENDER_DATA']) {
    const assigned = extractAssignedJson(html, marker);
    const normalized = normalizeToutiaoArticle(assigned);
    if (normalized) return normalized;
  }
  return null;
}

function decodeToutiaoScriptPayload(rawText: string): unknown {
  let candidate = rawText;
  if (candidate.includes('%')) {
    try {
      candidate = decodeURIComponent(candidate);
    } catch {
      // Keep original candidate when percent is literal.
    }
  }
  try {
    return parseJson(candidate);
  } catch {
    try {
      const fromBase64 = Buffer.from(rawText, 'base64').toString('utf8');
      return parseJson(fromBase64);
    } catch {
      return {};
    }
  }
}

function extractToutiaoItemId(url: URL): string {
  for (const key of ['group_id', 'item_id', 'thread_id', 'wid', 'id']) {
    const val = url.searchParams.get(key);
    if (val && /^\d+$/u.test(val)) return val;
  }
  const raw = getVideoId(url);
  const prefixed = /^[ia](\d{10,25})$/u.exec(raw);
  if (prefixed?.[1]) return prefixed[1];
  return /^\d+$/u.test(raw) ? raw : '';
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

registerParser('toutiao', {
  factory: (context) => new ToutiaoParser(context),
  allowedHosts: [
    'm.toutiao.com',
    'www.toutiao.com',
    'toutiao.com',
    'v.ixigua.com',
    'm.ixigua.com',
    'www.ixigua.com',
    'ixigua.com',
    'ib.365yg.com',
    'vas.snssdk.com',
    'vod.bytedanceapi.com',
    'www.douyin.com',
    'douyin.com',
    'm.douyin.com',
    'www.iesdouyin.com',
    'iesdouyin.com',
    'ttwid.bytedance.com',
    'api5-normal-c-hl.amemv.com',
    'aweme.snssdk.com',
    '*.toutiao.com',
    '*.snssdk.com',
    '*.ixigua.com',
    '*.365yg.com',
    '*.amemv.com',
    '*.douyinpic.com',
    '*.douyinstatic.com',
    '*.douyinvod.com',
    '*.byteimg.com',
  ],
});
