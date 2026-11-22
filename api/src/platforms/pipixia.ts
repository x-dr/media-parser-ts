import { load } from 'cheerio';
import type { ParseContext } from '../core/parse-context.js';
import type { PlatformParser } from '../core/parser.js';
import { registerParser } from '../core/parser-registry.js';
import { DEFAULT_DESKTOP_USER_AGENT } from '../config/user-agents.js';
import { readText } from '../http/response-reader.js';
import {
  array,
  at,
  author,
  parseJson,
  protocolUrl,
  record,
  result,
  stringAt,
  uniqueStrings,
} from './data.js';

const VIDEO_QUALITY_KEYS = [
  'video_download',
  'origin_video_download',
  'video_high',
  'video_fallback',
  'video_mid',
  'video_low',
] as const;

class PipixiaParser implements PlatformParser {
  public readonly platform = 'pipixia' as const;
  public constructor(private readonly context: ParseContext) {}

  public async parse(): Promise<ReturnType<typeof result>> {
    const headers = {
      'user-agent': DEFAULT_DESKTOP_USER_AGENT,
      referer: 'https://h5.pipix.com/',
    };

    let initialHtml = '';
    let locationHeaderValue = '';
    let responseUrl: URL = this.context.realUrl;

    try {
      const redirect = await this.context.session.request(this.context.realUrl, {
        headers,
        followRedirect: false,
        signal: this.context.signal,
      });
      initialHtml = readText(redirect);
      responseUrl = redirect.url;
      const rawLocation = redirect.headers.location;
      locationHeaderValue = (Array.isArray(rawLocation) ? rawLocation[0] : rawLocation) ?? '';
    } catch {
      // Fall through if initial request fails.
    }

    let item: unknown = {};
    let pageTitle = '';

    if (initialHtml) {
      const extracted = extractItemFromHtml(initialHtml);
      item = extracted.item;
      pageTitle = extracted.pageTitle || extractOgTitle(initialHtml);
    }

    if (Object.keys(record(item)).length === 0) {
      const pageUrl = locationHeaderValue
        ? new URL(locationHeaderValue, this.context.realUrl)
        : responseUrl;
      const videoId = extractPipixiaId(pageUrl);
      if (!videoId) return result({});

      const api = new URL('https://api.pipix.com/bds/cell/cell_comment/');
      for (const [key, value] of Object.entries({
        offset: '0',
        cell_type: '1',
        api_version: '1',
        cell_id: videoId,
        ac: 'wifi',
        channel: 'huawei_1319_64',
        aid: '1319',
        app_name: 'super',
      })) {
        api.searchParams.set(key, value);
      }

      const [data, pageHtml] = await Promise.all([
        this.context.session.getJson<unknown>(api, {
          headers,
          signal: this.context.signal,
        }).catch(() => ({})),
        pageUrl.href !== this.context.realUrl.href || !initialHtml
          ? this.context.session.getText(pageUrl, {
              headers,
              signal: this.context.signal,
            }).catch(() => '')
          : Promise.resolve(initialHtml),
      ]);

      item =
        at(data, 'data', 'cell_comments', 0, 'comment_info', 'item') ??
        at(data, 'data', 'item') ??
        {};

      if (Object.keys(record(item)).length === 0 && pageHtml) {
        const ssrFallback = extractItemFromHtml(pageHtml);
        item = ssrFallback.item;
        if (!pageTitle) pageTitle = ssrFallback.pageTitle;
      }
      if (!pageTitle && pageHtml) {
        pageTitle = extractOgTitle(pageHtml);
      }
    }

    const videoUrl = extractVideoUrl(item);
    const imageList = extractImages(item);
    const coverUrl = extractCoverUrl(item, imageList);
    const content = stringAt(item, 'content');
    const authorNode = at(item, 'author');

    return result({
      title: content || pageTitle,
      desc: content || null,
      videoUrl: videoUrl || null,
      coverUrl: coverUrl || null,
      imageList,
      author: author(
        at(authorNode, 'name'),
        at(authorNode, 'id') || at(authorNode, 'id_str'),
        protocolUrl(
          stringAt(authorNode, 'avatar', 'download_list', 0, 'url') ||
            stringAt(authorNode, 'avatar', 'url_list', 0, 'url'),
        ),
      ),
    });
  }
}

