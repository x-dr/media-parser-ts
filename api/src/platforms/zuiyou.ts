import { load } from 'cheerio';
import type { ParseContext } from '../core/parse-context.js';
import type { ImageItem } from '../core/media-result.js';
import type { PlatformParser } from '../core/parser.js';
import { registerParser } from '../core/parser-registry.js';
import { DEFAULT_DESKTOP_USER_AGENT } from '../config/user-agents.js';
import {
  array,
  at,
  author,
  extractAssignedJson,
  idAt,
  parseJson,
  protocolUrl,
  record,
  result,
  string,
  stringAt,
  uniqueStrings,
} from './data.js';

const LIVE_PHOTO_MAX_DURATION = 5;
const DETAIL_H5_API = 'https://share.xiaochuankeji.cn/planck/share/post/detail_h5';
const IMAGE_VARIANT_KEYS = [
  'origin',
  'origin_webp',
  '540',
  '540_webp',
  '360',
  '360_webp',
] as const;

class ZuiyouParser implements PlatformParser {
  public readonly platform = 'zuiyou' as const;
  public constructor(private readonly context: ParseContext) {}

  public async parse(): Promise<ReturnType<typeof result>> {
    const postId = extractPostId(this.context.realUrl);
    let post: unknown = {};

    if (postId) {
      try {
        const data = await this.context.session.getJson<unknown>(DETAIL_H5_API, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'user-agent': DEFAULT_DESKTOP_USER_AGENT,
            referer: 'https://share.xiaochuankeji.cn/',
          },
          json: { h_av: '5.2.13.011', pid: Number(postId) },
          signal: this.context.signal,
        });
        post = at(data, 'data', 'post');
      } catch {
        // Fall through to SSR HTML fallback.
      }
    }

    if (Object.keys(record(post)).length === 0) {
      post = await this.#fetchPostFromSsr();
    }
    if (Object.keys(record(post)).length === 0) return result({});

    const videosMap = record(at(post, 'videos'));
    const imgs = array(at(post, 'imgs'));
    const videoUrls = collectMainVideos(imgs, videosMap);
    const imageList = collectGalleryAndLivePhotos(imgs, videosMap);

    const coverUrl =
      protocolUrl(stringAt(post, 'cover')) ||
      extractImageUrl(imgs[0]) ||
      null;
    const member = at(post, 'member');
    const content = stringAt(post, 'content');

    return result({
      title: content,
      desc: content || null,
      videoUrl: videoUrls[0] ?? null,
      videoList: videoUrls.length > 1 ? videoUrls : [],
      coverUrl,
      imageList,
      author: author(
        at(member, 'name'),
        at(member, 'id'),
        protocolUrl(stringAt(member, 'avatar_urls', 'origin', 'urls', 0) || stringAt(member, 'avatar')),
      ),
    });
  }

  async #fetchPostFromSsr(): Promise<unknown> {
    try {
      const html = await this.context.session.getText(this.context.realUrl, {
        headers: {
          'user-agent': DEFAULT_DESKTOP_USER_AGENT,
          referer: 'https://share.xiaochuankeji.cn/',
        },
        signal: this.context.signal,
      });
      for (const marker of ['window.__INITIAL_STATE__', 'window.APP_INITIAL_STATE'] as const) {
        if (!html.includes(marker)) continue;
        const state = extractAssignedJson(html, marker);
        const found = findPostInState(state);
        if (Object.keys(record(found)).length > 0) return found;
      }
      const $ = load(html);
      const nextRaw = $('#__NEXT_DATA__').html();
      if (nextRaw) {
        const found = findPostInState(parseJson(nextRaw));
        if (Object.keys(record(found)).length > 0) return found;
      }
    } catch {
      // Ignore SSR fallback errors.
    }
    return {};
  }
}

function extractPostId(url: URL): string {
  const pid = url.searchParams.get('pid') ?? '';
  if (/^\d+$/u.test(pid)) return pid;
  const pathMatch = /\/post\/(\d+)/u.exec(url.pathname)?.[1];
  if (pathMatch) return pathMatch;
  const lastSegment = url.pathname.split('/').filter(Boolean).at(-1) ?? '';
  return /^\d+$/u.test(lastSegment) ? lastSegment : '';
}

