export interface ServiceStatus {
  status: 'ok' | 'not_ready';
  ready: boolean;
  checked_at: string;
  request_id: string;
}

export interface PublicPlatform {
  id: string;
  name: string;
  enabled: boolean;
  media_types: string[];
  domains: string[];
}

export interface PlatformResponse {
  data: { items: PublicPlatform[] };
  request_id: string;
}

export interface Author {
  nickname?: string;
  author_id?: string;
  avatar?: string;
  guild_name?: string;
}

export interface LiveImage {
  url: string | null;
  live_photo_url: string | null;
}

export interface Subtitle {
  text: string;
  start_ms?: number;
  end_ms?: number;
}

export interface MediaData {
  video_id?: string;
  platform?: string;
  title?: string;
  video_url?: string | null;
  video_list?: string[];
  audio_url?: string | null;
  cover_url?: string | null;
  author?: Author | null;
  image_list?: (string | LiveImage)[];
  subtitles?: Subtitle[];
}

export interface ParseSuccess {
  retcode: 200;
  retdesc: string;
  data: MediaData;
  succ: true;
  request_id: string;
  duration_ms?: number;
}

export interface ParseFailure {
  retcode: number;
  retdesc: string;
  data: null;
  succ: false;
  error_code: string;
  request_id?: string;
  duration_ms?: number;
}

export type ParseResponse = ParseSuccess | ParseFailure;

export type ResultState =
  | { kind: 'empty' }
  | { kind: 'loading'; longWait: boolean }
  | { kind: 'cancelled' }
  | { kind: 'error'; response: ParseFailure; retryAfter: number | null }
  | { kind: 'success'; response: ParseSuccess };
