import type { ParseContext } from '../core/parse-context.js';
import type { PlatformParser } from '../core/parser.js';
import { registerParser } from '../core/parser-registry.js';
import { at, author, record, result, string, stringAt } from './data.js';

class JimengParser implements PlatformParser {
  public readonly platform = 'jimeng' as const;
  public constructor(private readonly context: ParseContext) {}

  public async parse(): Promise<ReturnType<typeof result>> {
    let sourceUrl = this.context.realUrl;
    let itemId = extractItemId(sourceUrl);
    if (!itemId && sourceUrl.pathname.includes('/s/')) {
      const response = await this.context.session.request(sourceUrl, {
        followRedirect: true, signal: this.context.signal, maxBodyBytes: 1024 * 1024,
      });
      sourceUrl = response.url;
      itemId = extractItemId(sourceUrl);
    }
    if (!itemId) return result({});
    const payload = await this.context.session.getJson<unknown>(
      'https://jimeng.jianying.com/mweb/v1/get_item_info',
      {
        method: 'POST', json: { published_item_id: itemId }, signal: this.context.signal,
        timeoutMs: 30_000,
      },
    );
    if (String(at(payload, 'ret')) !== '0') return result({});
    const detail = at(payload, 'data');
    const common = at(detail, 'common_attr');
    const video = at(detail, 'video');
    const transcoded = at(video, 'transcoded_video');
    const videoUrl = stringAt(transcoded, 'origin', 'video_url') ||
      stringAt(video, 'origin_video', 'video_url') || bestTranscodedUrl(transcoded);
    const coverMap = record(at(common, 'cover_url_map'));
    const mappedCover = ['4096', '2400', '1080', '720', '480', '360', 'original']
      .map((key) => string(coverMap[key])).find(Boolean) ??
      Object.values(coverMap).map((value) => string(value)).find(Boolean);
    const coverUrl = (mappedCover ?? stringAt(common, 'cover_url')) || stringAt(video, 'cover_url') || null;
    const creator = at(detail, 'author');
    return result({
      title: stringAt(common, 'description') || '即梦AI 视频',
      videoUrl: videoUrl || null,
      videoList: videoUrl ? [videoUrl] : [],
      coverUrl,
      author: author(
        at(creator, 'name'),
        at(creator, 'uid') || at(creator, 'sec_uid'),
        at(creator, 'avatar_url'),
      ),
    });
  }
}

function extractItemId(url: URL): string {
  return url.searchParams.get('item_id') ?? url.searchParams.get('id') ??
    (/^\d+$/u.test(url.pathname.split('/').filter(Boolean).at(-1) ?? '')
      ? url.pathname.split('/').filter(Boolean).at(-1) ?? '' : '');
}

function bestTranscodedUrl(value: unknown): string {
  let best = { score: 0, bitrate: 0, url: '' };
  for (const entry of Object.values(record(value))) {
    const url = stringAt(entry, 'video_url');
    if (!url) continue;
    const width = Number(at(entry, 'width')) || 0;
    const height = Number(at(entry, 'height')) || 0;
    const bitrate = Number(at(entry, 'br') || at(entry, 'bitrate')) || 0;
    if (width * height > best.score || (width * height === best.score && bitrate > best.bitrate)) {
      best = { score: width * height, bitrate, url };
    }
  }
  return best.url;
}

registerParser('jimeng', {
  factory: (context) => new JimengParser(context),
  allowedHosts: [],
});
