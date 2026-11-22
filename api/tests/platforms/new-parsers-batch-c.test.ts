import { Buffer } from 'node:buffer';
import { createDecipheriv } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { getPlatformAllowedHosts, type PlatformId } from '../../src/config/platforms.js';
import { UpstreamError } from '../../src/core/errors.js';
import type { MediaResult } from '../../src/core/media-result.js';
import type { ParseContext, PlatformCredentials } from '../../src/core/parse-context.js';
import { getParserRegistration } from '../../src/core/parser-registry.js';
import type { HttpRequestOptions, HttpResponse, HttpSession } from '../../src/http/http-session.js';
import { OutboundPolicy } from '../../src/http/outbound-policy.js';
import { buildCctvNewsSignedRequest } from '../../src/platforms/cctv.js';
import '../../src/platforms/fanqie.js';
import '../../src/platforms/pinduoduo.js';
import {
  cleanYangshipinArticleHtml,
  generateYangshipinCkey,
} from '../../src/platforms/yangshipin.js';

class FixtureSession {
  public readonly calls: { kind: string; url: string; options: HttpRequestOptions }[] = [];
  public readonly texts: (string | Error)[] = [];
  public readonly json: unknown[] = [];
  public readonly responses: HttpResponse[] = [];

  public async getText(url: URL | string, options: HttpRequestOptions = {}): Promise<string> {
    this.calls.push({ kind: 'text', url: String(url), options });
    const value = this.texts.shift();
    if (value === undefined) throw new Error('missing text fixture');
    if (value instanceof Error) throw value;
    return value;
  }

  public async getJson<T>(url: URL | string, options: HttpRequestOptions = {}): Promise<T> {
    this.calls.push({ kind: 'json', url: String(url), options });
    if (this.json.length === 0) throw new Error('missing JSON fixture');
    const value = this.json.shift();
    if (value instanceof Error) throw value;
    return value as T;
  }

  public async request(url: URL | string, options: HttpRequestOptions = {}): Promise<HttpResponse> {
    this.calls.push({ kind: 'request', url: String(url), options });
    const value = this.responses.shift();
    if (!value) throw new Error('missing response fixture');
    return value;
  }
}

