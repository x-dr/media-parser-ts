import type { ParseContext } from '../core/parse-context.js';
import type { PlatformParser } from '../core/parser.js';
import { registerParser } from '../core/parser-registry.js';
import { safeErrorDetails } from '../core/errors.js';
import { DEFAULT_MOBILE_USER_AGENT } from '../config/user-agents.js';
import { getVideoId } from '../http/url-tools.js';
import {
  array, at, author, extractAssignedJson, parseJson, protocolUrl, record, result, string, stringAt, uniqueStrings,
} from './data.js';

type PageType = 'VIDEO' | 'ATLAS' | 'UNKNOWN';

class KuaishouParser implements PlatformParser {
  public readonly platform = 'kuaishou' as const;
  public constructor(private readonly context: ParseContext) {}

  public async parse(): Promise<ReturnType<typeof result>> {
    const videoId = getVideoId(this.context.realUrl);
    const candidates = [this.context.realUrl];
    if (videoId && !this.context.realUrl.pathname.startsWith('/fw/photo/')) {
      candidates.push(new URL(`https://v.m.chenzhongtech.com/fw/photo/${videoId}`));
    }
    let pageType: PageType = 'UNKNOWN';
    let state: unknown = {};
    for (const candidate of candidates) {
      for (const headers of [
        { 'user-agent': DEFAULT_MOBILE_USER_AGENT, referer: 'https://v.m.chenzhongtech.com/' },
        {
          referer: 'https://www.kuaishou.com/',
          ...(this.context.credentials.cookie ? { cookie: this.context.credentials.cookie } : {}),
        },
      ]) {
        try {
          const html = await this.context.session.getText(candidate, { headers, signal: this.context.signal });
          if (isBlocked(html)) continue;
          const parsed = parsePageState(html);
          if (parsed.pageType !== 'UNKNOWN' && Object.keys(record(parsed.state)).length > 0) {
            ({ pageType, state } = parsed);
            break;
          }
        } catch (error) {
          this.context.logger.warn(
            {
              platform_id: this.platform,
              error_category: 'candidate_failed',
              upstream_host: candidate.hostname,
              ...safeErrorDetails(error),
            },
            'kuaishou candidate failed',
          );
        }
      }
      if (pageType !== 'UNKNOWN') break;
    }
    if (pageType === 'UNKNOWN') return result({});
    return pageType === 'VIDEO'
      ? parseVideoState(state, videoId)
      : parseAtlasState(state);
  }
}

function parseVideoState(state: unknown, videoId: string): ReturnType<typeof result> {
  const client = at(state, 'defaultClient');
  const photoKey = `VisionVideoDetailPhoto:${videoId}`;
  let photo = at(client, photoKey);
  if (Object.keys(record(photo)).length === 0) {
    const fallbackKey = Object.keys(record(client)).find((key) => key.includes(`photoId":"${videoId}`));
    if (fallbackKey) photo = at(client, fallbackKey);
  }
  let authorNode: unknown = {};
  const authorReference = stringAt(photo, 'author', 'id');
  if (authorReference) authorNode = at(client, authorReference);
  const directVideo = stringAt(client, 'VisionVideoSetRepresentation:1', 'url') || stringAt(photo, 'photoUrl');
  const atlasResult = parseAtlasState(state);
  return result({
    ...atlasResult,
    title: stringAt(photo, 'caption') || atlasResult.title,
    videoUrl: directVideo.replaceAll('\\u002F', '/') || atlasResult.videoUrl,
    coverUrl: stringAt(photo, 'coverUrl') || atlasResult.coverUrl,
    author: author(
      at(authorNode, 'name'),
      at(authorNode, 'id'),
      at(authorNode, 'headerUrl'),
    ) ?? atlasResult.author,
  });
}

