import { Buffer } from 'node:buffer';
import { createDecipheriv, createHash } from 'node:crypto';
import { load } from 'cheerio';
import { ProxyAttemptError, safeErrorDetails } from '../core/errors.js';
import type { MediaResult } from '../core/media-result.js';
import type { ParseContext } from '../core/parse-context.js';
import type { PlatformParser } from '../core/parser.js';
import { registerParser } from '../core/parser-registry.js';
import {
  array,
  at,
  author,
  parseJson,
  record,
  result,
  string,
  stringAt,
  unescapeHtml,
  uniqueStrings,
  type JsonRecord,
} from './data.js';

const VIDEO_API = 'https://www.doubao.com/creativity/share/get_video_share_info';
const PLAY_INFO_API = 'https://www.doubao.com/samantha/media/get_play_info';
const VIDEO_MODEL_API = 'https://www.doubao.com/alice/resource/get_video_model';
const FPLAY_KDF_SALT =
  'TdTC5rgxYgkOUrPHpnM7pByyRiuCmrWKGWs521cXdST0m69/COjWjSanLjfBqVovHwWlGJKu8pSXMrYqOKrdWA==';

interface PlayInfoResult {
  url: string;
  poster: string;
  mediaType: string;
}

class DoubaoParser implements PlatformParser {
  public readonly platform = 'doubao' as const;

  public constructor(private readonly context: ParseContext) {}

  public async parse(): Promise<MediaResult> {
    const normalizedPath = this.context.realUrl.pathname.replace(/\/+$/u, '');
    if (normalizedPath.startsWith('/thread/') || normalizedPath.startsWith('/chat/')) {
      return this.#parseThread();
    }
    if (normalizedPath === '/video-sharing') {
      return this.#parseVideoShare();
    }
    if (normalizedPath === '/music-sharing') {
      return this.#parseMusicShare();
    }
    return result({});
  }

  async #parseThread(): Promise<MediaResult> {
    const html = await this.context.session.getText(this.context.realUrl, {
      headers: this.#headers('text/html,application/xhtml+xml'),
      signal: this.context.signal,
      maxBodyBytes: 5 * 1024 * 1024,
    });
    const roots = loadScriptPayloads(html);
    const creations: unknown[] = [];
    const imageUrls: string[] = [];
    collectCreations(roots, creations);
    collectImages(roots, imageUrls);
    const videoUrls: string[] = [];
    const coverUrls: string[] = [];

    for (const creation of creations) {
      const imageUrl = imageUrlFrom(at(creation, 'image'));
      if (imageUrl) {
        imageUrls.push(imageUrl);
        coverUrls.push(imageUrl);
      }
      const video = at(creation, 'video');
      if (Object.keys(record(video)).length > 0) {
        const videoId = stringAt(video, 'vid') || stringAt(video, 'video_id');
        let cleanUrls: string[] = [];
        if (videoId) {
          const clean = await this.#fetchUnwatermarked(videoId);
          cleanUrls = clean.urls;
          videoUrls.push(...clean.urls);
          if (clean.poster) coverUrls.push(clean.poster);
          if (clean.urls.length === 0) {
            const playInfo = await this.#fetchPlayInfo(videoId);
            if (playInfo.url) videoUrls.push(playInfo.url);
            if (playInfo.poster) coverUrls.push(playInfo.poster);
          }
        }
        if (cleanUrls.length === 0) {
          videoUrls.push(...extractThreadVideoUrls(video));
        }
        const poster =
          stringAt(video, 'poster_url') ||
          stringAt(video, 'cover', 'url') ||
          stringAt(video, 'poster', 'url');
        if (poster) coverUrls.push(poster);
      }
    }

    coverUrls.push(...imageUrls);
    const videos = preferUnwatermarked(uniqueStrings(videoUrls));
    const images = uniqueStrings(imageUrls);
    const covers = uniqueStrings(coverUrls);
    const explicitTitle = findPreferredTitle(roots);
    const messagesText = extractMessagesText(roots);
    const noMediaInContent =
      videos.length === 0 && images.length === 0 && Boolean(explicitTitle || messagesText);

