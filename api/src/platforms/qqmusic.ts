import { Buffer } from 'node:buffer';
import { DEFAULT_DESKTOP_USER_AGENT, DEFAULT_MOBILE_USER_AGENT } from '../config/user-agents.js';
import { ProxyAttemptError } from '../core/errors.js';
import type { MediaResult, SubtitleItem } from '../core/media-result.js';
import type { ParseContext } from '../core/parse-context.js';
import type { PlatformParser } from '../core/parser.js';
import { registerParser } from '../core/parser-registry.js';
import {
  array,
  at,
  author,
  extractBalancedBraces,
  idAt,
  numberAt,
  parseJson,
  parseLrcSubtitles,
  record,
  result,
  string,
  stringAt,
  uniqueStrings,
} from './data.js';

const API_URL = 'https://u.y.qq.com/cgi-bin/musicu.fcg';
const MV_PATH_RE = /\/(?:mv|mvDetail)\/([A-Za-z0-9]+)(?:\/|$)/u;
const SONG_PATH_RE = /\/(?:songDetail|song)\/([A-Za-z0-9]+)(?:\/|$)/u;

interface DetectedMedia {
  mediaType: 'mv' | 'song' | null;
  vid: string;
  songmid: string;
  songid: string;
}

interface ParseState {
  mediaType: 'mv' | 'song' | null;
  vid: string;
  songmid: string;
  songid: string;
  title: string;
  coverUrl: string;
  nickname: string;
  authorId: string;
  avatar: string;
  videoList: string[];
  audioUrl: string;
  subtitles: SubtitleItem[] | null;
}

class QQMusicParser implements PlatformParser {
  public readonly platform = 'qqmusic' as const;
  public constructor(private readonly context: ParseContext) {}

  public async parse(): Promise<MediaResult> {
    const detected = detectMedia(this.context.realUrl);
    const state: ParseState = {
      ...detected,
      title: '',
      coverUrl: '',
      nickname: '',
      authorId: '',
      avatar: '',
      videoList: [],
      audioUrl: '',
      subtitles: null,
    };

    await this.#parsePage(state);

    if (state.mediaType === 'song' || state.songmid || state.songid) {
      await this.#fetchSongData(state);
    } else if (state.mediaType === 'mv' || state.vid) {
      await this.#fetchMvData(state);
    }

    return result({
      title: state.title,
      videoUrl: state.videoList[0] ?? null,
      videoList: state.videoList,
      audioUrl: state.audioUrl || null,
      coverUrl: state.coverUrl || null,
      author: author(state.nickname, state.authorId, state.avatar),
      subtitles: state.subtitles,
    });
  }

  async #parsePage(state: ParseState): Promise<void> {
    let html: string;
    try {
      html = await this.context.session.getText(this.context.realUrl, {
        headers: mobileHeaders(),
        followRedirect: true,
        signal: this.context.signal,
      });
    } catch (error) {
      if (error instanceof ProxyAttemptError) throw error;
      return;
    }

    const payload = extractSsrFirstPageData(html);
    const data = Object.keys(record(at(payload, 'data'))).length > 0 ? at(payload, 'data') : payload;

    const video = record(at(data, 'video'));
    if (Object.keys(video).length > 0) {
      state.mediaType ??= 'mv';
      state.vid ||= string(video.vid);
      applyMvMetadata(state, video);
      const firstCreator = record(at(data, 'creator', 0));
      if (Object.keys(firstCreator).length > 0) {
        state.nickname = string(firstCreator.nick) || string(firstCreator.name);
        state.authorId = idAt(firstCreator, 'mid') || idAt(firstCreator, 'uin');
        state.avatar = string(firstCreator.avatar) || string(firstCreator.headurl);
      }
    }

