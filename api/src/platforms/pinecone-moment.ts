import { DEFAULT_MOBILE_USER_AGENT } from '../config/user-agents.js';
import { ProxyAttemptError, safeErrorDetails } from '../core/errors.js';
import type { MediaResult } from '../core/media-result.js';
import type { ParseContext } from '../core/parse-context.js';
import type { PlatformParser } from '../core/parser.js';
import { registerParser } from '../core/parser-registry.js';
import { array, at, author, record, result, string, stringAt, uniqueStrings } from './data.js';

const DETAIL_API_URL = 'https://m.pineconemoment.com/share/item/detail';
const OPTIONAL_QUERY_KEYS = [
  'sharer_id',
  'author_id',
  'channel',
  'version',
  'style_id',
  'share_id',
] as const;

class PineconeMomentParser implements PlatformParser {
  public readonly platform = 'pinecone_moment' as const;
  public constructor(private readonly context: ParseContext) {}

  public async parse(): Promise<MediaResult> {
    const params = extractPineconeParams(this.context.realUrl);
    if (!params) return result({});

    let payload: unknown;
    try {
      payload = await this.context.session.getJson<unknown>(DETAIL_API_URL, {
        searchParams: params,
        headers: {
          'user-agent': DEFAULT_MOBILE_USER_AGENT,
          referer: 'https://m.pineconemoment.com/',
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
        'failed to fetch Pinecone Moment detail',
      );
      return result({});
    }

    const code = at(payload, 'code');
    if (code !== 0 && code !== 200) return result({});

    const data = record(at(payload, 'data'));
    const storyCandidate = record(data.story);
    const story =
      Object.keys(storyCandidate).length > 0 ? storyCandidate : record(data.interactive_comic);
    if (Object.keys(story).length === 0) return result({});

    const title = string(story.title);
    const creatorCandidate = record(story.creator);
    const creator =
      Object.keys(creatorCandidate).length > 0 ? creatorCandidate : record(story.sharer);

    const images = array(story.images);
    const imageList = uniqueStrings(
      images.map((item) => validHttpUrl(stringAt(item, 'url'))),
    );
    const videoList = uniqueStrings(
      images.map((item) => validHttpUrl(stringAt(item, 'video_url'))),
    );

    const firstImage = record(images[0]);
    const coverUrl =
      validHttpUrl(string(firstImage.video_cover_url)) ||
      validHttpUrl(string(firstImage.url)) ||
      validHttpUrl(string(story.cover_uri)) ||
      null;

    const audioUrl = validHttpUrl(stringAt(story, 'dubbing', 'h5_audio', 'audio_url')) || null;

    return result({
      title,
      videoUrl: videoList[0] ?? null,
      videoList,
      imageList,
      audioUrl,
      coverUrl,
      author: author(
        creator.nickname,
        creator.user_id || creator.short_id,
        creator.avatar,
      ),
    });
  }
}

export function extractPineconeParams(url: URL): Record<string, string> | null {
  const pathParts = url.pathname.split('/').filter(Boolean);
  let storyId = url.searchParams.get('item_id') ?? url.searchParams.get('story_id') ?? '';
  if (!storyId && pathParts.length >= 2 && pathParts.at(-2) === 'story') {
    storyId = pathParts.at(-1) ?? '';
  }
  if (!storyId) return null;

  const params: Record<string, string> = {
    item_type: url.searchParams.get('item_type') ?? url.searchParams.get('story_type') ?? '1',
    item_id: storyId,
  };
  for (const key of OPTIONAL_QUERY_KEYS) {
    const value = url.searchParams.get(key);
    if (value) params[key] = value;
  }
  return params;
}

function validHttpUrl(value: string): string {
  return value.startsWith('http://') || value.startsWith('https://') ? value : '';
}

registerParser('pinecone_moment', {
  factory: (context) => new PineconeMomentParser(context),
  allowedHosts: ['m.pineconemoment.com', 'pineconemoment.com'],
});
