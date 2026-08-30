import type { ParseContext } from '../core/parse-context.js';
import type { ImageItem } from '../core/media-result.js';
import type { PlatformParser } from '../core/parser.js';
import { registerParser } from '../core/parser-registry.js';
import { safeErrorDetails } from '../core/errors.js';
import { array, at, author, extractAssignedJson, result, stringAt } from './data.js';

class XiaohongshuParser implements PlatformParser {
  public readonly platform = 'xiaohongshu' as const;
  public constructor(private readonly context: ParseContext) {}

  public async parse(): Promise<ReturnType<typeof result>> {
    let note: unknown = {};
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      try {
        const cookie = this.context.credentials.cookie;
        const html = await this.context.session.getText(this.context.realUrl, {
          headers: {
            referer: 'https://www.xiaohongshu.com/',
            ...(cookie ? { cookie } : {}),
          },
          signal: this.context.signal,
        });
        const state = extractAssignedJson(html, 'window.__INITIAL_STATE__');
        const firstNoteId = stringAt(state, 'note', 'firstNoteId');
        note = firstNoteId ? at(state, 'note', 'noteDetailMap', firstNoteId, 'note') : {};
        if (stringAt(note, 'video', 'media', 'stream', 'h264', 0, 'masterUrl') ||
            array(at(note, 'imageList')).length > 0) break;
      } catch (error) {
        this.context.logger.warn(
          {
            platform_id: this.platform,
            attempt,
            error_category: 'upstream_attempt_failed',
            ...safeErrorDetails(error),
          },
          'xiaohongshu parse attempt failed',
        );
      }
    }
    const images: ImageItem[] = [];
    for (const image of array(at(note, 'imageList'))) {
      const url = stringAt(image, 'urlDefault').replaceAll('\\u002F', '/');
      if (!url) continue;
      const livePhotoUrl = stringAt(image, 'stream', 'h264', 0, 'masterUrl').replaceAll('\\u002F', '/');
      images.push(at(image, 'livePhoto') === true && livePhotoUrl ? { url, livePhotoUrl } : url);
    }
    const user = at(note, 'user');
    const title = [stringAt(note, 'title'), stringAt(note, 'desc')].filter(Boolean).join('\n');
    return result({
      title,
      videoUrl: stringAt(note, 'video', 'media', 'stream', 'h264', 0, 'masterUrl')
        .replaceAll('\\u002F', '/') || null,
      coverUrl: stringAt(note, 'imageList', 0, 'urlDefault').replaceAll('\\u002F', '/') || null,
      imageList: images,
      author: author(at(user, 'nickname'), at(user, 'userId'), at(user, 'avatar')),
    });
  }
}

registerParser('xiaohongshu', {
  factory: (context) => new XiaohongshuParser(context),
  allowedHosts: [],
});
