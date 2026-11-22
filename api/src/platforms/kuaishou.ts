import type { ParseContext } from '../core/parse-context.js';
import type { PlatformParser } from '../core/parser.js';
import { registerParser } from '../core/parser-registry.js';
import { safeErrorDetails } from '../core/errors.js';
import { DEFAULT_DESKTOP_USER_AGENT, DEFAULT_MOBILE_USER_AGENT } from '../config/user-agents.js';
import { getVideoId } from '../http/url-tools.js';
import {
  array,
  at,
  author,
  extractAssignedJson,
  numberAt,
  parseJson,
  protocolUrl,
  record,
  result,
  string,
  stringAt,
  uniqueStrings,
} from './data.js';

type PageType = 'VIDEO' | 'ATLAS' | 'GRAPHQL' | 'UNKNOWN';

const GRAPHQL_URL = 'https://www.kuaishou.com/graphql';
const GRAPHQL_QUERY = `query visionVideoDetail($photoId: String, $type: String, $page: String, $webPageArea: String) {
  visionVideoDetail(photoId: $photoId, type: $type, page: $page, webPageArea: $webPageArea) {
    status
    type
    author {
      id
      name
      headerUrl
    }
    photo {
      id
      caption
      coverUrl
      photoUrl
      mainMvUrls {
        url
      }
      manifest {
        adaptationSet {
          representation {
            url
            backupUrl
          }
        }
      }
      atlas {
        cdn
        cdnList
        list
      }
    }
  }
}`;

class KuaishouParser implements PlatformParser {
  public readonly platform = 'kuaishou' as const;
  public constructor(private readonly context: ParseContext) {}

