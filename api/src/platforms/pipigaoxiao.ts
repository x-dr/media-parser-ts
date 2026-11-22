import type { ParseContext } from '../core/parse-context.js';
import type { PlatformParser } from '../core/parser.js';
import { registerParser } from '../core/parser-registry.js';
import { getVideoId } from '../http/url-tools.js';
import {
  array,
  at,
  author,
  idAt,
  protocolUrl,
  record,
  result,
  string,
  stringAt,
  uniqueStrings,
} from './data.js';

const IMAGE_VIEW_BASE = 'https://file.ippzone.com/img/view/id';
const VARIANT_KEYS = ['origin', '540', '360'] as const;

class PipigaoxiaoParser implements PlatformParser {
  public readonly platform = 'pipigaoxiao' as const;
  public constructor(private readonly context: ParseContext) {}

  public async parse(): Promise<ReturnType<typeof result>> {
    const postId = getVideoId(this.context.realUrl);
    if (!/^\d+$/u.test(postId)) return result({});

    const data = await this.context.session.getJson<unknown>(
      'https://h5.pipigx.com/ppapi/share/fetch_content',
      {
        method: 'POST',
        headers: { referer: this.context.realUrl.href },
        json: { mid: 'null', pid: Number(postId), type: 'post' },
        signal: this.context.signal,
      },
    );

    const post = at(data, 'data', 'post');
    const user = at(data, 'data', 'user');
    const imgs = array(at(post, 'imgs'));
    const videosMap = record(at(post, 'videos'));

    const videoUrls = collectPostVideos(imgs, videosMap);
    const imageList = collectPostImages(imgs, videosMap);

    const firstImageId = idAt(imgs[0], 'id');
    const coverUrl = firstImageId
      ? `${IMAGE_VIEW_BASE}/${firstImageId}`
      : imageList[0] ?? null;
    const avatarValue = idAt(user, 'avatar') || stringAt(user, 'avatar');
    const content = stringAt(post, 'content');

    return result({
      title: content,
      desc: content || null,
      videoUrl: videoUrls[0] ?? null,
      videoList: videoUrls.length > 1 ? videoUrls : [],
      coverUrl,
      imageList,
      author: author(
        at(user, 'name'),
        at(user, 'mid') || at(post, 'mid'),
        /^\d+$/u.test(avatarValue)
          ? `${IMAGE_VIEW_BASE}/${avatarValue}`
          : avatarValue,
      ),
    });
  }
}

function collectPostVideos(
  imgs: readonly unknown[],
  videosMap: Record<string, unknown>,
): string[] {
  const urls: string[] = [];
  for (const img of imgs) {
    const imgId = idAt(img, 'id');
    if (!imgId) continue;
    const videoUrl = stringAt(videosMap, imgId, 'url');
    if (videoUrl) urls.push(protocolUrl(videoUrl));
  }
  for (const entry of Object.values(videosMap)) {
    const videoUrl = stringAt(entry, 'url');
    if (videoUrl) urls.push(protocolUrl(videoUrl));
  }
  return uniqueStrings(urls);
}

function collectPostImages(
  imgs: readonly unknown[],
  videosMap: Record<string, unknown>,
): string[] {
  const images: string[] = [];
  for (const img of imgs) {
    const mapped = record(img);
    if (Object.keys(mapped).length === 0) continue;
    const imgId = idAt(mapped, 'id');
    // Skip items flagged as video or backed by an entry in post.videos.
    if (Boolean(mapped.video) || (imgId && Boolean(stringAt(videosMap, imgId, 'url')))) {
      continue;
    }

    const urlsNode = record(mapped.urls);
    let selectedUrl = '';
    for (const key of VARIANT_KEYS) {
      const candidates = array(at(urlsNode, key, 'urls'));
      const found = candidates.map((entry) => string(entry)).find(Boolean);
      if (found) {
        selectedUrl = protocolUrl(found);
        break;
      }
    }
    if (!selectedUrl) {
      const direct = string(mapped.url);
      if (direct) selectedUrl = protocolUrl(direct);
      else if (imgId) selectedUrl = `${IMAGE_VIEW_BASE}/${imgId}`;
    }
    if (selectedUrl) images.push(selectedUrl);
  }
  return uniqueStrings(images);
}

registerParser('pipigaoxiao', {
  factory: (context) => new PipigaoxiaoParser(context),
  allowedHosts: ['h5.pipigx.com'],
});
