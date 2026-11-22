import { load } from 'cheerio';
import type { ParseContext } from '../core/parse-context.js';
import type { PlatformParser } from '../core/parser.js';
import { registerParser } from '../core/parser-registry.js';
import { DEFAULT_DESKTOP_USER_AGENT, DEFAULT_MOBILE_USER_AGENT } from '../config/user-agents.js';
import {
  array,
  at,
  author,
  idAt,
  numberAt,
  parseJson,
  protocolUrl,
  record,
  result,
  string,
  stringAt,
  uniqueStrings,
} from './data.js';

const DEFAULT_APP_KEY = '61a2f329348b3bf77';

interface VideoRef {
  vid: string;
  appKey: string;
}

class XinpianchangParser implements PlatformParser {
  public readonly platform = 'xinpianchang' as const;
  public constructor(private readonly context: ParseContext) {}

  public async parse(): Promise<ReturnType<typeof result>> {
    const articleId = extractArticleId(this.context.realUrl);
    if (!articleId) return result({});

    let data = await this.#fetchArticleFromApi(articleId);
    if (Object.keys(record(data)).length === 0) {
      data = await this.#fetchArticleFromPage(articleId);
    }
    if (Object.keys(record(data)).length === 0) return result({});

    const videoRefs = collectVideoRefs(data);
    const allVideos: string[] = [];
    for (const ref of videoRefs) {
      const urls = await this.#fetchMediaVideos(ref.vid, ref.appKey);
      allVideos.push(...urls);
    }

    const videoList = uniqueStrings(allVideos);
    const imageList = uniqueStrings(
      array(at(data, 'images'))
        .map((img) => (typeof img === 'string' ? img : stringAt(img, 'url')))
        .filter((url) => url.startsWith('http')),
    );

    const authorNode = Object.keys(record(at(data, 'author', 'userinfo'))).length > 0
      ? at(data, 'author', 'userinfo')
      : at(data, 'creator');
    const rawDesc = stringAt(data, 'content') || stringAt(data, 'description');

    return result({
      title: stringAt(data, 'title'),
      desc: rawDesc || null,
      videoUrl: videoList[0] ?? null,
      videoList,
      coverUrl: protocolUrl(stringAt(data, 'cover')) || imageList[0] || null,
      imageList,
      author: author(
        at(authorNode, 'username') || at(authorNode, 'nickname'),
        at(authorNode, 'id'),
        protocolUrl(stringAt(authorNode, 'avatar')),
      ),
    });
  }

  async #fetchArticleFromApi(articleId: string): Promise<unknown> {
    try {
      const article = await this.context.session.getJson<unknown>(
        `https://app.xinpianchang.com/article/${articleId}`,
        {
          headers: {
            'user-agent': DEFAULT_MOBILE_USER_AGENT,
            accept: 'application/json, text/plain, */*',
          },
          signal: this.context.signal,
        },
      );
      if (at(article, 'status') === 0 && Object.keys(record(at(article, 'data'))).length > 0) {
        return at(article, 'data');
      }
    } catch {
      // Fall back to web page __NEXT_DATA__ extraction.
    }
    return {};
  }

  async #fetchArticleFromPage(articleId: string): Promise<unknown> {
    try {
      // Must use desktop UA + Accept: */* so Xinpianchang serves SSR __NEXT_DATA__.
      const html = await this.context.session.getText(
        `https://www.xinpianchang.com/a${articleId}`,
        {
          headers: {
            'user-agent': DEFAULT_DESKTOP_USER_AGENT,
            accept: '*/*',
          },
          signal: this.context.signal,
        },
      );
      const nextRaw = load(html)('#__NEXT_DATA__').html();
      if (!nextRaw) return {};
      const detail = at(parseJson(nextRaw), 'props', 'pageProps', 'detail');
      return Object.keys(record(detail)).length > 0 ? detail : {};
    } catch {
      return {};
    }
  }

  async #fetchMediaVideos(vid: string, appKey: string): Promise<string[]> {
    try {
      const mediaUrl = `https://mod-api.xinpianchang.com/mod/api/v2/media/${encodeURIComponent(vid)}?appKey=${encodeURIComponent(appKey)}`;
      const media = await this.context.session.getJson<unknown>(mediaUrl, {
        headers: {
          'user-agent': DEFAULT_MOBILE_USER_AGENT,
          accept: 'application/json, text/plain, */*',
          referer: 'https://www.xinpianchang.com/',
          origin: 'https://www.xinpianchang.com',
        },
        signal: this.context.signal,
      });
      if (Object.hasOwn(record(media), 'status') && numberAt(media, 'status', 0) !== 0) {
        return [];
      }
      const progressive = array(at(media, 'data', 'resource', 'progressive'))
        .map(record)
        .filter((entry) => string(entry.url).startsWith('http'));
      progressive.sort((left, right) => {
        const heightDiff = numberAt(right, 'height') - numberAt(left, 'height');
        if (heightDiff !== 0) return heightDiff;
        return numberAt(right, 'bitrate') - numberAt(left, 'bitrate');
      });
      return uniqueStrings(progressive.map((entry) => string(entry.url)));
    } catch {
      return [];
    }
  }
}

function extractArticleId(url: URL): string {
  const pathMatch = /(?:^|\/)(?:a|article\/)(\d+)/u.exec(url.pathname)?.[1];
  if (pathMatch) return pathMatch;
  return /(\d+)/u.exec(url.pathname)?.[1] ?? /(\d+)/u.exec(url.href)?.[1] ?? '';
}

function collectVideoRefs(data: unknown): VideoRef[] {
  const refs: VideoRef[] = [];
  const seenVids = new Set<string>();
  const defaultKey = stringAt(data, 'video', 'appKey') || DEFAULT_APP_KEY;

  const addRef = (vid: string, appKey: string): void => {
    if (!vid || seenVids.has(vid)) return;
    seenVids.add(vid);
    refs.push({ vid, appKey: appKey || defaultKey });
  };

  const primaryVid =
    idAt(data, 'vid') ||
    idAt(data, 'media_id') ||
    idAt(data, 'video', 'vid');
  addRef(primaryVid, defaultKey);

  for (const item of [...array(at(data, 'videos')), ...array(at(data, 'video_library'))]) {
    const itemVid = idAt(item, 'vid') || idAt(item, 'media_id');
    const itemKey = stringAt(item, 'appKey') || defaultKey;
    addRef(itemVid, itemKey);
  }

  return refs;
}

registerParser('xinpianchang', {
  factory: (context) => new XinpianchangParser(context),
  allowedHosts: ['app.xinpianchang.com', 'mod-api.xinpianchang.com', 'www.xinpianchang.com'],
});
