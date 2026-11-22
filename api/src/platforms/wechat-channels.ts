import { randomBytes } from 'node:crypto';
import type { ParseContext } from '../core/parse-context.js';
import type { TerminalErrorDetail } from '../core/media-result.js';
import type { PlatformParser } from '../core/parser.js';
import { registerParser } from '../core/parser-registry.js';
import { safeErrorDetails } from '../core/errors.js';
import {
  array,
  at,
  author,
  protocolUrl,
  result,
  stringAt,
  uniqueStrings,
} from './data.js';

const FEED_INFO_API = 'https://channels.weixin.qq.com/finder-preview/api/feed/get_feed_info';
const FEED_PAGE = 'https://channels.weixin.qq.com/finder-preview/pages/feed';
const SPH_PAGE = 'https://channels.weixin.qq.com/finder-preview/pages/sph';
const CHANNELS_USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36';

class FeedApiError extends Error {
  public constructor(
    message: string,
    public readonly terminalError: TerminalErrorDetail | null = null,
  ) {
    super(message);
    this.name = 'FeedApiError';
  }
}

class WechatChannelsParser implements PlatformParser {
  public readonly platform = 'wechat_channels' as const;
  public constructor(private readonly context: ParseContext) {}

  public async parse(): Promise<ReturnType<typeof result>> {
    const cookie = this.context.credentials.yuanbao_cookie;
    if (cookie) {
      try {
        return await this.#parseWithYuanbao(cookie);
      } catch (error) {
        if (error instanceof FeedApiError && error.terminalError) {
          return result({ terminalError: error.terminalError });
        }
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

    try {
      return await this.#parsePublic();
    } catch (error) {
      if (error instanceof FeedApiError && error.terminalError) {
        return result({ terminalError: error.terminalError });
      }
      this.context.logger.warn(
        {
          platform_id: this.platform,
          error_category: 'public_channel_failed',
          ...safeErrorDetails(error),
        },
        'wechat channels public feed failed',
      );
      return result({ cookieRequired: true });
    }
  }

  async #shortUri(): Promise<string> {
    const pathMatch = /(?:^|\/)sph\/([A-Za-z0-9]+)/u.exec(this.context.realUrl.pathname)?.[1];
    if (pathMatch) return pathMatch;
    const queryId = this.context.realUrl.searchParams.get('id');
    if (queryId) return queryId;
    const response = await this.context.session.request(this.context.realUrl, {
      headers: { 'user-agent': CHANNELS_USER_AGENT },
      followRedirect: true,
      signal: this.context.signal,
      maxBodyBytes: 1024 * 1024,
    });
    const resolved =
      response.url.searchParams.get('id') ??
      /(?:^|\/)sph\/([A-Za-z0-9]+)/u.exec(response.url.pathname)?.[1] ??
      '';
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
          accept: 'application/json, text/plain, */*',
          'content-type': 'application/json',
          origin: 'https://yuanbao.tencent.com',
          referer: 'https://yuanbao.tencent.com/chat',
          'user-agent': CHANNELS_USER_AGENT,
          cookie,
          'x-source': 'web',
        },
        json: { type: 'video_channel_url', url: this.context.realUrl.href, scene: 1 },
        signal: this.context.signal,
        timeoutMs: 20_000,
      },
    );
    const playable = stringAt(response, 'data', 'playable_url');
    if (!playable) throw new Error(stringAt(response, 'msg') || '元宝未返回可播放地址');
    const playableUrl = new URL(playable);
    const shortParam = playableUrl.searchParams.get('token');
    const exportId = playableUrl.searchParams.get('eid');
    if (!shortParam || !exportId) throw new Error('元宝响应缺少视频号临时凭证');

    const referer = new URL(FEED_PAGE);
    for (const [key, value] of Object.entries({
      entry_card_type: '48',
      comment_scene: '39',
      appid: '0',
      token: shortParam,
      entry_scene: '0',
      eid: exportId,
    })) {
      referer.searchParams.set(key, value);
    }
    const feed = await this.#feedInfo(
      { baseReq: { generalToken: shortParam }, exportId },
      referer.href,
      FEED_PAGE,
    );
    return normalizeFeed(feed);
  }

  async #feedInfo(payload: unknown, referer: string, pageUrl: string): Promise<unknown> {
    const url = new URL(FEED_INFO_API);
    url.searchParams.set('_rid', randomBytes(4).toString('hex'));
    url.searchParams.set('_pageUrl', pageUrl);
    const response = await this.context.session.getJson<unknown>(url, {
      method: 'POST',
      headers: {
        accept: 'application/json, text/plain, */*',
        'accept-language': 'zh-CN,zh;q=0.9,en;q=0.8',
        'content-type': 'application/json',
        origin: 'https://channels.weixin.qq.com',
        referer,
        'user-agent': CHANNELS_USER_AGENT,
      },
      json: payload,
      signal: this.context.signal,
      timeoutMs: 20_000,
    });
    const errorCode = at(response, 'errCode');
    if (errorCode !== 0 && errorCode !== undefined && errorCode !== null) {
      const errMsg = stringAt(response, 'errMsg') || '视频号接口返回错误';
      const isDeleted =
        errMsg.includes('删除') ||
        errMsg.includes('不存在') ||
        errMsg.includes('不可见') ||
        errMsg.includes('下架');
      throw new FeedApiError(
        errMsg,
        isDeleted ? { code: 'MEDIA_DELETED_OR_PRIVATE', message: errMsg } : null,
      );
    }
    return response;
  }
}