describe('Pinduoduo parser', () => {
  it('extracts goods and review share images directly from _oak_share_url without HTTP calls', async () => {
    const goodsSession = new FixtureSession();
    const goodsOutput = await parse(
      'pinduoduo',
      'https://mobile.yangkeduo.com/mall_quality_assurance.html?_t_timestamp=comm_share_landing&goods_id=768457919955&_oak_share_type=2&_oak_share_url=https%3A%2F%2Fimg.pddpic.com%2Fmms-material-img%2F2025-05-30%2Ffb07fde6.jpeg',
      goodsSession,
    );
    expect(goodsOutput).toMatchObject({
      title: '拼多多商品 (商品ID: 768457919955)',
      videoUrl: null,
      coverUrl: 'https://img.pddpic.com/mms-material-img/2025-05-30/fb07fde6.jpeg',
      imageList: ['https://img.pddpic.com/mms-material-img/2025-05-30/fb07fde6.jpeg'],
    });
    expect(goodsSession.calls).toHaveLength(0);

    const reviewSession = new FixtureSession();
    const reviewOutput = await parse(
      'pinduoduo',
      'https://mobile.yangkeduo.com/mall_quality_assurance.html?_t_timestamp=review_detail&goods_id=947457222887&review_id=754367546181347559&_oak_share_url=https%3A%2F%2Fimg.pddpic.com%2Freview-img%2F1.jpeg',
      reviewSession,
    );
    expect(reviewOutput.title).toBe(
      '拼多多评价分享 (商品ID: 947457222887, 评价ID: 754367546181347559)',
    );
    expect(reviewOutput.coverUrl).toBe('https://img.pddpic.com/review-img/1.jpeg');
  });

  it('signs Duoduo video dsp_detail requests with LocalPinduoduoSigner and passes managed cookies', async () => {
    const session = new FixtureSession();
    session.json.push({
      result: {
        feeds: [
          {
            data: {
              feedId: '6960355310530660128',
              feedTitle: '超好用厨房清洁神器，实测效果惊艳！',
              feedMedia: [
                { mediaType: 1, url: 'https://video.pddpic.com/live/clean_kitchen.mp4' },
                { mediaType: 2, url: 'https://img.pddpic.com/feed/cover.jpg' },
              ],
              authorInfo: {
                authorName: '居家好物推荐官',
                avatar: 'https://avatar.pddpic.com/u1.jpg',
                authorId: '10086',
              },
            },
          },
        ],
      },
    });

    const output = await parse(
      'pinduoduo',
      'https://mobile.yangkeduo.com/fyxmkief.html?feed_id=6960355310530660128&goods_id=978211601383',
      session,
      { cookie: 'PDDAccessToken=fixture-token' },
    );

    expect(output).toMatchObject({
      title: '超好用厨房清洁神器，实测效果惊艳！',
      videoUrl: 'https://video.pddpic.com/live/clean_kitchen.mp4',
      videoList: ['https://video.pddpic.com/live/clean_kitchen.mp4'],
      coverUrl: 'https://img.pddpic.com/feed/cover.jpg',
      author: {
        nickname: '居家好物推荐官',
        authorId: '10086',
        avatar: 'https://avatar.pddpic.com/u1.jpg',
      },
    });

    expect(session.calls).toHaveLength(1);
    const call = session.calls[0];
    expect(call?.url).toBe('https://mobile.yangkeduo.com/proxy/api/api/hub/dsp_detail/weak/list/get');
    expect(call?.options.headers).toMatchObject({
      cookie: 'PDDAccessToken=fixture-token',
    });
    const antiHeader = call?.options.headers?.['anti-content'];
    expect(typeof antiHeader).toBe('string');
    expect((antiHeader as string).startsWith('0as')).toBe(true);
    expect((antiHeader as string).length).toBeGreaterThan(100);
    expect(call?.options.json).toMatchObject({ anti_content: antiHeader });
  });

  it('parses goods SSR window.rawData and marks cookieRequired when Duoduo video is unauthenticated', async () => {
    const goodsSession = new FixtureSession();
    goodsSession.texts.push(assignment('window.rawData', {
      store: {
        initDataObj: {
          goods: {
            goods_name: '加厚纯棉大浴巾吸水速干',
            banner: [
              'https://img.pddpic.com/mms/banner1.jpg',
              'https://img.pddpic.com/mms/banner2.jpg',
            ],
            hd_thumb_url: 'https://img.pddpic.com/mms/banner1.jpg',
            video: { url: 'https://video.pddpic.com/goods/bath_towel.mp4' },
          },
        },
      },
    }));

    const goodsOutput = await parse(
      'pinduoduo',
      'https://mobile.yangkeduo.com/goods.html?goods_id=935025706654',
      goodsSession,
    );
    expect(goodsOutput).toMatchObject({
      title: '加厚纯棉大浴巾吸水速干',
      videoUrl: 'https://video.pddpic.com/goods/bath_towel.mp4',
      coverUrl: 'https://img.pddpic.com/mms/banner1.jpg',
      imageList: [
        'https://img.pddpic.com/mms/banner1.jpg',
        'https://img.pddpic.com/mms/banner2.jpg',
      ],
    });

    const unauthSession = new FixtureSession();
    unauthSession.json.push(
      new UpstreamError('http', '上游返回 HTTP 403', 403),
      new UpstreamError('http', '上游返回 HTTP 424', 424),
    );
    unauthSession.texts.push('');

    const unauthOutput = await parse(
      'pinduoduo',
      'https://mobile.yangkeduo.com/fyxmkief.html?feed_id=6960355310530660128',
      unauthSession,
    );
    expect(unauthOutput.videoUrl).toBeNull();
    expect(unauthOutput.title).toBe('多多视频 (FeedID: 6960355310530660128)');
    expect(unauthOutput.cookieRequired).toBe(true);
  });
});