    return result({
      title: explicitTitle || '豆包对话分享',
      desc: messagesText || null,
      videoUrl: videos[0] ?? null,
      videoList: videos,
      coverUrl: covers[0] ?? null,
      imageList: images,
      author: findAuthor(roots),
      ...(noMediaInContent ? { noMediaInContent: true } : {}),
    });
  }

  async #parseVideoShare(): Promise<MediaResult> {
    const shareId = this.context.realUrl.searchParams.get('share_id');
    const videoId = this.context.realUrl.searchParams.get('video_id');
    if (!shareId || !videoId) return result({});

    const clean = await this.#fetchUnwatermarked(videoId);
    let originalUrl = clean.urls[0] ?? '';
    let poster = clean.poster;
    if (!originalUrl) {
      const playInfo = await this.#fetchPlayInfo(videoId);
      originalUrl = playInfo.url;
      poster ||= playInfo.poster;
    }

    const detailResponse = await this.context.session.getJson<unknown>(VIDEO_API, {
      method: 'POST',
      searchParams: commonParams(),
      headers: this.#headers('application/json'),
      json: { share_id: shareId, vid: videoId, creation_id: '' },
      signal: this.context.signal,
    });
    const detail = at(detailResponse, 'data');
    const playInfo = at(detail, 'play_info');
    const sharedUrl = sanitizeVideoUrl(
      stringAt(playInfo, 'main') || stringAt(playInfo, 'backup'),
    );
    const videoUrl = originalUrl || sharedUrl;
    const user = at(detail, 'user_info');

    return result({
      title: stringAt(detail, 'prompt') || '豆包 AI 视频',
      videoUrl: videoUrl || null,
      videoList: clean.urls.length > 0 ? clean.urls : videoUrl ? [videoUrl] : [],
      coverUrl: poster || stringAt(playInfo, 'poster_url') || null,
      author: author(
        at(user, 'nickname') || at(user, 'user_name'),
        at(user, 'user_id'),
        at(user, 'avatar') || at(user, 'avatar_url'),
      ),
    });
  }

  async #parseMusicShare(): Promise<MediaResult> {
    const vid =
      this.context.realUrl.searchParams.get('vid') ??
      this.context.realUrl.searchParams.get('video_id') ??
      '';
    const audioUrls: string[] = [];
    const videoUrls: string[] = [];
    let coverUrl = '';

    if (vid) {
      const clean = await this.#fetchUnwatermarked(vid);
      videoUrls.push(...clean.urls);
      if (clean.poster) coverUrl = clean.poster;

      const playInfo = await this.#fetchPlayInfo(vid);
      if (playInfo.url) {
        if (playInfo.mediaType === 'audio') {
          audioUrls.push(playInfo.url);
        } else {
          videoUrls.push(playInfo.url);
        }
      }
      if (!coverUrl && playInfo.poster) {
        coverUrl = playInfo.poster;
      }
    }

    const dedupVideos = uniqueStrings(videoUrls);
    const finalVideoUrl = dedupVideos[0] ?? null;
    const finalAudioUrl = audioUrls[0] ?? finalVideoUrl;

    return result({
      title: '豆包AI音乐分享',
      desc: null,
      videoUrl: finalVideoUrl,
      videoList: dedupVideos,
      audioUrl: finalAudioUrl,
      coverUrl: coverUrl || null,
    });
  }

  async #fetchUnwatermarked(videoId: string): Promise<{ urls: string[]; poster: string }> {
    try {
      const response = await this.context.session.getJson<unknown>(VIDEO_MODEL_API, {
        method: 'POST',
        headers: this.#headers('application/json'),
        json: { params: [{ uri: videoId }] },
        signal: this.context.signal,
      });
      const first = at(response, 'data', 'results', 0);
      const modelRaw = stringAt(first, 'video_model_result', 'video_model');
      const model = modelRaw ? parseJson(modelRaw) : {};
      const fallbackApi = stringAt(model, 'fallback_api');
      const poster =
        stringAt(first, 'video_url_result', 'poster_url') || stringAt(model, 'poster_url');
      return { urls: fallbackApi ? await this.#fetchFallback(fallbackApi) : [], poster };
    } catch (error) {
      if (error instanceof ProxyAttemptError) throw error;
      this.context.logger.warn(
        {
          platform_id: this.platform,
          error_category: 'video_model_fallback',
          ...safeErrorDetails(error),
        },
        'doubao video model request failed',
      );
      return { urls: [], poster: '' };
    }
  }

  async #fetchFallback(fallbackApi: string): Promise<string[]> {
    const source = new URL(fallbackApi);
    if (!source.searchParams.has('key_seed')) return [];
    for (const variant of [
      { force_fids: Buffer.from('original').toString('base64'), codec_type: '5' },
      { codec_type: '1' },
    ]) {
      const url = new URL(source.href);
      url.searchParams.delete('logo_type');
      url.searchParams.delete('force_fids');
      for (const [key, value] of Object.entries(variant)) url.searchParams.set(key, value);
      const response = await this.context.session.getJson<unknown>(url, {
        headers: this.#headers('application/json'),
        signal: this.context.signal,
      });
      const data = at(response, 'video_info', 'data');
      const keySeed = stringAt(data, 'key_seed');
      if (!keySeed) continue;
      const urls: string[] = [];
      for (const video of walkRecords(at(data, 'video_list'))) {
        for (const key of ['main_url', 'backup_url_1']) {
          const decrypted = decipherFplayUrl(string(video[key]), keySeed);
          if (decrypted) urls.push(decrypted);
        }
      }
      if (urls.length > 0) return uniqueStrings(urls);
    }
    return [];
  }

  async #fetchPlayInfo(videoId: string): Promise<PlayInfoResult> {
    try {
      const response = await this.context.session.getJson<unknown>(PLAY_INFO_API, {
        method: 'POST',
        searchParams: commonParams(),
        headers: this.#headers('application/json'),
        json: { key: videoId },
        signal: this.context.signal,
      });
      const data = record(at(response, 'data'));
      return {
        url: sanitizeVideoUrl(stringAt(data, 'original_media_info', 'main_url')),
        poster: string(data.poster_url),
        mediaType: string(data.media_type),
      };
    } catch (error) {
      if (error instanceof ProxyAttemptError) throw error;
      this.context.logger.warn(
        {
          platform_id: this.platform,
          error_category: 'play_info_fallback',
          ...safeErrorDetails(error),
        },
        'doubao play info request failed',
      );
      return { url: '', poster: '', mediaType: '' };
    }
  }

  #headers(accept: string): Record<string, string> {
    const cookie = this.context.credentials.cookie;
    return {
      accept,
      origin: 'https://www.doubao.com',
      referer: this.context.realUrl.href,
      ...(cookie ? { cookie } : {}),
    };
  }
}

