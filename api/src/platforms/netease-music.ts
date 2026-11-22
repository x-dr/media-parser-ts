import { load } from 'cheerio';
import { DEFAULT_DESKTOP_USER_AGENT, DEFAULT_MOBILE_USER_AGENT } from '../config/user-agents.js';
import { ProxyAttemptError } from '../core/errors.js';
import type { ImageItem, MediaResult, SubtitleItem } from '../core/media-result.js';
import type { ParseContext } from '../core/parse-context.js';
import type { PlatformParser } from '../core/parser.js';
import { registerParser } from '../core/parser-registry.js';
import {
  array,
  at,
  author,
  extractAssignedJson,
  idAt,
  number,
  parseJson,
  parseLrcSubtitles,
  record,
  result,
  string,
  stringAt,
  unescapeHtml,
  uniqueStrings,
} from './data.js';

const MV_PATH_RE = /\/(?:mv|mvdetail)(?:\/|$)/iu;

interface DetectedNeteaseMedia {
  mediaType: 'mv' | 'mlog' | 'event' | 'song' | null;
  mediaId: string;
}

interface NeteaseState {
  title: string;
  coverUrl: string;
  videoList: string[];
  audioUrl: string;
  imageList: ImageItem[];
  subtitles: SubtitleItem[] | null;
  nickname: string;
  authorId: string;
  avatar: string;
}

class NeteaseMusicParser implements PlatformParser {
  public readonly platform = 'netease_music' as const;
  public constructor(private readonly context: ParseContext) {}

  public async parse(): Promise<MediaResult> {
    const state: NeteaseState = {
      title: '',
      coverUrl: '',
      videoList: [],
      audioUrl: '',
      imageList: [],
      subtitles: null,
      nickname: '',
      authorId: '',
      avatar: '',
    };

    const { mediaType, mediaId } = detectNeteaseMedia(this.context.realUrl);
    if (mediaType === 'mv') {
      await this.#parseMv(state, mediaId);
    } else if (mediaType === 'mlog') {
      await this.#parseMlog(state);
    } else if (mediaType === 'event') {
      await this.#parseEvent(state, mediaId);
    } else if (mediaType === 'song') {
      await this.#parseSong(state, mediaId, {}, false);
    }

    return result({
      title: state.title,
      videoUrl: state.videoList[0] ?? null,
      videoList: state.videoList,
      audioUrl: state.audioUrl || null,
      coverUrl: state.coverUrl || null,
      imageList: state.imageList,
      author: author(state.nickname, state.authorId, state.avatar),
      subtitles: state.subtitles,
    });
  }

