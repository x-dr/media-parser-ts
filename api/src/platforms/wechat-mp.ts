import { load } from 'cheerio';
import { DEFAULT_DESKTOP_USER_AGENT } from '../config/user-agents.js';
import { ProxyAttemptError, safeErrorDetails } from '../core/errors.js';
import type { MediaResult } from '../core/media-result.js';
import type { ParseContext } from '../core/parse-context.js';
import type { PlatformParser } from '../core/parser.js';
import { registerParser } from '../core/parser-registry.js';
import { author, result, unescapeHtml, uniqueStrings } from './data.js';

const DELETED_KEYWORDS = [
  '该内容已被发布者删除',
  '此内容因违规无法查看',
  '此内容已被发布者删除',
  '该内容因违规无法查看',
] as const;

interface VideoCandidate {
  url: string;
  width: number;
  height: number;
  filesize: number;
  quality: number;
}

class WechatMpParser implements PlatformParser {
  public readonly platform = 'wechat_mp' as const;
  public constructor(private readonly context: ParseContext) {}

  public async parse(): Promise<MediaResult> {
    let html: string;
    try {
      html = await this.context.session.getText(this.context.realUrl, {
        headers: {
          'user-agent': DEFAULT_DESKTOP_USER_AGENT,
          accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        },
        followRedirect: true,
        signal: this.context.signal,
      });
    } catch (error) {
      if (error instanceof ProxyAttemptError) throw error;
      this.context.logger.warn(
        {
          platform_id: this.platform,
          error_category: 'upstream_fetch_failed',
          ...safeErrorDetails(error),
        },
        'failed to fetch WeChat MP article',
      );
      return result({ title: '微信公众号文章' });
    }

    if (
      html.includes('环境异常') &&
      (html.includes('secitptpage/verify') || html.includes('完成验证后即可继续访问'))
    ) {
      return result({
        cookieRequired: true,
        terminalError: {
          code: 'COOKIE_REQUIRED',
          message: '微信公众号访问触发安全验证，请稍后重试',
        },
      });
    }

    if (DELETED_KEYWORDS.some((keyword) => html.includes(keyword))) {
      return result({
        terminalError: {
          code: 'MEDIA_DELETED_OR_PRIVATE',
          message: '该公众号文章已被作者删除或违规下架',
        },
      });
    }

    const $ = load(html);

    const jsTitle = extractTitleFromScript(html);
    const metaTitle = unescapeHtml($('meta[property="og:title"]').attr('content') ?? '').trim();
    const h1Title = $('#activity-name').first().text().trim();
    const title = jsTitle || metaTitle || h1Title || '微信公众号文章';

    const rawNickname = extractFirstJsString(html, [/\bvar\s+nickname\s*=/gu, /\bnick_name\s*:/gu]);
    const metaAuthor = unescapeHtml(
      $('meta[property="og:article:author"]').attr('content') ??
        $('meta[name="author"]').attr('content') ??
        '',
    ).trim();
    const domAuthor = $('#js_name').first().text().trim();
    const authorName = (rawNickname ? unescapeWechatText(rawNickname) : '') || metaAuthor || domAuthor;

    const authorId = extractFirstJsString(html, [/\bvar\s+user_name\s*=/gu, /\buser_name\s*:/gu]);
    const rawAvatar = extractFirstJsString(html, [
      /\bround_head_img\s*:/gu,
      /\bori_head_img_url\s*:/gu,
      /\bvar\s+round_head_img\s*=/gu,
      /\bvar\s+ori_head_img_url\s*=/gu,
    ]);
    const authorAvatar = rawAvatar ? unescapeWechatUrl(rawAvatar) : '';

    const rawCover = extractFirstJsString(html, [/\bvar\s+msg_cdn_url\s*=/gu, /\bcdn_url\s*:/gu]);
    const metaCover = unescapeHtml($('meta[property="og:image"]').attr('content') ?? '').trim();
    const coverUrl = (rawCover ? unescapeWechatUrl(rawCover) : '') || metaCover;

    const hasJsContent = $('#js_content').length > 0;
    const contentBox = hasJsContent ? $('#js_content').first() : $('body').first();
    const description = extractArticleText($, hasJsContent);

    const rawImages: string[] = [];
    contentBox.find('img').each((_index, element) => {
      const src = ($(element).attr('data-src') ?? $(element).attr('src') ?? '').trim();
      if (src.startsWith('http') && src.includes('qpic.cn')) {
        rawImages.push(src.replace(/\/(?:640|300|0)\?/u, '/0?'));
      }
    });
    const imageList = uniqueStrings(rawImages);
    if (imageList.length === 0 && coverUrl) {
      imageList.push(coverUrl);
    }

    const voiceId = $('mpvoice').first().attr('voice_encode_fileid')?.trim() ?? '';
    const audioUrl = voiceId ? `https://res.wx.qq.com/voice/getvoice?mediaid=${voiceId}` : null;

    const videoList = extractWechatVideos(html);
    const videoUrl = videoList[0] ?? null;

    return result({
      title,
      desc: description,
      author: author(authorName, authorId, authorAvatar),
      coverUrl: coverUrl || null,
      imageList,
      audioUrl,
      videoUrl,
      videoList,
    });
  }
}

