import { createHash, randomInt } from 'node:crypto';
import { DEFAULT_MOBILE_USER_AGENT } from '../config/user-agents.js';
import { ProxyAttemptError, safeErrorDetails } from '../core/errors.js';
import type { MediaResult } from '../core/media-result.js';
import type { ParseContext } from '../core/parse-context.js';
import type { PlatformParser } from '../core/parser.js';
import { registerParser } from '../core/parser-registry.js';
import { array, at, author, record, result, string } from './data.js';

const DETAIL_API = 'https://api.kmovie.gifshow.com/rest/n/kmovie/app/resource/getTemplateById';
const SIGN_KEY = 'yiuhjkbvhbjisjchgdnx38uejd';

export interface KwaiyingSignParams {
  timestamp: number;
  nonce: number;
  sign: string;
}

class KwaiyingParser implements PlatformParser {
  public readonly platform = 'kwaiying' as const;
  public constructor(private readonly context: ParseContext) {}

  public async parse(): Promise<MediaResult> {
    const templateId = extractKwaiyingTemplateId(this.context.realUrl);
    if (!templateId) return result({});

    const signParams = generateKwaiyingSignParams();
    let resJson: unknown;
    try {
      resJson = await this.context.session.getJson<unknown>(DETAIL_API, {
        headers: {
          'user-agent': DEFAULT_MOBILE_USER_AGENT,
          origin: 'https://share.kwaiying.com',
          referer: this.context.realUrl.href,
        },
        searchParams: {
          timestamp: signParams.timestamp,
          nonce: signParams.nonce,
          sign: signParams.sign,
          templateId,
        },
        signal: this.context.signal,
      });
    } catch (error) {
      if (error instanceof ProxyAttemptError) throw error;
      this.context.logger.warn(
        {
          platform_id: this.platform,
          error_category: 'upstream_api_failed',
          ...safeErrorDetails(error),
        },
        'failed to fetch Kwaiying template',
      );
      return result({});
    }

    if (at(resJson, 'result') !== 1) return result({});
    const resource = record(at(resJson, 'resource'));
    if (Object.keys(resource).length === 0) return result({});

    const videoUrl = string(resource.videoUrl) || null;
    const title = string(resource.name);
    const templateBean = record(resource.templateBean);
    const description = string(templateBean.description) || null;
    const coverUrl =
      string(templateBean.coverUrl) || string(templateBean.coverWebPUrl) || null;

    const user = record(resource.user);
    const avatar = string(array(user.iconUrlList)[0]);
    const music = record(resource.music);
    const audioUrl = string(music.url) || string(music.playUrl) || null;

    return result({
      title,
      desc: description,
      videoUrl,
      videoList: videoUrl ? [videoUrl] : [],
      coverUrl,
      audioUrl,
      author: author(
        user.nickName,
        user.userId || user.ksUserId,
        avatar,
      ),
    });
  }
}

export function extractKwaiyingTemplateId(url: URL): string {
  const fromQuery =
    url.searchParams.get('id') ??
    url.searchParams.get('templateId') ??
    url.searchParams.get('template_id') ??
    '';
  if (fromQuery) return fromQuery;
  const fallback = /[?&#](?:id|templateId|template_id)=(\d+)/u.exec(url.href);
  return fallback?.[1] ?? '';
}

export function generateKwaiyingSignParams(
  nowMs = Date.now(),
  nonce = randomInt(100_000_000_000, 1_000_000_000_000),
): KwaiyingSignParams {
  let hexStr = '';
  for (let index = 0; index < SIGN_KEY.length; index += 1) {
    hexStr += SIGN_KEY.charCodeAt(index).toString(16);
  }
  const digitsOnly = hexStr.replace(/[a-fA-F]/gu, '').slice(0, 16);
  const keyInt = digitsOnly ? BigInt(digitsOnly) : 0n;
  const s = (keyInt ^ BigInt(nowMs)) | keyInt;
  const sign = createHash('md5')
    .update((BigInt(nonce) ^ s).toString(), 'utf8')
    .digest('hex');
  return {
    timestamp: nowMs,
    nonce,
    sign,
  };
}

registerParser('kwaiying', {
  factory: (context) => new KwaiyingParser(context),
  allowedHosts: ['api.kmovie.gifshow.com'],
});