    const song = record(at(data, 'song'));
    if (Object.keys(song).length > 0) {
      state.mediaType ??= 'song';
      state.songmid ||= string(song.mid);
      state.songid ||= idAt(song, 'id');
      applySongMetadata(state, song);
    }
  }

  async #fetchSongData(state: ParseState): Promise<void> {
    const parsedSongId = state.songid ? Number.parseInt(state.songid, 10) : 0;
    const numericId = Number.isFinite(parsedSongId) && parsedSongId > 0 ? parsedSongId : 0;

    const payload = {
      comm: {
        cv: 4747474,
        ct: 24,
        format: 'json',
        inCharset: 'utf-8',
        outCharset: 'utf-8',
        notice: 0,
        platform: 'yqq.json',
        needNewCode: 1,
        uin: 0,
      },
      songinfo: {
        module: 'music.pf_song_detail_svr',
        method: 'get_song_detail_yqq',
        param: {
          song_mid: state.songmid,
          song_id: numericId,
        },
      },
      playUrl: {
        module: 'vkey.GetVkeyServer',
        method: 'CgiGetVkey',
        param: {
          guid: '2333333333',
          songmid: state.songmid ? [state.songmid] : [],
          songtype: [0],
          uin: '0',
          loginflag: 1,
          platform: '20',
        },
      },
      lyric: {
        module: 'music.musichallSong.PlayLyricInfo',
        method: 'GetPlayLyricInfo',
        param: {
          songMID: state.songmid,
          songID: numericId,
        },
      },
    };

    let apiResult: unknown;
    try {
      apiResult = await this.context.session.getJson<unknown>(API_URL, {
        method: 'POST',
        json: payload,
        headers: desktopJsonHeaders(),
        signal: this.context.signal,
      });
    } catch (error) {
      if (error instanceof ProxyAttemptError) throw error;
      return;
    }

    const trackInfo = record(at(apiResult, 'songinfo', 'data', 'track_info'));
    if (Object.keys(trackInfo).length > 0) {
      applySongMetadata(state, trackInfo);
    }

    const playData = at(apiResult, 'playUrl', 'data');
    const sips = array(at(playData, 'sip')).map((item) => string(item)).filter(Boolean);
    const purl = stringAt(playData, 'midurlinfo', 0, 'purl');
    if (purl && sips.length > 0) {
      const sip = sips.find((item) => item.startsWith('http')) ?? sips[0] ?? '';
      if (sip) state.audioUrl = `${sip}${purl}`;
    }

    const lyricB64 = stringAt(apiResult, 'lyric', 'data', 'lyric');
    if (lyricB64) {
      try {
        const decoded = Buffer.from(lyricB64, 'base64').toString('utf8');
        const parsed = parseLrcSubtitles(decoded);
        if (parsed.length > 0) state.subtitles = parsed;
      } catch {
        // Ignore malformed base64 lyric payloads.
      }
    }
  }

  async #fetchMvData(state: ParseState): Promise<void> {
    if (!state.vid) return;
    const payload = {
      comm: { ct: 24, cv: 0 },
      mvInfo: {
        module: 'video.VideoDataServer',
        method: 'get_video_info_batch',
        param: {
          vidlist: [state.vid],
          required: [
            'vid',
            'type',
            'sid',
            'cover_pic',
            'duration',
            'singers',
            'video_pay',
            'hint',
            'code',
            'msg',
            'name',
            'desc',
            'playcnt',
            'pubdate',
            'isfav',
            'gmid',
          ],
        },
      },
      mvUrl: {
        module: 'gosrf.Stream.MvUrlProxy',
        method: 'GetMvUrls',
        param: { vids: [state.vid], request_typet: 10001 },
      },
    };

    let apiResult: unknown;
    try {
      apiResult = await this.context.session.getJson<unknown>(API_URL, {
        method: 'POST',
        json: payload,
        headers: { ...mobileHeaders(), 'content-type': 'application/json' },
        signal: this.context.signal,
      });
    } catch (error) {
      if (error instanceof ProxyAttemptError) throw error;
      return;
    }

    const metadata = record(at(apiResult, 'mvInfo', 'data', state.vid));
    if (Object.keys(metadata).length > 0) {
      applyMvMetadata(state, metadata);
    }
    const streamData = at(apiResult, 'mvUrl', 'data', state.vid);
    state.videoList = extractStreams(streamData);
  }
}

export function detectMedia(url: URL): DetectedMedia {
  const vid = url.searchParams.get('vid') ?? '';
  if (vid) {
    return { mediaType: 'mv', vid, songmid: '', songid: '' };
  }
  const mvMatch = MV_PATH_RE.exec(url.pathname)?.[1];
  if (mvMatch) {
    return { mediaType: 'mv', vid: mvMatch, songmid: '', songid: '' };
  }

  const songmid = url.searchParams.get('songmid') ?? url.searchParams.get('songMid') ?? '';
  const songid =
    url.searchParams.get('songid') ??
    url.searchParams.get('songId') ??
    url.searchParams.get('id') ??
    '';
  if (songmid || songid) {
    return { mediaType: 'song', vid: '', songmid, songid };
  }

  const songMatch = SONG_PATH_RE.exec(url.pathname)?.[1];
  if (songMatch) {
    return { mediaType: 'song', vid: '', songmid: songMatch, songid: '' };
  }

  if (url.pathname.includes('playsong')) {
    return { mediaType: 'song', vid: '', songmid, songid };
  }

  return { mediaType: null, vid: '', songmid: '', songid: '' };
}

