import type { ParseContext } from '../core/parse-context.js';
import type { PlatformParser } from '../core/parser.js';
import { registerParser } from '../core/parser-registry.js';
import { at, author, result, stringAt } from './data.js';

class ZuiyouParser implements PlatformParser {
  public readonly platform = 'zuiyou' as const;
  public constructor(private readonly context: ParseContext) {}

  public async parse(): Promise<ReturnType<typeof result>> {
    const postId = this.context.realUrl.searchParams.get('pid');
    if (!postId || !/^\d+$/u.test(postId)) return result({});
    const data = await this.context.session.getJson<unknown>(
      'https://share.xiaochuankeji.cn/planck/share/post/detail_h5',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', referer: 'https://share.xiaochuankeji.cn/' },
        json: { h_av: '5.2.13.011', pid: Number(postId) },
        signal: this.context.signal,
      },
    );
    const post = at(data, 'data', 'post');
    const imageId = stringAt(post, 'imgs', 0, 'id');
    const member = at(post, 'member');
    return result({
      title: stringAt(post, 'content'),
      videoUrl: imageId ? stringAt(post, 'videos', imageId, 'url') || null : null,
      author: author(
        at(member, 'name'),
        at(member, 'id'),
        at(member, 'avatar_urls', 'origin', 'urls', 0),
      ),
    });
  }
}

registerParser('zuiyou', { factory: (context) => new ZuiyouParser(context), allowedHosts: [] });
