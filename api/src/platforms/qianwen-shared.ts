import { load } from 'cheerio';
import type { PlatformId } from '../config/platforms.js';
import type { AuthorInfo } from '../core/media-result.js';
import type { ParseContext } from '../core/parse-context.js';
import type { PlatformParser } from '../core/parser.js';
import { DEFAULT_MOBILE_USER_AGENT } from '../config/user-agents.js';
import {
  array,
  at,
  author,
  extractAssignedJson,
  parseJson,
  protocolUrl,
  record,
  result,
  string,
  stringAt,
  uniqueStrings,
} from './data.js';

const CHAT_SHARE_API = 'https://chat2-api.qianwen.com/api/v1/share/info?pr=qwen&fr=mac';

const MEDIA_URL_KEYS = new Set([
  'url',
  'downloadUrl',
  'download_url',
  'playUrl',
  'play_url',
  'videoUrl',
  'video_url',
  'imageUrl',
  'image_url',
  'imgUrl',
  'img_url',
  'originUrl',
  'origin_url',
  'rawUrl',
  'raw_url',
  'fileUrl',
  'file_url',
  'ossUrl',
  'src',
]);

interface ExtractedPayload {
  title: string;
  desc: string;
  coverUrl: string;
  videoList: string[];
  imageList: string[];
  author: AuthorInfo | null;
  hasStructuredContent: boolean;
}

export class QianwenSharedParser implements PlatformParser {
  public constructor(
    public readonly platform: PlatformId,
    private readonly context: ParseContext,
  ) {}

  public async parse(): Promise<ReturnType<typeof result>> {
    let htmlExtracted: ExtractedPayload | null = null;

    try {
      const html = await this.context.session.getText(this.context.realUrl, {
        headers: {
          'user-agent': DEFAULT_MOBILE_USER_AGENT,
          accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        },
        signal: this.context.signal,
      });
      htmlExtracted = parseHtmlPayload(html);
      if (htmlExtracted.videoList.length > 0 || htmlExtracted.imageList.length > 0) {
        return toMediaResult(htmlExtracted);
      }
    } catch {
      // Proceed to share API fallback when HTML fetch fails or is unmocked.
    }

    const shareId = extractShareId(this.context.realUrl);
    if (shareId) {
      const bizId =
        this.context.realUrl.searchParams.get('biz_id') ??
        this.context.realUrl.searchParams.get('bizId') ??
        'ai_qwen';
      const apiData = await this.#fetchShareInfo(shareId, bizId);
      if (Object.keys(apiData).length > 0) {
        const apiExtracted = extractFromData(apiData);
        return toMediaResult(mergeExtracted(apiExtracted, htmlExtracted));
      }
    }

    return htmlExtracted ? toMediaResult(htmlExtracted) : result({});
  }

  async #fetchShareInfo(shareId: string, bizId: string): Promise<Record<string, unknown>> {
    const candidateEndpoints = buildShareEndpoints(this.context.realUrl);
    for (const endpoint of candidateEndpoints) {
      try {
        const response = await this.context.session.getJson<unknown>(endpoint, {
          method: 'POST',
          headers: {
            'user-agent': DEFAULT_MOBILE_USER_AGENT,
            'content-type': 'application/json',
            accept: 'application/json, text/plain, */*',
          },
          json: { share_id: shareId, biz_id: bizId },
          signal: this.context.signal,
        });
        if (at(response, 'code') === 0 || at(response, 'success') === true) {
          const data = record(at(response, 'data'));
          if (Object.keys(data).length > 0) return data;
        }
      } catch {
        // Try next share endpoint candidate.
      }
    }
    return {};
  }
}

function buildShareEndpoints(realUrl: URL): string[] {
  const endpoints: string[] = [];
  const host = realUrl.hostname.toLowerCase();
  if (
    host === 'qianwen.com' ||
    host.endsWith('.qianwen.com') ||
    host === 'tongyi.com' ||
    host.endsWith('.tongyi.com') ||
    host.endsWith('.aliyun.com')
  ) {
    endpoints.push(new URL('/api/v1/share/info?pr=qwen&fr=mac', realUrl).href);
  }
  if (!endpoints.includes(CHAT_SHARE_API)) {
    endpoints.push(CHAT_SHARE_API);
  }
  return endpoints;
}

