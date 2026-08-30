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
