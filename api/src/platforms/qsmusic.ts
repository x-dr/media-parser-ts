import type { SubtitleItem } from '../core/media-result.js';
import type { ParseContext } from '../core/parse-context.js';
import type { PlatformParser } from '../core/parser.js';
import { registerParser } from '../core/parser-registry.js';
import { at, author, extractAssignedJson, parseJson, record, result, string, stringAt } from './data.js';

class QSMusicParser implements PlatformParser {
  public readonly platform = 'qsmusic' as const;
  public constructor(private readonly context: ParseContext) {}

  public async parse(): Promise<ReturnType<typeof result>> {
    const state = {
      title: '', videoUrl: '', audioUrl: '', coverUrl: '', nickname: '', authorId: '', avatar: '',
      subtitles: null as SubtitleItem[] | null,
    };
    const html = await this.context.session.getText(this.context.realUrl, {
      followRedirect: true, signal: this.context.signal,
    });
    const router = extractAssignedJson(html, '_ROUTER_DATA');
    for (const page of Object.values(record(at(router, 'loaderData')))) {
      const video = at(page, 'videoOptions');
      if (Object.keys(record(video)).length > 0) {
        state.title ||= stringAt(video, 'videoName') || stringAt(video, 'title');
        state.nickname ||= stringAt(video, 'artistName');
        state.avatar ||= firstUrl(at(video, 'artistThumbAvatarArr'));
        state.coverUrl ||= stringAt(video, 'coverURL') || stringAt(video, 'firstFrameURL');
        const stream = stringAt(video, 'url');
        if (stream.includes('video_mp4') || stream.includes('douyinvod.com')) state.videoUrl ||= stream;
        else state.audioUrl ||= stream;
        state.subtitles ||= extractSubtitles(video);
      }
      let track = at(page, 'trackOptions') || at(page, 'track') || at(page, 'seo_track');
      if (Object.keys(record(at(track, 'track'))).length > 0) track = at(track, 'track');
      if (Object.keys(record(track)).length === 0) continue;
      state.title ||= stringAt(track, 'name') || stringAt(track, 'title');
      const artist = at(track, 'artist') || at(track, 'artists', 0, 'user_info');
      state.nickname ||= stringAt(artist, 'nickname') || stringAt(artist, 'name');
      state.authorId ||= string(at(artist, 'id')) || string(at(artist, 'user_id'));
      state.avatar ||= firstUrl(at(artist, 'avatar_url'));
      state.coverUrl ||= firstUrl(at(track, 'album', 'cover_url')) || firstUrl(at(track, 'cover_url'));
      state.audioUrl ||= stringAt(track, 'audio_url') || stringAt(track, 'play_url') || stringAt(track, 'main_url');
      state.subtitles ||= extractSubtitles(at(page, 'audioWithLyricsOption')) ?? extractSubtitles(track);
    }
    const trackId = extractTrackId(this.context.realUrl);
    if ((!state.title || !(state.videoUrl || state.audioUrl)) && trackId) {
      await this.#applySeo(state, trackId);
    }
    return result({
      title: state.title,
      videoUrl: state.videoUrl || null,
      videoList: state.videoUrl ? [state.videoUrl] : [],
      audioUrl: state.audioUrl || null,
      coverUrl: state.coverUrl || null,
      author: author(state.nickname, state.authorId, state.avatar),
      subtitles: state.subtitles,
    });
  }

  async #applySeo(state: {
    title: string; audioUrl: string; coverUrl: string; nickname: string; authorId: string;
    avatar: string;
  }, trackId: string): Promise<void> {
    const url = new URL('https://beta-luna.douyin.com/luna/h5/seo_track');
    url.searchParams.set('track_id', trackId);
    url.searchParams.set('device_platform', 'web');
    const payload = await this.context.session.getJson<unknown>(url, {
      headers: { 'x-requested-with': 'XMLHttpRequest' }, signal: this.context.signal,
    });
    const track = at(payload, 'seo_track', 'track');
    const artist = at(track, 'artists', 0, 'user_info');
    state.title ||= stringAt(track, 'name');
    state.nickname ||= stringAt(artist, 'nickname');
    state.authorId ||= string(at(artist, 'id'));
    state.avatar ||= firstUrl(at(artist, 'medium_avatar_url'));
    state.coverUrl ||= firstUrl(at(track, 'album', 'cover_url'));
    const model = stringAt(payload, 'track_player', 'video_model');
    if (!state.audioUrl && model) {
      try {
        const video = at(parseJson(model), 'video_list', 0);
        state.audioUrl = stringAt(video, 'main_url') || stringAt(video, 'backup_url');
      } catch {
        // The page result can still be useful when this optional JSON is malformed.
      }
    }
  }
}

function firstUrl(value: unknown): string {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.find((item): item is string => typeof item === 'string' && Boolean(item)) ?? '';
  const mapped = record(value);
  return string(mapped.url) || string(mapped.origin_url) || string(mapped.large_url);
}

function extractTrackId(url: URL): string {
  for (const key of ['track_id', 'ugc_video_id']) {
    const value = url.searchParams.get(key);
    if (value) return value;
  }
  for (const prefix of ['/track/', '/video/']) {
    const position = url.pathname.indexOf(prefix);
    if (position >= 0) return url.pathname.slice(position + prefix.length).replace(/\D/gu, '');
  }
  return '';
}

function extractSubtitles(value: unknown): SubtitleItem[] | null {
  const data = record(value);
  const sentences = at(data, 'songMakerTeamSentences') || at(data, 'sentences') ||
    at(data, 'lyrics') || at(data, 'subtitles');
  if (Array.isArray(sentences)) {
    const items = sentences.flatMap((line): SubtitleItem[] => {
      if (typeof line === 'string' && line.trim()) return [{ text: line.trim() }];
      const text = stringAt(line, 'text') || stringAt(line, 'content') ||
        stringAt(line, 'sentence') || stringAt(line, 'lyric');
      if (!text) return [];
      const start = at(line, 'start_time') || at(line, 'startTime');
      const end = at(line, 'end_time') || at(line, 'endTime');
      return [{
        text: text.trim(),
        ...(typeof start === 'number' ? { startMs: start } : {}),
        ...(typeof end === 'number' ? { endMs: end } : {}),
      }];
    });
    if (items.length > 0) return items;
  }
  const lrc = string(data.lrc) || string(data.lyric) || string(data.lyrics_text) || string(data.lyric_string);
  return lrc ? parseLrc(lrc) : null;
}

function parseLrc(text: string): SubtitleItem[] | null {
  const items: SubtitleItem[] = [];
  for (const rawLine of text.split(/\r?\n/u)) {
    const line = rawLine.trim();
    if (!line) continue;
    const timestampEnd = line.indexOf(']');
    const timestamp = timestampEnd > 1 && line.startsWith('[')
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

registerParser('qsmusic', {
  factory: (context) => new QSMusicParser(context),
  allowedHosts: ['beta-luna.douyin.com'],
});