function extractShareId(url: URL): string {
  const queryShare =
    url.searchParams.get('share_id') ??
    url.searchParams.get('shareId') ??
    '';
  if (queryShare) return queryShare;
  return (
    /\/share\/(?:chat\/)?([A-Za-z0-9_-]+)/u.exec(url.pathname)?.[1] ??
    /\/qianwen\/share\/([A-Za-z0-9_-]+)/u.exec(url.pathname)?.[1] ??
    ''
  );
}

function parseHtmlPayload(html: string): ExtractedPayload {
  let state: unknown = {};
  if (html.includes('window.__INITIAL_PROPS__')) {
    const props = extractAssignedJson(html, 'window.__INITIAL_PROPS__');
    let initial: unknown = at(props, 'initialData');
    if (typeof initial === 'string') {
      let serialized = initial;
      if (serialized.startsWith('%')) {
        try {
          serialized = decodeURIComponent(serialized);
        } catch {
          // Keep original string if malformed URI component.
        }
      }
      try {
        initial = parseJson(serialized);
      } catch {
        initial = {};
      }
    }
    state = Object.keys(record(at(initial, 'data'))).length > 0 ? at(initial, 'data') : initial;
  }

  if (Object.keys(record(state)).length === 0 && html.includes('window.__INITIAL_STATE__')) {
    const rawState = extractAssignedJson(html, 'window.__INITIAL_STATE__');
    state = Object.keys(record(at(rawState, 'data'))).length > 0 ? at(rawState, 'data') : rawState;
  }

  const $ = load(html);
  if (Object.keys(record(state)).length === 0) {
    const nextRaw = $('#__NEXT_DATA__').html();
    if (nextRaw) {
      try {
        const nextParsed = parseJson(nextRaw);
        state = at(nextParsed, 'props', 'pageProps', 'data') ??
          at(nextParsed, 'props', 'pageProps') ??
          {};
      } catch {
        state = {};
      }
    }
  }

  const extracted = extractFromData(record(state));
  const ogTitle = $('meta[property="og:title"]').attr('content')?.trim() ?? '';
  const ogDesc = $('meta[property="og:description"]').attr('content')?.trim() ?? '';
  const ogImage = $('meta[property="og:image"]').attr('content')?.trim() ?? '';

  return {
    title: extracted.title || ogTitle,
    desc: extracted.desc || ogDesc,
    coverUrl: extracted.coverUrl || extracted.imageList[0] || ogImage,
    videoList: extracted.videoList,
    imageList: extracted.imageList,
    author: extracted.author,
    hasStructuredContent: extracted.hasStructuredContent,
  };
}

