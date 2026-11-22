import { load } from 'cheerio';
import { DEFAULT_MOBILE_USER_AGENT } from '../config/user-agents.js';
import { ProxyAttemptError } from '../core/errors.js';
import type { MediaResult } from '../core/media-result.js';
import type { ParseContext } from '../core/parse-context.js';
import type { PlatformParser } from '../core/parser.js';
import { registerParser } from '../core/parser-registry.js';
import {
  array,
  at,
  author,
  extractAssignedJson,
  record,
  result,
  string,
  stringAt,
  uniqueStrings,
} from './data.js';

class LofterParser implements PlatformParser {
  public readonly platform = 'lofter' as const;
  public constructor(private readonly context: ParseContext) {}

  public async parse(): Promise<MediaResult> {
    let html: string;
    try {
      html = await this.context.session.getText(this.context.realUrl, {
        headers: {
          'user-agent': DEFAULT_MOBILE_USER_AGENT,
          referer: 'https://www.lofter.com/',
          accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        },
        followRedirect: true,
        signal: this.context.signal,
      });
    } catch (error) {
      if (error instanceof ProxyAttemptError) throw error;
      return result({});
    }

    if (!html) return result({});

    const initData = record(extractAssignedJson(html, 'window.__initialize_data__'));
    if (Object.keys(initData).length > 0) {
      return parseFromInitData(initData);
    }
    return fallbackHtmlParse(html);
  }
}

function parseFromInitData(data: Record<string, unknown>): MediaResult {
  if ('answerDetailData' in data) {
    const ans = record(data.answerDetailData);
    const blogInfo = record(ans.blogInfo);
    const authorName = string(blogInfo.blogNickName) || string(blogInfo.blogName);
    const authorAvatar = string(blogInfo.bigAvaImg) || string(blogInfo.avaImg);
    const rawTitle = string(ans.barrage) || string(ans.answer);
    const imageList = uniqueStrings(
      array(ans.images).map((item) => stringAt(item, 'orign') || stringAt(item, 'raw')),
    );
    return result({
      title: stripHtmlTags(rawTitle),
      imageList,
      author: author(authorName, blogInfo.blogId, authorAvatar),
    });
  }

  const postBundle = record(at(data, 'postData', 'data'));
  const blogInfo = record(postBundle.blogInfo);
  const postView = record(at(postBundle, 'postData', 'postView'));

  const authorName = string(blogInfo.blogNickName) || string(blogInfo.blogName);
  const authorAvatar = string(blogInfo.bigAvaImg) || string(blogInfo.avaImg);
  const rawTitle = string(postView.title) || string(postView.digest);

  let videoUrl = '';
  let coverUrl = '';
  let caption = '';
  const images: string[] = [];

  const videoPostView = record(postView.videoPostView);
  if (Object.keys(videoPostView).length > 0) {
    const videoInfo = record(videoPostView.videoInfo);
    videoUrl = string(videoInfo.originUrl) || string(videoInfo.flashurl);
    coverUrl = string(videoInfo.video_img_url) || string(videoInfo.video_first_img);
    caption = string(videoPostView.caption);
  }

  const photoPostView = record(postView.photoPostView);
  if (Object.keys(photoPostView).length > 0) {
    for (const rawItem of array(photoPostView.photoLinks)) {
      const item = record(rawItem);
      const imgUrl = string(item.raw) || string(item.orign);
      if (imgUrl) images.push(imgUrl);
    }

    const firstFromPhoto = record(photoPostView.firstImage);
    const firstImg =
      Object.keys(firstFromPhoto).length > 0 ? firstFromPhoto : record(postView.firstImage);
    const firstImgUrl = string(firstImg.raw) || string(firstImg.orign);
    if (firstImgUrl) coverUrl = firstImgUrl;

    if (!caption) {
      caption = string(photoPostView.caption);
    }
  }

  const desc = stripHtmlTags(caption) || null;
  const title = stripHtmlTags(rawTitle);

  return result({
    title,
    desc,
    videoUrl: videoUrl || null,
    coverUrl: coverUrl || null,
    imageList: uniqueStrings(images),
    author: author(authorName, blogInfo.blogId, authorAvatar),
  });
}

function fallbackHtmlParse(html: string): MediaResult {
  const $ = load(html);
  const ogTitle = $('meta[property="og:title"]').first().attr('content')?.trim() ?? '';
  const docTitle = $('title').first().text().trim();
  const title = stripHtmlTags(ogTitle || docTitle);

  const coverUrl = $('meta[property="og:image"]').first().attr('content')?.trim() || null;
  const videoUrl = $('video').first().attr('src')?.trim() || null;

  const images: string[] = [];
  $('img').each((_index, element) => {
    const src = ($(element).attr('src') ?? $(element).attr('data-src') ?? '').trim();
    if (src && src.includes('lf127.net') && !src.includes('ava')) {
      images.push(src);
    }
  });

  return result({
    title,
    videoUrl,
    coverUrl,
    imageList: uniqueStrings(images),
  });
}

function stripHtmlTags(raw: string): string {
  if (!raw) return '';
  return raw.includes('<') ? load(raw).text().trim() : raw.trim();
}

registerParser('lofter', {
  factory: (context) => new LofterParser(context),
  allowedHosts: ['*.lofter.com', '163cn.tv'],
});