export function decipherFplayUrl(rawUrl: string, keySeed: string): string {
  if (!rawUrl || !keySeed) return '';
  try {
    const encrypted = Buffer.from(normalizeBase64(rawUrl), 'base64');
    const seed = Buffer.from(normalizeBase64(keySeed), 'base64');
    const firstHash = createHash('sha512').update(seed).digest();
    const derived = createHash('sha512')
      .update(Buffer.concat([firstHash, Buffer.from(FPLAY_KDF_SALT, 'base64')]))
      .digest();
    const decipher = createDecipheriv(
      'aes-128-cbc',
      derived.subarray(0, 16),
      derived.subarray(16, 32),
    );
    return Buffer.concat([decipher.update(encrypted.subarray(4)), decipher.final()])
      .toString('utf8')
      .trim();
  } catch {
    return '';
  }
}

function normalizeBase64(value: string): string {
  const normalized = value.replaceAll('-', '+').replaceAll('_', '/');
  return normalized + '='.repeat((4 - (normalized.length % 4)) % 4);
}

function commonParams(): Record<string, string> {
  return {
    version_code: '20800',
    language: 'zh-CN',
    device_platform: 'web',
    aid: '497858',
    real_aid: '497858',
    pkg_type: 'release_version',
    samantha_web: '1',
    'use-olympus-account': '1',
  };
}

