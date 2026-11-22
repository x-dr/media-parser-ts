import { load } from 'cheerio';
import type { ParseContext } from '../core/parse-context.js';
import type { AuthorInfo } from '../core/media-result.js';
import type { PlatformParser } from '../core/parser.js';
import { registerParser } from '../core/parser-registry.js';
import { DEFAULT_MOBILE_USER_AGENT } from '../config/user-agents.js';
import {
  array,
  at,
  author,
  extractAssignedJson,
  numberAt,
  parseJson,
  protocolUrl,
  record,
  result,
  string,
  stringAt,
  uniqueStrings,
} from './data.js';

class HaokanParser implements PlatformParser {
  public readonly platform = 'haokan' as const;
  public constructor(private readonly context: ParseContext) {}

  public async parse(): Promise<ReturnType<typeof result>> {
    const headers = {
      'user-agent': DEFAULT_MOBILE_USER_AGENT,
      referer: 'https://haokan.baidu.com/v',
    };
    const html = await this.context.session.getText(this.context.realUrl, {
      headers,
      signal: this.context.signal,
    });

    let data = extractHaokanState(html);
    let parsed = mapHaokanData(data);

    if (!parsed.videoUrl) {
      const vid = this.context.realUrl.searchParams.get('vid') ?? '';
      if (vid) {
        try {
          const apiUrl = new URL('https://haokan.baidu.com/v');
          apiUrl.searchParams.set('vid', vid);
          apiUrl.searchParams.set('_format', 'json');
          const apiRes = await this.context.session.getJson<unknown>(apiUrl, {
            headers,
            signal: this.context.signal,
          });
          data = Object.keys(record(at(apiRes, 'data', 'apiData'))).length > 0
            ? at(apiRes, 'data', 'apiData')
            : apiRes;
          parsed = mapHaokanData(data);
        } catch {
          // Keep initial HTML extraction result on fallback failure.
        }
      }
    }

    return result({
      title: parsed.title,
      desc: parsed.desc || null,
      videoUrl: parsed.videoUrl || null,
      videoList: parsed.videoList.length > 1 ? parsed.videoList : [],
      coverUrl: parsed.coverUrl || null,
      author: parsed.author,
    });
  }
}

function extractHaokanState(html: string): unknown {
  if (html.includes('window.jsonData')) {
    const jsonData = extractAssignedJson(html, 'window.jsonData');
    if (Object.keys(record(jsonData)).length > 0) return jsonData;
  }

  if (html.includes('window.__PRELOADED_STATE__')) {
    const preloaded = extractAssignedJson(html, 'window.__PRELOADED_STATE__');
    if (Object.keys(record(preloaded)).length > 0) return preloaded;
  }

  const $ = load(html);
  let scriptState: unknown = {};
  $('script').each((_index, element) => {
    if (Object.keys(record(scriptState)).length > 0) return;
    const raw = ($(element).html() ?? '').trim();
    if (!raw.startsWith('{') || !raw.endsWith('}')) return;
    if (!raw.includes('"url"') && !raw.includes('"play_url"') && !raw.includes('"videoInfo"')) {
      return;
    }
    try {
      const candidate = parseJson(raw);
      const inner = Object.keys(record(at(candidate, 'data'))).length > 0
        ? record(at(candidate, 'data'))
        : record(candidate);
      if (inner.url || inner.play_url || inner.videoInfo) {
        scriptState = candidate;
      }
    } catch {
      // Ignore unrelated inline scripts.
    }
  });

  return scriptState;
}

