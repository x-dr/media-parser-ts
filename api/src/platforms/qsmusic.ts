import { DEFAULT_MOBILE_USER_AGENT } from '../config/user-agents.js';
import { ProxyAttemptError, safeErrorDetails } from '../core/errors.js';
import type { MediaResult, SubtitleItem } from '../core/media-result.js';
import type { ParseContext } from '../core/parse-context.js';
import type { PlatformParser } from '../core/parser.js';
import { registerParser } from '../core/parser-registry.js';
import {
  at,
  author,
  extractAssignedJson,
  id,
  number,
  numberAt,
  parseJson,
  record,
  result,
  string,
  stringAt,
  type JsonRecord,
} from './data.js';

interface MutableQSMusicState {
  title: string;
  videoUrl: string;
  audioUrl: string;
  coverUrl: string;
  nickname: string;
  authorId: string;
  avatar: string;
  subtitles: SubtitleItem[] | null;
  isPreview: boolean;
  fullDuration: number | undefined;
}

class QSMusicParser implements PlatformParser {
  public readonly platform = 'qsmusic' as const;

  public constructor(private readonly context: ParseContext) {}

  public async parse(): Promise<MediaResult> {
    const state: MutableQSMusicState = {
      title: '',
      videoUrl: '',
      audioUrl: '',
      coverUrl: '',
      nickname: '',
      authorId: '',
      avatar: '',
      subtitles: null,
      isPreview: false,
      fullDuration: undefined,
    };

    try {
      const html = await this.context.session.getText(this.context.realUrl, {
        headers: { 'user-agent': DEFAULT_MOBILE_USER_AGENT },
        followRedirect: true,
        signal: this.context.signal,
      });
      parseRouterData(html, state);
    } catch (error) {
      if (error instanceof ProxyAttemptError) throw error;
      this.context.logger.warn(
        {
          platform_id: this.platform,
          error_category: 'page_fetch_failed',
          ...safeErrorDetails(error),
        },
        'failed to fetch QSMusic HTML page',
      );
    }

    const trackId =
      extractTrackId(this.context.realUrl) || extractTrackId(this.context.originalUrl);
    if ((!state.title || !(state.videoUrl || state.audioUrl)) && trackId) {
      await this.#applyTrackPayload(state, trackId);
    }

    return result({
      title: state.title,
      videoUrl: state.videoUrl || null,
      videoList: state.videoUrl ? [state.videoUrl] : [],
      audioUrl: state.audioUrl || null,
      coverUrl: state.coverUrl || null,
      author: author(state.nickname, state.authorId, state.avatar),
      subtitles: state.subtitles,
      isPreview: state.isPreview,
      ...(state.fullDuration !== undefined ? { fullDuration: state.fullDuration } : {}),
    });
  }

  async #applyTrackPayload(state: MutableQSMusicState, trackId: string): Promise<void> {
    let payload: JsonRecord | null = null;
    for (const path of ['/luna/h5/track_v2', '/luna/h5/seo_track']) {
      try {
        const url = new URL(`https://beta-luna.douyin.com${path}`);
        url.searchParams.set('track_id', trackId);
        url.searchParams.set('device_platform', 'web');
        const candidate = await this.context.session.getJson<unknown>(url, {
          headers: {
            'user-agent': DEFAULT_MOBILE_USER_AGENT,
            'x-requested-with': 'XMLHttpRequest',
            referer: `https://music.douyin.com/qishui/share/track?track_id=${trackId}`,
          },
          signal: this.context.signal,
        });
        if (isNonEmptyRecord(candidate)) {
          payload = candidate;
          break;
        }
      } catch (error) {
        if (error instanceof ProxyAttemptError) throw error;
        this.context.logger.warn(
          {
            platform_id: this.platform,
            error_category: 'track_payload_failed',
            ...safeErrorDetails(error),
          },
          'failed to fetch QSMusic track payload',
        );
      }
    }
    if (!payload) return;

    const track =
      nonEmptyRecord(payload.track) ?? record(at(payload, 'seo_track', 'track'));
    const artist =
      nonEmptyRecord(at(track, 'artists', 0, 'user_info')) ??
      nonEmptyRecord(at(track, 'artists', 0)) ??
      record(track.artist);

