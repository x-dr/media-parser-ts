import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { PlatformId } from '../../src/config/platforms.js';
import type { MediaResult } from '../../src/core/media-result.js';
import type { ParseContext, PlatformCredentials } from '../../src/core/parse-context.js';
import { getParserRegistration } from '../../src/core/parser-registry.js';
import type { HttpRequestOptions, HttpResponse, HttpSession } from '../../src/http/http-session.js';
import { extractVideoOid, extractWeiboId } from '../../src/platforms/weibo.js';
import '../../src/platforms/index.js';

interface RecordedCall {
  kind: 'text' | 'json' | 'request';
  url: string;
  options: HttpRequestOptions;
}

class MockSession {
  public readonly calls: RecordedCall[] = [];
  public readonly texts: string[] = [];
  public readonly json: unknown[] = [];
  public readonly responses: HttpResponse[] = [];
  public readonly cookies: { cookie: string; url: string }[] = [];

  public async getText(url: URL | string, options: HttpRequestOptions = {}): Promise<string> {
    this.calls.push({ kind: 'text', url: String(url), options });
    const next = this.texts.shift();
    if (next === undefined) throw new Error(`unexpected getText(${String(url)})`);
    return next;
  }

  public async getJson<T>(url: URL | string, options: HttpRequestOptions = {}): Promise<T> {
    this.calls.push({ kind: 'json', url: String(url), options });
    if (this.json.length === 0) throw new Error(`unexpected getJson(${String(url)})`);
    return this.json.shift() as T;
  }

  public async request(url: URL | string, options: HttpRequestOptions = {}): Promise<HttpResponse> {
    this.calls.push({ kind: 'request', url: String(url), options });
    const next = this.responses.shift();
    if (!next) throw new Error(`unexpected request(${String(url)})`);
    return next;
  }

  public async setCookie(rawCookie: string, url: URL | string): Promise<void> {
    this.cookies.push({ cookie: rawCookie, url: String(url) });
  }
}

async function runParser(
  platformId: PlatformId,
  url: string,
  session: MockSession,
  credentials: PlatformCredentials = {},
): Promise<MediaResult> {
  const noop = (fields: Record<string, unknown>, message: string): void => {
    void fields;
    void message;
  };
  const context: ParseContext = {
    requestId: 'upgrade-test-req',
    apiClientId: 'upgrade-test-client',
    apiKeyId: 'upgrade-test-key',
    platform: platformId,
    originalUrl: new URL(url),
    realUrl: new URL(url),
    session: session as unknown as HttpSession,
    signal: AbortSignal.timeout(3_000),
    logger: { debug: noop, info: noop, warn: noop, error: noop },
    credentials,
  };
  const parser = getParserRegistration(platformId).factory(context);
  return parser.parse(context);
}