function normalizeFeed(response: unknown): ReturnType<typeof result> {
  const feed = at(response, 'data', 'feedInfo');
  const authorNode = at(response, 'data', 'authorInfo');

  const directVideo =
    stringAt(feed, 'videoUrl') ||
    stringAt(feed, 'h264VideoInfo', 'videoUrl') ||
    stringAt(feed, 'h265VideoInfo', 'videoUrl');

  const mediaVideos = array(at(feed, 'media'))
    .map((entry) => {
      const baseUrl = stringAt(entry, 'url');
      const urlKey = stringAt(entry, 'urlToken') || stringAt(entry, 'url_token');
      return baseUrl ? `${baseUrl}${urlKey}` : '';
    })
    .filter(Boolean);

  const videoList = uniqueStrings(
    [directVideo, ...mediaVideos].filter(Boolean).map(protocolUrl),
  );
  const videoUrl = videoList[0] ?? null;

  const picSource = array(at(feed, 'picInfo')).length > 0
    ? array(at(feed, 'picInfo'))
    : array(at(feed, 'imgList'));
  const imageList = uniqueStrings(
    picSource
      .map((item) =>
        typeof item === 'string'
          ? item
          : stringAt(item, 'url') || stringAt(item, 'imgUrl'),
      )
      .filter(Boolean)
      .map(protocolUrl),
  );

  const audioUrl = protocolUrl(
    stringAt(feed, 'bgmInfo', 'bgmUrl') || stringAt(feed, 'musicInfo', 'musicUrl'),
  ) || null;
  const coverUrl = protocolUrl(
    stringAt(feed, 'coverUrl') || stringAt(feed, 'thumbUrl') || (imageList[0] ?? ''),
  ) || null;

  const feedTitle = stringAt(feed, 'title');
  const feedDesc = stringAt(feed, 'description');

  return result({
    title: feedTitle || feedDesc || '视频号',
    desc: feedDesc || null,
    videoUrl,
    videoList,
    audioUrl,
    coverUrl,
    imageList,
    author: author(
      at(authorNode, 'nickname'),
      at(authorNode, 'id') || at(authorNode, 'username'),
      protocolUrl(stringAt(authorNode, 'headImgUrl')),
    ),
  });
}

registerParser('wechat_channels', {
  factory: (context) => new WechatChannelsParser(context),
  allowedHosts: ['yuanbao.tencent.com', 'channels.weixin.qq.com'],
});