describe('Fanqie and Hongguo parsers', () => {
  const previewShareHtml = `
    <!doctype html>
    <html><body>
      <script>
        window._ROUTER_DATA = {
          "loaderData": {
            "video-animation-share_page": {
              "pageData": {
                "series_data": {
                  "title": "全家把我当乡下老太，都吓傻了",
                  "play_url": "https://v3-share.qznovel.com\\u002Fpreview.mp4?a=8662&start=0&end=30",
                  "cover_url": "https://p3-novel.byteimg.com/cover.image",
                  "author_name": "红果剧场"
                },
                "used_chapter_id": "7679061418129247257"
              },
              "linkParams": {
                "schemeParams": {
                  "vid": "7679061418129247257",
                  "video_id": "7679018384272395289"
                }
              }
            }
          }
        };
      </script>
    </body></html>
  `;

  const fullPlayerHtml = `
    <!doctype html>
    <html><head>
      <script type="application/ld+json">
        {"@type": "VideoObject", "name": "全家把我当乡下老太，都吓傻了 第1集",
         "contentUrl": "https://v3-hgweb.qznovelvod.com\\u002Ffull.mp4?mime_type=video_mp4",
         "duration": "PT2M51S"}
      </script>
    </head></html>
  `;

  it.each([
    ['fanqie', 'https://fqnovel.com/s/demo/'],
    ['hongguo_duanju', 'https://novelquickapp.com/s/wQ-MK1vuras/'],
    ['hongguo_manju', 'https://kylin.hainanyuyue.com/s/bR1qzzEd1A0/'],
  ] as const)('upgrades 30s preview to full player video for %s', async (platformId, url) => {
    const session = new FixtureSession();
    session.texts.push(previewShareHtml, fullPlayerHtml);

    const output = await parse(platformId, url, session);
    expect(output).toMatchObject({
      title: '全家把我当乡下老太，都吓傻了',
      videoUrl: 'https://v3-hgweb.qznovelvod.com/full.mp4?mime_type=video_mp4',
      coverUrl: 'https://p3-novel.byteimg.com/cover.image',
      author: { nickname: '红果剧场', authorId: '', avatar: '' },
    });
    expect(session.calls[1]?.url).toBe(
      'https://hongguoduanju.com/player/7679018384272395289/7679061418129247257',
    );
  });

  it('falls back to the preview URL when hongguoduanju.com player fails and leaves non-preview URLs untouched', async () => {
    const fallbackSession = new FixtureSession();
    fallbackSession.texts.push(
      previewShareHtml,
      new UpstreamError('http', '上游返回 HTTP 404', 404),
    );

    const fallbackOutput = await parse(
      'hongguo_duanju',
      'https://novelquickapp.com/s/wQ-MK1vuras/',
      fallbackSession,
    );
    expect(fallbackOutput.videoUrl).toBe(
      'https://v3-share.qznovel.com/preview.mp4?a=8662&start=0&end=30',
    );

    const directSession = new FixtureSession();
    directSession.texts.push(assignment('window._ROUTER_DATA', {
      loaderData: {
        pageData: {
          series_data: {
            title: '护镖人之无敌镖人！',
            play_url: 'https:\\u002F\\u002Fv3-share.qznovel.com\\u002Freal_play.mp4',
          },
        },
      },
    }));
    const directOutput = await parse(
      'fanqie',
      'https://changdunovel.com/t/byybBzZfKbg/',
      directSession,
    );
    expect(directOutput.videoUrl).toBe('https://v3-share.qznovel.com/real_play.mp4');
    expect(directSession.calls).toHaveLength(1);
  });
});

