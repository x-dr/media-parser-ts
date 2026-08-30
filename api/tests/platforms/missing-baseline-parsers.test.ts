import { Buffer } from 'node:buffer';
import { describe, expect, it } from 'vitest';
import type { PlatformId } from '../../src/config/platforms.js';
import type { ParseContext, PlatformCredentials } from '../../src/core/parse-context.js';
import type { MediaResult } from '../../src/core/media-result.js';
import { getParserRegistration } from '../../src/core/parser-registry.js';
import type { HttpRequestOptions, HttpResponse, HttpSession } from '../../src/http/http-session.js';
import { extractVideoOid, extractWeiboId } from '../../src/platforms/weibo.js';
import '../../src/platforms/index.js';

class FixtureSession {
  public readonly calls: { kind: string; url: string; options: HttpRequestOptions }[] = [];
  public readonly texts: string[] = [];
  public readonly json: unknown[] = [];
  public readonly responses: HttpResponse[] = [];

  public async getText(url: URL | string, options: HttpRequestOptions = {}): Promise<string> {
    this.calls.push({ kind: 'text', url: String(url), options });
    const value = this.texts.shift();
    if (value === undefined) throw new Error('missing text fixture');
    return value;
  }

  public async getJson<T>(url: URL | string, options: HttpRequestOptions = {}): Promise<T> {
    this.calls.push({ kind: 'json', url: String(url), options });
    if (this.json.length === 0) throw new Error('missing JSON fixture');
    return this.json.shift() as T;
  }

  public async request(url: URL | string, options: HttpRequestOptions = {}): Promise<HttpResponse> {
    this.calls.push({ kind: 'request', url: String(url), options });
    const value = this.responses.shift();
    if (!value) throw new Error('missing response fixture');
    return value;
  }
}