function findPostInState(state: unknown): unknown {
  const candidates = [
    at(state, 'sharePost', 'postDetail', 'post'),
    at(state, 'postDetail', 'post'),
    at(state, 'data', 'post'),
    at(state, 'props', 'pageProps', 'post'),
    at(state, 'post'),
  ];
  return candidates.find((candidate) => Object.keys(record(candidate)).length > 0) ?? {};
}

function isLivePhotoVideo(videoInfo: unknown, imgNode?: unknown): boolean {
  if (at(imgNode, 'livePhoto') === true || at(imgNode, 'live_photo') === true) return true;
  const mapped = record(videoInfo);
  if (mapped.is_live_photo === true || mapped.livePhoto === true) return true;
  const dur = mapped.dur;
  if (typeof dur === 'number' && Number.isFinite(dur)) {
    return dur > 0 && dur <= LIVE_PHOTO_MAX_DURATION;
  }
  return false;
}

function extractEmbeddedLiveVideo(imgNode: unknown): string {
  const embedded = at(imgNode, 'video');
  if (typeof embedded === 'string' && embedded.startsWith('http')) {
    return protocolUrl(embedded);
  }
  const embeddedObj = record(embedded);
  const direct =
    string(embeddedObj.url) ||
    string(embeddedObj.play_url) ||
    stringAt(embeddedObj, 'play_addr', 'url_list', 0) ||
    stringAt(imgNode, 'live_photo_url') ||
    stringAt(imgNode, 'livePhotoUrl');
  return direct ? protocolUrl(direct) : '';
}

function collectMainVideos(
  imgs: readonly unknown[],
  videosMap: Record<string, unknown>,
): string[] {
  const orderedKeys: string[] = [];
  for (const img of imgs) {
    const imgId = idAt(img, 'id');
    if (imgId) orderedKeys.push(imgId);
  }
  for (const key of Object.keys(videosMap)) {
    if (!orderedKeys.includes(key)) orderedKeys.push(key);
  }

  const urls: string[] = [];
  for (const key of orderedKeys) {
    const videoInfo = videosMap[key];
    if (!videoInfo) continue;
    const matchedImg = imgs.find((img) => idAt(img, 'id') === key);
    if (isLivePhotoVideo(videoInfo, matchedImg)) continue;
    const rawUrl = stringAt(videoInfo, 'url');
    if (rawUrl) urls.push(protocolUrl(rawUrl));
  }
  return uniqueStrings(urls);
}

function collectGalleryAndLivePhotos(
  imgs: readonly unknown[],
  videosMap: Record<string, unknown>,
): ImageItem[] {
  const items: ImageItem[] = [];
  for (const img of imgs) {
    const imgId = idAt(img, 'id');
    const cover = extractImageUrl(img);
    const embeddedLiveUrl = extractEmbeddedLiveVideo(img);

    if (embeddedLiveUrl) {
      if (cover) {
        items.push({ url: cover, livePhotoUrl: embeddedLiveUrl });
      }
      continue;
    }

    const videoInfo = imgId ? videosMap[imgId] : undefined;
    if (videoInfo === undefined) {
      if (cover) items.push(cover);
      continue;
    }

    const liveUrl = stringAt(videoInfo, 'url');
    if (isLivePhotoVideo(videoInfo, img) && liveUrl && cover) {
      items.push({ url: cover, livePhotoUrl: protocolUrl(liveUrl) });
    }
  }
  return items;
}

function extractImageUrl(imgNode: unknown): string {
  const mapped = record(imgNode);
  if (Object.keys(mapped).length === 0) return '';
  const urlsDict = record(mapped.urls);
  for (const variant of IMAGE_VARIANT_KEYS) {
    const candidate = stringAt(urlsDict, variant, 'urls', 0);
    if (candidate) return protocolUrl(candidate);
  }
  return protocolUrl(string(mapped.url));
}

registerParser('zuiyou', {
  factory: (context) => new ZuiyouParser(context),
  allowedHosts: ['share.xiaochuankeji.cn'],
});