  async #requestJson(
    url: string,
    searchParams: Record<string, string | number>,
  ): Promise<Record<string, unknown>> {
    try {
      const payload = await this.context.session.getJson<unknown>(url, {
        searchParams,
        headers: mobileHeaders(),
        signal: this.context.signal,
      });
      return record(payload);
    } catch (error) {
      if (error instanceof ProxyAttemptError) throw error;
      return {};
    }
  }

  async #parseMv(state: NeteaseState, mediaId: string): Promise<void> {
    if (!mediaId) return;
    const payload = await this.#requestJson('https://music.163.com/api/mv/detail', { id: mediaId });
    const data = record(payload.data);
    state.title = string(data.name);
    state.coverUrl = string(data.cover);

    const firstArtist = record(at(data, 'artists', 0));
    if (Object.keys(firstArtist).length > 0) {
      state.nickname = string(firstArtist.name) || string(data.artistName);
      state.authorId = idAt(firstArtist, 'id') || idAt(data, 'artistId');
      state.avatar = string(firstArtist.img1v1Url);
    } else if (string(data.artistName)) {
      state.nickname = string(data.artistName);
      state.authorId = idAt(data, 'artistId');
    }

    const streams: { rank: number; url: string }[] = [];
    for (const [quality, rawUrl] of Object.entries(record(data.brs))) {
      const streamUrl = string(rawUrl);
      if (isValidUrl(streamUrl)) {
        const parsedRank = Number.parseInt(quality, 10);
        streams.push({ rank: Number.isFinite(parsedRank) ? parsedRank : 0, url: streamUrl });
      }
    }
    streams.sort((left, right) => right.rank - left.rank);
    state.videoList = uniqueStrings(streams.map((entry) => entry.url));
  }

  async #parseMlog(state: NeteaseState): Promise<void> {
    const payload = await this.#fetchInitialProps(this.context.realUrl);
    const info = at(payload, 'mlogInfo');
    const resource = at(info, 'resource');
    const content = at(resource, 'content');
    const profile = record(at(resource, 'profile'));
    const video = at(content, 'video');

    applyAuthor(state, profile);
    state.title =
      stringAt(content, 'title') ||
      stringAt(content, 'text') ||
      (state.nickname ? `${state.nickname}的音乐动态` : '网易云音乐动态');
    state.coverUrl =
      stringAt(video, 'coverUrl') ||
      stringAt(video, 'frameUrl') ||
      stringAt(video, 'frameImage', 'imageUrl');

    state.videoList = rankedUrls(array(at(video, 'urlInfos')));
    if (state.videoList.length === 0) {
      const fallback = stringAt(video, 'urlInfo', 'url');
      if (isValidUrl(fallback)) {
        state.videoList = [fallback];
      }
    }
    state.imageList = extractImages(array(at(content, 'image')));

    const contentSong = record(at(content, 'song'));
    const song = Object.keys(contentSong).length > 0 ? contentSong : record(at(resource, 'song'));
    const songId = idAt(song, 'id');
    if (songId && state.videoList.length === 0) {
      await this.#parseSong(state, songId, song, false);
    }
  }

  async #parseEvent(state: NeteaseState, mediaId: string): Promise<void> {
    if (!mediaId) return;
    const eventUrl = new URL('https://music.163.com/event');
    eventUrl.searchParams.set('id', mediaId);
    const uid =
      this.context.realUrl.searchParams.get('uid') ??
      this.context.realUrl.searchParams.get('userid');
    if (uid) {
      eventUrl.searchParams.set('uid', uid);
    }

    const payload = await this.#fetchEventData(eventUrl);
    if (Object.keys(payload).length === 0) return;

    applyAuthor(state, record(payload.user));

    let content: Record<string, unknown> = {};
    const rawJson = string(payload.json);
    if (rawJson) {
      try {
        content = record(parseJson(rawJson));
      } catch {
        content = {};
      }
    }

    const song = record(content.song);
    state.title = string(content.title) || string(content.msg) || string(song.name);
    state.imageList = extractEventImages(array(payload.pics));
    state.videoList = extractNestedVideoUrls(content.videoData, 0);

    const songId = idAt(song, 'id');
    if (songId) {
      await this.#parseSong(state, songId, song, true);
    }
  }

  async #parseSong(
    state: NeteaseState,
    songId: string,
    fallback: Record<string, unknown>,
    preserveTitle: boolean,
  ): Promise<void> {
    const trimmedId = songId.trim();
    if (!trimmedId || !/^\d+$/u.test(trimmedId)) return;
    const numericId = Number(trimmedId);
    if (!Number.isSafeInteger(numericId) || numericId <= 0) return;

    const detail = await this.#requestJson('https://music.163.com/api/song/detail/', {
      id: numericId,
      ids: JSON.stringify([numericId]),
    });
    const firstSong = record(at(detail, 'songs', 0));
    const song = Object.keys(firstSong).length > 0 ? firstSong : fallback;

    if (!preserveTitle || !state.title) {
      state.title = string(song.name) || state.title;
    }
    const album = record(song.album);
    state.coverUrl ||= string(album.picUrl) || string(album.blurPicUrl);

    const firstArtist = record(at(song, 'artists', 0));
    if (Object.keys(firstArtist).length > 0 && !state.nickname) {
      state.nickname = string(firstArtist.name);
      state.authorId = idAt(firstArtist, 'id');
      state.avatar = string(firstArtist.img1v1Url) || string(firstArtist.picUrl);
    }

    const player = await this.#requestJson('https://music.163.com/api/song/enhance/player/url', {
      id: numericId,
      ids: JSON.stringify([numericId]),
      br: 320000,
    });
    const playerUrl = stringAt(player, 'data', 0, 'url');
    if (isValidUrl(playerUrl)) {
      state.audioUrl = playerUrl;
    }

    await this.#parseLyrics(state, numericId);
  }

  async #parseLyrics(state: NeteaseState, songId: number): Promise<void> {
    const payload = await this.#requestJson('https://music.163.com/api/song/lyric', {
      id: songId,
      lv: 1,
      kv: 1,
      tv: -1,
    });
    const lyric = stringAt(payload, 'lrc', 'lyric');
    if (!lyric) return;
    const parsed = parseLrcSubtitles(lyric);
    state.subtitles = parsed.length > 0 ? parsed : null;
  }

  async #fetchInitialProps(url: URL): Promise<Record<string, unknown>> {
    try {
      const html = await this.context.session.getText(url, {
        headers: mobileHeaders(),
        followRedirect: true,
        signal: this.context.signal,
      });
      return record(extractAssignedJson(html, 'window.__INITIAL_PROPS__'));
    } catch (error) {
      if (error instanceof ProxyAttemptError) throw error;
      return {};
    }
  }

  async #fetchEventData(url: URL): Promise<Record<string, unknown>> {
    let html: string;
    try {
      html = await this.context.session.getText(url, {
        headers: {
          'user-agent': DEFAULT_DESKTOP_USER_AGENT,
          referer: 'https://music.163.com/',
        },
        signal: this.context.signal,
      });
    } catch (error) {
      if (error instanceof ProxyAttemptError) throw error;
      return {};
    }

    const $ = load(html);
    const raw = $('#event-data').first().text().trim();
    if (!raw) return {};
    try {
      return record(parseJson(raw));
    } catch {
      try {
        return record(parseJson(unescapeHtml(raw)));
      } catch {
        return {};
      }
    }
  }
}