function loadScriptPayloads(html: string): unknown[] {
  const roots: unknown[] = [];
  const seenUnescaped = new Set<string>();
  const tryPushRaw = (raw: string): void => {
    const unescaped = unescapeHtml(raw).trim();
    if (!unescaped || seenUnescaped.has(unescaped)) return;
    try {
      roots.push(expandJsonStrings(parseJson(unescaped)));
      seenUnescaped.add(unescaped);
    } catch {
      // Ignore malformed script attributes.
    }
  };

  const $ = load(html);
  $('script[data-fn-args]').each((_index, element) => {
    const raw = $(element).attr('data-fn-args');
    if (raw) tryPushRaw(raw);
  });

  for (const raw of extractRawRouterScriptArgs(html)) {
    tryPushRaw(raw);
  }
  return roots;
}

function extractRawRouterScriptArgs(html: string): string[] {
  const results: string[] = [];
  const nameMarker = 'data-fn-name="r"';
  const argsAttr = 'data-fn-args="';
  const endMarker = '" nonce=';

  let cursor = 0;
  while (cursor < html.length) {
    const fnIdx = html.indexOf(nameMarker, cursor);
    if (fnIdx < 0) break;
    const tagEnd = html.indexOf('</script>', fnIdx);
    const searchLimit = tagEnd >= 0 ? tagEnd : html.length;
    const argsIdx = html.indexOf(argsAttr, fnIdx);
    if (argsIdx < 0 || argsIdx >= searchLimit) {
      cursor = fnIdx + nameMarker.length;
      continue;
    }
    const valueStart = argsIdx + argsAttr.length;
    const nonceIdx = html.indexOf(endMarker, valueStart);
    if (nonceIdx > valueStart && nonceIdx <= searchLimit) {
      results.push(html.slice(valueStart, nonceIdx));
      cursor = nonceIdx + endMarker.length;
    } else {
      cursor = valueStart;
    }
  }
  return results;
}

function expandJsonStrings(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(expandJsonStrings);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, child]) => [key, expandJsonStrings(child)]),
    );
  }
  if (typeof value === 'string') {
    const stripped = unescapeHtml(value).trim();
    if (stripped.startsWith('{') || stripped.startsWith('[')) {
      try {
        return expandJsonStrings(parseJson(stripped));
      } catch {
        return value;
      }
    }
  }
  return value;
}

function collectCreations(value: unknown, output: unknown[]): void {
  walk(value, (node) => {
    for (const path of [['creation_block', 'creations'], ['creations']] as const) {
      const creations =
        path.length === 1 ? array(node.creations) : array(at(node, ...path));
      output.push(
        ...creations.filter((item) => Object.keys(record(item)).length > 0),
      );
    }
  });
}

function collectImages(value: unknown, output: string[]): void {
  walk(value, (node) => {
    for (const image of array(node.ref_images)) output.push(imageUrlFrom(image));
    for (const resource of array(node.ref_resources)) {
      output.push(imageUrlFrom(at(resource, 'image')));
    }
    output.push(imageUrlFrom(node.image));
  });
}

function imageUrlFrom(value: unknown): string {
  return (
    stringAt(value, 'image_ori_raw', 'url') ||
    stringAt(value, 'image_raw', 'url') ||
    stringAt(value, 'image_ori', 'url') ||
    stringAt(value, 'image_origin', 'url') ||
    stringAt(value, 'raw_url') ||
    stringAt(value, 'origin_url') ||
    stringAt(value, 'url')
  );
}

