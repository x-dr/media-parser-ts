import { randomBytes } from 'node:crypto';
import { DEFAULT_MOBILE_USER_AGENT } from '../config/user-agents.js';
import { ProxyAttemptError, UpstreamError, safeErrorDetails } from '../core/errors.js';
import type { AuthorInfo, MediaResult, TerminalErrorDetail } from '../core/media-result.js';
import type { ParseContext } from '../core/parse-context.js';
import type { PlatformParser } from '../core/parser.js';
import { registerParser } from '../core/parser-registry.js';
import {
  LocalPinduoduoSigner,
  type PinduoduoSigner,
} from '../signers/pinduoduo/signer.js';
import {
  array,
  at,
  author,
  extractAssignedJson,
  number,
  protocolUrl,
  record,
  result,
  string,
  stringAt,
  uniqueStrings,
} from './data.js';

const DSP_DETAIL_ENDPOINTS = [
  'https://mobile.yangkeduo.com/proxy/api/api/hub/dsp_detail/weak/list/get',
  'https://api.pinduoduo.com/api/hub/dsp_detail/weak/list/get',
] as const;

const AUTH_ERROR_CODES = new Set([40001, 40002, 54001]);
const DELETED_ERROR_CODES = new Set([40004, 40401, 40404]);
const LIST_ID_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';

let sharedDefaultSigner: PinduoduoSigner | null = null;

function getDefaultPinduoduoSigner(): PinduoduoSigner {
  sharedDefaultSigner ??= new LocalPinduoduoSigner();
  return sharedDefaultSigner;
}

export interface PinduoduoParserOptions {
  signer?: PinduoduoSigner;
}

interface MutableParsedState {
  title: string;
  videoUrl: string;
  coverUrl: string;
  imageList: string[];
  audioUrl: string;
  author: AuthorInfo | null;
  cookieRequired: boolean;
  terminalError: TerminalErrorDetail | null;
}

export class PinduoduoParser implements PlatformParser {
  public readonly platform = 'pinduoduo' as const;
  readonly #signerOption: PinduoduoSigner | undefined;

  public constructor(
    private readonly context: ParseContext,
    options: PinduoduoParserOptions = {},
  ) {
    this.#signerOption = options.signer;
  }

  public async parse(): Promise<MediaResult> {
    const params = this.context.realUrl.searchParams;
    const feedId = (params.get('feed_id') ?? '').trim();
    const goodsId = (params.get('goods_id') ?? '').trim();
    const reviewId = (params.get('review_id') ?? '').trim();
    const ps = (params.get('ps') ?? '').trim();
    const oakShareUrl = decodeOakShareUrl(params.get('_oak_share_url') ?? '');

    const state: MutableParsedState = {
      title: '',
      videoUrl: '',
      coverUrl: '',
      imageList: [],
      audioUrl: '',
      author: null,
      cookieRequired: false,
      terminalError: null,
    };

    if (oakShareUrl) {
      state.imageList.push(oakShareUrl);
      state.coverUrl = oakShareUrl;
      if (goodsId) {
        state.title = formatGoodsFallbackTitle(goodsId, reviewId);
      }
    }

    if (feedId) {
      await this.#parseDuoduoVideo(feedId, state);
    }

    if (!state.videoUrl && state.imageList.length === 0) {
      await this.#parseGoodsDetail(state);
    }

    if (!state.title) {
      if (goodsId) {
        state.title = formatGoodsFallbackTitle(goodsId, reviewId);
      } else if (feedId) {
        state.title = `多多视频 (FeedID: ${feedId})`;
      } else if (ps) {
        state.title = `拼多多分享 (短链: ${ps})`;
      }
    }

    const images = uniqueStrings(state.imageList);
    const hasExtractedMedia = Boolean(state.videoUrl) || images.length > 0 || Boolean(state.audioUrl);

    let cookieRequired = false;
    let terminalError: TerminalErrorDetail | null = null;
    if (!hasExtractedMedia) {
      if (state.terminalError) {
        terminalError = state.terminalError;
      } else if (state.cookieRequired || Boolean(feedId || goodsId || ps)) {
        cookieRequired = true;
      } else {
        terminalError = {
          code: 'MEDIA_NOT_FOUND',
          message: '未能从拼多多链接中提取到有效媒体内容',
        };
      }
    }

    return result({
      title: state.title,
      videoUrl: state.videoUrl || null,
      videoList: state.videoUrl ? [state.videoUrl] : [],
      audioUrl: state.audioUrl || null,
      coverUrl: state.coverUrl || null,
      author: state.author,
      imageList: images,
      ...(cookieRequired ? { cookieRequired: true } : {}),
      ...(terminalError ? { terminalError } : {}),
    });
  }

