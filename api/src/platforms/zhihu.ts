import { load } from 'cheerio';
import type { ParseContext } from '../core/parse-context.js';
import type { PlatformParser } from '../core/parser.js';
import { registerParser } from '../core/parser-registry.js';
import { DEFAULT_MOBILE_USER_AGENT } from '../config/user-agents.js';
import {
  array,
  at,
  author,
  parseJson,
  protocolUrl,
  record,
  result,
  string,
  stringAt,
  uniqueStrings,
} from './data.js';

type ContentType = 'answer' | 'zvideo' | 'pin' | 'article';

interface ContentRef {
  type: ContentType;
  id: string;
  apiPath: string;
}

class ZhihuParser implements PlatformParser {
  public readonly platform = 'zhihu' as const;
  public constructor(private readonly context: ParseContext) {}

  public async parse(): Promise<ReturnType<typeof result>> {
    const content = extractContent(this.context.realUrl);
    if (!content) return result({});

    const headers = this.#buildHeaders();
    let data = await this.#fetchApiData(content, headers);
    if (Object.keys(record(data)).length === 0) {
      data = await this.#fetchHtmlFallback(content, headers);
    }
    if (Object.keys(record(data)).length === 0) return result({});

    const pinVideos = findPinVideos(data);
    const videoUrls: string[] = [];

    const directPlaylist =
      bestPlaylistUrl(at(data, 'playlist')) ||
      bestPlaylistUrl(at(data, 'video', 'playlist'));
    if (directPlaylist) videoUrls.push(directPlaylist);

    for (const pinVideo of pinVideos) {
      const pinUrl = bestPlaylistUrl(at(pinVideo, 'playlist')) || firstUrl(pinVideo);
      if (pinUrl) videoUrls.push(pinUrl);
    }

    const htmlBody = string(at(data, 'content')) || string(at(data, 'content_html'));
    if (htmlBody) {
      for (const lensId of extractLensIds(htmlBody)) {
        const lensVideo = await this.#fetchLensVideo(lensId, headers);
        if (lensVideo) videoUrls.push(lensVideo);
      }
    }

    const videoList = uniqueStrings(videoUrls.map(protocolUrl));
    const imageList = collectImages(data);
    const coverCandidate = resolveCoverUrl(data, pinVideos[0], imageList);

    const rawTitle =
      stringAt(data, 'question', 'title') ||
      stringAt(data, 'title') ||
      stringAt(data, 'excerpt_title');
    const rawDesc =
      stringAt(data, 'excerpt') ||
      htmlToText(stringAt(data, 'content_html') || stringAt(data, 'content'));
    const fallbackLabel = pinVideos.length > 0 || videoList.length > 0 ? '知乎视频' : '知乎内容';
    const title = rawTitle || rawDesc || fallbackLabel;
    const creator = at(data, 'author');

    return result({
      title,
      desc: rawDesc || null,
      videoUrl: videoList[0] ?? null,
      videoList: videoList.length > 1 ? videoList : [],
      coverUrl: coverCandidate || null,
      imageList,
      author: author(
        at(creator, 'name') || at(creator, 'nickname'),
        at(creator, 'id') || at(creator, 'url_token') || at(creator, 'urlToken'),
        protocolUrl(stringAt(creator, 'avatar_url') || stringAt(creator, 'avatarUrl')),
      ),
    });
  }

  #buildHeaders(): Record<string, string> {
    const cookie = this.context.credentials.cookie;
    return {
      'user-agent': DEFAULT_MOBILE_USER_AGENT,
      referer: 'https://www.zhihu.com/',
      ...(cookie ? { cookie } : {}),
    };
  }

  async #fetchApiData(
    content: ContentRef,
    headers: Record<string, string>,
  ): Promise<unknown> {
    try {
      const data = await this.context.session.getJson<unknown>(
        `https://api.zhihu.com/${content.apiPath}/${content.id}`,
        { headers, signal: this.context.signal },
      );
      if (Object.keys(record(data)).length > 0 && !at(data, 'error')) {
        return data;
      }
    } catch {
      // Fall back to HTML SSR extraction.
    }
    return {};
  }

  async #fetchHtmlFallback(
    content: ContentRef,
    headers: Record<string, string>,
  ): Promise<unknown> {
    try {
      const html = await this.context.session.getText(this.context.realUrl, {
        headers,
        signal: this.context.signal,
      });
      if (!html) return {};
      const $ = load(html);
      const initialRaw = $('#js-initialData').html();
      if (initialRaw) {
        try {
          const parsed = parseJson(initialRaw);
          const entities = at(parsed, 'initialState', 'entities');
          const entityBucket =
            content.type === 'article'
              ? 'articles'
              : content.type === 'answer'
                ? 'answers'
                : content.type === 'zvideo'
                  ? 'zvideos'
                  : 'pins';
          const entity = record(at(entities, entityBucket, content.id));
          if (Object.keys(entity).length > 0) return entity;
        } catch {
          // Fall through to OpenGraph / RichText extraction.
        }
      }

      const fallback: Record<string, unknown> = {};
      const ogTitle = $('meta[property="og:title"]').attr('content')?.trim() ?? '';
      if (ogTitle) fallback.title = ogTitle;
      const ogImage = $('meta[property="og:image"]').attr('content')?.trim() ?? '';
      if (ogImage) fallback.title_image = ogImage;
      const ogDesc =
        $('meta[property="og:description"]').attr('content')?.trim() ??
        $('meta[name="description"]').attr('content')?.trim() ??
        '';
      if (ogDesc) fallback.excerpt = ogDesc;
      const richHtml = $('div.Post-RichText, div.RichText').first().html() ?? '';
      if (richHtml) fallback.content = richHtml;
      return fallback;
    } catch {
      return {};
    }
  }

  async #fetchLensVideo(
    lensId: string,
    headers: Record<string, string>,
  ): Promise<string> {
    try {
      const lens = await this.context.session.getJson<unknown>(
        `https://lens.zhihu.com/api/v4/videos/${lensId}`,
        { headers, signal: this.context.signal },
      );
      return bestPlaylistUrl(at(lens, 'playlist'));
    } catch {
      return '';
    }
  }
}