function parseAtlasState(state: unknown): ReturnType<typeof result> {
  const payload = findNested(state, ['atlas', 'photo']) ?? findNested(state, ['photo']) ?? {};
  const photo = at(payload, 'photo');
  const atlasCandidates = [at(photo, 'ext_params', 'atlas'), at(payload, 'atlas')]
    .filter((value) => Object.keys(record(value)).length > 0);
  const atlas = atlasCandidates.find((value) =>
    array(at(value, 'list')).some((path) => string(path).toLowerCase().endsWith('.webp')),
  ) ?? atlasCandidates[0] ?? {};
  const cdn = firstCdn(atlas);
  const imageList = uniqueStrings(array(at(atlas, 'list')).map((path) => buildResourceUrl(cdn, string(path))));
  const fallbackImages = [firstUrl(at(photo, 'coverUrls')), firstUrl(at(photo, 'webpCoverUrls'))]
    .filter(Boolean);
  const images = imageList.length > 0 ? imageList : uniqueStrings(fallbackImages);
  let videoUrl = firstUrl(at(photo, 'mainMvUrls')) || firstUrl(at(photo, 'photoUrls'));
  if (!videoUrl) {
    for (const adaptation of array(at(photo, 'manifest', 'adaptationSet'))) {
      for (const representation of array(at(adaptation, 'representation'))) {
        videoUrl = firstUrl(at(representation, 'backupUrl'));
        if (!videoUrl) {
          const line = stringAt(representation, 'm3u8Slice').split(/\r?\n/u)
            .map((value) => value.trim()).find((value) => value.startsWith('http'));
          videoUrl = line ?? '';
        }
        if (videoUrl) break;
      }
      if (videoUrl) break;
    }
  }
  const authorId = at(photo, 'kwaiId') || at(photo, 'userEid') || at(photo, 'userId') || at(photo, 'eid');
  const music = at(photo, 'music');
  let audioUrl = firstUrl(at(music, 'audioUrls')) || normalizeUrl(stringAt(music, 'url'));
  if (!audioUrl) {
    const rawAtlas = at(payload, 'atlas');
    audioUrl = buildResourceUrl(firstCdn({ cdnList: at(rawAtlas, 'musicCdnList') }), stringAt(rawAtlas, 'music'));
  }
  return result({
    title: stringAt(photo, 'caption'),
    videoUrl: videoUrl || null,
    audioUrl: audioUrl || null,
    coverUrl: firstUrl(at(photo, 'coverUrls')) || firstUrl(at(photo, 'webpCoverUrls')) || images[0] || null,
    imageList: images,
    author: author(
      at(photo, 'userName') || at(photo, 'user_name'),
      authorId,
      firstUrl(at(photo, 'headUrls')) || at(photo, 'headUrl') || at(photo, 'headurl'),
    ),
  });
}

function parsePageState(html: string): { pageType: PageType; state: unknown } {
  if (html.includes('window.__APOLLO_STATE__')) {
    return { pageType: 'VIDEO', state: extractAssignedJson(html, 'window.__APOLLO_STATE__') };
  }
  if (html.includes('window.INIT_STATE')) {
    return { pageType: 'ATLAS', state: extractAssignedJson(html, 'window.INIT_STATE') };
  }
  return { pageType: 'UNKNOWN', state: {} };
}

function isBlocked(html: string): boolean {
  try { return at(parseJson(html), 'result') === 2; } catch { return false; }
}

function findNested(value: unknown, requiredKeys: readonly string[]): unknown {
  const stack: unknown[] = [value];
  while (stack.length > 0) {
    const current = stack.pop();
    if (Array.isArray(current)) {
      for (const child of current as unknown[]) stack.push(child);
    } else if (current && typeof current === 'object') {
      const mapped = record(current);
      if (requiredKeys.every((key) => Object.hasOwn(mapped, key))) return mapped;
      stack.push(...Object.values(mapped));
    }
  }
  return null;
}

function normalizeUrl(value: string): string {
  return protocolUrl(value.replaceAll('\\u002F', '/'));
}

function firstUrl(value: unknown): string {
  if (typeof value === 'string') return normalizeUrl(value);
  for (const item of array(value)) {
    if (typeof item === 'string') return normalizeUrl(item);
    const mapped = stringAt(item, 'url');
    if (mapped) return normalizeUrl(mapped);
  }
  return '';
}

function firstCdn(value: unknown): string {
  const direct = at(value, 'cdn');
  if (typeof direct === 'string') return direct;
  const directFirst = string(array(direct)[0]);
  if (directFirst) return directFirst;
  return array(at(value, 'cdnList')).map((item) => stringAt(item, 'cdn')).find(Boolean) ?? '';
}

function buildResourceUrl(cdn: string, path: string): string {
  const normalizedPath = normalizeUrl(path);
  if (!normalizedPath || normalizedPath.startsWith('http')) return normalizedPath;
  if (!cdn) return normalizedPath;
  const normalizedCdn = normalizeUrl(cdn).replace(/\/$/u, '');
  const base = normalizedCdn.startsWith('http') ? normalizedCdn : `https://${normalizedCdn}`;
  return `${base}/${normalizedPath.replace(/^\//u, '')}`;
}

registerParser('kuaishou', {
  factory: (context) => new KuaishouParser(context),
  allowedHosts: ['*.m.chenzhongtech.com'],
});