  async #parseDuoduoVideo(feedId: string, state: MutableParsedState): Promise<void> {
    const signer = this.#signerOption ?? getDefaultPinduoduoSigner();
    const antiContent = signer.getAntiContent();
    const cookie = this.context.credentials.cookie;

    const payload = {
      base: {
        scene_id: '55',
        mode: 0,
        direction: 0,
        list_id: randomListId(10),
        ext: JSON.stringify({
          feed_id_list: [feedId],
          page_from: '602100',
          load_author: true,
          load_data: true,
          url: this.context.realUrl.href,
        }),
      },
      anti_content: antiContent,
    };

    const headers: Record<string, string> = {
      'content-type': 'application/json;charset=UTF-8',
      'user-agent': DEFAULT_MOBILE_USER_AGENT,
      referer: this.context.realUrl.href,
      origin: 'https://mobile.yangkeduo.com',
      'anti-content': antiContent,
      ...(cookie ? { cookie } : {}),
    };

    for (const endpoint of DSP_DETAIL_ENDPOINTS) {
      try {
        const data = await this.context.session.getJson<unknown>(endpoint, {
          method: 'POST',
          json: payload,
          headers,
          signal: this.context.signal,
          timeoutMs: 10_000,
        });

        const errorCode = number(at(data, 'error_code'));
        const httpCode = number(at(data, 'http_code'));
        if (
          AUTH_ERROR_CODES.has(errorCode) ||
          httpCode === 401 ||
          httpCode === 403 ||
          httpCode === 424
        ) {
          state.cookieRequired = true;
          continue;
        }
        if (DELETED_ERROR_CODES.has(errorCode)) {
          state.terminalError = {
            code: 'MEDIA_DELETED_OR_PRIVATE',
            message: '该多多视频已删除或不可见',
          };
          return;
        }

        const feeds = array(at(data, 'result', 'feeds'));
        if (feeds.length === 0) continue;

        const feedData = at(feeds[0], 'data');
        const extractedTitle = (
          stringAt(feedData, 'feedTitle') ||
          stringAt(feedData, 'title') ||
          stringAt(feedData, 'feedDesc') ||
          stringAt(feedData, 'desc') ||
          stringAt(feedData, 'goods_v2', 'goods_info', 'goods_name')
        ).trim();
        if (extractedTitle) {
          state.title = extractedTitle;
        }

        for (const media of array(at(feedData, 'feedMedia'))) {
          const mediaType = number(at(media, 'mediaType'));
          const mediaUrl = cleanUrl(stringAt(media, 'url') || stringAt(media, 'playUrl'));
          if (mediaType === 1 && mediaUrl && !state.videoUrl) {
            state.videoUrl = mediaUrl;
          } else if (mediaType === 2 && mediaUrl && !state.coverUrl) {
            state.coverUrl = mediaUrl;
          }
        }

        if (!state.videoUrl) {
          state.videoUrl = cleanUrl(
            stringAt(feedData, 'h5_auto_play_url') ||
            stringAt(feedData, 'native_auto_play_url') ||
            stringAt(feedData, 'playUrl') ||
            stringAt(feedData, 'linkUrl'),
          );
        }
        if (!state.coverUrl) {
          state.coverUrl = cleanUrl(
            stringAt(feedData, 'cover') ||
            stringAt(feedData, 'blur_cover') ||
            stringAt(feedData, 'thumbUrl'),
          );
        }

        const rawAuthorInfo = record(at(feedData, 'author_info'));
        const authorNode = Object.keys(rawAuthorInfo).length > 0
          ? rawAuthorInfo
          : at(feedData, 'authorInfo');
        state.author = author(
          at(authorNode, 'authorName') || at(authorNode, 'nickname'),
          at(authorNode, 'authorId') || at(authorNode, 'mallId') || at(authorNode, 'room_id'),
          cleanUrl(stringAt(authorNode, 'avatar')),
        );
        return;
      } catch (error) {
        if (error instanceof ProxyAttemptError) throw error;
        if (
          error instanceof UpstreamError &&
          (error.statusCode === 401 || error.statusCode === 403 || error.statusCode === 424)
        ) {
          state.cookieRequired = true;
          this.context.logger.warn(
            {
              platform_id: this.platform,
              error_category: 'auth_required',
              status_code: error.statusCode,
              upstream_endpoint: endpoint,
            },
            'pinduoduo dsp_detail endpoint requires authentication',
          );
          continue;
        }
        this.context.logger.warn(
          {
            platform_id: this.platform,
            error_category: 'dsp_detail_failed',
            upstream_endpoint: endpoint,
            ...safeErrorDetails(error),
          },
          'pinduoduo dsp_detail request failed',
        );
      }
    }
  }

  async #parseGoodsDetail(state: MutableParsedState): Promise<void> {
    const cookie = this.context.credentials.cookie;
    let html: string;
    try {
      html = await this.context.session.getText(this.context.realUrl, {
        headers: {
          'user-agent': DEFAULT_MOBILE_USER_AGENT,
          referer: 'https://mobile.yangkeduo.com/',
          accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          ...(cookie ? { cookie } : {}),
        },
        signal: this.context.signal,
      });
    } catch (error) {
      if (error instanceof ProxyAttemptError) throw error;
      if (
        error instanceof UpstreamError &&
        (error.statusCode === 401 || error.statusCode === 403 || error.statusCode === 424)
      ) {
        state.cookieRequired = true;
      }
      this.context.logger.debug(
        {
          platform_id: this.platform,
          error_category: 'goods_html_failed',
          ...safeErrorDetails(error),
        },
        'pinduoduo goods HTML request failed',
      );
      return;
    }

    if (!html) return;
    if (isLoginOrRiskHtml(html)) {
      state.cookieRequired = true;
    }

    const rawData = extractAssignedJson(html, 'window.rawData');
    const initData = record(at(rawData, 'store', 'initDataObj'));
    const goodsNode = Object.keys(initData).length > 0
      ? at(initData, 'goods')
      : at(rawData, 'initDataObj', 'goods');
    const goods = record(goodsNode);
    if (Object.keys(goods).length === 0) return;

    const goodsName = string(goods.goods_name).trim();
    if (!state.title && goodsName) {
      state.title = goodsName;
    }

    const bannerCandidates = [goods.banner, goods.gallery, goods.top_gallery];
    const banner = bannerCandidates.find((candidate) => array(candidate).length > 0) ?? [];
    for (const item of array(banner)) {
      const imgUrl = cleanUrl(typeof item === 'string' ? item : stringAt(item, 'url'));
      if (imgUrl && !state.imageList.includes(imgUrl)) {
        state.imageList.push(imgUrl);
      }
    }

    const video = goods.video;
    if (typeof video === 'string') {
      const url = cleanUrl(video);
      if (url) state.videoUrl = url;
    } else if (video && typeof video === 'object') {
      const url = cleanUrl(stringAt(video, 'url') || stringAt(video, 'play_url'));
      if (url) state.videoUrl = url;
    }
    if (!state.videoUrl) {
      const galleryVideo = cleanUrl(
        stringAt(goods, 'video_gallery', 0, 'url') ||
        stringAt(goods, 'video_gallery', 0, 'video_url'),
      );
      if (galleryVideo) state.videoUrl = galleryVideo;
    }

    if (!state.coverUrl) {
      state.coverUrl = cleanUrl(string(goods.hd_thumb_url) || string(goods.thumb_url));
    }
  }
}