function mapHaokanData(data: unknown): {
  title: string;
  desc: string;
  videoUrl: string;
  videoList: string[];
  coverUrl: string;
  author: AuthorInfo | null;
} {
  const root = record(data);
  const innerData = Object.keys(record(root.data)).length > 0 ? record(root.data) : root;
  const videoInfo = Object.keys(record(innerData.videoInfo)).length > 0
    ? record(innerData.videoInfo)
    : record(innerData.response);
  const curMeta = Object.keys(record(root.curVideoMeta)).length > 0
    ? record(root.curVideoMeta)
    : record(innerData.curVideoMeta);

  const videoUrls: string[] = [];

  // Structure A: modern window.jsonData with rank-ordered clarityArr.
  const clarityArr = array(videoInfo.clarityArr).length > 0
    ? array(videoInfo.clarityArr)
    : array(videoInfo.clarity_arr);
  if (clarityArr.length > 0) {
    const ranked = clarityArr
      .map(record)
      .filter((entry) => Boolean(string(entry.url)))
      .sort((left, right) => numberAt(right, 'rank') - numberAt(left, 'rank'));
    for (const item of ranked) {
      const normalized = normalizeHaokanUrl(string(item.url));
      if (normalized) videoUrls.push(normalized);
    }
  }

  const infoPlayUrl = normalizeHaokanUrl(
    string(videoInfo.play_url) || string(videoInfo.playurl) || string(videoInfo.url),
  );
  if (infoPlayUrl) videoUrls.push(infoPlayUrl);

  // Structure B: legacy window.__PRELOADED_STATE__.curVideoMeta.clarityUrl (highest clarity last).
  const clarityUrlList = array(curMeta.clarityUrl);
  if (clarityUrlList.length > 0) {
    for (let index = clarityUrlList.length - 1; index >= 0; index -= 1) {
      const normalized = normalizeHaokanUrl(stringAt(clarityUrlList[index], 'url'));
      if (normalized) videoUrls.push(normalized);
    }
  }
  const metaPlayUrl = normalizeHaokanUrl(string(curMeta.playurl));
  if (metaPlayUrl) videoUrls.push(metaPlayUrl);

  // Structure C: Baidu mobile search landing JSON.
  const landingUrl = string(innerData.url);
  if (landingUrl && (landingUrl.includes('.mp4') || landingUrl.includes('bdstatic'))) {
    const normalized = normalizeHaokanUrl(landingUrl);
    if (normalized) videoUrls.push(normalized);
  }

  const dedupedVideos = uniqueStrings(videoUrls);

  const title =
    string(videoInfo.title) ||
    string(innerData.title) ||
    string(curMeta.title);
  const desc =
    string(videoInfo.desc) ||
    string(videoInfo.miaoshu) ||
    string(curMeta.desc) ||
    string(curMeta.miaoshu) ||
    string(innerData.desc);
  const coverUrl = normalizeHaokanUrl(
    string(videoInfo.posterImage) ||
      string(videoInfo.poster) ||
      string(videoInfo.cover) ||
      string(innerData.poster) ||
      string(curMeta.poster),
  );

  const modernAuthor = record(innerData.author);
  const mthNode = record(curMeta.mth);
  const parsedAuthor = (string(modernAuthor.name) || string(modernAuthor.author_name))
    ? author(
        modernAuthor.name || modernAuthor.author_name,
        modernAuthor.uk || modernAuthor.mthid || modernAuthor.id,
        normalizeHaokanUrl(
          string(modernAuthor.icon) ||
            string(modernAuthor.author_photo) ||
            string(modernAuthor.avatar),
        ),
      )
    : author(
        mthNode.author_name,
        mthNode.mthid,
        normalizeHaokanUrl(string(mthNode.author_photo)),
      );

  return {
    title,
    desc,
    videoUrl: dedupedVideos[0] ?? '',
    videoList: dedupedVideos,
    coverUrl,
    author: parsedAuthor,
  };
}

function normalizeHaokanUrl(raw: string): string {
  if (!raw) return '';
  let decoded = raw;
  if (decoded.includes('%')) {
    try {
      decoded = decodeURIComponent(decoded);
    } catch {
      // Keep original string if percent-encoding is partial.
    }
  }
  return protocolUrl(decoded.replaceAll('\\/', '/').replaceAll('\\u002F', '/'));
}

registerParser('haokan', {
  factory: (context) => new HaokanParser(context),
  allowedHosts: ['haokan.baidu.com'],
});
