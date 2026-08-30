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

export interface MediaResult {
  title: string;
  videoUrl: string | null;
  videoList: string[];
  audioUrl: string | null;
  coverUrl: string | null;
  author: AuthorInfo | null;
  imageList: ImageItem[];
  subtitles: SubtitleItem[] | null;
}

export function emptyMediaResult(): MediaResult {
  return {
    title: '',
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
  return Boolean(result.videoUrl) || result.videoList.length > 0 || result.imageList.length > 0;
}
