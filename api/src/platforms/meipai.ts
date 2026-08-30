import { load } from 'cheerio';
import type { ParseContext } from '../core/parse-context.js';
import type { PlatformParser } from '../core/parser.js';
import { registerParser } from '../core/parser-registry.js';
import { at, author, extractAssignedJson, protocolUrl, result, string, stringAt } from './data.js';

class MeipaiParser implements PlatformParser {
  public readonly platform = 'meipai' as const;
  public constructor(private readonly context: ParseContext) {}

  public async parse(): Promise<ReturnType<typeof result>> {
    const mediaId = /\d{15,}/u.exec(this.context.realUrl.href)?.[0];
    if (!mediaId) return result({});
    const html = await this.context.session.getText(`http://www.meipai.com/media/${mediaId}`, {
      headers: { referer: 'https://www.meipai.com/' }, signal: this.context.signal,
    });
    const phpData = extractAssignedJson(html, 'window.PHPDATA');
    const media = at(phpData, 'mediaInfo');
    const rawTitle = string(at(media, 'caption_origin')) || string(at(media, 'caption'));
    const rawCover = protocolUrl(stringAt(media, 'cover_pic'));
    const user = at(media, 'user');
    return result({
      title: load(rawTitle).text().trim(),
      videoUrl: await this.#decodeVideo(stringAt(media, 'video')),
      coverUrl: rawCover ? rawCover.split('!')[0] ?? null : null,
      author: author(
        at(user, 'screen_name'),
        at(user, 'id'),
        protocolUrl(stringAt(user, 'avatar')),
      ),
    });
  }

  async #decodeVideo(encoded: string): Promise<string | null> {
    if (encoded.length < 8) return null;
    try {
      const decimal = String(Number.parseInt(encoded.slice(0, 4).split('').reverse().join(''), 16));
      if (decimal.length < 4) return null;
      const firstIndex = Number(decimal[0]);
      const firstLength = Number(decimal[1]);
      const tailOffset = Number(decimal[2]);
      const tailLength = Number(decimal[3]);
      let content = encoded.slice(4);
      content = content.slice(0, firstIndex) + content.slice(firstIndex + firstLength);
      const tailIndex = content.length - tailOffset - tailLength;
      content = content.slice(0, tailIndex) + content.slice(tailIndex + tailLength);
      let rawUrl = Buffer.from(content, 'base64').toString('utf8');
      rawUrl = protocolUrl(rawUrl);
      if (rawUrl.startsWith('http://')) rawUrl = `https://${rawUrl.slice(7)}`;
      const endpoint = new URL('https://cracl.meitubase.com/resource/get_cdn_url');
      endpoint.searchParams.set('url', rawUrl);
      const response = await this.context.session.request(endpoint, {
        followRedirect: false,
        headers: { referer: 'https://www.meipai.com/' },
        signal: this.context.signal,
        maxBodyBytes: 1024 * 1024,
      });
      const locationHeader = response.headers.location;
      const location = Array.isArray(locationHeader) ? locationHeader[0] : locationHeader;
      return location ? new URL(location, endpoint).href : rawUrl;
    } catch {
      return null;
    }
  }
}

registerParser('meipai', {
  factory: (context) => new MeipaiParser(context),
  allowedHosts: ['cracl.meitubase.com'],
});
