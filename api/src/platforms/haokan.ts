import type { ParseContext } from '../core/parse-context.js';
import type { PlatformParser } from '../core/parser.js';
import { registerParser } from '../core/parser-registry.js';
import { array, at, author, extractAssignedJson, result, stringAt } from './data.js';

class HaokanParser implements PlatformParser {
  public readonly platform = 'haokan' as const;
  public constructor(private readonly context: ParseContext) {}

  public async parse(): Promise<ReturnType<typeof result>> {
    const html = await this.context.session.getText(this.context.realUrl, {
      headers: { referer: 'https://haokan.baidu.com/v' }, signal: this.context.signal,
    });
    const data = extractAssignedJson(html, 'window.__PRELOADED_STATE__');
    const clarity = array(at(data, 'curVideoMeta', 'clarityUrl'));
    const best = clarity.at(-1);
    const authorNode = at(data, 'curVideoMeta', 'mth');
    const decodedVideo = stringAt(best, 'url');
    return result({
      title: stringAt(data, 'curVideoMeta', 'title'),
      videoUrl: decodedVideo ? decodeURIComponent(decodedVideo).replaceAll('\\/', '/') : null,
      coverUrl: stringAt(data, 'curVideoMeta', 'poster').replaceAll('\\/', '/') || null,
      author: author(
        at(authorNode, 'author_name'),
        at(authorNode, 'mthid'),
        stringAt(authorNode, 'author_photo').replaceAll('\\/', '/'),
      ),
    });
  }
}

registerParser('haokan', { factory: (context) => new HaokanParser(context), allowedHosts: [] });
