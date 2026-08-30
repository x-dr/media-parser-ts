import type { LiveImage, MediaData, Subtitle } from '../types';

export interface NormalizedImage {
  imageUrl: string | null;
  livePhotoUrl: string | null;
}

export function safeHttpUrl(value: unknown): string | null {
  if (typeof value !== 'string' || value.length === 0) return null;
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.href : null;
  } catch {
    return null;
  }
}

export function videoUrls(data: MediaData): string[] {
  return uniqueUrls([data.video_url, ...(data.video_list ?? [])]);
}

export function normalizeImages(data: MediaData): NormalizedImage[] {
  return (data.image_list ?? []).map((item) => normalizeImage(item))
    .filter((item) => item.imageUrl !== null || item.livePhotoUrl !== null);
}

export function formatSubtitleTime(subtitle: Subtitle): string | null {
  if (subtitle.start_ms === undefined && subtitle.end_ms === undefined) return null;
  const start = formatMilliseconds(subtitle.start_ms ?? 0);
  const end = subtitle.end_ms === undefined ? null : formatMilliseconds(subtitle.end_ms);
  return end ? `${start} – ${end}` : start;
}

export function platformMark(name: string): string {
  const latin = /[A-Za-z]+/u.exec(name)?.[0];
  if (latin) return latin.slice(0, 1).toUpperCase();
  const segments = new Intl.Segmenter('zh-CN', { granularity: 'grapheme' }).segment(name);
  return Array.from(segments, ({ segment }) => segment).slice(0, 1).join('');
}

const brandPalette: ReadonlyArray<readonly [RegExp, string]> = [
  [/抖音|douyin|tiktok/iu, '#161823'],
  [/小红书|redbook|xhs|xiaohongshu/iu, '#ff2442'],
  [/快手|kuaishou/iu, '#ff6a06'],
  [/哔哩|bilibili|b站/iu, '#fb7299'],
  [/微信|视频号|wechat|weixin/iu, '#07c160'],
  [/微博|weibo/iu, '#e6162d'],
  [/知乎|zhihu/iu, '#0066ff'],
  [/西瓜|xigua/iu, '#ff4b2b'],
  [/剪映|jianying|capcut/iu, '#0fb9b1'],
  [/即梦|jimeng/iu, '#7b5cff'],
  [/豆包|doubao/iu, '#335cff'],
  [/皮皮虾|pipix/iu, '#ffb300'],
  [/好看|haokan/iu, '#3b6ff0'],
  [/头条|toutiao/iu, '#f04142'],
  [/youtube/iu, '#ff0033'],
  [/instagram/iu, '#d62976'],
  [/twitter|推特/iu, '#14171a'],
];

export function platformBrand(name: string): string {
  for (const [pattern, color] of brandPalette) {
    if (pattern.test(name)) return color;
  }
  return '#6c4de6';
}

function normalizeImage(item: string | LiveImage): NormalizedImage {
  if (typeof item === 'string') return { imageUrl: safeHttpUrl(item), livePhotoUrl: null };
  return {
    imageUrl: safeHttpUrl(item.url),
    livePhotoUrl: safeHttpUrl(item.live_photo_url),
  };
}

function uniqueUrls(values: unknown[]): string[] {
  return [...new Set(values.map(safeHttpUrl).filter((value): value is string => value !== null))];
}

function formatMilliseconds(value: number): string {
  const totalSeconds = Math.max(0, Math.floor(value / 1_000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
}
