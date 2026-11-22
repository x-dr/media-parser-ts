import { load } from 'cheerio';
import { DEFAULT_MOBILE_USER_AGENT } from '../config/user-agents.js';
import { ProxyAttemptError } from '../core/errors.js';
import type { MediaResult } from '../core/media-result.js';
import type { ParseContext } from '../core/parse-context.js';
import type { PlatformParser } from '../core/parser.js';
import { registerParser } from '../core/parser-registry.js';
import {
  array,
  at,
  author,
  extractBalancedBraces,
  parseJson,
  record,
  result,
  string,
  stringAt,
  uniqueStrings,
} from './data.js';

class DewuParser implements PlatformParser {
  public readonly platform = 'dewu' as const;
  public constructor(private readonly context: ParseContext) {}

  public async parse(): Promise<MediaResult> {
    let html: string;
    try {
      html = await this.context.session.getText(this.context.realUrl, {
        headers: {
          'user-agent': DEFAULT_MOBILE_USER_AGENT,
          referer: 'https://m.dewu.com/',
          accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        },
        followRedirect: true,
        signal: this.context.signal,
      });
    } catch (error) {
      if (error instanceof ProxyAttemptError) throw error;
      return result({});
    }

    const data = extractDewuNextData(html);
    const metaDataList = array(at(data, 'props', 'pageProps', 'metaOGInfo', 'data'));
    if (metaDataList.length === 0) return result({});

    const targetData = record(metaDataList[0]);
    const contentData = record(targetData.content);
    const userData = record(targetData.userInfo);

    const title = string(contentData.title).trim();
    const desc = string(contentData.content).trim() || null;
    const coverUrl = stringAt(contentData, 'cover', 'url') || null;
    const authorInfo = author(userData.userName, userData.userId, userData.icon);

    let videoUrl = '';
    const images: string[] = [];
    for (const rawItem of array(at(contentData, 'media', 'list'))) {
      const item = record(rawItem);
      const mediaType = string(item.mediaType);
      const url = string(item.url);
      if (!url) continue;
      if (mediaType === 'video' && !videoUrl) {
        videoUrl = url;
      } else if (mediaType === 'img') {
        images.push(url);
      }
    }

    if (!videoUrl) {
      videoUrl = string(contentData.videoShareUrl);
    }

    if (!videoUrl && images.length === 0 && coverUrl) {
      images.push(coverUrl);
    }

    return result({
      title,
      desc,
      videoUrl: videoUrl || null,
      coverUrl,
      imageList: uniqueStrings(images),
      author: authorInfo,
    });
  }
}

function extractDewuNextData(html: string): Record<string, unknown> {
  if (!html) return {};
  const $ = load(html);
  for (const element of $('script').toArray()) {
    const content = $(element).text().trim();
    if (!content.includes('metaOGInfo')) continue;
    try {
      return record(parseJson(content));
    } catch {
      const braceStart = content.indexOf('{');
      if (braceStart >= 0) {
        const slice = extractBalancedBraces(content, braceStart);
        if (slice) {
          try {
            return record(parseJson(slice));
          } catch {
            // Continue inspecting remaining script blocks.
          }
        }
      }
    }
  }
  return {};
}

registerParser('dewu', {
  factory: (context) => new DewuParser(context),
  allowedHosts: ['app.dewu.com', '*.dewu.com', '*.poizon.com', 'dw4.co'],
});
