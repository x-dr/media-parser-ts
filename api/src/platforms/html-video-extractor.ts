import * as cheerio from 'cheerio';
import {
  extractAssignedJson,
  protocolUrl,
  record,
  string,
  unescapeHtml,
  unescapeUnicodeEscapes,
} from './data.js';

export interface ExtractedHtmlVideo {
  title: string | null;
  videoUrl: string | null;
  coverUrl: string | null;
  author: string | null;
}

export function extractHtmlVideoPage(html: string): ExtractedHtmlVideo {
  const output: ExtractedHtmlVideo = {
    title: null,
    videoUrl: null,
    coverUrl: null,
    author: null,
  };
  if (!html) return output;

  const routerJson = extractRouterData(html);
  if (routerJson) {
    const fromJson = searchJsonForVideo(routerJson);
    if (fromJson.title) output.title = fromJson.title;
    if (fromJson.videoUrl) output.videoUrl = fromJson.videoUrl;
    if (fromJson.coverUrl) output.coverUrl = fromJson.coverUrl;
    if (fromJson.author) output.author = fromJson.author;
  }

  const $ = cheerio.load(html);
  $('meta').each((_index, element) => {
    const name = ($(element).attr('property') ?? $(element).attr('name') ?? '').toLowerCase();
    const content = unescapeHtml($(element).attr('content') ?? '').trim();
    if (!name || !content) return;
    if (
      !output.videoUrl &&
      (name === 'og:url' || name === 'twitter:player' || name === 'video:url' || name === 'og:video') &&
      (content.includes('mime_type=video') || content.includes('.mp4') || content.includes('/tos-cn-') || content.includes('play'))
    ) {
      output.videoUrl = content;
    } else if (!output.coverUrl && (name === 'og:image' || name === 'twitter:image')) {
      output.coverUrl = content;
    } else if (
      !output.title &&
      (name === 'og:description' || name === 'description' || name === 'og:title' || name === 'twitter:title')
    ) {
      output.title = content;
    }
  });

  if (!output.title) {
    const pageTitle = unescapeHtml($('title').first().text()).trim();
    if (pageTitle) output.title = pageTitle;
  }

  if (!output.videoUrl) {
    const videoSrc = unescapeHtml($('video').first().attr('src') ?? '').trim();
    if (videoSrc) output.videoUrl = videoSrc;
  }

  if (output.videoUrl) output.videoUrl = cleanMediaUrl(output.videoUrl);
  if (output.coverUrl) output.coverUrl = cleanMediaUrl(output.coverUrl);
  return output;
}

function extractRouterData(html: string): unknown {
  for (const marker of ['window._ROUTER_DATA', 'window._SSR_DATA']) {
    const parsed = extractAssignedJson(html, marker);
    if (Object.keys(record(parsed)).length > 0) return parsed;
  }
  const $ = cheerio.load(html);
  let fallback: unknown = null;
  $('script').each((_index, element) => {
    if (fallback !== null) return;
    const content = $(element).text().trim();
    if (!(content.includes('play_url') || content.includes('video_url') || content.includes('series_data'))) {
      return;
    }
    const braceStart = content.indexOf('{');
    const braceEnd = content.lastIndexOf('}');
    if (braceStart >= 0 && braceEnd > braceStart) {
      try {
        fallback = JSON.parse(content.slice(braceStart, braceEnd + 1)) as unknown;
      } catch {
        // Ignore non-JSON script blocks.
      }
    }
  });
  return fallback;
}

function searchJsonForVideo(data: unknown): ExtractedHtmlVideo {
  const found: ExtractedHtmlVideo = {
    title: null,
    videoUrl: null,
    coverUrl: null,
    author: null,
  };

  const walk = (node: unknown, depth: number): void => {
    if (depth > 16 || node === null || typeof node !== 'object') return;
    if (Array.isArray(node)) {
      for (const item of node) walk(item, depth + 1);
      return;
    }
    const obj = node as Record<string, unknown>;
    if (!found.title) {
      for (const key of ['title', 'series_title', 'video_title', 'share_title', 'name']) {
        const val = string(obj[key]).trim();
        if (val) {
          found.title = val;
          break;
        }
      }
    }
    if (!found.videoUrl) {
      for (const key of ['play_url', 'video_url', 'video_play_url', 'url', 'mp4_url']) {
        const val = string(obj[key]).trim();
        if (val && (val.includes('http://') || val.includes('https://') || val.includes('.mp4') || val.includes('/tos-cn-'))) {
          found.videoUrl = val;
          break;
        }
      }
    }
    if (!found.coverUrl) {
      for (const key of ['cover_url', 'poster_url', 'cover', 'image_url', 'og:image']) {
        const val = string(obj[key]).trim();
        if (val && (val.includes('http://') || val.includes('https://'))) {
          found.coverUrl = val;
          break;
        }
      }
    }
    if (!found.author) {
      for (const key of ['author', 'author_name', 'user_name', 'nick_name', 'nickname']) {
        const val = string(obj[key]).trim();
        if (val) {
          found.author = val;
          break;
        }
      }
    }
    for (const child of Object.values(obj)) {
      walk(child, depth + 1);
    }
  };

  walk(data, 0);
  return found;
}

function cleanMediaUrl(raw: string): string | null {
  const cleaned = protocolUrl(unescapeHtml(unescapeUnicodeEscapes(raw)).trim());
  return cleaned || null;
}
