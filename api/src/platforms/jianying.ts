import { createHash } from 'node:crypto';
import { ProxyAttemptError, safeErrorDetails } from '../core/errors.js';
import type { MediaResult } from '../core/media-result.js';
import type { ParseContext } from '../core/parse-context.js';
import type { PlatformParser } from '../core/parser.js';
import { registerParser } from '../core/parser-registry.js';
import {
  array,
  at,
  author,
  record,
  result,
  string,
  stringAt,
  uniqueStrings,
  type JsonRecord,
} from './data.js';

const DETAIL_API = 'https://lv-api.ulikecam.com/lv/v1/web/replicate/multi_get_templates';
const CAPCUT_CLUSTER_PATH = '/lv/v1/coordination/cluster_list';
const CAPCUT_DETAIL_PATH = '/lv/v1/coordination/share_detail_query';
const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

interface JianyingTarget {
  shareType: 'capcut' | 'template';
  targetId: string;
  itemType: number;
}

class JianyingParser implements PlatformParser {
  public readonly platform = 'jianying' as const;

  public constructor(private readonly context: ParseContext) {}

  public async parse(): Promise<MediaResult> {
    const target = extractJianyingTarget(this.context.realUrl);
    if (!target.targetId) return result({});

    if (target.shareType === 'capcut') {
      return this.#parseCapcutShare(target.targetId);
    }
    return this.#parseTemplate(target.targetId, target.itemType);
  }

  async #parseCapcutShare(shareId: string): Promise<MediaResult> {
    const hostname = this.context.realUrl.hostname.toLowerCase();
    const origins = hostname.endsWith('capcut.com')
      ? ['https://www.capcut.com', 'https://www.capcut.cn']
      : ['https://www.capcut.cn', 'https://www.capcut.com'];

    for (const origin of origins) {
      const parsed = await this.#queryCapcutOrigin(origin, shareId);
      if (parsed) return parsed;
    }
    return result({});
  }

  async #queryCapcutOrigin(origin: string, shareId: string): Promise<MediaResult | null> {
    const timestamp = Math.floor(Date.now() / 1000);
    let innerShareId = shareId;

    try {
      const sign1 = buildLvSign(CAPCUT_CLUSTER_PATH, '7', timestamp);
      const clusterPayload = await this.context.session.getJson<unknown>(
        `${origin}${CAPCUT_CLUSTER_PATH}`,
        {
          method: 'POST',
          headers: {
            sign: sign1,
            'device-time': String(timestamp),
            pf: '7',
            'sign-ver': '1',
            'user-agent': USER_AGENT,
            origin,
            referer: this.context.realUrl.href,
          },
          json: { share_id: shareId, password: '' },
          timeoutMs: 12_000,
          signal: this.context.signal,
        },
      );
      const candidateId = stringAt(clusterPayload, 'data', 'share_info_list', 0, 'share_id');
      if (candidateId) innerShareId = candidateId;
    } catch (error) {
      if (error instanceof ProxyAttemptError) throw error;
      this.context.logger.debug(
        {
          platform_id: this.platform,
          error_category: 'capcut_cluster_failed',
          ...safeErrorDetails(error),
        },
        'CapCut cluster_list query failed',
      );
    }

    try {
      const sign2 = buildLvSign(CAPCUT_DETAIL_PATH, '7', timestamp);
      const detailPayload = await this.context.session.getJson<unknown>(
        `${origin}${CAPCUT_DETAIL_PATH}`,
        {
          method: 'POST',
          headers: {
            sign: sign2,
            'device-time': String(timestamp),
            pf: '7',
            'sign-ver': '1',
            'user-agent': USER_AGENT,
            origin,
            referer: this.context.realUrl.href,
          },
          json: { share_id: innerShareId },
          timeoutMs: 12_000,
          signal: this.context.signal,
        },
      );

      const data = record(at(detailPayload, 'data'));
      if (Object.keys(data).length === 0) return null;

      const videoUrl =
        pickCapcutVideoUrl(data.normal_video) || pickCapcutVideoUrl(data.video);
      if (!videoUrl) return null;

      const coverImage = record(data.cover_image);
      const coverUrl =
        string(coverImage.preview_1080p_url) ||
        string(coverImage.preview_720p_url) ||
        string(coverImage.preview_360p_url) ||
        null;

      return result({
        title: string(data.file_name) || string(data.share_name) || 'CapCut视频',
        videoUrl,
        videoList: [videoUrl],
        coverUrl,
        author: author(data.uploader_name, data.uploader_id, data.uploader_avatar),
      });
    } catch (error) {
      if (error instanceof ProxyAttemptError) throw error;
      this.context.logger.warn(
        {
          platform_id: this.platform,
          error_category: 'capcut_detail_failed',
          ...safeErrorDetails(error),
        },
        'CapCut share_detail_query failed',
      );
      return null;
    }
  }

  async #parseTemplate(templateId: string, itemType: number): Promise<MediaResult> {
    const timestamp = Math.floor(Date.now() / 1000);
    const sign = buildLvSign('/lv/v1/web/replicate/multi_get_templates', '0', timestamp);

    let payload: unknown;
    try {
      payload = await this.context.session.getJson<unknown>(DETAIL_API, {
        method: 'POST',
        headers: {
          sign,
          pf: '0',
          'sign-ver': '1',
          'device-time': String(timestamp),
          'user-agent': USER_AGENT,
          origin: 'https://lv.ulikecam.com',
          referer: 'https://lv.ulikecam.com/',
        },
        json: {
          sdk_version: '100.0.0',
          id: [templateId],
          scene: 'share',
          item_type: itemType,
        },
        signal: this.context.signal,
      });
    } catch (error) {
      if (error instanceof ProxyAttemptError) throw error;
      this.context.logger.warn(
        {
          platform_id: this.platform,
          error_category: 'jianying_template_failed',
          ...safeErrorDetails(error),
        },
        'failed to fetch Jianying template',
      );
      return result({});
    }

    const template = record(at(payload, 'data', 'templates', 0));
    if (Object.keys(template).length === 0) return result({});

    const previewUrl = string(template.video_url);
    const resolvedVideoUrl = previewUrl
      ? await this.#resolveUnwatermarkedUrl(previewUrl)
      : '';
    const videoUrl = resolvedVideoUrl || null;
    const authorNode = record(template.author);
    const aweme = record(authorNode.aweme_info);

    return result({
      title: string(template.title) || string(template.short_title) || '剪映模板',
      videoUrl,
      videoList: videoUrl ? [videoUrl] : [],
      audioUrl: stringAt(template, 'music_info', 'play_url') || null,
      coverUrl: string(template.cover_url) || string(template.cover) || null,
      imageList: uniqueStrings(array(template.images).map((value) => string(value))),
      author: author(
        authorNode.name || authorNode.nickname || aweme.name,
        authorNode.uid || authorNode.id || aweme.uid,
        authorNode.avatar || authorNode.avatar_url || aweme.avatar_url,
      ),
    });
  }

  async #resolveUnwatermarkedUrl(previewUrl: string): Promise<string> {
    if (!previewUrl) return '';
    try {
      const rangeResp = await this.context.session.request(previewUrl, {
        method: 'GET',
        headers: {
          range: 'bytes=0-131072',
          'user-agent': USER_AGENT,
        },
        maxBodyBytes: 262_144,
        timeoutMs: 5_000,
        signal: this.context.signal,
      });
      const headerText = rangeResp.body.toString('latin1');
      const vidMatch = /vid:(v[0-9a-zA-Z]+)/u.exec(headerText);
      const vid = vidMatch?.[1] ?? '';
      if (!vid) return previewUrl;

      const iesUrl =
        `https://www.iesdouyin.com/aweme/v1/play/` +
        `?video_id=${encodeURIComponent(vid)}&ratio=default&line=0` +
        `&is_play_url=1&watermark=0&source=PackSourceEnum_PUBLISH`;

      const headResp = await this.context.session.request(iesUrl, {
        method: 'HEAD',
        headers: { 'user-agent': USER_AGENT },
        followRedirect: false,
        discardBody: true,
        timeoutMs: 5_000,
        signal: this.context.signal,
      });
      const rawLocation = headResp.headers.location;
      const location = Array.isArray(rawLocation) ? rawLocation[0] : rawLocation;
      if ((headResp.statusCode === 301 || headResp.statusCode === 302) && location) {
        return location;
      }
      return iesUrl;
    } catch (error) {
      if (error instanceof ProxyAttemptError) throw error;
      this.context.logger.debug(
        {
          platform_id: this.platform,
          error_category: 'jianying_unwatermark_fallback',
          ...safeErrorDetails(error),
        },
        'falling back to Jianying preview video URL',
      );
      return previewUrl;
    }
  }
}

