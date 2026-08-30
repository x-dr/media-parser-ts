import { load } from 'cheerio';
import type { ParseContext } from '../core/parse-context.js';
import type { PlatformParser } from '../core/parser.js';
import { registerParser } from '../core/parser-registry.js';
import { safeErrorDetails } from '../core/errors.js';
import { ChallengeExecutor } from '../security/challenge-executor.js';
import { at, author, parseJson, result, string } from './data.js';

const challengeExecutor = new ChallengeExecutor();

class TencentChannelParser implements PlatformParser {
  public readonly platform = 'tencent_channel' as const;
  public constructor(private readonly context: ParseContext) {}

  public async parse(): Promise<ReturnType<typeof result>> {
    let html = await this.context.session.getText(this.context.realUrl, {
      followRedirect: true, headers: pageHeaders(), signal: this.context.signal,
    });
    if (html.includes('EO-Bot-Js-Token') || html.includes('Qua7lMrVs')) {
      const script = load(html)('script').first().html() ?? '';
      try {
        const challenge = await challengeExecutor.execute(script, this.context.realUrl, this.context.signal);
        await this.context.session.setCookie(
          `${challenge.cookieName}=${challenge.token}; Path=/; Secure`,
          this.context.realUrl,
        );
        const retried = await this.context.session.getText(this.context.realUrl, {
          headers: pageHeaders(), signal: this.context.signal,
        });
        if (retried.length > html.length) html = retried;
      } catch (error) {
        this.context.logger.warn(
          {
            platform_id: this.platform,
            error_category: 'challenge_failed',
            ...safeErrorDetails(error),
          },
          'isolated channel challenge failed; using public metadata fallback',
        );
      }
    }
    return extractMetadata(html);
  }
}

function extractMetadata(html: string): ReturnType<typeof result> {
  const $ = load(html);
  let title = '';
  let videoUrl = '';
  let coverUrl = '';
  let nickname = '';
  let avatar = '';
  let authorId = '';
  for (const element of $('script[type="application/ld+json"]').toArray()) {
    try {
      const data = parseJson($(element).text());
      title ||= text(at(data, 'headline') || at(data, 'text'));
      nickname ||= text(at(data, 'author', 'name'));
      avatar ||= url(at(data, 'author', 'url'));
      videoUrl ||= url(at(data, 'video', 'contentUrl'));
      coverUrl ||= url(at(data, 'video', 'thumbnailUrl'));
    } catch {
      // Ignore an unrelated malformed JSON-LD block.
    }
  }
  title ||= $('meta[property="og:title"]').attr('content') ?? '';
  coverUrl ||= $('meta[property="og:image"]').attr('content') ?? '';
  videoUrl ||= $('video[src]').first().attr('src') ?? '';
  videoUrl ||= /"contentUrl"\s*:\s*"([^"]+qchannelvideo[^"]+)"/u.exec(html)?.[1] ?? '';
  videoUrl ||= /(https?:\/\/qchannelvideo\.photo\.qq\.com\/[^"'< >\s]+\.mp4[^"'< >\s]*)/u.exec(html)?.[1] ?? '';
  const posterIndex = html.indexOf('"poster":');
  if (posterIndex >= 0) {
    const poster = html.slice(posterIndex, posterIndex + 4_096);
    nickname ||= /"nick":"([^"]+)"/u.exec(poster)?.[1] ?? '';
    avatar ||= /"avatar":"([^"]+)"/u.exec(poster)?.[1] ?? '';
    authorId ||= /"str_tiny_id":"([^"]+)"/u.exec(poster)?.[1] ??
      /"tiny_id":(\d+)/u.exec(poster)?.[1] ?? '';
  }
  const guildName = /｜([^｜]+)｜腾讯频道/u.exec(title)?.[1]?.trim();
  const mappedAuthor = author(nickname, authorId, url(avatar));
  return result({
    title: text(title),
    videoUrl: url(videoUrl) || null,
    videoList: videoUrl ? [url(videoUrl)] : [],
    coverUrl: url(coverUrl) || null,
    author: mappedAuthor && guildName ? { ...mappedAuthor, guildName } : mappedAuthor,
  });
}

function pageHeaders(): Record<string, string> {
  return {
    accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    referer: 'https://pd.qq.com/',
  };
}

function text(value: unknown): string {
  return load(`<span>${string(value)}</span>`)('span').text().trim();
}

function url(value: unknown): string {
  return text(value).replaceAll('\\/', '/').replaceAll('&amp;', '&');
}

registerParser('tencent_channel', {
  factory: (context) => new TencentChannelParser(context),
  allowedHosts: [],
});