function formatGoodsFallbackTitle(goodsId: string, reviewId: string): string {
  return reviewId
    ? `拼多多评价分享 (商品ID: ${goodsId}, 评价ID: ${reviewId})`
    : `拼多多商品 (商品ID: ${goodsId})`;
}

function decodeOakShareUrl(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return '';
  if (trimmed.startsWith('http://') || trimmed.startsWith('https://')) {
    return trimmed;
  }
  try {
    return cleanUrl(decodeURIComponent(trimmed));
  } catch {
    return cleanUrl(trimmed);
  }
}

function cleanUrl(raw: string): string {
  return protocolUrl(raw.trim());
}

function randomListId(length: number): string {
  const bytes = randomBytes(length);
  let output = '';
  for (const byte of bytes) {
    output += LIST_ID_ALPHABET[byte % LIST_ID_ALPHABET.length] ?? 'a';
  }
  return output;
}

function isLoginOrRiskHtml(html: string): boolean {
  const lower = html.toLowerCase();
  return (
    lower.includes('login.html') ||
    lower.includes('psnl_verification') ||
    lower.includes('verify_auth_token')
  );
}

registerParser('pinduoduo', {
  factory: (context) => new PinduoduoParser(context),
  allowedHosts: [
    'api.pinduoduo.com',
    'mobile.yangkeduo.com',
    '*.yangkeduo.com',
    '*.pinduoduo.com',
  ],
});
