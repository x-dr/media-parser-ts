import { load } from 'cheerio';
import type { ParseContext } from '../core/parse-context.js';
import type { PlatformParser } from '../core/parser.js';
import { registerParser } from '../core/parser-registry.js';
import { array, at, author, record, result, string, stringAt, uniqueStrings } from './data.js';

type ContentType = 'answer' | 'zvideo' | 'pin' | 'article';

class ZhihuParser implements PlatformParser {
  public readonly platform = 'zhihu' as const;
  public constructor(private readonly context: ParseContext) {}

  public async parse(): Promise<ReturnType<typeof result>> {
    const content = extractContent(this.context.realUrl);
    if (!content) return result({});
    const data = await this.context.session.getJson<unknown>(
      `https://api.zhihu.com/${content.apiPath}/${content.id}`,
      {
        headers: { referer: 'https://www.zhihu.com/' },
        signal: this.context.signal,
      },
    );
    const pinVideo = findPinVideo(data);
    let videoUrl = bestPlaylistUrl(at(data, 'playlist')) ||
      bestPlaylistUrl(at(pinVideo, 'playlist'));
    if (!videoUrl) {
      const htmlContent = string(at(data, 'content'));
      const lensId = /data-lens-id=["'](\d+)["']/u.exec(htmlContent)?.[1];
      if (lensId) {
        const lens = await this.context.session.getJson<unknown>(
          `https://lens.zhihu.com/api/v4/videos/${lensId}`,
          { headers: { referer: 'https://www.zhihu.com/' }, signal: this.context.signal },
        );
        videoUrl = bestPlaylistUrl(at(lens, 'playlist'));
      }
    }
    const imageList = collectImages(data);
    const questionTitle = stringAt(data, 'question', 'title');
    const title = [
      questionTitle || stringAt(data, 'title') || stringAt(data, 'excerpt_title'),
      stringAt(data, 'excerpt'),
    ].filter(Boolean).join('\n') || htmlToText(
      stringAt(data, 'content_html') || stringAt(data, 'content'),
    ) || (Object.keys(record(pinVideo)).length > 0 ? '知乎视频' : '知乎内容');
    const creator = at(data, 'author');
    return result({
      title,
      videoUrl: videoUrl || null,
      coverUrl: firstUrl(at(pinVideo, 'thumbnail')) || firstUrl(at(data, 'thumbnail')) ||
        firstUrl(at(data, 'image_url')) || imageList[0] || null,
      imageList,
      author: author(at(creator, 'name'), at(creator, 'id'), at(creator, 'avatar_url')),
    });
  }
}

function extractContent(url: URL): { type: ContentType; id: string; apiPath: string } | null {
  const candidates: [ContentType, RegExp, string][] = [
    ['answer', /question\/\d+\/answer\/(\d+)/u, 'answers'],
    ['answer', /\/answer\/(\d+)/u, 'answers'],
    ['zvideo', /\/zvideo\/(\d+)/u, 'videos'],
    ['pin', /\/pin\/(\d+)/u, 'pins'],
    ['article', /(?:zhuanlan\.zhihu\.com\/p\/|\/article\/)(\d+)/u, 'articles'],
  ];
  for (const [type, pattern, apiPath] of candidates) {
    const match = pattern.exec(type === 'article' ? url.href : url.pathname);
    if (match?.[1]) return { type, id: match[1], apiPath };
  }
  return null;
}

function firstUrl(value: unknown): string {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = firstUrl(item);
      if (found) return found;
    }
    return '';
  }
  const item = record(value);
  return string(item.url) || string(item.play_url);
}

function bestPlaylistUrl(value: unknown): string {
  const items = Array.isArray(value) ? value : Object.values(record(value));
  const candidates = items.map(record).filter((item) => Object.keys(item).length > 0);
  candidates.sort((left, right) => score(right) - score(left));
  for (const item of candidates) {
    const url = string(item.play_url) || string(item.url);
    if (url) return url;
  }
  return '';
}

function score(item: Record<string, unknown>): number {
  const bitrate = Number(item.bitrate) || 0;
  const pixels = (Number(item.width) || 0) * (Number(item.height) || 0);
  return (bitrate * 1_000_000_000) + pixels;
}

function findPinVideo(data: unknown): unknown {
  return array(at(data, 'content')).find((item) => stringAt(item, 'type') === 'video') ?? {};
}

function collectImages(data: unknown): string[] {
  const images: string[] = [];
  for (const item of array(at(data, 'content'))) {
    if (stringAt(item, 'type') !== 'image') continue;
    images.push(firstUrl(at(item, 'url') || at(item, 'image')));
  }
  const contentHtml = stringAt(data, 'content') || stringAt(data, 'content_html');
  if (contentHtml) {
    const $ = load(contentHtml);
    $('img').each((_index, element) => {
      const url = $(element).attr('data-original') ?? $(element).attr('data-actualsrc') ??
        $(element).attr('src') ?? '';
      if (url.startsWith('http://') || url.startsWith('https://')) images.push(url);
    });
  }
  return uniqueStrings(images);
}

function htmlToText(value: string): string {
  return value ? load(value).text().replace(/\s+/gu, ' ').trim() : '';
}

registerParser('zhihu', {
  factory: (context) => new ZhihuParser(context),
  allowedHosts: ['api.zhihu.com', 'lens.zhihu.com'],
});
