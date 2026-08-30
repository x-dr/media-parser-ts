import { load } from 'cheerio';
import type { ParseContext } from '../core/parse-context.js';
import type { PlatformParser } from '../core/parser.js';
import { registerParser } from '../core/parser-registry.js';
import { author, result, uniqueStrings } from './data.js';

class LvzhouParser implements PlatformParser {
  public readonly platform = 'lvzhou' as const;
  public constructor(private readonly context: ParseContext) {}

  public async parse(): Promise<ReturnType<typeof result>> {
    const html = await this.context.session.getText(this.context.realUrl, {
      headers: { referer: 'https://oasis.weibo.cn/' }, signal: this.context.signal,
    });
    const $ = load(html);
    const imageList = uniqueStrings($('.media img').toArray().map((element) => $(element).attr('src')));
    const background = /background-image:url\((.*?)\)/u.exec(html)?.[1];
    return result({
      title: $('.status-text, .status-title').first().text().trim(),
      videoUrl: $('video').first().attr('src') ?? null,
      imageList,
      coverUrl: background ?? imageList[0] ?? null,
      author: author(
        $('.user .nickname').first().text().trim(),
        '',
        $('.user .avatar img').first().attr('src') ?? '',
      ),
    });
  }
}

registerParser('lvzhou', { factory: (context) => new LvzhouParser(context), allowedHosts: [] });