describe('the seven parsers that lacked standalone Python tests', () => {
  it('parses AcFun pageInfo', async () => {
    const session = new FixtureSession();
    session.texts.push(assignment('window.pageInfo', {
      title: 'AcFun fixture', coverUrl: 'https://cdn.example/acfun.jpg',
      currentVideoInfo: { ksPlayJson: JSON.stringify({
        adaptationSet: [{ representation: [{ url: 'https://cdn.example/acfun.m3u8' }] }],
      }) },
      user: { name: 'author', id: 1, headUrl: 'https://cdn.example/avatar.jpg' },
    }));
    const output = await parse('acfun', 'https://www.acfun.cn/v/ac1', session);
    expect(output).toMatchObject({ title: 'AcFun fixture', videoUrl: 'https://cdn.example/acfun.m3u8' });
    expect(output.author?.authorId).toBe('1');
  });

  it('selects the final clarity URL from Haokan state', async () => {
    const session = new FixtureSession();
    session.texts.push(assignment('window.__PRELOADED_STATE__', {
      curVideoMeta: {
        title: 'Haokan fixture',
        clarityUrl: [
          { url: 'https%3A%2F%2Fcdn.example%2Flow.mp4' },
          { url: 'https%3A%2F%2Fcdn.example%2Fhigh.mp4' },
        ],
        poster: 'https://cdn.example/cover.jpg',
        mth: { author_name: 'author', mthid: 2, author_photo: 'https://cdn.example/a.jpg' },
      },
    }));
    const output = await parse('haokan', 'https://haokan.baidu.com/v?vid=1', session);
    expect(output.videoUrl).toBe('https://cdn.example/high.mp4');
  });

  it('reconstructs Pear Video URLs and author metadata', async () => {
    const session = new FixtureSession();
    session.json.push({ videoInfo: {
      videos: { srcUrl: 'https://cdn.example/123-456-hd.mp4' },
      video_image: 'https://cdn.example/pear.jpg',
    } });
    session.texts.push(`
      <div class="summary">Pear fixture</div>
      <div class="thiscat"><div class="col-name">Pear author</div>
      <div class="column-subscribe" data-userid="7"></div>
      <img src="https://cdn.example/pear-author.jpg"></div>
    `);
    const output = await parse('lishipin', 'https://www.pearvideo.com/video_1805408', session);
    expect(output.videoUrl).toBe('https://cdn.example/cont-video_1805408-456-hd.mp4');
    expect(output.author?.authorId).toBe('7');
  });

  it('maps Pipigaoxiao video, cover and numeric avatar IDs', async () => {
    const session = new FixtureSession();
    session.json.push({ data: {
      post: { content: 'Pipi fixture', mid: 8, imgs: [{ id: '10' }], videos: {
        '10': { url: 'https://cdn.example/pipi.mp4' },
      } },
      user: { name: 'author', mid: 8, avatar: '11' },
    } });
    const output = await parse(
      'pipigaoxiao', 'https://h5.pipigx.com/pp/post/123?pid=123', session,
    );
    expect(output).toMatchObject({
      videoUrl: 'https://cdn.example/pipi.mp4',
      coverUrl: 'https://file.ippzone.com/img/view/id/10',
    });
    expect(output.author?.avatar).toBe('https://file.ippzone.com/img/view/id/11');
  });

  it('parses Weishi init state', async () => {
    const session = new FixtureSession();
    session.texts.push(assignment('window.Vise.initState', { feedsList: [{
      feedDesc: 'Weishi fixture', videoUrl: 'https:\\u002F\\u002Fcdn.example\\u002Fweishi.mp4',
      videoCover: 'https:\\u002F\\u002Fcdn.example\\u002Fweishi.jpg',
      poster: { nick: 'author', id: 9, avatar: 'https://cdn.example/a.jpg' },
    }] }));
    const output = await parse('weishi', 'https://video.weishi.qq.com/abc', session);
    expect(output.videoUrl).toBe('https://cdn.example/weishi.mp4');
  });

  it('retries Xiaohongshu explicitly and passes only the managed request credential', async () => {
    const session = new FixtureSession();
    session.texts.push(
      assignment('window.__INITIAL_STATE__', { note: {} }),
      assignment('window.__INITIAL_STATE__', { note: {} }),
      assignment('window.__INITIAL_STATE__', { note: {
        firstNoteId: 'note-1',
        noteDetailMap: { 'note-1': { note: {
          title: 'XHS', desc: 'fixture', imageList: [{
            urlDefault: 'https://cdn.example/xhs.jpg', livePhoto: true,
            stream: { h264: [{ masterUrl: 'https://cdn.example/xhs-live.mp4' }] },
          }],
          user: { nickname: 'author', userId: '10', avatar: 'https://cdn.example/a.jpg' },
        } } },
      } }),
    );
    const output = await parse(
      'xiaohongshu', 'https://www.xiaohongshu.com/discovery/item/1', session,
      { cookie: 'fixture-cookie' },
    );
    expect(session.calls.filter((call) => call.kind === 'text')).toHaveLength(3);
    expect(session.calls[0]?.options.headers).toMatchObject({ cookie: 'fixture-cookie' });
    expect(output.imageList).toEqual([{
      url: 'https://cdn.example/xhs.jpg', livePhotoUrl: 'https://cdn.example/xhs-live.mp4',
    }]);
  });

  it('uses local Douyin signing, request-local ttwid and maps live photos', async () => {
    const session = new FixtureSession();
    session.responses.push({
      statusCode: 200,
      url: new URL('https://ttwid.bytedance.com/ttwid/union/register/'),
      headers: { 'set-cookie': ['ttwid=fixture-id; Path=/; Secure'] },
      body: Buffer.from('{}'),
    });
    session.json.push({ aweme_detail: {
      desc: 'Douyin fixture',
      video: {
        bit_rate: [{ play_addr: { url_list: [
          'https://direct.example/video.mp4',
          'https://referer-gated.example/video.mp4',
          'https://www.douyin.com/aweme/v1/play/?video_id=fixture',
        ] } }],
        dynamic_cover: { url_list: ['https://cdn.example/cover.jpg'] },
      },
      images: [{
        url_list: ['https://cdn.example/image.jpg'],
        video: { play_addr: { url_list: ['https://cdn.example/live.mp4'] } },
      }],
      music: { play_url: { url_list: ['https://cdn.example/audio.mp3'] } },
      author: { nickname: 'author', unique_id: '11', avatar_thumb: { url_list: ['avatar'] } },
    } });
    const output = await parse('douyin', 'https://www.douyin.com/video/123', session);
    const detailCall = session.calls.find((call) => call.kind === 'json');
    expect(detailCall?.url).toContain('a_bogus=');
    expect(detailCall?.options.headers).toMatchObject({ cookie: 'ttwid=fixture-id' });
    expect(output.videoUrl).toBe('https://direct.example/video.mp4');
    expect(output.imageList).toEqual([{
      url: 'https://cdn.example/image.jpg', livePhotoUrl: 'https://cdn.example/live.mp4',
    }]);
  });
});