  public async parse(): Promise<ReturnType<typeof result>> {
    const videoId = getVideoId(this.context.realUrl);
    const candidates = buildCandidateUrls(this.context.realUrl, videoId);
    const cookie = this.context.credentials.cookie;

    let pageType: PageType = 'UNKNOWN';
    let state: unknown = {};
    let blocked = false;

    const headerCandidates: Record<string, string>[] = [
      {
        'user-agent': DEFAULT_MOBILE_USER_AGENT,
        referer: 'https://v.m.chenzhongtech.com/',
        accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        ...(cookie ? { cookie } : {}),
      },
      {
        'user-agent': DEFAULT_DESKTOP_USER_AGENT,
        referer: 'https://www.kuaishou.com/',
        ...(cookie ? { cookie } : {}),
      },
    ];

    for (const candidate of candidates) {
      for (const headers of headerCandidates) {
        try {
          const html = await this.context.session.getText(candidate, {
            headers,
            signal: this.context.signal,
          });
          if (isBlockedHtml(html)) {
            blocked = true;
            continue;
          }
          const parsed = parsePageState(html);
          if (parsed.pageType !== 'UNKNOWN' && isValidState(parsed.pageType, parsed.state)) {
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

    if (pageType === 'UNKNOWN' && videoId) {
      const graphqlAttempt = await this.#tryGraphqlApi(videoId, cookie);
      if (graphqlAttempt.blocked) blocked = true;
      if (graphqlAttempt.detail) {
        pageType = 'GRAPHQL';
        state = graphqlAttempt.detail;
      }
    }

    if (pageType === 'UNKNOWN') {
      return result(blocked ? { cookieRequired: true } : {});
    }

    const output =
      pageType === 'GRAPHQL'
        ? parseGraphqlState(state)
        : pageType === 'VIDEO'
          ? parseVideoState(state, videoId)
          : parseAtlasState(state);

    if (!output.videoUrl && output.imageList.length === 0 && blocked) {
      return result({ ...output, cookieRequired: true });
    }
    return output;
  }

  async #tryGraphqlApi(
    videoId: string,
    cookie: string | undefined,
  ): Promise<{ detail: unknown; blocked: boolean }> {
    try {
      const payload = await this.context.session.getJson<unknown>(GRAPHQL_URL, {
        method: 'POST',
        headers: {
          'content-type': 'application/json; charset=UTF-8',
          'user-agent': DEFAULT_DESKTOP_USER_AGENT,
          referer: `https://www.kuaishou.com/short-video/${videoId}`,
          ...(cookie ? { cookie } : {}),
        },
        json: {
          operationName: 'visionVideoDetail',
          variables: { photoId: videoId, page: 'detail' },
          query: GRAPHQL_QUERY,
        },
        signal: this.context.signal,
      });
      if (isBlockedJson(payload)) {
        return { detail: null, blocked: true };
      }
      const detail = at(payload, 'data', 'visionVideoDetail');
      if (Object.keys(record(at(detail, 'photo'))).length > 0) {
        return { detail, blocked: false };
      }
    } catch (error) {
      this.context.logger.warn(
        {
          platform_id: this.platform,
          error_category: 'graphql_fallback_failed',
          ...safeErrorDetails(error),
        },
        'kuaishou graphql fallback failed',
      );
    }
    return { detail: null, blocked: false };
  }
}

function buildCandidateUrls(realUrl: URL, videoId: string): URL[] {
  const urls: URL[] = [realUrl];
  const seen = new Set<string>([realUrl.href]);
  const pushUnique = (raw: string): void => {
    if (seen.has(raw)) return;
    seen.add(raw);
    urls.push(new URL(raw));
  };

  if (videoId) {
    if (!realUrl.pathname.replace(/\/$/u, '').startsWith('/fw/photo/')) {
      pushUnique(`https://v.m.chenzhongtech.com/fw/photo/${videoId}`);
    }
    pushUnique(`https://www.kuaishou.com/short-video/${videoId}`);
  }
  return urls;
}

function parseGraphqlState(detail: unknown): ReturnType<typeof result> {
  const photo = record(at(detail, 'photo'));
  const authorNode = record(at(detail, 'author'));

  let videoUrl = firstUrl(photo.mainMvUrls) || normalizeUrl(string(photo.photoUrl));
  if (!videoUrl) {
    for (const adaptation of array(at(photo, 'manifest', 'adaptationSet'))) {
      for (const representation of array(at(adaptation, 'representation'))) {
        videoUrl = firstUrl(at(representation, 'backupUrl')) ||
          normalizeUrl(stringAt(representation, 'url'));
        if (videoUrl) break;
      }
      if (videoUrl) break;
    }
  }

  const atlas = record(photo.atlas);
  const cdn = firstCdn(atlas);
  const imageList = uniqueStrings(
    array(atlas.list).map((path) => buildResourceUrl(cdn, string(path))),
  );
  const caption = string(photo.caption);
  const coverUrl = normalizeUrl(string(photo.coverUrl)) || imageList[0] || '';

  return result({
    title: caption,
    desc: caption || null,
    videoUrl: videoUrl || null,
    coverUrl: coverUrl || null,
    imageList,
    author: author(
      authorNode.name,
      authorNode.id,
      normalizeUrl(string(authorNode.headerUrl)),
    ),
  });
}

function parseVideoState(state: unknown, videoId: string): ReturnType<typeof result> {
  const client = at(state, 'defaultClient');
  const photoKey = `VisionVideoDetailPhoto:${videoId}`;
  let photo = at(client, photoKey);
  if (Object.keys(record(photo)).length === 0) {
    const fallbackKey = Object.keys(record(client)).find(
      (key) => key.includes(`photoId":"${videoId}`) || key.startsWith('VisionVideoDetailPhoto:'),
    );
    if (fallbackKey) photo = at(client, fallbackKey);
  }
  let authorNode: unknown = {};
  const authorReference = stringAt(photo, 'author', 'id');
  if (authorReference) authorNode = at(client, authorReference);
  const directVideo = stringAt(client, 'VisionVideoSetRepresentation:1', 'url') ||
    stringAt(photo, 'photoUrl');
  const atlasResult = parseAtlasState(state);
  const caption = stringAt(photo, 'caption') || atlasResult.title;
  return result({
    ...atlasResult,
    title: caption,
    desc: caption || atlasResult.desc || null,
    videoUrl: normalizeUrl(directVideo) || atlasResult.videoUrl,
    coverUrl: normalizeUrl(stringAt(photo, 'coverUrl')) || atlasResult.coverUrl,
    author: author(
      at(authorNode, 'name'),
      at(authorNode, 'id'),
      normalizeUrl(stringAt(authorNode, 'headerUrl')),
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
  const imageList = uniqueStrings(
    array(at(atlas, 'list')).map((path) => buildResourceUrl(cdn, string(path))),
  );
  const fallbackImages = [
    firstUrl(at(photo, 'coverUrls')),
    firstUrl(at(photo, 'webpCoverUrls')),
  ].filter(Boolean);
  const images = imageList.length > 0 ? imageList : uniqueStrings(fallbackImages);

  let videoUrl = firstUrl(at(photo, 'mainMvUrls')) || firstUrl(at(photo, 'photoUrls'));
  if (!videoUrl) {
    for (const adaptation of array(at(photo, 'manifest', 'adaptationSet'))) {
      for (const representation of array(at(adaptation, 'representation'))) {
        videoUrl = firstUrl(at(representation, 'backupUrl'));
        if (!videoUrl) {
          const line = stringAt(representation, 'm3u8Slice')
            .split(/\r?\n/u)
            .map((value) => value.trim())
            .find((value) => value.startsWith('http'));
          videoUrl = line ?? '';
        }
        if (videoUrl) break;
      }
      if (videoUrl) break;
    }
  }

  const authorId =
    at(photo, 'kwaiId') ||
    at(photo, 'userEid') ||
    at(photo, 'userId') ||
    at(photo, 'eid');
  const music = at(photo, 'music');
  let audioUrl = firstUrl(at(music, 'audioUrls')) || normalizeUrl(stringAt(music, 'url'));
  if (!audioUrl) {
    const rawAtlas = at(payload, 'atlas');
    audioUrl = buildResourceUrl(
      firstCdn({ cdnList: at(rawAtlas, 'musicCdnList') }),
      stringAt(rawAtlas, 'music'),
    );
  }
  const caption = stringAt(photo, 'caption');

  let parsedAuthor = author(
    at(photo, 'userName') || at(photo, 'user_name'),
    authorId,
    firstUrl(at(photo, 'headUrls')) ||
      normalizeUrl(stringAt(photo, 'headUrl') || stringAt(photo, 'headurl')),
  );
  if (!parsedAuthor) {
    const profileEntry = Object.values(record(state)).find(
      (val) => Object.keys(record(at(val, 'userProfile', 'profile'))).length > 0,
    );
    if (profileEntry) {
      const profile = at(profileEntry, 'userProfile', 'profile');
      parsedAuthor = author(
        at(profile, 'user_name'),
        at(profile, 'user_id'),
        normalizeUrl(stringAt(profile, 'headurl')),
      );
    }
  }

  return result({
    title: caption,
    desc: caption || null,
    videoUrl: videoUrl || null,
    audioUrl: audioUrl || null,
    coverUrl:
      firstUrl(at(photo, 'coverUrls')) ||
      firstUrl(at(photo, 'webpCoverUrls')) ||
      images[0] ||
      null,
    imageList: images,
    author: parsedAuthor,
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

function isValidState(pageType: PageType, state: unknown): boolean {
  if (Object.keys(record(state)).length === 0) return false;
  if (pageType === 'ATLAS') {
    const payload = findNested(state, ['photo']);
    if (!payload) return false;
    const photo = record(at(payload, 'photo'));
    return Boolean(
      photo.caption ||
      photo.coverUrls ||
      photo.webpCoverUrls ||
      photo.mainMvUrls ||
      photo.manifest ||
      record(payload).atlas,
    );
  }
  if (pageType === 'VIDEO') {
    const defaultClient = record(at(state, 'defaultClient'));
    if (Object.keys(defaultClient).length === 0) return false;
    if (defaultClient['VisionVideoSetRepresentation:1']) return true;
    return Object.keys(defaultClient).some(
      (key) => key.includes('visionVideoDetail') || key.includes('VisionVideoDetailPhoto:'),
    );
  }
  return true;
}

function isBlockedHtml(html: string): boolean {
  if (!html) return false;
  if (
    !html.includes('window.__APOLLO_STATE__') &&
    !html.includes('window.INIT_STATE') &&
    (html.includes('ANTICRAWL_DEFAULT') || html.includes('captcha') || html.includes('滑块验证'))
  ) {
    return true;
  }
  try {
    return isBlockedJson(parseJson(html));
  } catch {
    return false;
  }
}

function isBlockedJson(payload: unknown): boolean {
  const rootCode = numberAt(payload, 'result', -1);
  const dataCode = numberAt(payload, 'data', 'result', -1);
  const detailStatus = numberAt(payload, 'data', 'visionVideoDetail', 'status', -1);
  return (
    rootCode === 2 ||
    rootCode === 400002 ||
    dataCode === 2 ||
    dataCode === 400002 ||
    detailStatus === 2 ||
    stringAt(payload, 'bizName') === 'ANTICRAWL_DEFAULT'
  );
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
  allowedHosts: ['*.m.chenzhongtech.com', 'www.kuaishou.com'],
});
