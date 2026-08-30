import type { ImageItem } from '../core/media-result.js';
import type { PlatformId } from '../config/platforms.js';
import type { ParseContext } from '../core/parse-context.js';
import type { PlatformParser } from '../core/parser.js';
import { getVideoId } from '../http/url-tools.js';
import { safeErrorDetails } from '../core/errors.js';
import { LocalByteDanceSigner } from '../signers/bytedance/signer.js';
import { array, at, author, result, string, stringAt } from './data.js';

const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36';
const signer = new LocalByteDanceSigner();

export class DouyinSharedParser implements PlatformParser {
  public constructor(
    public readonly platform: PlatformId,
    private readonly context: ParseContext,
  ) {}

  public async parse(): Promise<ReturnType<typeof result>> {
    const awemeId = getVideoId(this.context.realUrl);
    if (!awemeId) return result({});
    let payload: unknown = {};
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      try {
        const ttwid = await this.#getTtwid();
        const url = new URL('https://www.douyin.com/aweme/v1/web/aweme/detail/');
        for (const [key, value] of Object.entries({
          device_platform: 'webapp', aid: '6383', channel: 'channel_pc_web',
          aweme_id: awemeId, msToken: signer.getMsToken(),
        })) url.searchParams.set(key, value);
        url.searchParams.set('a_bogus', signer.getABogus(url, USER_AGENT));
        payload = await this.context.session.getJson<unknown>(url, {
          headers: {
            'sec-ch-ua': '"Google Chrome";v="123", "Not:A-Brand";v="8", "Chromium";v="123"',
            'sec-ch-ua-mobile': '?0', 'sec-ch-ua-platform': '"Windows"',
            'sec-fetch-site': 'same-origin', 'sec-fetch-mode': 'cors', 'sec-fetch-dest': 'empty',
            'accept-language': 'zh-CN,zh;q=0.9,en;q=0.8',
            referer: `https://www.douyin.com/video/${awemeId}?previous_page=web_code_link`,
            ...(ttwid ? { cookie: `ttwid=${ttwid}` } : {}),
            'user-agent': USER_AGENT,
          },
          signal: this.context.signal,
        });
        if (Object.keys((at(payload, 'aweme_detail') ?? {})).length > 0) break;
      } catch (error) {
        this.context.logger.warn(
          {
            platform_id: this.platform,
            attempt,
            error_category: 'upstream_attempt_failed',
            ...safeErrorDetails(error),
          },
          'douyin detail attempt failed',
        );
      }
    }
    const detail = at(payload, 'aweme_detail');
    const bitRateUrls = array(at(detail, 'video', 'bit_rate', 0, 'play_addr', 'url_list'))
      .map((value) => string(value)).filter(Boolean);
    // Douyin rotates equivalent CDN mirrors in url_list. Prefer the browser-accessible `*-weba`
    // mirror and keep every other address as a fallback, without depending on array position.
    const videoList = orderVideoUrls(bitRateUrls);
    const videoUrl = videoList[0] ?? '';
    const imagesSource = array(at(detail, 'images')).length > 0
      ? array(at(detail, 'images'))
      : array(at(detail, 'image_list'));
    const imageList: ImageItem[] = [];
    for (const image of imagesSource) {
      const urls = array(at(image, 'url_list')).map((value) => string(value)).filter(Boolean);
      const imageUrl = urls.at(-1);
      if (!imageUrl) continue;
      const livePhotoUrl = stringAt(image, 'video', 'play_addr', 'url_list', 0);
      imageList.push(livePhotoUrl ? { url: imageUrl, livePhotoUrl } : imageUrl);
    }
    const creator = at(detail, 'author');
    return result({
      title: stringAt(detail, 'desc'),
      videoUrl: videoUrl || null,
      videoList,
      audioUrl: stringAt(detail, 'music', 'play_url', 'url_list', 0) || null,
      coverUrl: stringAt(detail, 'video', 'dynamic_cover', 'url_list', 0) ||
        stringAt(detail, 'images', 0, 'url_list', 0) || null,
      imageList,
      author: author(
        at(creator, 'nickname'),
        at(creator, 'unique_id') || at(creator, 'short_id'),
        at(creator, 'avatar_thumb', 'url_list', 0),
      ),
    });
  }

  async #getTtwid(): Promise<string> {
    const response = await this.context.session.request(
      'https://ttwid.bytedance.com/ttwid/union/register/',
      {
        method: 'POST',
        json: {
          region: 'cn', aid: 6383, need_t: 1, service: 'www.douyin.com',
          migrate_priority: 0, cb_url_protocol: 'https', domain: '.douyin.com',
        },
        signal: this.context.signal,
        maxBodyBytes: 1024 * 1024,
      },
    );
    const cookies = response.headers['set-cookie'];
    const values = Array.isArray(cookies) ? cookies : cookies ? [cookies] : [];
    for (const value of values) {
      const match = /(?:^|;\s*)ttwid=([^;]+)/u.exec(value);
      if (match?.[1]) return match[1];
    }
    return '';
  }
}

function orderVideoUrls(urls: readonly string[]): string[] {
  const preferred: string[] = [];
  const fallbacks: string[] = [];
  for (const value of new Set(urls)) {
    try {
      const hostname = new URL(value).hostname.toLowerCase();
      (hostname.endsWith('-weba.douyinvod.com') ? preferred : fallbacks).push(value);
    } catch {
      fallbacks.push(value);
    }
  }
  return [...preferred, ...fallbacks];
}