function extractContent(url: URL): ContentRef | null {
  const candidates: readonly [ContentType, RegExp, string][] = [
    ['answer', /question\/\d+\/answer\/(\d+)/u, 'answers'],
    ['answer', /\/answer\/(\d+)/u, 'answers'],
    ['zvideo', /\/zvideo\/(\d+)/u, 'videos'],
    ['pin', /\/pin\/(\d+)/u, 'pins'],
    ['article', /(?:zhuanlan\.zhihu\.com\/p\/|zhihu\.com\/p\/|\/p\/|\/article\/)(\d+)/u, 'articles'],
  ];
  for (const [type, pattern, apiPath] of candidates) {
    const match = pattern.exec(type === 'article' ? url.href : url.pathname);
    if (match?.[1]) return { type, id: match[1], apiPath };
  }
  return null;
}

function extractLensIds(htmlContent: string): string[] {
  const ids: string[] = [];
  const $ = load(htmlContent);
  $('[data-lens-id]').each((_index, element) => {
    const rawId = ($(element).attr('data-lens-id') ?? '').trim();
    if (/^\d+$/u.test(rawId)) ids.push(rawId);
  });
  if (ids.length === 0) {
    const match = /data-lens-id=["'](\d+)["']/u.exec(htmlContent)?.[1];
    if (match) ids.push(match);
  }
  return uniqueStrings(ids);
}

function firstUrl(value: unknown): string {
  if (typeof value === 'string') return protocolUrl(value);
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = firstUrl(item);
      if (found) return found;
    }
    return '';
  }
  const item = record(value);
  return protocolUrl(string(item.url) || string(item.play_url) || string(item.original_url));
}

function bestPlaylistUrl(value: unknown): string {
  const items = Array.isArray(value) ? value : Object.values(record(value));
  const candidates = items.map(record).filter((item) => Object.keys(item).length > 0);
  candidates.sort((left, right) => score(right) - score(left));
  for (const item of candidates) {
    const url = string(item.play_url) || string(item.url);
    if (url) return protocolUrl(url);
  }
  return '';
}

function score(item: Record<string, unknown>): number {
  const bitrate = Number(item.bitrate) || 0;
  const pixels = (Number(item.width) || 0) * (Number(item.height) || 0);
  return bitrate * 1_000_000_000 + pixels;
}

function findPinVideos(data: unknown): unknown[] {
  return array(at(data, 'content')).filter((item) => stringAt(item, 'type') === 'video');
}

function extractArticleCover(data: unknown): string {
  const coverKeys = [
    'title_image',
    'title_img',
    'titleImage',
    'cover_url',
    'cover',
    'thumbnail',
    'image_url',
    'imageUrl',
  ] as const;
  for (const key of coverKeys) {
    const candidate = firstUrl(at(data, key));
    if (candidate.startsWith('http://') || candidate.startsWith('https://')) {
      return candidate;
    }
  }
  return '';
}

function resolveCoverUrl(
  data: unknown,
  firstPinVideo: unknown,
  imageList: readonly string[],
): string {
  return (
    firstUrl(at(firstPinVideo, 'thumbnail')) ||
    firstUrl(at(firstPinVideo, 'cover_url')) ||
    extractArticleCover(data) ||
    (imageList[0] ?? '')
  );
}

function collectImages(data: unknown): string[] {
  const images: string[] = [];
  const headerCover = extractArticleCover(data);
  if (headerCover) images.push(headerCover);

  for (const item of array(at(data, 'content'))) {
    if (stringAt(item, 'type') !== 'image') continue;
    const pinImg = firstUrl(at(item, 'original_url') || at(item, 'url') || at(item, 'image'));
    if (pinImg.startsWith('http://') || pinImg.startsWith('https://')) {
      images.push(pinImg);
    }
  }

  const contentHtml = stringAt(data, 'content') || stringAt(data, 'content_html');
  if (contentHtml) {
    const $ = load(contentHtml);
    $('img').each((_index, element) => {
      const rawUrl =
        $(element).attr('data-original') ??
        $(element).attr('data-actualsrc') ??
        $(element).attr('data-default-watermark-src') ??
        $(element).attr('src') ??
        '';
      const normalized = protocolUrl(rawUrl.trim());
      if (normalized.startsWith('http://') || normalized.startsWith('https://')) {
        images.push(normalized);
      }
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
