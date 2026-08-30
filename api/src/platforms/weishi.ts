import type { ParseContext } from '../core/parse-context.js';
import type { PlatformParser } from '../core/parser.js';
import { registerParser } from '../core/parser-registry.js';
import { at, author, extractAssignedJson, result, stringAt } from './data.js';

class WeishiParser implements PlatformParser {
  public readonly platform = 'weishi' as const;
  public constructor(private readonly context: ParseContext) {}

  public async parse(): Promise<ReturnType<typeof result>> {
    const html = await this.context.session.getText(this.context.realUrl, {
      headers: { referer: 'https://isee.weishi.qq.com' }, signal: this.context.signal,
    });
    const data = extractAssignedJson(html, 'window.Vise.initState');
    const feed = at(data, 'feedsList', 0);
    const poster = at(feed, 'poster');
    return result({
      title: stringAt(feed, 'feedDesc'),
      videoUrl: stringAt(feed, 'videoUrl').replaceAll('\\u002F', '/') || null,
      coverUrl: stringAt(feed, 'videoCover').replaceAll('\\u002F', '/') || null,
      author: author(
        at(poster, 'nick'),
        at(poster, 'id'),
        stringAt(poster, 'avatar').replaceAll('\\u002F', '/'),
      ),
    });
  }
}

registerParser('weishi', { factory: (context) => new WeishiParser(context), allowedHosts: [] });
