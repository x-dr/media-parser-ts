import { load } from 'cheerio';
import type { ParseContext } from '../core/parse-context.js';
import type { PlatformParser } from '../core/parser.js';
import { registerParser } from '../core/parser-registry.js';
import { array, at, author, result, stringAt, uniqueStrings } from './data.js';

class PipixiaParser implements PlatformParser {
  public readonly platform = 'pipixia' as const;
  public constructor(private readonly context: ParseContext) {}

  public async parse(): Promise<ReturnType<typeof result>> {
    const redirect = await this.context.session.request(this.context.realUrl, {
      headers: { referer: 'https://h5.pipix.com/' }, followRedirect: false, signal: this.context.signal,
    });
    const locationHeader = redirect.headers.location;
    const location = Array.isArray(locationHeader) ? locationHeader[0] : locationHeader;
    if (!location) return result({});
    const pageUrl = new URL(location, this.context.realUrl);
    const videoId = pageUrl.pathname.split('/').filter(Boolean).at(-1) ?? '';
    if (!/^\d+$/u.test(videoId)) return result({});
    const api = new URL('https://api.pipix.com/bds/cell/cell_comment/');
    for (const [key, value] of Object.entries({
      offset: '0', cell_type: '1', api_version: '1', cell_id: videoId,
      ac: 'wifi', channel: 'huawei_1319_64', aid: '1319', app_name: 'super',
    })) api.searchParams.set(key, value);
    const [data, html] = await Promise.all([
      this.context.session.getJson<unknown>(api, { signal: this.context.signal }),
      this.context.session.getText(pageUrl, { signal: this.context.signal }),
    ]);
    const item = at(data, 'data', 'cell_comments', 0, 'comment_info', 'item');
    const videoUrl = stringAt(item, 'video', 'video_high', 'url_list', 0, 'url') || null;
    const imageList = array(at(item, 'note', 'multi_image'))
      .map((image) => stringAt(image, 'url_list', 0, 'url'));
    const pageTitle = load(html)('meta[property="og:title"]').attr('content')
      ?.replace(/\s*-\s*皮皮虾\s*$/u, '').trim() ?? '';
    const authorNode = at(item, 'author');
    return result({
      title: stringAt(item, 'content') || pageTitle,
      videoUrl,
      coverUrl: stringAt(item, 'cover', 'url_list', 0, 'url') || null,
      imageList: uniqueStrings(imageList),
      author: author(
        at(authorNode, 'name'),
        at(authorNode, 'id'),
        at(authorNode, 'avatar', 'download_list', 0, 'url'),
      ),
    });
  }
}

registerParser('pipixia', {
  factory: (context) => new PipixiaParser(context),
  allowedHosts: ['api.pipix.com'],
});
