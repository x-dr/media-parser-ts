import type { ParseContext } from '../core/parse-context.js';
import type { PlatformParser } from '../core/parser.js';
import { registerParser } from '../core/parser-registry.js';
import { array, at, author, result, string, stringAt, uniqueStrings } from './data.js';

class XinpianchangParser implements PlatformParser {
  public readonly platform = 'xinpianchang' as const;
  public constructor(private readonly context: ParseContext) {}

  public async parse(): Promise<ReturnType<typeof result>> {
    const articleId = /(?:a|article\/)?(\d+)/u.exec(this.context.realUrl.pathname)?.[1];
    if (!articleId) return result({});
    const article = await this.context.session.getJson<unknown>(
      `https://app.xinpianchang.com/article/${articleId}`,
      { headers: { accept: 'application/json, text/plain, */*' }, signal: this.context.signal },
    );
    if (at(article, 'status') !== 0) return result({});
    const data = at(article, 'data');
    const vid = string(at(data, 'vid')) || string(at(data, 'media_id'));
    const appKey = stringAt(data, 'video', 'appKey') || '61a2f329348b3bf77';
    let videoList: string[] = [];
    if (vid) {
      const media = await this.context.session.getJson<unknown>(
        `https://mod-api.xinpianchang.com/mod/api/v2/media/${encodeURIComponent(vid)}?appKey=${encodeURIComponent(appKey)}`,
        { signal: this.context.signal },
      );
      videoList = uniqueStrings(
        array(at(media, 'data', 'resource', 'progressive')).map((entry) => stringAt(entry, 'url')),
      ).filter((url) => url.startsWith('http'));
    }
    const authorNode = at(data, 'author', 'userinfo');
    return result({
      title: stringAt(data, 'title'),
      videoUrl: videoList[0] ?? null,
      videoList,
      coverUrl: stringAt(data, 'cover') || null,
      author: author(at(authorNode, 'username'), at(authorNode, 'id'), at(authorNode, 'avatar')),
    });
  }
}

registerParser('xinpianchang', {
  factory: (context) => new XinpianchangParser(context),
  allowedHosts: ['app.xinpianchang.com', 'mod-api.xinpianchang.com'],
});
