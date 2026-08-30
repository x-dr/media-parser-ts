import { createHash } from 'node:crypto';
import type { ParseContext } from '../core/parse-context.js';
import type { PlatformParser } from '../core/parser.js';
import { registerParser } from '../core/parser-registry.js';
import { array, at, author, result, string, stringAt, uniqueStrings } from './data.js';

class JianyingParser implements PlatformParser {
  public readonly platform = 'jianying' as const;
  public constructor(private readonly context: ParseContext) {}

  public async parse(): Promise<ReturnType<typeof result>> {
    const templateId = this.context.realUrl.searchParams.get('template_id');
    if (!templateId) return result({});
    const rawItemType = this.context.realUrl.searchParams.get('item_type') ?? '0';
    const itemType = /^\d+$/u.test(rawItemType) ? Number(rawItemType) : 0;
    const timestamp = Math.floor(Date.now() / 1000);
    const sign = createHash('md5').update(`9e2c|mplates|0||${timestamp}||11ac`).digest('hex');
    const payload = await this.context.session.getJson<unknown>(
      'https://lv-api.ulikecam.com/lv/v1/web/replicate/multi_get_templates',
      {
        method: 'POST',
        headers: {
          sign, pf: '0', 'sign-ver': '1', 'device-time': String(timestamp),
          origin: 'https://lv.ulikecam.com', referer: 'https://lv.ulikecam.com/',
        },
        json: { sdk_version: '100.0.0', id: [templateId], scene: 'share', item_type: itemType },
        signal: this.context.signal,
      },
    );
    const template = at(payload, 'data', 'templates', 0);
    const videoUrl = stringAt(template, 'video_url') || null;
    const authorNode = at(template, 'author');
    const aweme = at(authorNode, 'aweme_info');
    return result({
      title: stringAt(template, 'title') || stringAt(template, 'short_title') || '剪映模板',
      videoUrl,
      videoList: videoUrl ? [videoUrl] : [],
      audioUrl: stringAt(template, 'music_info', 'play_url') || null,
      coverUrl: stringAt(template, 'cover_url') || stringAt(template, 'cover') || null,
      imageList: uniqueStrings(array(at(template, 'images')).map((value) => string(value))),
      author: author(
        at(authorNode, 'name') || at(aweme, 'name'),
        at(authorNode, 'uid') || at(authorNode, 'id') || at(aweme, 'uid'),
        at(authorNode, 'avatar') || at(authorNode, 'avatar_url') || at(aweme, 'avatar_url'),
      ),
    });
  }
}

registerParser('jianying', {
  factory: (context) => new JianyingParser(context),
  allowedHosts: ['lv-api.ulikecam.com'],
});