function extractJianyingTarget(url: URL): JianyingTarget {
  const pathname = url.pathname;
  const hostname = url.hostname.toLowerCase();
  const shareMatch = /\/share\/(\d+)/u.exec(pathname);
  if (shareMatch?.[1]) {
    return { shareType: 'capcut', targetId: shareMatch[1], itemType: 0 };
  }

  const templateId = url.searchParams.get('template_id') ?? '';
  if (!templateId && hostname.includes('capcut')) {
    return { shareType: 'capcut', targetId: '', itemType: 0 };
  }

  const rawItemType = url.searchParams.get('item_type') ?? '0';
  const itemType = /^\d+$/u.test(rawItemType) ? Number(rawItemType) : 0;
  return { shareType: 'template', targetId: templateId, itemType };
}

function pickCapcutVideoUrl(source: unknown): string {
  const mapped: JsonRecord = record(source);
  for (const key of ['player_1080p', 'player_720p', 'player_480p', 'player_360p']) {
    const candidate = stringAt(mapped, key, 'main_url');
    if (candidate) return candidate;
  }
  return '';
}

function buildLvSign(apiPath: string, pf: string, timestamp: number): string {
  const tail = apiPath.slice(-7);
  return createHash('md5')
    .update(`9e2c|${tail}|${pf}||${timestamp}||11ac`, 'utf8')
    .digest('hex')
    .toLowerCase();
}

registerParser('jianying', {
  factory: (context) => new JianyingParser(context),
  allowedHosts: [
    'lv-api.ulikecam.com',
    '*.ulikecam.com',
    'www.capcut.cn',
    'capcut.cn',
    'www.capcut.com',
    'capcut.com',
    '*.capcut.cn',
    '*.capcut.com',
    'www.iesdouyin.com',
    'iesdouyin.com',
    'aweme.snssdk.com',
    '*.jianying.com',
    '*.douyinvod.com',
    '*.bytevcloudcdn.com',
    '*.zjcdn.com',
    '*.snssdk.com',
    '*.pstatp.com',
    '*.bytecdn.cn',
    '*.bytedance.com',
    '*.ibytedtos.com',
    '*.capcutvod.com',
    '*.vlabvod.com',
  ],
});
