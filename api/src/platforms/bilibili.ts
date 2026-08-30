import type { ParseContext } from '../core/parse-context.js';
import type { PlatformParser } from '../core/parser.js';
import { registerParser } from '../core/parser-registry.js';
import { array, at, author, protocolUrl, result, stringAt, uniqueStrings } from './data.js';

class BilibiliParser implements PlatformParser {
  public readonly platform = 'bilibili' as const;
  public constructor(private readonly context: ParseContext) {}

  public async parse(): Promise<ReturnType<typeof result>> {
    const bvid = /(BV[a-zA-Z0-9]+)/u.exec(this.context.realUrl.href)?.[1];
    if (!bvid) return result({});
    const viewUrl = new URL('https://api.bilibili.com/x/web-interface/view');
    viewUrl.searchParams.set('bvid', bvid);
    const headers = { referer: 'https://www.bilibili.com/' };
    const view = await this.context.session.getJson<unknown>(viewUrl, {
      headers, signal: this.context.signal,
    });
    if (at(view, 'code') !== 0) return result({});
    const data = at(view, 'data');
    const pages = array(at(data, 'pages'));
    const urls: string[] = [];
    for (const page of pages) {
      const cid = at(page, 'cid');
      if (typeof cid !== 'number' && typeof cid !== 'string') continue;
      const playUrl = new URL('https://api.bilibili.com/x/player/playurl');
      for (const [key, value] of Object.entries({
        otype: 'json', fnver: '0', fnval: '3', player: '3', qn: '112',
        bvid, cid: String(cid), platform: 'html5', high_quality: '1',
      })) playUrl.searchParams.set(key, value);
      const play = await this.context.session.getJson<unknown>(playUrl, {
        headers, signal: this.context.signal,
      });
      const url = stringAt(play, 'data', 'durl', 0, 'url');
      if (url) urls.push(url);
    }
    const videoList = uniqueStrings(urls);
    const owner = at(data, 'owner');
    return result({
      title: stringAt(data, 'title'),
      videoUrl: videoList[0] ?? null,
      videoList: pages.length > 1 ? videoList : [],
      coverUrl: stringAt(data, 'pic') || null,
      author: author(
        at(owner, 'name'),
        at(owner, 'mid'),
        protocolUrl(stringAt(owner, 'face')),
      ),
    });
  }
}

registerParser('bilibili', {
  factory: (context) => new BilibiliParser(context),
  allowedHosts: ['api.bilibili.com'],
});