export function detectNeteaseMedia(url: URL): DetectedNeteaseMedia {
  const direct = detectFromPathAndParams(url.pathname, url.searchParams);
  if (direct.mediaType !== null) return direct;
  if (url.hash.startsWith('#/')) {
    try {
      const hashUrl = new URL(url.hash.slice(1), 'https://music.163.com');
      const fromHash = detectFromPathAndParams(hashUrl.pathname, hashUrl.searchParams);
      if (fromHash.mediaType !== null) return fromHash;
    } catch {
      // Ignore malformed hash fragments.
    }
  }
  return direct;
}

function detectFromPathAndParams(pathname: string, params: URLSearchParams): DetectedNeteaseMedia {
  const pathLower = pathname.toLowerCase();
  const mediaId = params.get('id') ?? '';
  if (pathLower.includes('/landing/mlog')) {
    return { mediaType: 'mlog', mediaId };
  }
  if (pathLower.includes('/landing/mv') || MV_PATH_RE.test(pathLower)) {
    const trimmed = pathname.replace(/\/+$/u, '');
    const lastSegment = trimmed.split('/').pop() ?? '';
    const fallbackId =
      lastSegment && !['mv', 'mvdetail'].includes(lastSegment.toLowerCase()) ? lastSegment : '';
    return { mediaType: 'mv', mediaId: mediaId || fallbackId };
  }
  if (pathLower.includes('/event')) {
    return { mediaType: 'event', mediaId };
  }
  if (pathLower.includes('/song')) {
    if (params.has('id')) {
      return { mediaType: 'song', mediaId };
    }
    const trimmed = pathname.replace(/\/+$/u, '');
    const lastSegment = trimmed.split('/').pop() ?? '';
    const pathId = /^\d+$/u.test(lastSegment) ? lastSegment : '';
    return { mediaType: 'song', mediaId: pathId };
  }
  return { mediaType: null, mediaId };
}

