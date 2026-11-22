import { load } from 'cheerio';
import { DEFAULT_MOBILE_USER_AGENT } from '../config/user-agents.js';
import { ProxyAttemptError, safeErrorDetails } from '../core/errors.js';
import type { AuthorInfo, MediaResult } from '../core/media-result.js';
import type { ParseContext } from '../core/parse-context.js';
import type { PlatformParser } from '../core/parser.js';
import { registerParser } from '../core/parser-registry.js';
import {
  array,
  at,
  author,
  id,
  parseJson,
  record,
  result,
  string,
  unescapeHtml,
  uniqueStrings,
  type JsonRecord,
} from './data.js';

const GENERAL_SHARE_DETAIL_API = 'https://yb.tencent.com/api/share/general_share_detail';
const IGNORED_MEDIA_TOKENS = ['avatar', 'icon', 'logo', 'target'] as const;

interface MutableYuanbaoState {
  title: string;
  coverUrl: string;
  videoList: string[];
  imageList: string[];
  author: AuthorInfo | null;
  hasConversation: boolean;
}

class YuanbaoParser implements PlatformParser {
  public readonly platform = 'yuanbao' as const;
  public constructor(private readonly context: ParseContext) {}

  public async parse(): Promise<MediaResult> {
    const cookie = this.context.credentials.cookie;
    let pageHtml: string;
    try {
      pageHtml = await this.context.session.getText(this.context.realUrl, {
        headers: {
          'user-agent': DEFAULT_MOBILE_USER_AGENT,
          accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          ...(cookie ? { cookie } : {}),
        },
        followRedirect: true,
        signal: this.context.signal,
      });
    } catch (error) {
      if (error instanceof ProxyAttemptError) throw error;
      this.context.logger.warn(
        {
          platform_id: this.platform,
          error_category: 'upstream_fetch_failed',
          ...safeErrorDetails(error),
        },
        'failed to fetch Yuanbao share page',
      );
      return result({});
    }

    if (!pageHtml.trim()) return result({});

    const $ = load(pageHtml);
    const payload = loadNextData($);
    const pageProps = record(at(payload, 'props', 'pageProps'));

    if (pageProps.isShareDel === true) {
      return result({
        terminalError: {
          code: 'MEDIA_DELETED_OR_PRIVATE',
          message: '该分享内容已被删除或不存在',
        },
      });
    }

    const state: MutableYuanbaoState = {
      title: '',
      coverUrl: '',
      videoList: [],
      imageList: [],
      author: null,
      hasConversation: false,
    };

    const rawFullShare = pageProps.fullChatShareData;
    const hasFullShare = isNonEmptyObject(rawFullShare);
    if (hasFullShare) {
      parseChatShare(record(rawFullShare), state);
    }

    const rawDetail = pageProps.shareDetailData;
    const hasShareDetail = isNonEmptyObject(rawDetail);
    if (hasShareDetail) {
      parseShareDetail(record(rawDetail), state);
    }

    if (!hasFullShare && !hasShareDetail) {
      collectDirectMedia(pageProps, state, 0);
    }

    if (state.videoList.length === 0 && state.imageList.length === 0) {
      const standalone = await this.#fetchStandaloneShareDetail(pageProps, cookie);
      if (isNonEmptyObject(standalone)) {
        parseShareDetail(record(standalone), state);
      }
    }

    if (!state.title) {
      const docTitle = $('title').first().text().trim();
      if (docTitle) state.title = docTitle;
    }

    const videoList = uniqueStrings(state.videoList);
    const imageList = uniqueStrings(state.imageList);
    const noMediaInContent =
      videoList.length === 0 &&
      imageList.length === 0 &&
      (state.hasConversation || Boolean(state.title));

    return result({
      title: state.title,
      videoUrl: videoList[0] ?? null,
      videoList,
      coverUrl: state.coverUrl || null,
      imageList,
      author: state.author,
      ...(noMediaInContent ? { noMediaInContent: true } : {}),
    });
  }