function extractArticleText($: ReturnType<typeof load>, hasJsContent: boolean): string | null {
  const cloneRoot = load(hasJsContent ? ($('#js_content').first().html() ?? '') : ($('body').first().html() ?? ''));
  cloneRoot('script, style, noscript, mpvoice').remove();
  cloneRoot('br').replaceWith('\n');
  cloneRoot('p, div, section, li, h1, h2, h3, h4, h5, h6, blockquote, tr').each((_index, element) => {
    cloneRoot(element).append('\n');
  });
  const lines = cloneRoot
    .root()
    .text()
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
  return lines.length > 0 ? lines.join('\n') : null;
}

function extractTitleFromScript(html: string): string {
  const direct = extractFirstJsString(html, [/\bvar\s+msg_title\s*=/gu, /\bmsg_title\s*:/gu]);
  if (direct) return unescapeWechatText(direct);

  for (const match of html.matchAll(/\btitle\s*:/gu)) {
    let cursor = match.index + match[0].length;
    while (cursor < html.length && isAsciiSpace(html[cursor] ?? '')) cursor += 1;
    if (html.startsWith('xml', cursor)) {
      const closeParen = html.indexOf(')', cursor);
      if (closeParen < 0 || closeParen - cursor > 120) continue;
      const colonIdx = html.indexOf(':', closeParen + 1);
      if (colonIdx < 0 || colonIdx - closeParen > 20) continue;
      cursor = colonIdx + 1;
    }
    const candidate = readQuotedLiteral(html, cursor);
    if (candidate) return unescapeWechatText(candidate);
  }
  return '';
}

function extractFirstJsString(html: string, patterns: readonly RegExp[]): string {
  for (const pattern of patterns) {
    for (const match of html.matchAll(pattern)) {
      const value = readQuotedLiteral(html, match.index + match[0].length);
      if (value) return value;
    }
  }
  return '';
}

function readQuotedLiteral(source: string, startIndex: number): string {
  let cursor = startIndex;
  while (cursor < source.length && isAsciiSpace(source[cursor] ?? '')) cursor += 1;
  const quote = source[cursor] ?? '';
  if (quote !== "'" && quote !== '"' && quote !== '`') return '';
  cursor += 1;
  let output = '';
  while (cursor < source.length) {
    const ch = source[cursor] ?? '';
    if (ch === '\\') {
      const next = source[cursor + 1] ?? '';
      if (next === 'x' && cursor + 3 < source.length) {
        const hex = source.slice(cursor + 2, cursor + 4);
        if (/^[0-9a-fA-F]{2}$/u.test(hex)) {
          output += String.fromCharCode(parseInt(hex, 16));
          cursor += 4;
          continue;
        }
      }
      if (next === "'" || next === '"' || next === '`' || next === '\\' || next === '/') {
        output += next;
      } else if (next === 'n') {
        output += '\n';
      } else if (next === 'r') {
        output += '\r';
      } else if (next === 't') {
        output += '\t';
      } else {
        output += `\\${next}`;
      }
      cursor += 2;
      continue;
    }
    if (ch === quote) return output;
    if ((quote === "'" || quote === '"') && (ch === '\r' || ch === '\n')) return '';
    output += ch;
    cursor += 1;
  }
  return '';
}

function isAsciiSpace(ch: string): boolean {
  return ch === ' ' || ch === '\t' || ch === '\r' || ch === '\n';
}

function unescapeWechatText(raw: string): string {
  return unescapeHtml(raw.replaceAll('\\x26amp;', '&').replaceAll('\\x26', '&').replaceAll('&amp;', '&')).trim();
}

