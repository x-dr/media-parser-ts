import type { ParseContext } from '../core/parse-context.js';
import type { PlatformParser } from '../core/parser.js';
import { registerParser } from '../core/parser-registry.js';
import { getVideoId } from '../http/url-tools.js';
import { result, stringAt } from './data.js';

class HuyaParser implements PlatformParser {
  public readonly platform = 'huya' as const;
  public constructor(private readonly context: ParseContext) {}

  public async parse(): Promise<ReturnType<typeof result>> {
    const videoId = getVideoId(this.context.realUrl);
    if (!/^\d+$/u.test(videoId)) return result({});
    const url = new URL('https://liveapi.huya.com/moment/getMomentContent');
    url.searchParams.set('videoId', videoId);
    const data = await this.context.session.getJson<unknown>(url, {
      headers: { referer: 'https://www.huya.com/' }, signal: this.context.signal,
    });
    return result({
      title: stringAt(data, 'data', 'moment', 'videoInfo', 'videoTitle'),
      videoUrl: stringAt(data, 'data', 'moment', 'videoInfo', 'definitions', 0, 'url') || null,
      coverUrl: stringAt(data, 'data', 'moment', 'videoInfo', 'videoCover') || null,
    });
  }
}

registerParser('huya', {
  factory: (context) => new HuyaParser(context),
  allowedHosts: ['liveapi.huya.com'],
});