    state.title ||= string(track.name) || string(track.title);
    state.nickname ||= string(artist.nickname) || string(artist.name);
    state.authorId ||= id(artist.id) || id(artist.user_id);
    state.avatar ||=
      imageUrl(artist.medium_avatar_url) ||
      imageUrl(artist.avatar_url) ||
      imageUrl(artist.url_avatar);
    state.coverUrl ||=
      imageUrl(at(track, 'album', 'cover_url')) ||
      imageUrl(at(track, 'album', 'url_cover')) ||
      imageUrl(track.cover_url);

    const model = loadVideoModel(at(payload, 'track_player', 'video_model'));
    if (model) {
      const video = record(at(model, 'video_list', 0));
      state.audioUrl ||= string(video.main_url) || string(video.backup_url);
      applyDuration(
        state,
        number(track.duration) / 1000,
        number(model.video_duration, -1),
      );
    }
  }
}

function parseRouterData(html: string, state: MutableQSMusicState): void {
  const router = extractAssignedJson(html, '_ROUTER_DATA');
  for (const page of Object.values(record(at(router, 'loaderData')))) {
    const video = record(at(page, 'videoOptions'));
    if (Object.keys(video).length > 0) {
      state.title ||= string(video.videoName) || string(video.title);
      state.nickname ||= string(video.artistName);
      state.avatar ||= firstUrl(video.artistThumbAvatarArr);
      state.coverUrl ||= string(video.coverURL) || string(video.firstFrameURL);
      const stream = string(video.url);
      if (stream) {
        if (stream.includes('video_mp4') || stream.includes('douyinvod.com')) {
          state.videoUrl ||= stream;
        } else {
          state.audioUrl ||= stream;
        }
      }
      state.subtitles ||= extractSubtitles(video);
    }

    const lyricsOpt = record(at(page, 'audioWithLyricsOption'));
    if (Object.keys(lyricsOpt).length > 0) {
      const lyricsStream = string(lyricsOpt.url);
      if (lyricsStream) {
        state.audioUrl ||= lyricsStream;
        state.title ||= string(lyricsOpt.trackName);
        state.nickname ||= string(lyricsOpt.artistName);
        state.authorId ||= id(lyricsOpt.artistIdStr);
        state.coverUrl ||= string(lyricsOpt.coverURL);
        const fullSec = number(lyricsOpt.duration, -1);
        const clipSec = number(lyricsOpt.offsetDuration, -1);
        applyDuration(state, fullSec, clipSec > 0 ? clipSec : fullSec);
      }
      state.subtitles ||= extractSubtitles(lyricsOpt);
    }

    let track =
      nonEmptyRecord(at(page, 'trackOptions')) ??
      nonEmptyRecord(at(page, 'track')) ??
      nonEmptyRecord(at(page, 'seo_track'));
    if (track && isNonEmptyRecord(track.track)) {
      track = track.track;
    }
    if (!track) continue;

    state.title ||= string(track.name) || string(track.title);
    const artist =
      nonEmptyRecord(track.artist) ??
      nonEmptyRecord(at(track, 'artists', 0, 'user_info')) ??
      record(at(track, 'artists', 0));
    state.nickname ||= string(artist.nickname) || string(artist.name);
    state.authorId ||= id(artist.id) || id(artist.user_id);
    state.avatar ||= imageUrl(artist.avatar_url) || imageUrl(artist.url_avatar);
    state.coverUrl ||=
      imageUrl(at(track, 'album', 'cover_url')) ||
      imageUrl(at(track, 'album', 'url_cover')) ||
      imageUrl(track.cover_url);
    state.audioUrl ||=
      string(track.audio_url) || string(track.play_url) || string(track.main_url);
    state.subtitles ||= extractSubtitles(track);
  }
}

function applyDuration(
  state: MutableQSMusicState,
  fullSeconds: number,
  clipSeconds: number,
): void {
  if (!Number.isFinite(fullSeconds) || fullSeconds <= 0) return;
  state.fullDuration = Math.round(fullSeconds * 1000) / 1000;
  if (!Number.isFinite(clipSeconds) || clipSeconds <= 0) return;
  state.isPreview = clipSeconds < fullSeconds - 1;
}

function loadVideoModel(raw: unknown): JsonRecord | null {
  if (!raw) return null;
  if (typeof raw === 'string') {
    try {
      return nonEmptyRecord(parseJson(raw));
    } catch {
      return null;
    }
  }
  return nonEmptyRecord(raw);
}