function extractSsrFirstPageData(html: string): unknown {
  const marker = 'window.__ssrFirstPageData__';
  const markerIdx = html.indexOf(marker);
  if (markerIdx < 0) return {};
  const eqIdx = html.indexOf('=', markerIdx + marker.length);
  if (eqIdx < 0) return {};

  let pos = eqIdx + 1;
  while (pos < html.length && (html[pos] === ' ' || html[pos] === '\t' || html[pos] === '\r' || html[pos] === '\n')) {
    pos += 1;
  }

  if (html[pos] === '"') {
    let escaped = false;
    for (let idx = pos + 1; idx < html.length; idx += 1) {
      const ch = html[idx];
      if (escaped) {
        escaped = false;
      } else if (ch === '\\') {
        escaped = true;
      } else if (ch === '"') {
        try {
          const decoded = parseJson(html.slice(pos, idx + 1));
          return typeof decoded === 'string' ? parseJson(decoded) : decoded;
        } catch {
          return {};
        }
      }
    }
    return {};
  }

  if (html[pos] === '{') {
    const slice = extractBalancedBraces(html, pos);
    if (!slice) return {};
    try {
      return parseJson(slice);
    } catch {
      return {};
    }
  }

  return {};
}

function stripMidSuffix(pmid: string): string {
  return pmid.endsWith('_1') ? pmid.slice(0, -2) : pmid;
}

function applySongMetadata(state: ParseState, track: Record<string, unknown>): void {
  state.title ||= string(track.name) || string(track.title);
  const album = record(track.album);
  const albumMid = string(album.mid) || stripMidSuffix(string(album.pmid));
  if (albumMid && !state.coverUrl) {
    state.coverUrl = `https://y.qq.com/music/photo_new/T002R800x800M000${albumMid}.jpg`;
  }

  const singers = array(track.singer).length > 0 ? array(track.singer) : array(track.singers);
  const firstSinger = record(singers[0]);
  if (Object.keys(firstSinger).length > 0 && !state.nickname) {
    const singerMid = string(firstSinger.mid) || stripMidSuffix(string(firstSinger.pmid));
    state.nickname = string(firstSinger.name) || string(firstSinger.title);
    state.authorId = idAt(firstSinger, 'mid') || idAt(firstSinger, 'id');
    state.avatar = singerMid ? `https://y.qq.com/music/photo_new/T001R300x300M000${singerMid}.jpg` : '';
  }
}

function applyMvMetadata(state: ParseState, video: Record<string, unknown>): void {
  state.title ||= string(video.name) || string(video.raw_name);
  state.coverUrl ||= string(video.cover_pic) || string(video.first_frame_pic);

  const singers = array(video.singers).length > 0 ? array(video.singers) : array(video.related_singers);
  const firstSinger = record(singers[0]);
  if (Object.keys(firstSinger).length > 0 && !state.nickname) {
    state.nickname = string(firstSinger.name) || string(firstSinger.title);
    state.authorId = idAt(firstSinger, 'mid') || idAt(firstSinger, 'id');
    state.avatar = string(firstSinger.picurl) || string(firstSinger.avatar);
  }

  const uploaderNick = string(video.uploader_nick);
  if (!state.nickname && uploaderNick) {
    state.nickname = uploaderNick;
    state.authorId = idAt(video, 'uploader_encuin') || idAt(video, 'uploader_uin');
    state.avatar = string(video.uploader_headurl);
  }
}

function extractStreams(streamData: unknown): string[] {
  const streams: { quality: number; url: string }[] = [];
  for (const kind of ['mp4', 'hls'] as const) {
    for (const rawItem of array(at(streamData, kind))) {
      const item = record(rawItem);
      if (Object.keys(item).length === 0) continue;
      const code = item.code;
      if (code !== undefined && code !== null && code !== 0) continue;

      const rawCandidates = item.url ?? item.freeflow_url ?? item.comm_url;
      const candidates = typeof rawCandidates === 'string'
        ? [rawCandidates]
        : array(rawCandidates).map((entry) => string(entry));
      let url = candidates.find(isHttpUrl) ?? '';
      const m3u8 = string(item.m3u8);
      if (!url && isHttpUrl(m3u8)) {
        url = m3u8;
      }
      if (url) {
        const quality =
          numberAt(item, 'filetype') ||
          numberAt(item, 'newFileType') ||
          numberAt(item, 'fileSize') ||
          0;
        streams.push({ quality, url });
      }
    }
  }
  streams.sort((left, right) => right.quality - left.quality);
  return uniqueStrings(streams.map((entry) => entry.url));
}

function isHttpUrl(value: string): boolean {
  return value.startsWith('http://') || value.startsWith('https://');
}

function mobileHeaders(): Record<string, string> {
  return {
    'user-agent': DEFAULT_MOBILE_USER_AGENT,
    referer: 'https://y.qq.com/',
  };
}

function desktopJsonHeaders(): Record<string, string> {
  return {
    'user-agent': DEFAULT_DESKTOP_USER_AGENT,
    referer: 'https://y.qq.com/',
    'content-type': 'application/json',
  };
}

registerParser('qqmusic', {
  factory: (context) => new QQMusicParser(context),
  allowedHosts: ['u.y.qq.com', 'c.y.qq.com', '*.y.qq.com'],
});
