import type { ParseContext } from '../core/parse-context.js';
import type { PlatformParser } from '../core/parser.js';
import { registerParser } from '../core/parser-registry.js';
import { array, at, author, parseJson, record, result, string, stringAt, uniqueStrings } from './data.js';

class SoulParser implements PlatformParser {
  public readonly platform = 'soul' as const;
  public constructor(private readonly context: ParseContext) {}

  public async parse(): Promise<ReturnType<typeof result>> {
    const fragmentQuery = this.context.realUrl.hash.includes('?')
      ? new URLSearchParams(this.context.realUrl.hash.split('?')[1] ?? '')
      : new URLSearchParams();
    const params: Record<string, string> = {};
    for (const key of ['postIdEcpt', 'sign', 'signVersion']) {
      const value = this.context.realUrl.searchParams.get(key) ?? fragmentQuery.get(key);
      if (!value) return result({});
      params[key] = value;
    }
    const postPayload = await this.context.session.getJson<unknown>(
      'https://api-h5.soulapp.cn/html/v3/post/detail',
      { searchParams: params, headers: soulHeaders(), signal: this.context.signal },
    );
    if (at(postPayload, 'success') !== true) return result({});
    const post = at(postPayload, 'data', 'post');
    const authorId = stringAt(post, 'authorIdEcpt');
    const userPayload = authorId ? await this.context.session.getJson<unknown>(
      'https://api-h5.soulapp.cn/html/v2/user/info',
      { searchParams: { userIdEcpt: authorId }, headers: soulHeaders(), signal: this.context.signal },
    ) : {};
    const user = at(userPayload, 'data');
    const attachments = array(at(post, 'attachments'));
    const video = attachments.find((attachment) => stringAt(attachment, 'type') === 'VIDEO');
    let extension: unknown = {};
    const rawExtension = stringAt(video, 'ext');
    if (rawExtension) {
      try { extension = parseJson(rawExtension); } catch { extension = {}; }
    }
    const imageList = uniqueStrings(attachments.flatMap((attachment) => {
      if (stringAt(attachment, 'type') === 'VIDEO') return [];
      const item = record(attachment);
      const url = ['fileUrl', 'imageUrl', 'imageOriginUrl', 'pictureUrl']
        .map((key) => string(item[key])).find(Boolean);
      return url ? [url.replaceAll('\\/', '/')] : [];
    }));
    return result({
      title: stringAt(post, 'content') || 'Soul 帖子',
      videoUrl: stringAt(video, 'fileUrl').replaceAll('\\/', '/') || null,
      coverUrl: (stringAt(video, 'videoCoverUrl') || stringAt(extension, 'videoCoverUrl'))
        .replaceAll('\\/', '/') || null,
      imageList,
      author: author(
        at(user, 'nickName'),
        authorId,
        stringAt(user, 'headImgurl').replaceAll('\\/', '/'),
      ),
    });
  }
}

function soulHeaders(): Record<string, string> {
  return {
    accept: 'application/json, text/plain, */*',
    referer: 'https://w13.soulsmile.cn/',
    origin: 'https://w13.soulsmile.cn',
  };
}

registerParser('soul', {
  factory: (context) => new SoulParser(context),
  allowedHosts: ['api-h5.soulapp.cn'],
});