function unescapeWechatUrl(raw: string): string {
  return unescapeHtml(raw.replaceAll('\\x26amp;', '&').replaceAll('\\x26', '&').replaceAll('&amp;', '&')).trim();
}

function extractWechatVideos(html: string): string[] {
  const videoGroups = new Map<string, VideoCandidate[]>();

  for (const match of html.matchAll(/\burl\s*:\s*['"`](https?:\/\/mpvideo\.qpic\.cn\/[^'"`\s]+)['"`]/gu)) {
    const rawUrl = match[1];
    if (!rawUrl) continue;
    const cleanUrl = unescapeWechatUrl(rawUrl);
    const blockText = extractEnclosingFlatObject(html, match.index);
    const item: VideoCandidate = {
      url: cleanUrl,
      width: extractIntField(blockText, /\bwidth\s*:\s*['"`]?(\d+)/u),
      height: extractIntField(blockText, /\bheight\s*:\s*['"`]?(\d+)/u),
      filesize: extractIntField(blockText, /\bfilesize\s*:\s*['"`]?(\d+)/u),
      quality: extractIntField(blockText, /\bvideo_quality_level\s*:\s*['"`]?(\d+)/u),
    };

    const groupKey = computeVideoGroupKey(cleanUrl);
    const existing = videoGroups.get(groupKey);
    if (existing) {
      existing.push(item);
    } else {
      videoGroups.set(groupKey, [item]);
    }
  }

  if (
    html.includes('video_page_info') &&
    !html.includes('video_page_infos') &&
    !html.includes('videoPageInfos')
  ) {
    const allItems: VideoCandidate[] = [];
    for (const items of videoGroups.values()) allItems.push(...items);
    const best = pickBestVideo(allItems);
    if (best) return [best.url];
  } else if (videoGroups.size > 0) {
    const urls: string[] = [];
    for (const items of videoGroups.values()) {
      const best = pickBestVideo(items);
      if (best && !urls.includes(best.url)) {
        urls.push(best.url);
      }
    }
    return urls;
  }

  const seenKeys = new Set<string>();
  const fallbackUrls: string[] = [];
  for (const match of html.matchAll(/https?:\/\/mpvideo\.qpic\.cn\/[^\s'"`<>]+/gu)) {
    const cleanUrl = unescapeWechatUrl(match[0]);
    const prefixMatch = /mpvideo\.qpic\.cn\/([a-zA-Z0-9_-]+)/u.exec(cleanUrl);
    const key = prefixMatch?.[1] ?? (cleanUrl.split('?')[0] ?? cleanUrl);
    if (!seenKeys.has(key)) {
      seenKeys.add(key);
      fallbackUrls.push(cleanUrl);
    }
  }
  return fallbackUrls;
}

function extractEnclosingFlatObject(source: string, position: number): string {
  const openIdx = source.lastIndexOf('{', position);
  if (openIdx < 0) return '';
  const closeIdx = source.indexOf('}', position);
  if (closeIdx < 0) return '';
  return source.slice(openIdx, closeIdx + 1);
}

function extractIntField(block: string, pattern: RegExp): number {
  const match = pattern.exec(block);
  return match?.[1] ? parseInt(match[1], 10) : 0;
}

function computeVideoGroupKey(url: string): string {
  const formatMatch = /mpvideo\.qpic\.cn\/([a-zA-Z0-9_-]+)\.f\d+/u.exec(url);
  if (formatMatch?.[1]) return formatMatch[1];
  const prefixMatch = /mpvideo\.qpic\.cn\/([a-zA-Z0-9_-]+)/u.exec(url);
  return prefixMatch?.[1] ?? (url.split('?')[0] ?? url);
}

function pickBestVideo(items: readonly VideoCandidate[]): VideoCandidate | null {
  let best: VideoCandidate | null = null;
  for (const candidate of items) {
    if (!best || compareVideoCandidate(candidate, best) > 0) {
      best = candidate;
    }
  }
  return best;
}

function compareVideoCandidate(left: VideoCandidate, right: VideoCandidate): number {
  if (left.quality !== right.quality) return left.quality - right.quality;
  const leftPixels = left.width * left.height;
  const rightPixels = right.width * right.height;
  if (leftPixels !== rightPixels) return leftPixels - rightPixels;
  return left.filesize - right.filesize;
}

registerParser('wechat_mp', {
  factory: (context) => new WechatMpParser(context),
  allowedHosts: ['mp.weixin.qq.com', 'res.wx.qq.com', 'weixin.qq.com'],
});