function imageUrl(value: unknown): string {
  const mapped = record(value);
  if (mapped.urls !== undefined) {
    const base = firstUrl(mapped.urls);
    const uri = id(mapped.uri);
    if (base && uri) {
      return `${base.replace(/\/+$/u, '')}/${uri.replace(/^\/+/u, '')}`;
    }
    return base;
  }
  return firstUrl(value);
}

function firstUrl(value: unknown): string {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) {
    return value.find((item): item is string => typeof item === 'string' && Boolean(item)) ?? '';
  }
  const mapped = record(value);
  return string(mapped.url) || string(mapped.origin_url) || string(mapped.large_url);
}

function extractTrackId(url: URL): string {
  for (const key of ['track_id', 'ugc_video_id']) {
    const value = url.searchParams.get(key);
    if (value) return value;
  }
  let decodedPath = url.pathname;
  try {
    decodedPath = decodeURIComponent(url.pathname);
  } catch {
    // Keep original pathname if malformed escape exists.
  }
  for (const prefix of ['/track/', '/video/']) {
    const position = decodedPath.indexOf(prefix);
    if (position >= 0) {
      const digits = decodedPath.slice(position + prefix.length).replace(/\D/gu, '');
      if (digits) return digits;
    }
  }
  return '';
}

function extractSubtitles(value: unknown): SubtitleItem[] | null {
  const data = record(value);
  const sentences =
    data.songMakerTeamSentences ??
    data.sentences ??
    data.lyrics ??
    data.subtitles;
  if (Array.isArray(sentences)) {
    const items = sentences.flatMap((line): SubtitleItem[] => {
      if (typeof line === 'string' && line.trim()) return [{ text: line.trim() }];
      const text =
        stringAt(line, 'text') ||
        stringAt(line, 'content') ||
        stringAt(line, 'sentence') ||
        stringAt(line, 'lyric');
      if (!text) return [];
      const hasStart = isNonEmptyRecord(line) && ('start_time' in line || 'startTime' in line);
      const hasEnd = isNonEmptyRecord(line) && ('end_time' in line || 'endTime' in line);
      const start = numberAt(line, 'start_time') || numberAt(line, 'startTime');
      const end = numberAt(line, 'end_time') || numberAt(line, 'endTime');
      return [
        {
          text: text.trim(),
          ...(hasStart ? { startMs: start } : {}),
          ...(hasEnd ? { endMs: end } : {}),
        },
      ];
    });
    if (items.length > 0) return items;
  }
  const lrc =
    string(data.lrc) ||
    string(data.lyric) ||
    string(data.lyrics_text) ||
    string(data.lyric_string);
  return lrc ? parseLrc(lrc) : null;
}

function parseLrc(text: string): SubtitleItem[] | null {
  const items: SubtitleItem[] = [];
  for (const rawLine of text.split(/\r?\n/u)) {
    const line = rawLine.trim();
    if (!line) continue;
    const timestampEnd = line.indexOf(']');
    const timestamp =
      timestampEnd > 1 && line.startsWith('[')
        ? line.slice(1, timestampEnd).split(':')
        : [];
    const minutes = timestamp[0] ?? '';
    const seconds = timestamp[1] ?? '';
    const lyric = timestampEnd >= 0 ? line.slice(timestampEnd + 1).trim() : '';
    if (isUnsignedNumber(minutes, false) && isUnsignedNumber(seconds, true) && lyric) {
      items.push({
        text: lyric,
        startMs: Math.round((Number(minutes) * 60 + Number(seconds)) * 1000),
      });
    } else if (!line.startsWith('[')) {
      items.push({ text: line });
    }
  }
  return items.length > 0 ? items : null;
}

function isUnsignedNumber(value: string, allowDecimal: boolean): boolean {
  if (!value) return false;
  let decimalCount = 0;
  for (const character of value) {
    if (character === '.' && allowDecimal) {
      decimalCount += 1;
      if (decimalCount > 1) return false;
    } else if (character < '0' || character > '9') {
      return false;
    }
  }
  return value !== '.';
}

function isNonEmptyRecord(value: unknown): value is JsonRecord {
  return (
    value !== null &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    Object.keys(value).length > 0
  );
}

function nonEmptyRecord(value: unknown): JsonRecord | null {
  return isNonEmptyRecord(value) ? value : null;
}

registerParser('qsmusic', {
  factory: (context) => new QSMusicParser(context),
  allowedHosts: ['beta-luna.douyin.com', '*.douyin.com'],
});
