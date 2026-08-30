import type { ParseContext } from '../core/parse-context.js';
import type { PlatformParser } from '../core/parser.js';
import { registerParser } from '../core/parser-registry.js';
import { getVideoId } from '../http/url-tools.js';
import { at, author, result, stringAt } from './data.js';

class PipigaoxiaoParser implements PlatformParser {
  public readonly platform = 'pipigaoxiao' as const;
  public constructor(private readonly context: ParseContext) {}

  public async parse(): Promise<ReturnType<typeof result>> {
    const postId = getVideoId(this.context.realUrl);
    if (!/^\d+$/u.test(postId)) return result({});
    const data = await this.context.session.getJson<unknown>(
      'https://h5.pipigx.com/ppapi/share/fetch_content',
      {
        method: 'POST',
        headers: { referer: this.context.realUrl.href },
        json: { mid: 'null', pid: Number(postId), type: 'post' },
        signal: this.context.signal,
      },
    );
    const post = at(data, 'data', 'post');
    const user = at(data, 'data', 'user');
    const imageId = stringAt(post, 'imgs', 0, 'id');
    const avatarValue = stringAt(user, 'avatar');
    return result({
      title: stringAt(post, 'content'),
      videoUrl: imageId ? stringAt(post, 'videos', imageId, 'url') || null : null,
      coverUrl: imageId ? `https://file.ippzone.com/img/view/id/${imageId}` : null,
      author: author(
        at(user, 'name'),
        at(user, 'mid') || at(post, 'mid'),
        /^\d+$/u.test(avatarValue)
          ? `https://file.ippzone.com/img/view/id/${avatarValue}`
          : avatarValue,
      ),
    });
  }
}

registerParser('pipigaoxiao', {
  factory: (context) => new PipigaoxiaoParser(context),
  allowedHosts: [],
});