function extractThreadVideoUrls(video: unknown): string[] {
  const clean: string[] = [];
  const watermarked: string[] = [];
  const add = (value: string): void => {
    const sanitized = sanitizeVideoUrl(value);
    if (!sanitized) return;
    (isWatermarked(sanitized) ? watermarked : clean).push(sanitized);
  };
  add(stringAt(video, 'download_url'));
  let model: unknown = at(video, 'video_model');
  if (typeof model === 'string') {
    try {
      model = parseJson(model);
    } catch {
      model = {};
    }
  }
  for (const item of walkRecords(model)) {
    for (const key of ['main_url', 'backup_url_1']) {
      const encoded = string(item[key]);
      if (!encoded) continue;
      try {
        add(Buffer.from(encoded, 'base64').toString('utf8'));
      } catch {
        // Ignore invalid base64 video candidates.
      }
    }
  }
  const urls = uniqueStrings(clean);
  return urls.length > 0 ? urls : uniqueStrings(watermarked);
}

function sanitizeVideoUrl(value: string): string {
  if (!value) return '';
  try {
    const url = new URL(value);
    for (const key of ['lr', 'logo_type', 'download']) url.searchParams.delete(key);
    return url.href;
  } catch {
    return value;
  }
}

function isWatermarked(value: string): boolean {
  const lower = value.toLowerCase();
  return ['video_gen_watermark', 'watermark_dyn', 'logo_type=video_gen_watermark'].some(
    (marker) => lower.includes(marker),
  );
}

function preferUnwatermarked(values: string[]): string[] {
  const clean = values.filter((value) => !isWatermarked(value));
  return clean.length > 0 ? clean : values;
}

function findPreferredTitle(value: unknown): string {
  const records = walkRecords(value);
  for (const key of ['title', 'prompt', 'description'] as const) {
    for (const node of records) {
      const text = string(node[key]).trim();
      if (text && !text.startsWith('{') && !text.startsWith('[')) {
        return text;
      }
    }
  }
  return '';
}

function extractMessagesText(value: unknown): string {
  const texts: string[] = [];
  for (const node of walkRecords(value)) {
    const content = node.content;
    if (typeof content === 'string') {
      const trimmed = content.trim();
      if (
        trimmed.length > 1 &&
        !(trimmed.startsWith('{') && trimmed.endsWith('}')) &&
        !(trimmed.startsWith('[') && trimmed.endsWith(']')) &&
        !texts.includes(trimmed)
      ) {
        texts.push(trimmed);
      }
    } else if (content && typeof content === 'object' && !Array.isArray(content)) {
      const contentObj = record(content);
      const textVal = (string(contentObj.text) || string(contentObj.message)).trim();
      if (textVal && !texts.includes(textVal)) {
        texts.push(textVal);
      }
    }
  }
  return texts.join('\n\n');
}

function findAuthor(value: unknown): ReturnType<typeof author> {
  let found: ReturnType<typeof author> = null;
  walk(value, (node) => {
    if (found) return;
    const nickname = string(node.nickname).trim() || string(node.user_name).trim();
    if (nickname) {
      found = author(
        nickname,
        node.user_id || node.uid || node.id,
        node.avatar || node.avatar_url,
      );
    }
  });
  return found;
}

function walk(value: unknown, visit: (node: JsonRecord) => void): void {
  if (Array.isArray(value)) {
    for (const child of value) walk(child, visit);
    return;
  }
  if (!value || typeof value !== 'object') return;
  const node = record(value);
  visit(node);
  for (const child of Object.values(node)) walk(child, visit);
}

function walkRecords(value: unknown): JsonRecord[] {
  const output: JsonRecord[] = [];
  walk(value, (node) => output.push(node));
  return output;
}

registerParser('doubao', {
  factory: (context) => new DoubaoParser(context),
  allowedHosts: [
    '*.doubao.com',
    '*.douyinvod.com',
    '*.byteimg.com',
    '*.bytedance.com',
    '*.bytecdn.cn',
    '*.bytedanceapi.com',
    '*.snssdk.com',
    '*.volces.com',
  ],
});