describe('upgraded social, video, and e-commerce parsers', () => {
  describe('Xiaohongshu upgrades', () => {
    it('resolves originVideoKey watermark-free video, spectrum/32-hex original images, JS SSR literals, and separated title/desc', async () => {
      const session = new MockSession();
      const rawSsr = `<script>window.__INITIAL_STATE__ = {
        "extraMap": new Map([["a", 1]]),
        "extraSet": new Set([1, 2]),
        "createdAt": new Date(),
        "emptyVal": undefined,
        "note": {
          "firstNoteId": "6700abc",
          "noteDetailMap": {
            "6700abc": {
              "note": {
                "title": "小红书标题",
                "desc": "小红书正文描述",
                "video": {
                  "consumer": { "originVideoKey": "spectrum/origin_video_1080p.mp4" },
                  "media": { "stream": { "h264": [{ "masterUrl": "https://cdn.example/watermarked.mp4" }] } }
                },
                "imageList": [
                  {
                    "urlDefault": "http://sns-webpic-qc.xhscdn.com/20261122/0123456789abcdef0123456789abcdef/spectrum/1040g00831xyz!nd_dft_wlteh_webp_3",
                    "livePhoto": true,
                    "stream": { "h265": [{ "masterUrl": "http:\\u002F\\u002Fsns-video-bd.xhscdn.com\\u002Flive_clip.mp4" }] }
                  },
                  {
                    "traceId": "1040g2sg31trace"
                  }
                ],
                "user": { "nickname": "小红薯", "userId": "u100", "avatar": "http://cdn.example/avatar.jpg" }
              }
            }
          }
        }
      };</script>`;
      session.texts.push(rawSsr);

      const output = await runParser('xiaohongshu', 'https://www.xiaohongshu.com/explore/6700abc', session);
      expect(output.title).toBe('小红书标题');
      expect(output.desc).toBe('小红书正文描述');
      expect(output.videoUrl).toBe('https://sns-video-bd.xhscdn.com/spectrum/origin_video_1080p.mp4');
      expect(output.imageList).toEqual([
        {
          url: 'https://sns-img-qc.xhscdn.com/spectrum/1040g00831xyz?imageView2/2/w/1920/format/jpg',
          livePhotoUrl: 'https://sns-video-bd.xhscdn.com/live_clip.mp4',
        },
        'https://sns-img-qc.xhscdn.com/1040g2sg31trace?imageView2/2/w/1920/format/jpg',
      ]);
      expect(output.author).toEqual({
        nickname: '小红薯',
        authorId: 'u100',
        avatar: 'https://cdn.example/avatar.jpg',
      });
    });

    it('detects deleted or private notes via empty noteDetailMap entry', async () => {
      const session = new MockSession();
      session.texts.push(
        `<script>window.__INITIAL_STATE__ = ${JSON.stringify({
          note: {
            firstNoteId: 'deleted-id',
            noteDetailMap: { 'deleted-id': { note: {} } },
          },
        })};</script>`,
      );
      const output = await runParser('xiaohongshu', 'https://www.xiaohongshu.com/explore/deleted-id', session);
      expect(output.terminalError?.code).toBe('MEDIA_DELETED_OR_PRIVATE');
      expect(session.calls).toHaveLength(1);
    });
  });

  describe('Bilibili upgrades', () => {
    it('supports AV numbers with anti-412 client UA and extracts video desc', async () => {
      const session = new MockSession();
      session.json.push(
        {
          code: 0,
          data: {
            bvid: 'BV1xx411c7mD',
            title: 'AV号视频测试',
            desc: '视频简介内容',
            pic: 'https://i0.hdslb.com/bfs/archive/cover.jpg',
            owner: { name: 'UP主', mid: 99, face: '//i0.hdslb.com/bfs/face/u.jpg' },
            pages: [{ cid: 888, page: 1 }],
          },
        },
        {
          code: 0,
          data: { durl: [{ url: 'https://upos-sz.bilivideo.com/av.mp4' }] },
        },
      );

      const output = await runParser('bilibili', 'https://www.bilibili.com/video/av170001', session);
      expect(session.calls[0]?.url).toContain('aid=170001');
      expect(session.calls[0]?.options.headers).toMatchObject({ 'user-agent': 'okhttp/4.9.3' });
      expect(output.title).toBe('AV号视频测试');
      expect(output.desc).toBe('视频简介内容');
      expect(output.videoUrl).toBe('https://upos-sz.bilivideo.com/av.mp4');
    });

    it('supports Dynamic / Opus image gallery posts and Bangumi ep/ss playback', async () => {
      const opusSession = new MockSession();
      opusSession.json.push({
        code: 0,
        data: {
          item: {
            modules: {
              module_author: { name: '画师UP', mid: 777, face: '//i0.hdslb.com/face.jpg' },
              module_dynamic: {
                major: {
                  opus: {
                    title: 'Opus图文标题',
                    summary: { text: 'Opus正文摘要' },
                    pics: [
                      { url: '//i0.hdslb.com/bfs/new_dyn/img1.png' },
                      { url: 'https://i0.hdslb.com/bfs/new_dyn/img2.png' },
                    ],
                  },
                },
              },
            },
          },
        },
      });
      const opus = await runParser('bilibili', 'https://www.bilibili.com/opus/987654321012345678', opusSession);
      expect(opus.title).toBe('Opus图文标题');
      expect(opus.desc).toBe('Opus正文摘要');
      expect(opus.imageList).toEqual([
        'https://i0.hdslb.com/bfs/new_dyn/img1.png',
        'https://i0.hdslb.com/bfs/new_dyn/img2.png',
      ]);

      const pgcSession = new MockSession();
      pgcSession.json.push(
        {
          code: 0,
          result: {
            title: '测试番剧',
            evaluate: '番剧简介',
            cover: 'https://i0.hdslb.com/season.jpg',
            up_info: { uname: '哔哩哔哩番剧', mid: 1000, avatar: 'https://i0.hdslb.com/up.jpg' },
            episodes: [{ id: 12345, cid: 555666, bvid: 'BV1pgc', title: '第1话', long_title: '启程' }],
          },
        },
        { code: 0, data: { pages: [{ cid: 555666 }] } },
        { code: 0, result: { durl: [{ url: 'https://upos-sz.bilivideo.com/pgc-ep1.mp4' }] } },
      );
      const pgc = await runParser('bilibili', 'https://www.bilibili.com/bangumi/play/ep12345', pgcSession);
      expect(pgc.title).toBe('测试番剧 第1话 启程');
      expect(pgc.desc).toBe('番剧简介');
      expect(pgc.videoUrl).toBe('https://upos-sz.bilivideo.com/pgc-ep1.mp4');

      const reg = getParserRegistration('bilibili');
      expect(reg.allowedHosts).toEqual(expect.arrayContaining(['api.bilibili.com', 'api.vc.bilibili.com']));
    });
  });

  describe('Xianyu MTOP signing & media upgrades', () => {
    it('signs MTOP requests with _m_h5_tk MD5 token and extracts intro video, HD gallery, desc, and seller', async () => {
      const session = new MockSession();
      session.texts.push(`<script>var url = 'https://m.tb.cn/h.abc?id=889900&price=299';</script>`);
      session.responses.push({
        statusCode: 200,
        url: new URL('https://h5api.m.goofish.com/h5/mtop.taobao.idle.item.info/1.0/'),
        headers: {
          'set-cookie': [
            '_m_h5_tk=mysecret_1700000000; Path=/; Domain=.goofish.com',
            '_m_h5_tk_enc=encval; Path=/; Domain=.goofish.com',
          ],
        },
        body: Buffer.from('{"ret":["FAIL_SYS_TOKEN_EMPTY::令牌为空"]}'),
      });
      session.json.push(
        {
          ret: ['SUCCESS::调用成功'],
          data: {
            title: '99新相机转让',
            description: '箱说全无拆修',
            imageInfos: [
              { url: '//img.alicdn.com/bao/uploaded/i1/cam1.jpg_790x10000Q75.jpg' },
              { url: 'http://img.alicdn.com/bao/uploaded/i2/cam2.png_400x400.jpg' },
            ],
          },
        },
        {
          ret: ['SUCCESS::调用成功'],
          data: {
            sellerDO: { nick: '闲***家', sellerId: 42, portraitUrl: '//img.alicdn.com/seller.jpg' },
            flowData: {
              floating: { components: [{ data: { userNick: '真实卖家昵称' } }] },
            },
            itemDO: {
              videoInfos: [{ videoUrl: 'http://cloud.video.taobao.com/play/u/intro.mp4' }],
            },
          },
        },
      );

      const output = await runParser('xianyu', 'https://e.tb.cn/h.shortlink', session);
      expect(output.title).toBe('99新相机转让');
      expect(output.desc).toBe('箱说全无拆修');
      expect(output.videoUrl).toBe('https://cloud.video.taobao.com/play/u/intro.mp4');
      expect(output.imageList).toEqual([
        'https://img.alicdn.com/bao/uploaded/i1/cam1.jpg',
        'https://img.alicdn.com/bao/uploaded/i2/cam2.png',
      ]);
      expect(output.author).toEqual({
        nickname: '真实卖家昵称',
        authorId: '42',
        avatar: 'https://img.alicdn.com/seller.jpg',
      });

      const signedCall = session.calls.find((call) => call.kind === 'json');
      const params = signedCall?.options.searchParams as Record<string, string>;
      const expectedSign = createHash('md5')
        .update(`mysecret&${params.t ?? ''}&12574478&${params.data ?? ''}`, 'utf8')
        .digest('hex');
      expect(params.sign).toBe(expectedSign);
      expect(getParserRegistration('xianyu').allowedHosts).toEqual(
        expect.arrayContaining(['h5api.m.goofish.com', 'acs.m.goofish.com']),
      );
    });
  });

  describe('Kuaishou GraphQL & anti-crawl upgrades', () => {
    it('falls back to GraphQL when HTML routes return incomplete state, and flags cookieRequired on anti-crawl', async () => {
      const gqlSession = new MockSession();
      // 3 candidate URLs * 2 header sets = 6 HTML calls
      for (let i = 0; i < 6; i += 1) {
        gqlSession.texts.push('<html><body>empty</body></html>');
      }
      gqlSession.json.push({
        data: {
          visionVideoDetail: {
            status: 1,
            author: { id: 'ks-u1', name: '老铁作者', headerUrl: '//tx2.a.kwimgs.com/head.jpg' },
            photo: {
              id: '3xphoto',
              caption: '快手GraphQL文案',
              coverUrl: '//tx2.a.kwimgs.com/cover.jpg',
              mainMvUrls: [{ url: 'https://txmov2.a.kwimgs.com/upic/video.mp4' }],
            },
          },
        },
      });

      const gqlOutput = await runParser(
        'kuaishou',
        'https://www.kuaishou.com/short-video/3xphoto',
        gqlSession,
        { cookie: 'kuaishou-managed-cookie' },
      );
      expect(gqlOutput.title).toBe('快手GraphQL文案');
      expect(gqlOutput.desc).toBe('快手GraphQL文案');
      expect(gqlOutput.videoUrl).toBe('https://txmov2.a.kwimgs.com/upic/video.mp4');
      const gqlCall = gqlSession.calls.find((c) => c.kind === 'json');
      expect(gqlCall?.url).toBe('https://www.kuaishou.com/graphql');
      expect(gqlCall?.options.headers).toMatchObject({ cookie: 'kuaishou-managed-cookie' });

      const blockedSession = new MockSession();
      for (let i = 0; i < 4; i += 1) {
        blockedSession.texts.push('{"result":2,"bizName":"ANTICRAWL_DEFAULT"}');
      }
      blockedSession.json.push({ result: 2 });
      const blockedOutput = await runParser(
        'kuaishou',
        'https://v.m.chenzhongtech.com/fw/photo/blocked-id',
        blockedSession,
      );
      expect(blockedOutput.cookieRequired).toBe(true);
    });
  });

  describe('Weibo LivePhoto, HD original images & cookie upgrades', () => {
    it('extracts LivePhotos from pic_infos and strips sinaimg.cn watermark buckets', async () => {
      expect(extractVideoOid(new URL('https://weibo.com/l/wblive/p/show/1022:230940500001'))).toBe('1022:230940500001');
      expect(extractWeiboId(new URL('https://weibo.com/2/detail/5335826707778519'))).toBe('5335826707778519');

      const session = new MockSession();
      // 1) m.weibo.cn/statuses/show returns not-ok -> 2) detail HTML empty -> 3) PC Ajax succeeds
      session.json.push({ ok: 0 });
      session.texts.push('<html></html>');
      session.json.push({
        ok: 1,
        text_raw: '微博实况图测试',
        pic_ids: ['picA', 'picB'],
        pic_infos: {
          picA: {
            type: 'livephoto',
            largest: { url: 'https://wx2.sinaimg.cn/large/picA.jpg' },
            video: 'https://video.weibo.com/media/play?livephoto=https%3A%2F%2Fus.sinaimg.cn%2FpicA.mov',
          },
          picB: {
            type: 'pic',
            mw2000: { url: 'https://wx3.sinaimg.cn/mw2000/picB.jpg' },
          },
        },
        user: { screen_name: '博主', id: 800, avatar_hd: 'https://tvax1.sinaimg.cn/avatar.jpg' },
      });

      const output = await runParser(
        'weibo',
        'https://weibo.com/800/5331959570240710',
        session,
        { cookie: 'SUB=weibo_session' },
      );
      expect(session.calls[0]?.options.headers).toMatchObject({ cookie: 'SUB=weibo_session' });
      expect(output.desc).toBe('微博实况图测试');
      expect(output.imageList).toEqual([
        {
          url: 'https://wx2.sinaimg.cn/osj1080/picA.jpg',
          livePhotoUrl: 'https://video.weibo.com/media/play?livephoto=https%3A%2F%2Fus.sinaimg.cn%2FpicA.mov',
        },
        'https://wx3.sinaimg.cn/osj1080/picB.jpg',
      ]);
    });
  });

  describe('Zuiyou, Pipigaoxiao & Pipixia upgrades', () => {
    it('extracts Zuiyou LivePhotos and mixed video+image posts', async () => {
      const session = new MockSession();
      session.json.push({
        data: {
          post: {
            content: '最右混合动态与实况图',
            member: { id: 301, name: '右友', avatar_urls: { origin: { urls: ['https://cdn.example/zy-a.jpg'] } } },
            imgs: [
              { id: 1, urls: { origin: { urls: ['https://cdn.example/main-cover.jpg'] } } },
              { id: 2, urls: { origin: { urls: ['https://cdn.example/lp-cover.jpg'] } } },
              {
                id: 3,
                urls: { origin: { urls: ['https://cdn.example/embedded-lp.jpg'] } },
                video: { url: 'https://cdn.example/embedded-lp.mp4' },
              },
              { id: 4, urls: { origin: { urls: ['https://cdn.example/static.jpg'] } } },
            ],
            videos: {
              '1': { url: 'https://cdn.example/main-video.mp4', dur: 22 },
              '2': { url: 'https://cdn.example/live-photo.mp4', dur: 2.4 },
            },
          },
        },
      });

      const output = await runParser('zuiyou', 'https://share.xiaochuankeji.cn/hybrid/share/post?pid=999', session);
      expect(output.videoUrl).toBe('https://cdn.example/main-video.mp4');
      expect(output.desc).toBe('最右混合动态与实况图');
      expect(output.imageList).toEqual([
        { url: 'https://cdn.example/lp-cover.jpg', livePhotoUrl: 'https://cdn.example/live-photo.mp4' },
        { url: 'https://cdn.example/embedded-lp.jpg', livePhotoUrl: 'https://cdn.example/embedded-lp.mp4' },
        'https://cdn.example/static.jpg',
      ]);
    });

    it('extracts Pipigaoxiao multi-image post galleries', async () => {
      const session = new MockSession();
      session.json.push({
        data: {
          post: {
            content: '皮皮搞笑图集',
            mid: 55,
            imgs: [
              { id: 201, urls: { origin: { urls: ['https://file.ippzone.com/origin/201.jpg'] } } },
              { id: 202 },
            ],
            videos: {},
          },
          user: { name: '搞笑君', mid: 55, avatar: '66' },
        },
      });

      const output = await runParser('pipigaoxiao', 'https://h5.pipigx.com/pp/post/789?pid=789', session);
      expect(output.videoUrl).toBeNull();
      expect(output.desc).toBe('皮皮搞笑图集');
      expect(output.imageList).toEqual([
        'https://file.ippzone.com/origin/201.jpg',
        'https://file.ippzone.com/img/view/id/202',
      ]);
    });

    it('extracts Pipixia H5 SSR encoded script payload directly without extra API call', async () => {
      const session = new MockSession();
      const ssrPayload = encodeURIComponent(
        JSON.stringify({
          seoTDK: { title: '皮皮虾SSR标题 - 皮皮虾' },
          ppxItemDetail: {
            item: {
              content: '皮皮虾正文内容',
              video: { video_download: { url_list: [{ url: 'https://cdn.example/ppx-hd.mp4' }] } },
              note: { multi_image: [{ url_list: [{ url: 'https://cdn.example/ppx-1.jpg' }] }] },
              cover: { url_list: [{ url: 'https://cdn.example/ppx-cover.jpg' }] },
              author: { id: 901, name: '皮友', avatar: { url_list: [{ url: 'https://cdn.example/ppx-av.jpg' }] } },
            },
          },
        }),
      );
      session.responses.push({
        statusCode: 200,
        url: new URL('https://h5.pipix.com/item/123456'),
        headers: {},
        body: Buffer.from(`<html><head></head><body><script>${ssrPayload}</script></body></html>`),
      });

      const output = await runParser('pipixia', 'https://h5.pipix.com/item/123456', session);
      expect(session.calls).toHaveLength(1);
      expect(output.videoUrl).toBe('https://cdn.example/ppx-hd.mp4');
      expect(output.imageList).toEqual(['https://cdn.example/ppx-1.jpg']);
      expect(output.desc).toBe('皮皮虾正文内容');
    });
  });

  describe('Qianwen, Zhihu, Haokan, Xinpianchang & WeChat Channels upgrades', () => {
    it('supports qianwen.com share API multimodal media and sets noMediaInContent for text-only chats', async () => {
      const mediaSession = new MockSession();
      mediaSession.texts.push('<html><body><div id="root"></div></body></html>');
      mediaSession.json.push({
        code: 0,
        data: {
          session: {
            title: '千问多模态生成',
            record_list: [
              {
                query: '生成一张猫咪图片',
                response_messages: [
                  {
                    content: [
                      { type: 'text', text: '已为您生成猫咪图片' },
                      { type: 'image_url', image_url: 'https://dashscope.oss.example/cat.png' },
                    ],
                  },
                ],
              },
            ],
          },
        },
      });
      const mediaOut = await runParser('qianwen', 'https://www.qianwen.com/share/chat/sh_12345', mediaSession);
      expect(mediaOut.title).toBe('千问多模态生成');
      expect(mediaOut.desc).toBe('已为您生成猫咪图片');
      expect(mediaOut.imageList).toEqual(['https://dashscope.oss.example/cat.png']);
      expect(mediaOut.noMediaInContent).toBeUndefined();

      const textSession = new MockSession();
      textSession.texts.push(
        `<script>window.__INITIAL_PROPS__ = ${JSON.stringify({
          initialData: {
            data: {
              session: {
                title: '纯文本问答',
                record_list: [{ query: '你好', response_messages: [{ text: '你好！有什么可以帮您？' }] }],
              },
            },
          },
        })};</script>`,
      );
      const textOut = await runParser('qianwen', 'https://tongyi.com/qianwen/share', textSession);
      expect(textOut.title).toBe('纯文本问答');
      expect(textOut.noMediaInContent).toBe(true);
    });

    it('passes ZHIHU_COOKIE, falls back to js-initialData HTML, and extracts desc', async () => {
      const session = new MockSession();
      session.json.push({ error: { code: 403, message: 'forbidden' } });
      session.texts.push(
        `<html><body><script id="js-initialData">${JSON.stringify({
          initialState: {
            entities: {
              articles: {
                '654321': {
                  title: '知乎专栏文章',
                  excerpt: '文章摘要内容',
                  title_image: 'https://pic1.zhimg.com/v2-cover.jpg',
                  content: '<p>正文<img data-original="https://pic2.zhimg.com/v2-body.jpg"></p>',
                  author: { name: '答主', urlToken: 'dazhu', avatarUrl: 'https://pic3.zhimg.com/av.jpg' },
                },
              },
            },
          },
        })}</script></body></html>`,
      );

      const output = await runParser(
        'zhihu',
        'https://www.zhihu.com/p/654321',
        session,
        { cookie: 'z_c0=zhihu-token' },
      );
      expect(session.calls[0]?.options.headers).toMatchObject({ cookie: 'z_c0=zhihu-token' });
      expect(output.title).toBe('知乎专栏文章');
      expect(output.desc).toBe('文章摘要内容');
      expect(output.imageList).toEqual([
        'https://pic1.zhimg.com/v2-cover.jpg',
        'https://pic2.zhimg.com/v2-body.jpg',
      ]);
    });

    it('extracts Haokan modern window.jsonData highest-rank clarity stream and desc', async () => {
      const session = new MockSession();
      session.texts.push(
        `<script>window.jsonData = ${JSON.stringify({
          data: {
            videoInfo: {
              title: '好看现代结构视频',
              desc: '好看视频描述',
              posterImage: 'https:\\/\\/pic.rmb.bdstatic.com\\/poster.jpg',
              clarityArr: [
                { rank: 1, url: 'https%3A%2F%2Fvd3.bdstatic.com%2Fsd.mp4' },
                { rank: 4, url: 'https%3A%2F%2Fvd3.bdstatic.com%2F1080p.mp4' },
              ],
            },
            author: { name: '好看作者', uk: 'hk-1', icon: 'https:\\/\\/pic.rmb.bdstatic.com\\/icon.jpg' },
          },
        })};</script>`,
      );

      const output = await runParser('haokan', 'https://haokan.baidu.com/v?vid=999', session);
      expect(output.videoUrl).toBe('https://vd3.bdstatic.com/1080p.mp4');
      expect(output.desc).toBe('好看视频描述');
      expect(output.author?.nickname).toBe('好看作者');
    });

    it('falls back to Xinpianchang __NEXT_DATA__ page when App API fails', async () => {
      const session = new MockSession();
      session.json.push({ status: -1 });
      session.texts.push(
        `<html><body><script id="__NEXT_DATA__">${JSON.stringify({
          props: {
            pageProps: {
              detail: {
                title: '新片场短片',
                content: '短片创作幕后描述',
                cover: 'https://oss-xpc0.xpccdn.com/cover.jpg',
                video: { vid: 'vid_abc', appKey: 'custom_key' },
                author: { userinfo: { id: 77, username: '导演甲', avatar: 'https://oss-xpc0.xpccdn.com/av.jpg' } },
              },
            },
          },
        })}</script></body></html>`,
      );
      session.json.push({
        status: 0,
        data: {
          resource: {
            progressive: [
              { height: 720, url: 'https://qiniu-xpc4.xpccdn.com/720p.mp4' },
              { height: 1080, url: 'https://qiniu-xpc4.xpccdn.com/1080p.mp4' },
            ],
          },
        },
      });

      const output = await runParser('xinpianchang', 'https://www.xinpianchang.com/a123456', session);
      expect(output.title).toBe('新片场短片');
      expect(output.desc).toBe('短片创作幕后描述');
      expect(output.videoUrl).toBe('https://qiniu-xpc4.xpccdn.com/1080p.mp4');
      expect(output.videoList).toEqual([
        'https://qiniu-xpc4.xpccdn.com/1080p.mp4',
        'https://qiniu-xpc4.xpccdn.com/720p.mp4',
      ]);
    });

    it('extracts WeChat Channels picInfo image gallery, bgmUrl audio, and separated title/desc', async () => {
      const session = new MockSession();
      session.json.push({
        errCode: 0,
        data: {
          authorInfo: { nickname: '视频号创作者', id: 'sph_u1', headImgUrl: 'https://wx.qlogo.cn/head.jpg' },
          feedInfo: {
            title: '视频号图文标题',
            description: '视频号图文详情文案',
            coverUrl: 'https://finder.video.qq.com/cover.jpg',
            picInfo: [
              { url: 'https://finder.video.qq.com/pic1.jpg' },
              { url: 'https://finder.video.qq.com/pic2.jpg' },
            ],
            bgmInfo: { bgmUrl: 'https://finder.video.qq.com/bgm.mp3' },
          },
        },
      });

      const output = await runParser('wechat_channels', 'https://weixin.qq.com/sph/AbCdEfGh', session);
      expect(output.title).toBe('视频号图文标题');
      expect(output.desc).toBe('视频号图文详情文案');
      expect(output.imageList).toEqual([
        'https://finder.video.qq.com/pic1.jpg',
        'https://finder.video.qq.com/pic2.jpg',
      ]);
      expect(output.audioUrl).toBe('https://finder.video.qq.com/bgm.mp3');
    });
  });
});