function extractPipixiaId(url: URL): string {
  const itemMatch = /\/item\/(\d+)/u.exec(url.pathname)?.[1];
  if (itemMatch) return itemMatch;
  const last = url.pathname.split('/').filter(Boolean).at(-1) ?? '';
  return /^\d+$/u.test(last) ? last : '';
}

function extractItemFromHtml(html: string): { item: unknown; pageTitle: string } {
  const $ = load(html);
  let foundItem: unknown = {};
  let pageTitle = '';

  $('script').each((_index, element) => {
    if (Object.keys(record(foundItem)).length > 0) return;
    const raw = ($(element).html() ?? '').trim();
    if (!raw) return;

    let payload: unknown = null;
    if (
      raw.includes('%22ppxItemDetail%22') ||
      raw.includes('%22itemId%22') ||
      raw.includes('%7B%22')
    ) {
      try {
        payload = parseJson(decodeURIComponent(raw));
      } catch {
        payload = null;
      }
    } else if (raw.includes('ppxItemDetail')) {
      try {
        payload = parseJson(raw);
      } catch {
        payload = null;
      }
    }

    if (payload) {
      const candidate = at(payload, 'ppxItemDetail', 'item');
      if (Object.keys(record(candidate)).length > 0) {
        foundItem = candidate;
        pageTitle = stripPipixiaSuffix(stringAt(payload, 'seoTDK', 'title'));
      }
    }
  });

  return { item: foundItem, pageTitle };
}

function extractOgTitle(html: string): string {
  const raw = load(html)('meta[property="og:title"]').attr('content') ?? '';
  return stripPipixiaSuffix(raw);
}

function stripPipixiaSuffix(rawTitle: string): string {
  const trimmed = rawTitle.trim();
  const suffixIndex = trimmed.lastIndexOf('-');
  if (suffixIndex >= 0 && trimmed.slice(suffixIndex + 1).trim() === '皮皮虾') {
    return trimmed.slice(0, suffixIndex).trim();
  }
  return trimmed;
}

function extractVideoUrl(item: unknown): string {
  const video = at(item, 'video');
  for (const key of VIDEO_QUALITY_KEYS) {
    const candidate =
      stringAt(video, key, 'url_list', 0, 'url') ||
      stringAt(item, key, 'url_list', 0, 'url');
    if (candidate) return protocolUrl(candidate);
  }
  return '';
}

function extractImages(item: unknown): string[] {
  const noteImages = array(at(item, 'note', 'multi_image'));
  const sourceList = noteImages.length > 0
    ? noteImages
    : array(at(item, 'large_image_list')).length > 0
      ? array(at(item, 'large_image_list'))
      : array(at(item, 'thumb_image_list'));

  const urls: string[] = [];
  for (const image of sourceList) {
    const candidate =
      stringAt(image, 'url_list', 0, 'url') ||
      stringAt(image, 'download_list', 0, 'url');
    if (candidate) urls.push(protocolUrl(candidate));
  }
  return uniqueStrings(urls);
}

function extractCoverUrl(item: unknown, imageList: readonly string[]): string {
  const direct =
    stringAt(item, 'cover', 'url_list', 0, 'url') ||
    stringAt(item, 'video', 'cover_image', 'url_list', 0, 'url');
  if (direct) return protocolUrl(direct);
  return imageList[0] ?? '';
}

registerParser('pipixia', {
  factory: (context) => new PipixiaParser(context),
  allowedHosts: ['api.pipix.com', 'h5.pipix.com'],
});
