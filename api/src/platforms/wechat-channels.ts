import { randomBytes } from 'node:crypto';
import type { ParseContext } from '../core/parse-context.js';
import type { PlatformParser } from '../core/parser.js';
import { registerParser } from '../core/parser-registry.js';
import { safeErrorDetails } from '../core/errors.js';
import { at, author, result, stringAt } from './data.js';

const FEED_INFO_API = 'https://channels.weixin.qq.com/finder-preview/api/feed/get_feed_info';
const FEED_PAGE = 'https://channels.weixin.qq.com/finder-preview/pages/feed';
const SPH_PAGE = 'https://channels.weixin.qq.com/finder-preview/pages/sph';

class WechatChannelsParser implements PlatformParser {
  public readonly platform = 'wechat_channels' as const;
  public constructor(private readonly context: ParseContext) {}

  public async parse(): Promise<ReturnType<typeof result>> {
    const cookie = this.context.credentials.yuanbao_cookie;
    if (cookie) {
      try {
        return await this.#parseWithYuanbao(cookie);
      } catch (error) {
        this.context.logger.warn(
          {
            platform_id: this.platform,
            error_category: 'credential_fallback',
            ...safeErrorDetails(error),
          },
          'yuanbao credential failed; using anonymous channel API',
        );
      }
    }
    return this.#parsePublic();
  }

  async #shortUri(): Promise<string> {
    const pathMatch = /(?:^|\/)sph\/([A-Za-z0-9]+)/u.exec(this.context.realUrl.pathname)?.[1];
    if (pathMatch) return pathMatch;
    const queryId = this.context.realUrl.searchParams.get('id');
    if (queryId) return queryId;
    const response = await this.context.session.request(this.context.realUrl, {
      followRedirect: true, signal: this.context.signal, maxBodyBytes: 1024 * 1024,
    });
    const resolved = response.url.searchParams.get('id');
    if (!resolved) throw new Error('链接不是可识别的视频号分享链接');
    return resolved;
  }

  async #parsePublic(): Promise<ReturnType<typeof result>> {
    const shortUri = await this.#shortUri();
    const response = await this.#feedInfo(
      { baseReq: { generalToken: '' }, shortUri },
      `${SPH_PAGE}?id=${encodeURIComponent(shortUri)}`,
      SPH_PAGE,
    );
    return normalizeFeed(response);
  }

  async #parseWithYuanbao(cookie: string): Promise<ReturnType<typeof result>> {
    const response = await this.context.session.getJson<unknown>(
      'https://yuanbao.tencent.com/api/weixin/get_parse_result',
      {
        method: 'POST',
        headers: {
          origin: 'https://yuanbao.tencent.com', referer: 'https://yuanbao.tencent.com/chat',
          cookie, 'x-source': 'web',
        },
        json: { type: 'video_channel_url', url: this.context.realUrl.href, scene: 1 },
        signal: this.context.signal, timeoutMs: 20_000,
      },
    );
    const playable = stringAt(response, 'data', 'playable_url');
    if (!playable) throw new Error('元宝未返回可播放地址');
    const playableUrl = new URL(playable);
    const token = playableUrl.searchParams.get('token');
    const exportId = playableUrl.searchParams.get('eid');
    if (!token || !exportId) throw new Error('元宝响应缺少视频号临时凭证');
    const referer = new URL(FEED_PAGE);
    for (const [key, value] of Object.entries({
      entry_card_type: '48', comment_scene: '39', appid: '0', token, entry_scene: '0', eid: exportId,
    })) referer.searchParams.set(key, value);
    const feed = await this.#feedInfo(
      { baseReq: { generalToken: token }, exportId }, referer.href, FEED_PAGE,
    );
    return normalizeFeed(feed);
  }

  async #feedInfo(payload: unknown, referer: string, pageUrl: string): Promise<unknown> {
    const url = new URL(FEED_INFO_API);
    url.searchParams.set('_rid', randomBytes(4).toString('hex'));
    url.searchParams.set('_pageUrl', pageUrl);
    const response = await this.context.session.getJson<unknown>(url, {
      method: 'POST',
      headers: { origin: 'https://channels.weixin.qq.com', referer },
      json: payload,
      signal: this.context.signal,
      timeoutMs: 20_000,
    });
    const errorCode = at(response, 'errCode');
    if (errorCode !== 0 && errorCode !== undefined && errorCode !== null) {
      throw new Error(stringAt(response, 'errMsg') || '视频号接口返回错误');
    }
    return response;
  }
}

function normalizeFeed(response: unknown): ReturnType<typeof result> {
  const feed = at(response, 'data', 'feedInfo');
  const authorNode = at(response, 'data', 'authorInfo');
  const videoUrl = stringAt(feed, 'videoUrl') || stringAt(feed, 'h264VideoInfo', 'videoUrl') ||
    stringAt(feed, 'h265VideoInfo', 'videoUrl');
  return result({
    title: stringAt(feed, 'description') || '视频号',
    videoUrl: videoUrl || null,
    videoList: videoUrl ? [videoUrl] : [],
    coverUrl: stringAt(feed, 'coverUrl') || null,
    author: author(
      at(authorNode, 'nickname'), at(authorNode, 'id'), at(authorNode, 'headImgUrl'),
    ),
  });
}

registerParser('wechat_channels', {
  factory: (context) => new WechatChannelsParser(context),
  allowedHosts: ['yuanbao.tencent.com'],
});
