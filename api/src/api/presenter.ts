import { platformDefinitions, type PlatformId } from '../config/platforms.js';
import type { ImageItem, MediaResult } from '../core/media-result.js';
import { convertMediaUrlToHttps, getVideoId } from '../http/url-tools.js';

export interface LegacySuccessResponse {
  retcode: 200;
  retdesc: '成功';
  data: Record<string, unknown>;
  succ: true;
}

export interface LegacyErrorResponse {
  retcode: number;
  retdesc: string;
  data: null;
  succ: false;
  error_code: string;
}

export type LegacyResponse = LegacySuccessResponse | LegacyErrorResponse;

export function presentSuccess(
  platformId: PlatformId,
  realUrl: URL,
  result: MediaResult,
): LegacySuccessResponse {
  const videoList = [...new Set(result.videoList.map((url) => convertMediaUrlToHttps(url)).filter(isString))];
  const videoUrl = convertMediaUrlToHttps(result.videoUrl) ?? videoList[0] ?? null;
  if (videoUrl && videoList.includes(videoUrl)) {
    videoList.splice(videoList.indexOf(videoUrl), 1);
    videoList.unshift(videoUrl);
  }
  const data: Record<string, unknown> = {
    video_id: getVideoId(realUrl),
    platform: platformDefinitions[platformId].displayName,
    title: result.title,
    video_url: videoUrl,
    audio_url: convertMediaUrlToHttps(result.audioUrl),
    cover_url: convertMediaUrlToHttps(result.coverUrl),
    author: result.author ? {
      nickname: result.author.nickname,
      author_id: result.author.authorId,
      avatar: convertMediaUrlToHttps(result.author.avatar) ?? '',
      ...(result.author.guildName === undefined ? {} : { guild_name: result.author.guildName }),
    } : null,
    image_list: result.imageList.map(presentImage),
  };
  if (videoList.length >= 2) data.video_list = videoList;
  if (result.subtitles && result.subtitles.length > 0) {
    data.subtitles = result.subtitles.map((subtitle) => ({
      text: subtitle.text,
      ...(subtitle.startMs === undefined ? {} : { start_ms: subtitle.startMs }),
      ...(subtitle.endMs === undefined ? {} : { end_ms: subtitle.endMs }),
    }));
  }
  return { retcode: 200, retdesc: '成功', data, succ: true };
}

export function presentError(retcode: number, message: string, errorCode: string): LegacyErrorResponse {
  return {
    retcode,
    retdesc: message,
    data: null,
    succ: false,
    error_code: errorCode,
  };
}

function presentImage(image: ImageItem): string | { url: string | null; live_photo_url: string | null } {
  if (typeof image === 'string') return convertMediaUrlToHttps(image) ?? '';
  return {
    url: convertMediaUrlToHttps(image.url),
    live_photo_url: convertMediaUrlToHttps(image.livePhotoUrl),
  };
}

function isString(value: string | null): value is string {
  return value !== null;
}
