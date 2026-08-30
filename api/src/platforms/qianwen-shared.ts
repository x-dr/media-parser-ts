import type { PlatformId } from '../config/platforms.js';
import type { ParseContext } from '../core/parse-context.js';
import type { PlatformParser } from '../core/parser.js';
import { array, at, author, extractAssignedJson, parseJson, record, result, string, stringAt, uniqueStrings } from './data.js';

export class QianwenSharedParser implements PlatformParser {
  public constructor(
    public readonly platform: PlatformId,
    private readonly context: ParseContext,
  ) {}

  public async parse(): Promise<ReturnType<typeof result>> {
    const html = await this.context.session.getText(this.context.realUrl, {
      headers: { accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8' },
      signal: this.context.signal,
    });
    const props = extractAssignedJson(html, 'window.__INITIAL_PROPS__');
    let initial: unknown = at(props, 'initialData');
    if (typeof initial === 'string') {
      let serialized = initial;
      if (serialized.startsWith('%')) serialized = decodeURIComponent(serialized);
      try { initial = parseJson(serialized); } catch { initial = {}; }
    }
    const data = record(at(initial, 'data'));
    const content = Object.keys(data).length > 0 ? data : record(initial);
    let title = string(content.title) || string(content.shareSubtitle) || string(content.shareTitle);
    const session = record(content.session);
    if (!title) title = string(session.title);
    if (!title) {
      const firstRecord = at(session, 'record_list', 0);
      title = string(at(firstRecord, 'query')) || stringAt(firstRecord, 'query', 'content') ||
        stringAt(firstRecord, 'query', 'text');
    }
    const creator = at(content, 'creator') || at(content, 'content', 'creator');
    const directImages = array(at(content, 'images'));
    if (directImages.length === 0 && at(content, 'image')) directImages.push(at(content, 'image'));
    const imageUrls = directImages.map((image) =>
      typeof image === 'string' ? image : stringAt(image, 'downloadUrl') || stringAt(image, 'url'));
    const playInfo = at(content, 'playInfo');
    const videoUrls = [stringAt(playInfo, 'url') || stringAt(playInfo, 'downloadUrl')].filter(Boolean);
    const deep = deepMedia(content);
    const imageList = uniqueStrings(imageUrls.length > 0 ? imageUrls : deep.images);
    const videoList = uniqueStrings(videoUrls.length > 0 ? videoUrls : deep.videos);
    return result({
      title,
      videoUrl: videoList[0] ?? null,
      videoList,
      coverUrl: imageList[0] ?? null,
      imageList,
      author: author(
        at(creator, 'nick'),
        at(creator, 'authorId') || at(creator, 'uid'),
        at(creator, 'avatar'),
      ),
    });
  }
}

function deepMedia(value: unknown): { videos: string[]; images: string[] } {
  const videos: string[] = [];
  const images: string[] = [];
  const walk = (current: unknown): void => {
    if (Array.isArray(current)) {
      for (const item of current) walk(item);
      return;
    }
    if (!current || typeof current !== 'object') return;
    for (const [key, child] of Object.entries(current)) {
      if (['url', 'downloadUrl', 'playUrl'].includes(key) && typeof child === 'string') {
        const cleaned = child.replaceAll('\\u0026', '&');
        if (isMediaUrl(cleaned, 'video')) videos.push(cleaned);
        else if (isMediaUrl(cleaned, 'image')) images.push(cleaned);
      } else {
        walk(child);
      }
    }
  };
  walk(value);
  return { videos: uniqueStrings(videos), images: uniqueStrings(images) };
}

function isMediaUrl(value: string, kind: 'video' | 'image'): boolean {
  if (!(value.startsWith('http://') || value.startsWith('https://'))) return false;
  try {
    const path = decodeURIComponent(new URL(value).pathname).toLowerCase();
    const extensions = kind === 'video'
      ? ['.mp4', '.mov', '.m4v', '.webm']
      : ['.jpg', '.jpeg', '.png', '.webp', '.gif'];
    return extensions.some((extension) => path.includes(extension)) ||
      (kind === 'video' && path.includes('/video/'));
  } catch {
    return false;
  }
}
