import { DEFAULT_MOBILE_USER_AGENT } from '../config/user-agents.js';
import { ProxyAttemptError, safeErrorDetails } from '../core/errors.js';
import type { MediaResult } from '../core/media-result.js';
import type { ParseContext } from '../core/parse-context.js';
import type { PlatformParser } from '../core/parser.js';
import { registerParser } from '../core/parser-registry.js';
import { array, at, author, id, number, record, result, string, stringAt, uniqueStrings } from './data.js';

const SHARE_RECORD_API = 'https://www.butterflyai.cn/butterfly/community/v1/share/record/get?aid=564650';

class ButterflyAiParser implements PlatformParser {
  public readonly platform = 'butterflyai' as const;
  public constructor(private readonly context: ParseContext) {}

  public async parse(): Promise<MediaResult> {
    const headers = {
      'user-agent': DEFAULT_MOBILE_USER_AGENT,
      referer: 'https://www.butterflyai.cn/',
      accept: 'application/json, text/plain, */*',
    };

    let sourceUrl = this.context.realUrl;
    let shareToken =
      sourceUrl.searchParams.get('share_code') ??
      sourceUrl.searchParams.get('share_token') ??
      '';
    let shareRecordId =
      sourceUrl.searchParams.get('share_id') ??
      sourceUrl.searchParams.get('share_record_id') ??
      '';

    if (!shareToken && /\/s\/[a-zA-Z0-9_-]+/u.test(sourceUrl.pathname)) {
      try {
        const redirectResp = await this.context.session.request(sourceUrl, {
          headers,
          followRedirect: true,
          maxBodyBytes: 1024 * 1024,
          signal: this.context.signal,
        });
        sourceUrl = redirectResp.url;
        shareToken =
          sourceUrl.searchParams.get('share_code') ??
          sourceUrl.searchParams.get('share_token') ??
          '';
        shareRecordId =
          sourceUrl.searchParams.get('share_id') ??
          sourceUrl.searchParams.get('share_record_id') ??
          '';
      } catch (error) {
        if (error instanceof ProxyAttemptError) throw error;
        this.context.logger.warn(
          {
            platform_id: this.platform,
            error_category: 'redirect_follow_failed',
            ...safeErrorDetails(error),
          },
          'failed to follow ButterflyAI short-link redirect',
        );
      }
    }

    if (!shareToken && !shareRecordId) {
      return result({});
    }

    let data: unknown;
    try {
      data = await this.context.session.getJson<unknown>(SHARE_RECORD_API, {
        method: 'POST',
        headers,
        json: {
          share_record_id: shareRecordId,
          from_h5: true,
          share_token: shareToken,
          extra_params: {
            aid: '564650',
            app_name: '星绘',
          },
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
        'failed to request ButterflyAI share record API',
      );
      return result({});
    }

    const statusInfo = record(at(data, 'status_info'));
    const statusCode = number(statusInfo.status_code ?? at(data, 'status_code'), 0);
    if (statusCode !== 0) {
      return result({});
    }

    const shareRecord = record(at(data, 'share_record'));
    const artwork = record(shareRecord.artwork);
    const creator = record(shareRecord.creator);

    let title = (
      string(artwork.title) || stringAt(shareRecord, 'show_info', 'effect_title')
    ).trim();
    if (!title) {
      const firstEffect = at(shareRecord, 'effect_list', 0);
      title = (
        stringAt(firstEffect, 'name') || stringAt(firstEffect, 'show_info', 'effect_title')
      ).trim();
    }

    const description =
      (string(artwork.description) || string(shareRecord.prompt)).trim() || null;

    const authorName =
      string(creator.screen_name) || string(creator.nickname) || string(creator.name);
    const authorId = id(creator.user_id) || id(creator.uid) || id(creator.id);
    const avatarField = creator.avatar ?? creator.avatar_url;
    const authorAvatar =
      typeof avatarField === 'string'
        ? avatarField
        : stringAt(avatarField, 'large_url') ||
          stringAt(avatarField, 'image_url') ||
          stringAt(avatarField, 'middle_url');

    const renderingVideo = record(shareRecord.rendering_video);
    let videoUrl = string(renderingVideo.video_url) || string(renderingVideo.download_url);

    const images: string[] = [];
    for (const rawResource of array(artwork.resource_list)) {
      const resource = record(rawResource);
      for (const rawVid of array(at(resource, 'video_resource', 'rendering_videos'))) {
        if (!videoUrl) {
          videoUrl = stringAt(rawVid, 'video_url') || stringAt(rawVid, 'download_url');
        }
      }
      for (const rawImg of array(at(resource, 'image_resource', 'rendering_images'))) {
        const imgUrl =
          stringAt(rawImg, 'no_wm_download_url') ||
          stringAt(rawImg, 'download_url') ||
          stringAt(rawImg, 'image_url');
        if (imgUrl) images.push(imgUrl);
      }
    }

    for (const rawImg of array(shareRecord.rendering_images)) {
      const imgUrl =
        stringAt(rawImg, 'no_wm_download_url') ||
        stringAt(rawImg, 'download_url') ||
        stringAt(rawImg, 'image_url');
      if (imgUrl) images.push(imgUrl);
    }

    const imageList = uniqueStrings(images);
    const coverUrl =
      string(artwork.cover_image_url) ||
      string(artwork.cover_url) ||
      string(renderingVideo.cover_image_url) ||
      null;

    return result({
      title,
      desc: description,
      videoUrl: videoUrl || null,
      videoList: videoUrl ? [videoUrl] : [],
      coverUrl,
      imageList,
      author: author(authorName, authorId, authorAvatar),
    });
  }
}

registerParser('butterflyai', {
  factory: (context) => new ButterflyAiParser(context),
  allowedHosts: ['www.butterflyai.cn', 'butterflyai.cn', '*.butterflyai.cn'],
});