describe('CCTV parser', () => {
  it('extracts 32-hex GUID from CCTV web HTML and selects HLS or MP4 stream from CNTV API', async () => {
    const hlsSession = new FixtureSession();
    hlsSession.texts.push(`
      <html><head><title>生财有道</title></head><body>
        <script>var guid = "00e121ae62194fec8ab20e5b8eb9a89a";</script>
      </body></html>
    `);
    hlsSession.json.push({
      title: '<b>《生财有道》</b> 20260526 匠心织锦绣',
      hls_url: 'https://hls.cntv.lxdns.com/asp/hls/main/0303000a/3/default/00e12/main.m3u8',
      image: 'https://p1.img.cctvpic.com/cover.jpg',
      column: '生财有道',
    });

    const hlsOutput = await parse(
      'cctv',
      'https://tv.cctv.com/2026/05/26/VIDElJFgf7P8XnEqtQr04Lf7260526.shtml',
      hlsSession,
    );
    expect(hlsOutput).toMatchObject({
      title: '《生财有道》 20260526 匠心织锦绣',
      videoUrl: 'https://hls.cntv.lxdns.com/asp/hls/main/0303000a/3/default/00e12/main.m3u8',
      coverUrl: 'https://p1.img.cctvpic.com/cover.jpg',
      author: { nickname: '生财有道', authorId: '', avatar: '' },
    });
    expect(hlsSession.calls[1]?.url).toBe(
      'https://vdn.apps.cntv.cn/api/getHttpVideoInfo.do?pid=00e121ae62194fec8ab20e5b8eb9a89a',
    );

    const mp4Session = new FixtureSession();
    mp4Session.json.push({
      title: '焦点访谈',
      video: {
        chapters4: [
          { url: 'https://vod.cntv.lxdns.com/part1.mp4', image: 'https://p1.img.cctvpic.com/c1.jpg' },
          { url: 'https://vod.cntv.lxdns.com/part2.mp4', image: 'https://p1.img.cctvpic.com/c2.jpg' },
        ],
      },
      produce: '央视综合',
    });
    const mp4Output = await parse(
      'cctv',
      'https://tv.cctv.com/v.shtml?guid=11e121ae62194fec8ab20e5b8eb9a89b',
      mp4Session,
    );
    expect(mp4Output.videoUrl).toBe('https://vod.cntv.lxdns.com/part1.mp4');
    expect(mp4Output.videoList).toEqual([
      'https://vod.cntv.lxdns.com/part1.mp4',
      'https://vod.cntv.lxdns.com/part2.mp4',
    ]);
    expect(mp4Output.coverUrl).toBe('https://p1.img.cctvpic.com/c1.jpg');
  });

  it('signs CCTV News gateway requests with HMAC-SHA256 and decodes Base64 payloads', async () => {
    const signed = buildCctvNewsSignedRequest('12063254061111721092', '1700000000000');
    expect(signed.url).toBe(
      'https://api.cctvnews.cctv.com/1.0.0/feed/article/server/getArticle?appcode=video_web&articleId=12063254061111721092',
    );
    expect(signed.headers['x-ca-signature-headers']).toBe('x-ca-key,x-ca-stage,x-ca-timestamp');
    expect(signed.headers['x-ca-signature']).toBeTruthy();

    const session = new FixtureSession();
    const encodedPayload = Buffer.from(
      JSON.stringify({
        data: {
          title: '今天是第九个中国医师节',
          source: '央视新闻客户端',
          videos: [
            {
              url: 'https://res.cctvnews.cctv.com/video/stream.m3u8',
              cover: { url: 'https://img.cctvnews.cctv.com/cover1.jpg' },
            },
          ],
        },
      }),
      'utf8',
    ).toString('base64');
    session.json.push({ code: 0, response: encodedPayload });

    const output = await parse(
      'cctv',
      'https://content-static.cctvnews.cctv.com/snow-book/video.html?item_id=12063254061111721092',
      session,
    );
    expect(output).toMatchObject({
      title: '今天是第九个中国医师节',
      videoUrl: 'https://res.cctvnews.cctv.com/video/stream.m3u8',
      coverUrl: 'https://img.cctvnews.cctv.com/cover1.jpg',
      author: { nickname: '央视新闻客户端', authorId: '', avatar: '' },
    });
  });
});