function extractFromData(content: Record<string, unknown>): ExtractedPayload {
  const hasStructuredContent = Object.keys(content).length > 0;
  let title =
    string(content.title) ||
    string(content.shareSubtitle) ||
    string(content.shareTitle);
  let desc =
    string(content.desc) ||
    string(content.description) ||
    string(content.shareSubtitle);

  const session = record(content.session);
  if (!title) title = string(session.title);

  const records = array(session.record_list).length > 0
    ? array(session.record_list)
    : array(content.messages);
  if (records.length > 0) {
    const firstRecord = record(records[0]);
    if (!title) {
      title =
        string(firstRecord.query) ||
        stringAt(firstRecord, 'query', 'content') ||
        stringAt(firstRecord, 'query', 'text') ||
        stringAt(firstRecord, 'request_messages', 0, 'content') ||
        extractFirstTextPart(firstRecord.content);
    }
    if (!desc) {
      desc =
        extractAssistantText(firstRecord) ||
        string(firstRecord.answer) ||
        stringAt(firstRecord, 'answer', 'content');
    }
  }

  const creator = Object.keys(record(content.creator)).length > 0
    ? content.creator
    : at(content, 'content', 'creator');

  const directImages = [
    ...array(content.images),
    ...array(content.mediaList),
    ...array(content.medias),
  ];
  if (directImages.length === 0 && content.image) {
    directImages.push(content.image);
  }

  const imageUrls: string[] = [];
  const videoUrls: string[] = [];

  for (const item of directImages) {
    const candidate = typeof item === 'string'
      ? item
      : stringAt(item, 'downloadUrl') ||
        stringAt(item, 'originUrl') ||
        stringAt(item, 'url');
    const cleaned = normalizeCandidateUrl(candidate);
    if (!cleaned) continue;
    if (isMediaUrl(cleaned, 'video')) videoUrls.push(cleaned);
    else imageUrls.push(cleaned);
  }

  const playInfo = record(content.playInfo);
  const directVideo = normalizeCandidateUrl(
    string(playInfo.url) || string(playInfo.downloadUrl) || string(playInfo.playUrl),
  );
  if (directVideo) videoUrls.push(directVideo);

  const deep = deepMedia(content);
  const finalVideos = uniqueStrings(videoUrls.length > 0 ? videoUrls : deep.videos);
  const finalImages = uniqueStrings(imageUrls.length > 0 ? imageUrls : deep.images);
  const coverCandidate = normalizeCandidateUrl(
    string(content.coverUrl) || string(content.poster) || string(playInfo.coverUrl),
  ) || (finalImages[0] ?? '');

  return {
    title,
    desc,
    coverUrl: coverCandidate,
    videoList: finalVideos,
    imageList: finalImages,
    author: author(
      at(creator, 'nick') || at(creator, 'nickname'),
      at(creator, 'authorId') || at(creator, 'uid'),
      at(creator, 'avatar'),
    ),
    hasStructuredContent,
  };
}

function extractFirstTextPart(contentNode: unknown): string {
  if (typeof contentNode === 'string') return contentNode.trim();
  for (const part of array(contentNode)) {
    const text = stringAt(part, 'text') || stringAt(part, 'content');
    if (text.trim()) return text.trim();
  }
  return '';
}

function extractAssistantText(recordNode: Record<string, unknown>): string {
  for (const msg of array(recordNode.response_messages)) {
    const text = extractFirstTextPart(at(msg, 'content')) || stringAt(msg, 'text');
    const cleaned = stripMarkdownImages(text);
    if (cleaned) return cleaned;
  }
  return '';
}

function stripMarkdownImages(text: string): string {
  if (!text) return '';
  return text.replace(/!\[[^\]]{0,200}\]\(https?:\/\/[^\s)]{1,2000}\)/gu, '').trim();
}

function mergeExtracted(
  primary: ExtractedPayload,
  fallback: ExtractedPayload | null,
): ExtractedPayload {
  if (!fallback) return primary;
  return {
    title: primary.title || fallback.title,
    desc: primary.desc || fallback.desc,
    coverUrl: primary.coverUrl || fallback.coverUrl,
    videoList: primary.videoList.length > 0 ? primary.videoList : fallback.videoList,
    imageList: primary.imageList.length > 0 ? primary.imageList : fallback.imageList,
    author: primary.author ?? fallback.author,
    hasStructuredContent: primary.hasStructuredContent || fallback.hasStructuredContent,
  };
}

function toMediaResult(payload: ExtractedPayload): ReturnType<typeof result> {
  const hasAnyMedia = payload.videoList.length > 0 || payload.imageList.length > 0;
  const isTextOnly =
    !hasAnyMedia &&
    (payload.hasStructuredContent || Boolean(payload.title.trim() || payload.desc.trim()));

  return result({
    title: payload.title || payload.desc,
    desc: payload.desc || null,
    videoUrl: payload.videoList[0] ?? null,
    videoList: payload.videoList,
    coverUrl: payload.coverUrl || payload.imageList[0] || null,
    imageList: payload.imageList,
    author: payload.author,
    ...(isTextOnly ? { noMediaInContent: true } : {}),
  });
}

