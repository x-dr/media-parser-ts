import type { ParseContext } from '../core/parse-context.js';
import type { PlatformParser } from '../core/parser.js';
import { registerParser } from '../core/parser-registry.js';
import { extractAssignedJson, result, stringAt } from './data.js';

class QuanminkgeParser implements PlatformParser {
  public readonly platform = 'quanminkge' as const;
  public constructor(private readonly context: ParseContext) {}

  public async parse(): Promise<ReturnType<typeof result>> {
    const shareId = this.context.realUrl.searchParams.get('s');
    if (!shareId) return result({});
    const url = new URL('https://kg.qq.com/node/play');
    url.searchParams.set('s', shareId);
    const html = await this.context.session.getText(url, {
      headers: { referer: 'https://kg.qq.com/' }, signal: this.context.signal,
    });
    const data = extractAssignedJson(html, 'window.__DATA__');
    return result({
      title: stringAt(data, 'detail', 'content'),
      videoUrl: stringAt(data, 'detail', 'playurl_video') || null,
      coverUrl: stringAt(data, 'detail', 'cover') || null,
    });
  }
}

registerParser('quanminkge', { factory: (context) => new QuanminkgeParser(context), allowedHosts: [] });
