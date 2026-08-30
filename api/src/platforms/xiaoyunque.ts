import type { ParseContext } from '../core/parse-context.js';
import type { PlatformParser } from '../core/parser.js';
import { registerParser } from '../core/parser-registry.js';
import { array, at, author, result, stringAt, uniqueStrings } from './data.js';

class XiaoyunqueParser implements PlatformParser {
  public readonly platform = 'xiaoyunque' as const;
  public constructor(private readonly context: ParseContext) {}

  public async parse(): Promise<ReturnType<typeof result>> {
    let sourceUrl = this.context.realUrl;
    if (sourceUrl.searchParams.size === 0 && sourceUrl.pathname.includes('/s/')) {
      const response = await this.context.session.request(sourceUrl, {
        followRedirect: true, signal: this.context.signal, maxBodyBytes: 1024 * 1024,
      });
      sourceUrl = response.url;
    }
    if (sourceUrl.searchParams.size === 0) return result({});
    const queryParams = Object.fromEntries(sourceUrl.searchParams.entries());
    const payload = await this.context.session.getJson<unknown>(
      'https://xiaoyunque.jianying.com/luckycat/cn/jianying/campaign/v1/pippit/share/landing_page',
      {
        method: 'POST', json: { query_params: queryParams },
        signal: this.context.signal, timeoutMs: 30_000,
      },
    );
    if (at(payload, 'err_no') !== 0) return result({});
    const generate = at(payload, 'data', 'page_info', 'generate_page');
    const item = at(generate, 'item_info');
    const images = uniqueStrings(array(at(item, 'image_info')).map((image) =>
      typeof image === 'string' ? image : stringAt(image, 'image_url')));
    const videoInfo = at(item, 'video_info');
    const videoUrl = stringAt(item, 'video_url') || stringAt(item, 'video_play_url') ||
      stringAt(videoInfo, 'main_url') || stringAt(videoInfo, 'video_url');
    const user = at(generate, 'user_info');
    return result({
      title: stringAt(item, 'desc') || stringAt(item, 'title') || '小云雀AI 作品',
      videoUrl: videoUrl || null,
      videoList: videoUrl ? [videoUrl] : [],
      coverUrl: stringAt(item, 'cover_url') || images[0] || null,
      imageList: images,
      author: author(
        at(user, 'nick_name'),
        at(user, 'user_id') || at(user, 'sec_uid'),
        at(user, 'avatar_url'),
      ),
    });
  }
}

registerParser('xiaoyunque', {
  factory: (context) => new XiaoyunqueParser(context),
  allowedHosts: [],
});
