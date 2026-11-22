import type { PublicErrorCode } from './errors.js';

export interface AuthorInfo {
  nickname: string;
  authorId: string;
  avatar: string;
  guildName?: string;
}

export interface LivePhoto {
  url: string | null;
  livePhotoUrl: string | null;
}

export type ImageItem = string | LivePhoto;

export interface SubtitleItem {
  text: string;
  startMs?: number;
  endMs?: number;
}

export interface TerminalErrorDetail {
  code: PublicErrorCode;
  message: string;
}

export interface MediaResult {
  title: string;
  desc?: string | null;
  videoUrl: string | null;
  videoList: string[];
  audioUrl: string | null;
  coverUrl: string | null;
  author: AuthorInfo | null;
  imageList: ImageItem[];
  subtitles: SubtitleItem[] | null;
  isPreview?: boolean;
  fullDuration?: number;
  noMediaInContent?: boolean;
  cookieRequired?: boolean;
  terminalError?: TerminalErrorDetail | null;
}

export function emptyMediaResult(): MediaResult {
  return {
    title: '',
    desc: null,
    videoUrl: null,
    videoList: [],
    audioUrl: null,
    coverUrl: null,
    author: null,
    imageList: [],
    subtitles: null,
  };
}

export function hasMedia(result: MediaResult): boolean {
  return (
    Boolean(result.videoUrl) ||
    result.videoList.length > 0 ||
    result.imageList.length > 0 ||
    Boolean(result.audioUrl)
  );
}