describe('Yangshipin parser', () => {
  it('generates valid cKey 8.1 ciphertexts and resolves portrait/landscape video streams via playvinfo', async () => {
    const ckey = generateYangshipinCkey('l00005817wl', '1789545734', 'a1b2c3d4e5f60718293a4b5c6d7e8f90');
    expect(ckey.startsWith('--01')).toBe(true);
    const decipher = createDecipheriv(
      'aes-128-cbc',
      Buffer.from('4e2918885fd98109869d14e0231a0bf4', 'hex'),
      Buffer.from('16b17e519ddd0ce5b79d7a63a4dd801c', 'hex'),
    );
    const decrypted = Buffer.concat([
      decipher.update(Buffer.from(ckey.slice(4), 'hex')),
      decipher.final(),
    ]).toString('utf8');
    expect(decrypted).toContain('|l00005817wl|1789545734|mg3c3b04ba|1.3.5|');

    const session = new FixtureSession();
    session.texts.push(
      assignment('window.__STATE_portrait_video__', {
        payloads: {
          videoDataList: {
            items: [
              {
                videoData: {
                  vid: 'l00005817wl',
                  title: '5次助攻对4次助攻！巅峰对决',
                  shareItem: { shareImgUrl: 'https://jietufengmian.yangshipin.cn/cover1.jpg' },
                  detailFollowItem: {
                    actorItem: {
                      nickName: { text: '奥运来了' },
                      headUrl: 'https://mpuser.ysp.cctv.cn/avatar1.jpeg',
                    },
                  },
                },
              },
            ],
          },
        },
      }),
      '({"em":85,"exem":-3,"curTime":1789545734})',
      '({"s":"o","vl":{"cnt":1,"vi":[{"fn":"l00005817wl.mp4","fvkey":"ABC123KEY","ul":{"ui":[{"url":"https://mp4playcloud-cdn.ysp.cctv.cn/"}]}}]}})',
    );

    const output = await parse(
      'yangshipin',
      'https://m.yangshipin.cn/portrait_video?vid=l00005817wl',
      session,
    );
    expect(output).toMatchObject({
      title: '5次助攻对4次助攻！巅峰对决',
      videoUrl: 'https://mp4playcloud-cdn.ysp.cctv.cn/l00005817wl.mp4?vkey=ABC123KEY&platform=2',
      coverUrl: 'https://jietufengmian.yangshipin.cn/cover1.jpg',
      imageList: [],
      author: {
        nickname: '奥运来了',
        authorId: '',
        avatar: 'https://mpuser.ysp.cctv.cn/avatar1.jpeg',
      },
    });
    const signedCall = session.calls[2];
    expect(signedCall?.options.searchParams).toMatchObject({
      vid: 'l00005817wl',
      encryptVer: '8.1',
      _rnd: '1789545734',
    });
  });

  it('follows meta-refresh redirects to articles and extracts cleaned text, images, audio, and embedded cctv_video', async () => {
    expect(
      cleanYangshipinArticleHtml('<p>第一段</p><p>第二段<br/>换行</p><script>bad()</script>'),
    ).toBe('第一段\n\n第二段\n\n换行');

    const imageArticleSession = new FixtureSession();
    imageArticleSession.texts.push(
      `<meta http-equiv="refresh" content="0; URL='https://m.yangshipin.cn/static/article.html?articleid=e05kmjv3gty29'"/>`,
      '<html><head><title>文章</title></head><body></body></html>',
    );
    imageArticleSession.json.push({
      ret: 0,
      data: {
        errCode: 0,
        head: {
          title: '亚运乒乓球签表：上届冠亚军孙颖莎早田希娜同半区',
          source: '体坛网',
          coverImage: 'https://jietufengmian.yangshipin.cn/cover_article.jpg',
        },
        content: {
          content: '<p>体坛周报全媒体原创</p><p>北京时间9月18日晚上，签表正式出炉。</p>',
          images: [
            'https://jietufengmian.yangshipin.cn/img1.jpg',
            'https://jietufengmian.yangshipin.cn/img2.jpg',
          ],
        },
      },
    });

    const articleOutput = await parse('yangshipin', 'https://www.yspapp.cn/6j3j', imageArticleSession);
    expect(articleOutput).toMatchObject({
      title: '亚运乒乓球签表：上届冠亚军孙颖莎早田希娜同半区',
      desc: '体坛周报全媒体原创\n\n北京时间9月18日晚上，签表正式出炉。',
      coverUrl: 'https://jietufengmian.yangshipin.cn/cover_article.jpg',
      imageList: [
        'https://jietufengmian.yangshipin.cn/img1.jpg',
        'https://jietufengmian.yangshipin.cn/img2.jpg',
      ],
      videoUrl: null,
      author: { nickname: '体坛网', authorId: '', avatar: '' },
    });

    const embeddedSession = new FixtureSession();
    embeddedSession.texts.push(
      '<html></html>',
      '({"curTime":1789545800})',
      '({"vl":{"vi":[{"fn":"v00000embedded.mp4","fvkey":"EMBKEY","ul":{"ui":[{"url":"https://mp4playcloud-cdn.ysp.cctv.cn/"}]}}]}})',
    );
    embeddedSession.json.push({
      ret: 0,
      data: {
        errCode: 0,
        head: {
          title: '新闻联播重点快讯',
          source: '央视新闻',
          coverImage: 'https://jietufengmian.yangshipin.cn/cover_news.jpg',
        },
        content: {
          content: '<p>今日新闻要点如下：</p><cctv_video id="v00000embedded"></cctv_video>',
          images: [],
        },
        audioCapsule: { audioUrl: 'https://audio.ysp.cctv.cn/news.mp3' },
      },
    });

    const embeddedOutput = await parse(
      'yangshipin',
      'https://m.yangshipin.cn/static/article.html?articleid=art123',
      embeddedSession,
    );
    expect(embeddedOutput).toMatchObject({
      title: '新闻联播重点快讯',
      audioUrl: 'https://audio.ysp.cctv.cn/news.mp3',
      videoUrl: 'https://mp4playcloud-cdn.ysp.cctv.cn/v00000embedded.mp4?vkey=EMBKEY&platform=2',
      videoList: ['https://mp4playcloud-cdn.ysp.cctv.cn/v00000embedded.mp4?vkey=EMBKEY&platform=2'],
    });
  });
});