describe('high-risk parser compatibility fixtures', () => {
  it.each([
    ['https://video.weibo.com/show?fid=1034%3A5336275486703690', '5336275486703690'],
    ['https://weibo.com/tv/show/1034:5336275486703690', '5336275486703690'],
    ['https://weibo.com/7928442102/5331959570240710', '5331959570240710'],
    ['https://weibo.com/7928442102/O8yqz0I8Q', '5020389670169684'],
    ['https://m.weibo.cn/detail/5331959570240710', '5331959570240710'],
    ['https://m.weibo.cn/detail/O8yqz0I8Q', '5020389670169684'],
  ])('extracts numeric Weibo ID from %s', (url, expected) => {
    expect(extractWeiboId(new URL(url))).toBe(expected);
  });

  it('extracts the Weibo video object ID and maps image posts', async () => {
    expect(extractVideoOid(new URL('https://weibo.com/tv/show/1034:5336275486703690')))
      .toBe('1034:5336275486703690');
    const session = new FixtureSession();
    session.json.push({ ok: 1, data: {
      text_raw: 'Weibo fixture',
      pics: [
        { large: { url: 'https://cdn.example/weibo-1.jpg' } },
        { large: { url: 'https://cdn.example/weibo-2.jpg' } },
      ],
      user: { screen_name: 'author', id: 12, avatar_hd: 'https://cdn.example/a.jpg' },
    } });
    const output = await parse('weibo', 'https://m.weibo.cn/detail/5331959570240710', session);
    expect(output.imageList).toEqual([
      'https://cdn.example/weibo-1.jpg', 'https://cdn.example/weibo-2.jpg',
    ]);
    expect(output.author?.nickname).toBe('author');
  });

  it('parses the public WeChat Channels feed and h265 fallback', async () => {
    const session = new FixtureSession();
    session.json.push(feedResponse('h265VideoInfo', 'https://cdn.example/h265.mp4'));
    const output = await parse(
      'wechat_channels', 'https://weixin.qq.com/sph/AzGrUgqzFv', session,
    );
    expect(output.videoUrl).toBe('https://cdn.example/h265.mp4');
    expect(session.calls[0]?.options.json).toEqual({
      baseReq: { generalToken: '' }, shortUri: 'AzGrUgqzFv',
    });
  });

  it('uses managed Yuanbao credentials and falls back anonymously when they expire', async () => {
    const valid = new FixtureSession();
    valid.json.push(
      { data: { playable_url: 'https://channels.weixin.qq.com/finder-preview/pages/feed?token=temp&eid=export' } },
      feedResponse('h264VideoInfo', 'https://cdn.example/channel.mp4'),
    );
    const validOutput = await parse(
      'wechat_channels', 'https://weixin.qq.com/sph/AzGrUgqzFv', valid,
      { yuanbao_cookie: 'fixture-cookie' },
    );
    expect(validOutput.videoUrl).toBe('https://cdn.example/channel.mp4');
    expect(valid.calls[0]?.options.headers).toMatchObject({ cookie: 'fixture-cookie' });
    expect(valid.calls[1]?.options.json).toEqual({
      baseReq: { generalToken: 'temp' }, exportId: 'export',
    });

    const expired = new FixtureSession();
    expired.json.push(
      { msg: 'expired' },
      feedResponse('h264VideoInfo', 'https://cdn.example/public.mp4'),
    );
    const fallback = await parse(
      'wechat_channels', 'https://weixin.qq.com/sph/AzGrUgqzFv', expired,
      { yuanbao_cookie: 'expired-fixture' },
    );
    expect(fallback.videoUrl).toBe('https://cdn.example/public.mp4');
    expect(expired.calls).toHaveLength(2);
  });

  it('maps Kuaishou Apollo state without any embedded fallback credential', async () => {
    const session = new FixtureSession();
    session.texts.push(assignment('window.__APOLLO_STATE__', { defaultClient: {
      'VisionVideoDetailPhoto:photo-id': {
        caption: 'Kuaishou fixture', photoUrl: 'https://cdn.example/kuaishou.mp4',
        coverUrl: 'https://cdn.example/kuaishou.jpg', author: { id: 'User:1' },
      },
      'User:1': { name: 'author', id: '13', headerUrl: 'https://cdn.example/a.jpg' },
    } }));
    const output = await parse(
      'kuaishou', 'https://v.m.chenzhongtech.com/fw/photo/photo-id', session,
    );
    expect(output).toMatchObject({
      title: 'Kuaishou fixture', videoUrl: 'https://cdn.example/kuaishou.mp4',
    });
    expect(session.calls[0]?.options.headers).not.toHaveProperty('cookie');
  });

  it.each([
    `<script type="application/ld+json">${JSON.stringify({
      headline: 'Video｜Guild｜腾讯频道',
      author: { name: 'author', url: 'https://cdn.example/a.jpg' },
      video: {
        contentUrl: 'https://qchannelvideo.photo.qq.com/video.mp4',
        thumbnailUrl: 'https://cdn.example/cover.jpg',
      },
    })}</script>`,
    '<meta property="og:title" content="Tencent fixture"><meta property="og:image" content="https://cdn.example/cover.jpg"><video src="https://qchannelvideo.photo.qq.com/fallback.mp4"></video>',
  ])('extracts Tencent Channel public metadata without executing a challenge', async (html) => {
    const session = new FixtureSession();
    session.texts.push(html);
    const output = await parse('tencent_channel', 'https://pd.qq.com/s/code?b=2', session);
    expect(output.videoUrl).toContain('qchannelvideo.photo.qq.com');
    expect(session.calls).toHaveLength(1);
  });

  it('parses Doubao video sharing with managed Cookie and watermark parameters removed', async () => {
    const session = new FixtureSession();
    session.json.push(
      { code: 0, data: { results: [] } },
      { code: 0, data: {
        original_media_info: { main_url: 'https://cdn.example/doubao.mp4?lr=1&token=keep' },
        poster_url: 'https://cdn.example/doubao.jpg',
      } },
      { code: 0, data: {
        prompt: 'Doubao fixture', play_info: {},
        user_info: { nickname: 'author', user_id: 14 },
      } },
    );
    const output = await parse(
      'doubao',
      'https://www.doubao.com/video-sharing?share_id=share&video_id=video',
      session,
      { cookie: 'fixture-cookie' },
    );
    expect(output.videoUrl).toBe('https://cdn.example/doubao.mp4?token=keep');
    expect(output.coverUrl).toBe('https://cdn.example/doubao.jpg');
    expect(session.calls.every((call) => call.options.headers?.cookie === 'fixture-cookie')).toBe(true);
  });
});

