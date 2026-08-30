import { load } from 'cheerio';
import type { ParseContext } from '../core/parse-context.js';
import type { PlatformParser } from '../core/parser.js';
import { registerParser } from '../core/parser-registry.js';
import { getVideoId } from '../http/url-tools.js';
import { author, result, stringAt } from './data.js';

class LishipinParser implements PlatformParser {
  public readonly platform = 'lishipin' as const;
  public constructor(private readonly context: ParseContext) {}

  public async parse(): Promise<ReturnType<typeof result>> {
    const videoId = getVideoId(this.context.realUrl);
    const numericId = videoId.replace(/\D/gu, '');
    if (!numericId) return result({});
    const headers = { referer: this.context.realUrl.href };
    const [data, html] = await Promise.all([
      this.context.session.getJson<unknown>('https://www.pearvideo.com/videoStatus.jsp', {
        searchParams: { contId: numericId, mrd: Math.random() }, headers, signal: this.context.signal,
      }),
      this.context.session.getText(this.context.realUrl, { headers, signal: this.context.signal }),
    ]);
    const $ = load(html);
    const source = stringAt(data, 'videoInfo', 'videos', 'srcUrl');
    const videoUrl = source.replace(/\d+-(\d+-hd\.mp4)/u, `cont-${videoId}-$1`) || null;
    const authorNode = $('.thiscat').first();
    const authorId = authorNode.find('.column-subscribe').attr('data-userid') ??
      /author_(\d+)/u.exec(authorNode.find('a[href*="author_"]').attr('href') ?? '')?.[1] ?? '';
    return result({
      title: $('.summary').first().text().trim(),
      videoUrl,
      coverUrl: stringAt(data, 'videoInfo', 'video_image') || null,
      author: author(
        authorNode.find('.col-name').first().text().trim(),
        authorId,
        authorNode.find('img').first().attr('src') ?? '',
      ),
    });
  }
}

registerParser('lishipin', { factory: (context) => new LishipinParser(context), allowedHosts: [] });