describe('outbound host allowlists for batch C platforms', () => {
  it.each([
    ['pinduoduo', 'https://api.pinduoduo.com/api/hub/dsp_detail/weak/list/get'],
    ['fanqie', 'https://hongguoduanju.com/player/1/2'],
    ['hongguo_duanju', 'https://hongguoduanju.com/player/1/2'],
    ['hongguo_manju', 'https://hongguoduanju.com/player/1/2'],
    ['cctv', 'https://vdn.apps.cntv.cn/api/getHttpVideoInfo.do?pid=abc'],
    ['cctv', 'https://api.cctvnews.cctv.com/1.0.0/feed/article/server/getArticle'],
    ['yangshipin', 'https://playvv.yangshipin.cn/playvinfo'],
    ['yangshipin', 'https://comment.yangshipin.cn/web/article/article_info'],
    ['yangshipin', 'https://h5access.yangshipin.cn/web/article/article_info'],
  ] as const)('allows %s to contact %s', (platformId, targetUrl) => {
    const registration = getParserRegistration(platformId);
    const policy = new OutboundPolicy({
      allowedHosts: [...getPlatformAllowedHosts(platformId), ...registration.allowedHosts],
    });
    expect(() => policy.assertUrl(new URL(targetUrl))).not.toThrow();
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