async function parse(
  platformId: PlatformId,
  url: string,
  session: FixtureSession,
  credentials: PlatformCredentials = {},
): Promise<MediaResult> {
  const log = (fields: Record<string, unknown>, message: string): void => {
    void fields;
    void message;
  };
  const context: ParseContext = {
    requestId: 'fixture-request',
    apiClientId: 'fixture-client',
    apiKeyId: 'fixture-key',
    platform: platformId,
    originalUrl: new URL(url),
    realUrl: new URL(url),
    session: session as unknown as HttpSession,
    signal: AbortSignal.timeout(2_000),
    logger: {
      debug: log,
      info: log,
      warn: log,
      error: log,
    },
    credentials,
  };
  const parser = getParserRegistration(platformId).factory(context);
  return parser.parse(context);
}

function assignment(marker: string, value: unknown): string {
  return `<script>${marker} = ${JSON.stringify(value)};</script>`;
}

function feedResponse(
  videoField: 'h264VideoInfo' | 'h265VideoInfo',
  videoUrl: string,
): unknown {
  return {
    errCode: 0,
    data: {
      authorInfo: { nickname: 'author', headImgUrl: 'https://cdn.example/a.jpg' },
      feedInfo: {
        description: 'Channel fixture', coverUrl: 'https://cdn.example/cover.jpg',
        [videoField]: { videoUrl },
      },
    },
  };
}