function applyAuthor(state: NeteaseState, profile: Record<string, unknown>): void {
  if (Object.keys(profile).length === 0) return;
  state.nickname = string(profile.nickname) || string(profile.name);
  state.authorId = idAt(profile, 'userId') || idAt(profile, 'id');
  state.avatar = string(profile.avatarUrl) || string(profile.avatar);
}

function rankedUrls(entries: readonly unknown[]): string[] {
  const ranked: { quality: number; url: string }[] = [];
  for (const rawEntry of entries) {
    const entry = record(rawEntry);
    const url = string(entry.url);
    if (!isValidUrl(url)) continue;
    const quality = number(entry.resolution) || number(entry.r) || 0;
    ranked.push({ quality, url });
  }
  ranked.sort((left, right) => right.quality - left.quality);
  return uniqueStrings(ranked.map((item) => item.url));
}

function extractImages(entries: readonly unknown[]): string[] {
  const images: string[] = [];
  for (const rawEntry of entries) {
    if (typeof rawEntry === 'string' && isValidUrl(rawEntry)) {
      images.push(rawEntry);
      continue;
    }
    const entry = record(rawEntry);
    const url =
      string(entry.originUrl) ||
      string(entry.url) ||
      string(entry.imageUrl) ||
      string(entry.picUrl);
    if (isValidUrl(url)) {
      images.push(url);
    }
  }
  return uniqueStrings(images);
}

function extractEventImages(entries: readonly unknown[]): ImageItem[] {
  const images: ImageItem[] = [];
  for (const rawEntry of entries) {
    const entry = record(rawEntry);
    const url =
      string(entry.originUrl) ||
      string(entry.pcRectangleUrl) ||
      string(entry.rectangleUrl);
    if (!isValidUrl(url)) continue;
    const liveUrl = string(entry.videoOriginalUrl) || string(entry.videoUrl);
    images.push({
      url,
      livePhotoUrl: isValidUrl(liveUrl) ? liveUrl : null,
    });
  }
  return images;
}

function extractNestedVideoUrls(value: unknown, depth: number): string[] {
  if (depth > 16 || value === null || value === undefined) return [];
  if (Array.isArray(value)) {
    return uniqueStrings(value.flatMap((child) => extractNestedVideoUrls(child, depth + 1)));
  }
  if (typeof value === 'object') {
    const found: string[] = [];
    for (const [key, child] of Object.entries(record(value))) {
      const childStr = string(child);
      if (key.toLowerCase().includes('url') && isValidUrl(childStr) && isVideoMediaPath(childStr)) {
        found.push(childStr);
      } else {
        found.push(...extractNestedVideoUrls(child, depth + 1));
      }
    }
    return uniqueStrings(found);
  }
  return [];
}

function isVideoMediaPath(url: string): boolean {
  const pathPart = (url.split('?')[0] ?? '').toLowerCase();
  return pathPart.endsWith('.mp4') || pathPart.endsWith('.mov') || pathPart.endsWith('.m3u8');
}

function isValidUrl(value: string): boolean {
  return value.startsWith('http://') || value.startsWith('https://');
}

function mobileHeaders(): Record<string, string> {
  return {
    'user-agent': DEFAULT_MOBILE_USER_AGENT,
    referer: 'https://music.163.com/',
  };
}

registerParser('netease_music', {
  factory: (context) => new NeteaseMusicParser(context),
  allowedHosts: ['interface.music.163.com', 'interface3.music.163.com', '*.music.163.com'],
});
