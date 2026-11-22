import { load } from 'cheerio';
import { DEFAULT_MOBILE_USER_AGENT } from '../config/user-agents.js';
import { ProxyAttemptError } from '../core/errors.js';
import type { MediaResult } from '../core/media-result.js';
import type { ParseContext } from '../core/parse-context.js';
import type { PlatformParser } from '../core/parser.js';
import { registerParser } from '../core/parser-registry.js';
import { author, protocolUrl, result, unescapeHtml } from './data.js';

const FILM_URL_RE = /\bfilmurl\s*:\s*['"]([^'"]+)['"]/iu;
const FILM_IMG_RE = /\bfilmimg\s*:\s*['"]([^'"]+)['"]/iu;

class PeiyinxiuParser implements PlatformParser {
  public readonly platform = 'peiyinxiu' as const;
  public constructor(private readonly context: ParseContext) {}

  public async parse(): Promise<MediaResult> {
    let html: string;
    try {
      html = await this.context.session.getText(this.context.realUrl, {
        headers: {
          'user-agent': DEFAULT_MOBILE_USER_AGENT,
          referer: 'https://www.peiyinxiu.com/',
        },
        followRedirect: true,
        signal: this.context.signal,
      });
    } catch (error) {
      if (error instanceof ProxyAttemptError) throw error;
      return result({});
    }

    const $ = load(html);
    const authorId = $('#wlui').first().attr('data-uid') ?? '';
    const titleTag = $('.filmName').first();
    const ogTitle = $('meta[property="og:title"]').first().attr('content')?.trim() ?? '';
    const title =
      titleTag.attr('data-title')?.trim() ||
      titleTag.text().trim() ||
      ogTitle;

    const rawNickname = $('.athorName span').first().text().trim();
    const nickname = rawNickname.replace(/^@+/u, '');
    const avatar = absoluteUrl($('.userHead').first().attr('src') ?? '') ?? '';

    const filmUrl = extractScriptValue(html, FILM_URL_RE);
    const ogImage = $('meta[property="og:image"]').first().attr('content')?.trim() ?? '';
    const coverUrl = extractScriptValue(html, FILM_IMG_RE) ?? absoluteUrl(ogImage);

    return result({
      title,
      videoUrl: filmUrl,
      videoList: filmUrl ? [filmUrl] : [],
      coverUrl,
      author: author(nickname, authorId, avatar),
    });
  }
}

function extractScriptValue(html: string, pattern: RegExp): string | null {
  const match = pattern.exec(html)?.[1];
  return match ? absoluteUrl(unescapeHtml(match).trim()) : null;
}

function absoluteUrl(rawUrl: string): string | null {
  if (!rawUrl) return null;
  const resolved = protocolUrl(rawUrl.trim());
  return resolved.startsWith('http://') || resolved.startsWith('https://') ? resolved : null;
}

registerParser('peiyinxiu', {
  factory: (context) => new PeiyinxiuParser(context),
  allowedHosts: ['m.peiyinxiu.com', '*.peiyinxiu.com'],
});