  async #fetchStandaloneShareDetail(
    pageProps: JsonRecord,
    cookie: string | undefined,
  ): Promise<unknown> {
    const pathname = this.context.realUrl.pathname;
    if (!pathname.includes('/bot/app/share/')) return {};

    const shareId =
      string(pageProps.shareId) ||
      (pathname.replace(/\/+$/u, '').split('/').filter(Boolean).at(-1) ?? '');
    const userId = this.context.realUrl.searchParams.get('userId') ?? '';
    if (!shareId) return {};

    try {
      const payload = await this.context.session.getJson<unknown>(GENERAL_SHARE_DETAIL_API, {
        method: 'POST',
        headers: {
          'user-agent': DEFAULT_MOBILE_USER_AGENT,
          accept: 'application/json, text/plain, */*',
          'content-type': 'application/json',
          origin: 'https://yb.tencent.com',
          referer: this.context.realUrl.href,
          'x-requested-with': 'XMLHttpRequest',
          'x-source': 'web',
          'x-verify-flag': '1',
          ...(cookie ? { cookie } : {}),
        },
        json: {
          shareType: 'videoWeb',
          shareId,
          userId,
        },
        signal: this.context.signal,
      });
      const obj = record(payload);
      return Object.keys(obj).length > 0 && !obj.error ? obj : {};
    } catch (error) {
      if (error instanceof ProxyAttemptError) throw error;
      this.context.logger.debug(
        {
          platform_id: this.platform,
          error_category: 'standalone_share_detail_failed',
          ...safeErrorDetails(error),
        },
        'Yuanbao standalone share API failed',
      );
      return {};
    }
  }
}

function loadNextData($: ReturnType<typeof load>): JsonRecord {
  const raw = $('script#__NEXT_DATA__').first().html() ?? $('script#__NEXT_DATA__').first().text();
  if (!raw.trim()) return {};
  try {
    return record(parseJson(raw));
  } catch {
    return {};
  }
}

function parseChatShare(payload: JsonRecord, state: MutableYuanbaoState): void {
  const chat = record(payload.chat);
  const card = record(chat.shareCardInfo);
  const conversations = array(chat.convs);
  if (conversations.length > 0 || Object.keys(chat).length > 0) {
    state.hasConversation = true;
  }

  state.title = cleanTitle(card.title);
  state.author = extractAuthor(chat, conversations);

  for (const rawConv of conversations) {
    const conv = record(rawConv);
    if (string(conv.speaker) !== 'ai') continue;
    for (const rawSpeech of array(conv.speechesV2)) {
      const speech = record(rawSpeech);
      const extra = record(speech.extra);
      for (const rawReplace of array(extra.replaces)) {
        const replace = record(rawReplace);
        for (const rawMedia of array(replace.multimedias)) {
          collectMultimedia(record(rawMedia), state);
        }
      }
    }
  }

  if (!state.title) {
    state.title = findPrompt(conversations);
  }

  const cardMediaType = string(card.imageFrom).toLowerCase();
  const cardImage = firstValidUrl([card.coverUrl, card.imageUrl]);
  if (cardImage) {
    if (cardMediaType.includes('video')) {
      state.coverUrl ||= cardImage;
    } else if (state.imageList.length === 0) {
      state.imageList.push(cardImage);
      state.coverUrl ||= cardImage;
    }
  }
}

function collectMultimedia(media: JsonRecord, state: MutableYuanbaoState): void {
  if (Object.keys(media).length === 0) return;

  const mediaType = ['type', 'mediaType', 'mimeType', 'display']
    .map((key) => string(media[key]).toLowerCase())
    .join(' ');
  const isVideo = mediaType.includes('video');
  const isImage = mediaType.includes('image') || !isVideo;

  const primary = firstValidUrl([
    media.downloadUrl,
    media.url,
    media.resourceUrl,
    media.playUrl,
    media.videoUrl,
  ]);
  if (isVideo && primary) {
    state.videoList.push(primary);
  } else if (isImage && primary) {
    state.imageList.push(primary);
  }

  const cover = firstValidUrl([
    media.downloadCoverUrl,
    media.cover,
    media.coverUrl,
    media.thumbnailUrl,
    media.previewUrl,
  ]);
  if (cover && (isVideo || !state.coverUrl)) {
    state.coverUrl = cover;
  }
}