function deepMedia(value: unknown): { videos: string[]; images: string[] } {
  const videos: string[] = [];
  const images: string[] = [];
  const visitedStrings = new Set<string>();

  const inspectUrl = (raw: string, hintKind?: 'video' | 'image'): void => {
    const cleaned = normalizeCandidateUrl(raw);
    if (!cleaned) return;
    if (isMediaUrl(cleaned, 'video')) {
      videos.push(cleaned);
    } else if (isMediaUrl(cleaned, 'image')) {
      images.push(cleaned);
    } else if (hintKind === 'video') {
      videos.push(cleaned);
    } else if (hintKind === 'image') {
      images.push(cleaned);
    }
  };

  const walk = (current: unknown): void => {
    if (Array.isArray(current)) {
      for (const item of current) walk(item);
      return;
    }
    if (typeof current === 'string') {
      const trimmed = current.trim();
      if ((trimmed.startsWith('{') || trimmed.startsWith('[')) && !visitedStrings.has(trimmed)) {
        visitedStrings.add(trimmed);
        try {
          walk(parseJson(trimmed));
          return;
        } catch {
          // Fall through to markdown URL extraction.
        }
      }
      for (const mdUrl of extractMarkdownImageUrls(current)) {
        inspectUrl(mdUrl, 'image');
      }
      return;
    }
    if (!current || typeof current !== 'object') return;

    const mapped = record(current);
    const partType = (string(mapped.type) || string(mapped.contentType)).toLowerCase();
    const hintKind: 'video' | 'image' | undefined = partType.includes('video')
      ? 'video'
      : partType.includes('image') || partType.includes('img')
        ? 'image'
        : undefined;

    for (const [key, child] of Object.entries(mapped)) {
      if (MEDIA_URL_KEYS.has(key) && typeof child === 'string') {
        const keyHint: 'video' | 'image' | undefined = key.toLowerCase().includes('video')
          ? 'video'
          : key.toLowerCase().includes('img') || key.toLowerCase().includes('image')
            ? 'image'
            : hintKind;
        inspectUrl(child, keyHint);
      } else {
        walk(child);
      }
    }
  };

  walk(value);
  return { videos: uniqueStrings(videos), images: uniqueStrings(images) };
}

function extractMarkdownImageUrls(text: string): string[] {
  if (!text.includes('![')) return [];
  const urls: string[] = [];
  const regex = /!\[[^\]]{0,200}\]\((https?:\/\/[^\s)]{1,2000})\)/gu;
  let match = regex.exec(text);
  while (match) {
    if (match[1]) urls.push(match[1]);
    match = regex.exec(text);
  }
  return urls;
}

function normalizeCandidateUrl(raw: string): string {
  if (!raw) return '';
  const cleaned = protocolUrl(raw.trim().replaceAll('\\u0026', '&').replaceAll('\\u002F', '/'));
  return cleaned.startsWith('http://') || cleaned.startsWith('https://') ? cleaned : '';
}

function isMediaUrl(value: string, kind: 'video' | 'image'): boolean {
  if (!(value.startsWith('http://') || value.startsWith('https://'))) return false;
  try {
    const parsed = new URL(value);
    const path = decodeURIComponent(parsed.pathname).toLowerCase();
    const extensions = kind === 'video'
      ? ['.mp4', '.mov', '.m4v', '.webm']
      : ['.jpg', '.jpeg', '.png', '.webp', '.gif'];
    if (extensions.some((extension) => path.includes(extension))) return true;
    if (kind === 'video' && path.includes('/video/')) return true;
    const formatParam = (parsed.searchParams.get('format') ?? parsed.searchParams.get('x-oss-process') ?? '').toLowerCase();
    if (kind === 'image' && (formatParam.includes('image/') || formatParam.includes('jpg') || formatParam.includes('png') || formatParam.includes('webp'))) {
      return true;
    }
    return false;
  } catch {
    return false;
  }
}