function parseShareDetail(detail: JsonRecord, state: MutableYuanbaoState): void {
  if (Object.keys(detail).length === 0) return;
  const candidateTitle = cleanTitle(detail.title || detail.prompt);
  if (candidateTitle) {
    state.hasConversation = true;
    state.title ||= candidateTitle;
  }

  let extra: unknown = detail.extra;
  if (typeof extra === 'string' && extra.trim()) {
    try {
      extra = parseJson(extra);
    } catch {
      extra = {};
    }
  }
  if (isNonEmptyObject(extra)) {
    collectDirectMedia(extra, state, 0);
  }
  collectDirectMedia(detail, state, 0);

  if (!state.author) {
    state.author = authorFromDict(record(detail.userInfo ?? detail.author));
  }
}

function collectDirectMedia(data: unknown, state: MutableYuanbaoState, depth: number): void {
  if (depth > 20 || data === null || data === undefined) return;
  if (Array.isArray(data)) {
    for (const item of data) {
      collectDirectMedia(item, state, depth + 1);
    }
    return;
  }
  if (typeof data !== 'object') return;

  for (const [key, value] of Object.entries(record(data))) {
    const keyLower = key.toLowerCase();
    if (typeof value === 'string') {
      const url = validUrl(value);
      if (!url) continue;
      if (IGNORED_MEDIA_TOKENS.some((token) => keyLower.includes(token))) continue;
      if (keyLower.includes('video') || keyLower.includes('playurl')) {
        state.videoList.push(url);
      } else if (
        keyLower.includes('cover') ||
        keyLower.includes('poster') ||
        keyLower.includes('thumbnail')
      ) {
        state.coverUrl ||= url;
      } else if (
        keyLower === 'downloadurl' ||
        keyLower === 'imageurl' ||
        keyLower === 'image_url'
      ) {
        state.imageList.push(url);
      }
    } else if (value !== null && typeof value === 'object') {
      collectDirectMedia(value, state, depth + 1);
    }
  }
}

function extractAuthor(chat: JsonRecord, conversations: readonly unknown[]): AuthorInfo | null {
  const baseAuthor = authorFromDict(record(chat.userInfo));
  for (const rawConv of conversations) {
    const conv = record(rawConv);
    if (string(conv.speaker) !== 'human') continue;
    const candidate = authorFromDict(record(conv.role));
    if (candidate) {
      const convUserId = id(conv.userId);
      const mergedCandidate: AuthorInfo = {
        nickname: candidate.nickname,
        authorId: candidate.authorId || convUserId,
        avatar: candidate.avatar,
      };
      if (!baseAuthor) return mergedCandidate;
      return {
        nickname: baseAuthor.nickname || mergedCandidate.nickname,
        authorId: baseAuthor.authorId || mergedCandidate.authorId,
        avatar: baseAuthor.avatar || mergedCandidate.avatar,
      };
    }
  }
  return baseAuthor;
}

function authorFromDict(data: JsonRecord): AuthorInfo | null {
  if (Object.keys(data).length === 0) return null;
  return author(
    data.name || data.nickname || data.nick,
    data.userId || data.id || data.uid,
    data.imageUrl || data.avatar || data.avatarUrl,
  );
}

function findPrompt(conversations: readonly unknown[]): string {
  for (const rawConv of conversations) {
    const conv = record(rawConv);
    if (string(conv.speaker) !== 'human') continue;
    const prompt = string(conv.displayPrompt) || string(conv.speech);
    if (prompt.trim()) return cleanTitle(prompt);
  }
  return '腾讯元宝分享';
}

function cleanTitle(value: unknown): string {
  if (typeof value !== 'string') return '';
  return unescapeHtml(value).trim().replace(/^\[(?:图片|视频)\]\s*/u, '');
}

function validUrl(value: unknown): string {
  if (typeof value !== 'string') return '';
  if (!value.startsWith('http://') && !value.startsWith('https://')) return '';
  return unescapeHtml(value).replaceAll('\\u0026', '&');
}

function firstValidUrl(values: readonly unknown[]): string {
  for (const value of values) {
    const url = validUrl(value);
    if (url) return url;
  }
  return '';
}

function isNonEmptyObject(value: unknown): boolean {
  return value !== null && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length > 0;
}

registerParser('yuanbao', {
  factory: (context) => new YuanbaoParser(context),
  allowedHosts: ['yb.tencent.com', 'yuanbao.tencent.com'],
});
