import { Buffer } from 'node:buffer';
import { describe, expect, it } from 'vitest';
import type { PlatformId } from '../../src/config/platforms.js';
import { UpstreamError } from '../../src/core/errors.js';
import type { MediaResult } from '../../src/core/media-result.js';
import type { ParseContext, PlatformCredentials } from '../../src/core/parse-context.js';
import { getParserRegistration } from '../../src/core/parser-registry.js';
import type { HttpRequestOptions, HttpResponse, HttpSession } from '../../src/http/http-session.js';
import '../../src/platforms/butterflyai.js';
import '../../src/platforms/hailuo.js';
import {
  extractKwaiyingTemplateId,
  generateKwaiyingSignParams,
} from '../../src/platforms/kwaiying.js';
import { extractPineconeParams } from '../../src/platforms/pinecone-moment.js';
import '../../src/platforms/wechat-mp.js';
import '../../src/platforms/yuanbao.js';

class FixtureSession {
  public readonly calls: { kind: string; url: string; options: HttpRequestOptions }[] = [];
  public readonly texts: (string | Error)[] = [];
  public readonly json: unknown[] = [];
  public readonly responses: (HttpResponse | Error)[] = [];

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
    if (value instanceof Error) throw value;
    return value;
  }
}

describe('batch B parser registrations and outbound host declarations', () => {
  it('registers all 6 platforms with explicit external API hosts', () => {
    expect(getParserRegistration('wechat_mp').allowedHosts).toContain('mp.weixin.qq.com');
    expect(getParserRegistration('yuanbao').allowedHosts).toContain('yb.tencent.com');
    expect(getParserRegistration('hailuo').allowedHosts).toContain('hailuoai.com');
    expect(getParserRegistration('butterflyai').allowedHosts).toContain('www.butterflyai.cn');
    expect(getParserRegistration('pinecone_moment').allowedHosts).toContain('m.pineconemoment.com');
    expect(getParserRegistration('kwaiying').allowedHosts).toContain('api.kmovie.gifshow.com');
  });
});

describe('WeChat MP parser (wechat_mp)', () => {
  const articleUrl = 'https://mp.weixin.qq.com/s/test_article_123';

  it('extracts article title, text description, upgraded /0? images, author, and mpvoice audio', async () => {
    const session = new FixtureSession();
    session.texts.push(`
      <!DOCTYPE html>
      <html>
      <head>
        <meta property="og:title" content="测试公众号标题" />
        <meta property="og:article:author" content="测试公众号" />
        <meta property="og:image" content="https://mmbiz.qpic.cn/cover.jpg" />
      </head>
      <body>
        <script>
          var msg_title = '测试公众号标题\\x26amp;特辑';
          var nickname = '测试公众号';
          var user_name = 'gh_123456789abc';
          var msg_cdn_url = 'https://mmbiz.qpic.cn/cover.jpg';
        </script>
        <h1 id="activity-name">测试公众号标题</h1>
        <a id="js_name">测试公众号</a>
        <div id="js_content">
          <p>第一段正文</p>
          <p>第二段正文</p>
          <img data-src="https://mmbiz.qpic.cn/mmbiz_png/test/640?wx_fmt=png" />
          <img data-src="https://mmbiz.qpic.cn/mmbiz_jpg/test2/300?wx_fmt=jpeg" />
          <mpvoice voice_encode_fileid="voice_file_999" name="语音"></mpvoice>
        </div>
      </body>
      </html>
    `);

    const output = await parse('wechat_mp', articleUrl, session);
    expect(output.title).toBe('测试公众号标题&特辑');
    expect(output.desc).toBe('第一段正文\n第二段正文');
    expect(output.author).toEqual({
      nickname: '测试公众号',
      authorId: 'gh_123456789abc',
      avatar: '',
    });
    expect(output.coverUrl).toBe('https://mmbiz.qpic.cn/cover.jpg');
    expect(output.imageList).toEqual([
      'https://mmbiz.qpic.cn/mmbiz_png/test/0?wx_fmt=png',
      'https://mmbiz.qpic.cn/mmbiz_jpg/test2/0?wx_fmt=jpeg',
    ]);
    expect(output.audioUrl).toBe('https://res.wx.qq.com/voice/getvoice?mediaid=voice_file_999');
  });

  it('selects highest quality clarity in single-video video_page_info pages', async () => {
    const session = new FixtureSession();
    session.texts.push(`
      <!DOCTYPE html>
      <html>
      <body>
        <script>
          window.cgiData = {
            title: '测试视频标题',
            user_name: 'gh_video123',
            nick_name: '视频号博主',
            round_head_img: 'https://mmbiz.qpic.cn/avatar.png',
            cdn_url: 'https://mmbiz.qpic.cn/cover.jpg',
          };
          video_page_info = {
            mp_video_trans_info: [
              {
                format_id: 10004,
                width: 480,
                height: 854,
                filesize: 1000,
                video_quality_level: 1,
                url: 'http://mpvideo.qpic.cn/video_low.mp4?k=1'
              },
              {
                format_id: 10002,
                width: 1080,
                height: 1920,
                filesize: 5000,
                video_quality_level: 3,
                url: 'http://mpvideo.qpic.cn/video_hd.mp4?k=2&amp;p=1'
              }
            ]
          };
        </script>
      </body>
      </html>
    `);

    const output = await parse('wechat_mp', articleUrl, session);
    expect(output.title).toBe('测试视频标题');
    expect(output.author).toEqual({
      nickname: '视频号博主',
      authorId: 'gh_video123',
      avatar: 'https://mmbiz.qpic.cn/avatar.png',
    });
    expect(output.videoUrl).toBe('http://mpvideo.qpic.cn/video_hd.mp4?k=2&p=1');
    expect(output.videoList).toEqual(['http://mpvideo.qpic.cn/video_hd.mp4?k=2&p=1']);
  });

  it('selects best clarity per video group for multi-video articles', async () => {
    const session = new FixtureSession();
    session.texts.push(`
      <!DOCTYPE html>
      <html>
      <head><meta property="og:title" content="多视频文章测试" /></head>
      <body>
        <script>
          var videoPageInfos = [
            {
              video_id: 'wxv_video_1',
              mp_video_trans_info: [
                {
                  format_id: 10004, width: 480, height: 854, filesize: 1000, video_quality_level: 1,
                  url: 'http://mpvideo.qpic.cn/0bc3vid1aaaa.f10004.mp4?k=1'
                },
                {
                  format_id: 10002, width: 1080, height: 1920, filesize: 5000, video_quality_level: 3,
                  url: 'http://mpvideo.qpic.cn/0bc3vid1aaaa.f10002.mp4?k=2'
                }
              ]
            },
            {
              video_id: 'wxv_video_2',
              mp_video_trans_info: [
                {
                  format_id: 10004, width: 640, height: 360, filesize: 2000, video_quality_level: 1,
                  url: 'http://mpvideo.qpic.cn/0bc3vid2bbbb.f10004.mp4?k=3'
                },
                {
                  format_id: 10002, width: 1280, height: 720, filesize: 6000, video_quality_level: 3,
                  url: 'http://mpvideo.qpic.cn/0bc3vid2bbbb.f10002.mp4?k=4'
                }
              ]
            }
          ];
        </script>
      </body>
      </html>
    `);

    const output = await parse('wechat_mp', articleUrl, session);
    expect(output.title).toBe('多视频文章测试');
    expect(output.videoUrl).toBe('http://mpvideo.qpic.cn/0bc3vid1aaaa.f10002.mp4?k=2');
    expect(output.videoList).toEqual([
      'http://mpvideo.qpic.cn/0bc3vid1aaaa.f10002.mp4?k=2',
      'http://mpvideo.qpic.cn/0bc3vid2bbbb.f10002.mp4?k=4',
    ]);
  });

  it('detects environment verification and deleted articles as terminal errors', async () => {
    const verifySession = new FixtureSession();
    verifySession.texts.push(
      '<html><head><link rel="stylesheet" href="//res.wx.qq.com/secitptpage/verify.css"></head><body><h2>环境异常</h2><p>完成验证后即可继续访问。</p></body></html>',
    );
    const verifyOutput = await parse('wechat_mp', articleUrl, verifySession);
    expect(verifyOutput.cookieRequired).toBe(true);
    expect(verifyOutput.terminalError?.code).toBe('COOKIE_REQUIRED');

    const deletedSession = new FixtureSession();
    deletedSession.texts.push('<html><body><h3>该内容已被发布者删除</h3></body></html>');
    const deletedOutput = await parse('wechat_mp', articleUrl, deletedSession);
    expect(deletedOutput.terminalError?.code).toBe('MEDIA_DELETED_OR_PRIVATE');

    const failSession = new FixtureSession();
    failSession.texts.push(new UpstreamError('http', 'HTTP 404', 404));
    const failOutput = await parse('wechat_mp', articleUrl, failSession);
    expect(failOutput.title).toBe('微信公众号文章');
    expect(failOutput.videoUrl).toBeNull();
  });
});

describe('Tencent Yuanbao parser (yuanbao)', () => {
  function makeNextPage(pageProps: Record<string, unknown>, title = '用户和元宝的对话'): string {
    const payload = { props: { pageProps }, page: '/s/[shareId]' };
    return `<html><head><title>${title}</title></head><body><script id="__NEXT_DATA__" type="application/json">${JSON.stringify(payload)}</script></body></html>`;
  }

  it('parses generated images from chat shares and forwards optional managed cookie', async () => {
    const session = new FixtureSession();
    session.texts.push(
      makeNextPage({
        fullChatShareData: {
          chat: {
            convs: [
              {
                speaker: 'human',
                userId: 'user-1',
                displayPrompt: '帮我生成一张海报',
                role: {
                  name: '测试用户',
                  imageUrl: 'https://avatar.example.com/user.jpg',
                },
              },
              {
                speaker: 'ai',
                speechesV2: [
                  {
                    extra: {
                      replaces: [
                        {
                          multimedias: [
                            {
                              type: 'loadingImage',
                              mediaType: 'image',
                              url: 'https://cos.example.com/preview.jpg',
                              downloadUrl: 'https://cos.example.com/original.jpg',
                              thumbnailUrl: 'https://cos.example.com/thumb.jpg',
                            },
                          ],
                        },
                      ],
                    },
                  },
                ],
              },
            ],
            shareCardInfo: {
              title: '[图片]帮我生成一张海报',
              imageFrom: 'loadingImage',
              coverUrl: 'https://cos.example.com/card.jpg',
            },
          },
        },
      }),
    );

    const output = await parse(
      'yuanbao',
      'https://yb.tencent.com/s/testShareId',
      session,
      { cookie: 'yb_cookie=secret' },
    );
    expect(session.calls[0]?.options.headers).toMatchObject({ cookie: 'yb_cookie=secret' });
    expect(output.title).toBe('帮我生成一张海报');
    expect(output.imageList).toEqual(['https://cos.example.com/original.jpg']);
    expect(output.coverUrl).toBe('https://cos.example.com/thumb.jpg');
    expect(output.videoUrl).toBeNull();
    expect(output.noMediaInContent).toBeUndefined();
    expect(output.author).toEqual({
      nickname: '测试用户',
      authorId: 'user-1',
      avatar: 'https://avatar.example.com/user.jpg',
    });
  });

  it('parses generated videos and standalone /bot/app/share/ fallback API', async () => {
    const chatVideoSession = new FixtureSession();
    chatVideoSession.texts.push(
      makeNextPage({
        fullChatShareData: {
          chat: {
            convs: [
              { speaker: 'human', displayPrompt: '让画面下雪' },
              {
                speaker: 'ai',
                speechesV2: [
                  {
                    extra: {
                      replaces: [
                        {
                          multimedias: [
                            {
                              type: 'loadingVideo',
                              mimeType: 'video/mp4',
                              url: 'https://cos.example.com/video.mp4',
                              downloadUrl: 'https://cos.example.com/video-original.mp4',
                              cover: 'https://cos.example.com/video-cover.jpg',
                            },
                          ],
                        },
                      ],
                    },
                  },
                ],
              },
            ],
            shareCardInfo: {
              title: '[视频]帮我生成视频：让画面下雪',
              imageFrom: 'loadingVideo',
            },
          },
        },
      }),
    );

    const videoOutput = await parse('yuanbao', 'https://yb.tencent.com/s/testVideo', chatVideoSession);
    expect(videoOutput.title).toBe('帮我生成视频：让画面下雪');
    expect(videoOutput.videoUrl).toBe('https://cos.example.com/video-original.mp4');
    expect(videoOutput.videoList).toEqual(['https://cos.example.com/video-original.mp4']);
    expect(videoOutput.coverUrl).toBe('https://cos.example.com/video-cover.jpg');
    expect(videoOutput.imageList).toEqual([]);

    const standaloneSession = new FixtureSession();
    standaloneSession.texts.push(makeNextPage({ shareId: 'standalone123' }));
    standaloneSession.json.push({
      title: '独立视频分享',
      extra: JSON.stringify({
        videoUrl: 'https://cos.example.com/standalone.mp4',
        coverUrl: 'https://cos.example.com/standalone-cover.jpg',
      }),
      userInfo: { nickname: '元宝创作者', userId: 'u-99' },
    });

    const standaloneOutput = await parse(
      'yuanbao',
      'https://yb.tencent.com/bot/app/share/standalone123?userId=u-99',
      standaloneSession,
      { cookie: 'yb_session=1' },
    );
    expect(standaloneSession.calls[1]?.url).toBe('https://yb.tencent.com/api/share/general_share_detail');
    expect(standaloneSession.calls[1]?.options.headers).toMatchObject({ cookie: 'yb_session=1' });
    expect(standaloneOutput.videoUrl).toBe('https://cos.example.com/standalone.mp4');
    expect(standaloneOutput.author?.nickname).toBe('元宝创作者');
  });

  it('marks text-only conversations with noMediaInContent and distinguishes deleted shares', async () => {
    const textOnlySession = new FixtureSession();
    textOnlySession.texts.push(
      makeNextPage({
        fullChatShareData: {
          chat: {
            convs: [
              { speaker: 'human', displayPrompt: '请用一句话介绍量子力学' },
              { speaker: 'ai', speechesV2: [{ content: '微观粒子的波粒二象性与概率演化。' }] },
            ],
            shareCardInfo: { title: '量子力学简介' },
          },
        },
      }),
    );
    const textOnlyOutput = await parse('yuanbao', 'https://yb.tencent.com/s/textChat', textOnlySession);
    expect(textOnlyOutput.title).toBe('量子力学简介');
    expect(textOnlyOutput.videoList).toEqual([]);
    expect(textOnlyOutput.imageList).toEqual([]);
    expect(textOnlyOutput.noMediaInContent).toBe(true);

    const deletedSession = new FixtureSession();
    deletedSession.texts.push(makeNextPage({ isShareDel: true, shareId: 'deleted' }));
    const deletedOutput = await parse('yuanbao', 'https://yb.tencent.com/s/deleted', deletedSession);
    expect(deletedOutput.imageList).toEqual([]);
    expect(deletedOutput.videoList).toEqual([]);
    expect(deletedOutput.noMediaInContent).toBeUndefined();
    expect(deletedOutput.terminalError?.code).toBe('MEDIA_DELETED_OR_PRIVATE');
  });
});

describe('Hailuo AI parser (hailuo)', () => {
  it('parses Next.js Flight SSR videoAsset and prefers downloadURLWithAIWatermark', async () => {
    const videoAsset = {
      id: '546156739889123328',
      desc: '第一秒的时候轻微点头，第二秒连续摇头',
      coverURL: 'https://cdn.hailuoai.com/cover.jpg',
      videoURL: 'https://cdn.hailuoai.com/preview.mp4',
      downloadURL: 'https://cdn.hailuoai.com/download.mp4',
      userIDStr: '546139659380772869',
      originFiles: [
        {
          id: '1',
          url: 'https://cdn.hailuoai.com/ref1.jpg',
          coverUrl: 'https://cdn.hailuoai.com/ref1_thumb.jpg',
        },
        {
          id: '2',
          url: 'https://cdn.hailuoai.com/ref2.jpg',
        },
      ],
      videoURLs: {
        downloadURLWithAIWatermark: 'https://cdn.hailuoai.com/clean_ai.mp4',
        downloadURLWithHailuoWatermark: 'https://cdn.hailuoai.com/brand_hailuo.mp4',
      },
    };
    const flightTree = ['$', 'div', null, { video: { videoAsset } }];
    const flightChunk = `25:${JSON.stringify(flightTree)}`;
    const html = `<!DOCTYPE html><html><body><script>self.__next_f.push([1,${JSON.stringify(flightChunk)}])</script></body></html>`;

    const session = new FixtureSession();
    session.texts.push(html);

    const output = await parse(
      'hailuo',
      'https://hailuoai.com/share/ai-video/enbrdg0JlAen?source-scene=shared',
      session,
    );
    expect(output.title).toBe('');
    expect(output.desc).toBe('第一秒的时候轻微点头，第二秒连续摇头');
    expect(output.videoUrl).toBe('https://cdn.hailuoai.com/clean_ai.mp4');
    expect(output.videoList).toEqual(['https://cdn.hailuoai.com/clean_ai.mp4']);
    expect(output.coverUrl).toBe('https://cdn.hailuoai.com/cover.jpg');
    expect(output.author?.authorId).toBe('546139659380772869');
    expect(output.imageList).toEqual([
      'https://cdn.hailuoai.com/ref1.jpg',
      'https://cdn.hailuoai.com/ref2.jpg',
    ]);
  });

  it('falls back to JSON-LD VideoObject metadata and handles empty pages', async () => {
    const ldJson = {
      '@context': 'https://schema.org',
      '@graph': [
        {
          '@type': 'VideoObject',
          name: '海螺视频测试标题',
          description: '这是详细描述',
          contentUrl: 'https://cdn.hailuoai.com/ld_video.mp4',
          thumbnailUrl: 'https://cdn.hailuoai.com/ld_thumb.jpg',
          author: { '@type': 'Person', name: '创作者小明' },
        },
      ],
    };
    const session = new FixtureSession();
    session.texts.push(
      `<!DOCTYPE html><html><head><script type="application/ld+json">${JSON.stringify(ldJson)}</script></head><body></body></html>`,
    );

    const output = await parse('hailuo', 'https://hailuoai.video/share/ai-video/test123', session);
    expect(output.title).toBe('海螺视频测试标题');
    expect(output.desc).toBe('这是详细描述');
    expect(output.videoUrl).toBe('https://cdn.hailuoai.com/ld_video.mp4');
    expect(output.coverUrl).toBe('https://cdn.hailuoai.com/ld_thumb.jpg');
    expect(output.author?.nickname).toBe('创作者小明');

    const emptySession = new FixtureSession();
    emptySession.texts.push('');
    const emptyOutput = await parse('hailuo', 'https://hailuoai.com/share/ai-video/invalid', emptySession);
    expect(emptyOutput.videoUrl).toBeNull();
    expect(emptyOutput.imageList).toEqual([]);
  });
});

describe('ButterflyAI parser (butterflyai)', () => {
  it('parses unwatermarked image galleries from share_code URLs', async () => {
    const session = new FixtureSession();
    session.json.push({
      status_code: 0,
      status_info: { status_code: 0, status_msg: 'Success' },
      share_record: {
        prompt: '清凉夏日胶片写真提示词',
        artwork: {
          title: '夏日清凉少女写真',
          cover_image_url: 'https://p26-community.butterfly.cn/cover.jpg',
        },
        creator: {
          user_id: 7788,
          screen_name: '星绘创作师',
          avatar: {
            large_url: 'https://p3-passport.byteacctimg.com/avatar_large.jpeg',
            image_url: 'https://p3-passport.byteacctimg.com/avatar.jpeg',
          },
        },
        rendering_images: [
          {
            no_wm_download_url: 'https://p26-community.butterfly.cn/pic1_hd.jpg',
            download_url: 'https://p26-community.butterfly.cn/pic1_wm.jpg',
          },
          {
            image_url: 'https://p26-community.butterfly.cn/pic2.jpg',
          },
        ],
      },
    });

    const output = await parse(
      'butterflyai',
      'https://www.butterflyai.cn/share/record?share_code=abc123Test',
      session,
    );
    expect(output.title).toBe('夏日清凉少女写真');
    expect(output.desc).toBe('清凉夏日胶片写真提示词');
    expect(output.author).toEqual({
      nickname: '星绘创作师',
      authorId: '7788',
      avatar: 'https://p3-passport.byteacctimg.com/avatar_large.jpeg',
    });
    expect(output.imageList).toEqual([
      'https://p26-community.butterfly.cn/pic1_hd.jpg',
      'https://p26-community.butterfly.cn/pic2.jpg',
    ]);
    expect(output.coverUrl).toBe('https://p26-community.butterfly.cn/cover.jpg');
    expect(output.videoUrl).toBeNull();
  });

  it('follows /s/{code}/ short links and parses rendering_video works', async () => {
    const session = new FixtureSession();
    session.responses.push({
      statusCode: 200,
      url: new URL('https://www.butterflyai.cn/share/record?share_code=vid123&share_id=rec99'),
      headers: {},
      body: Buffer.from(''),
    });
    session.json.push({
      status_code: 0,
      status_info: { status_code: 0, status_msg: 'Success' },
      share_record: {
        show_info: { effect_title: 'AI 视频变换' },
        creator: {
          screen_name: '特效大师',
          avatar_url: 'https://p3-passport.byteacctimg.com/avatar_str.jpeg',
        },
        rendering_video: {
          video_url: 'https://v-butterfly.douyinvod.com/video1.mp4',
          cover_image_url: 'https://v-butterfly.douyinvod.com/cover1.jpg',
        },
      },
    });

    const output = await parse('butterflyai', 'https://www.butterflyai.cn/s/gQ0EXE9BJsw/', session);
    expect(session.calls[0]?.kind).toBe('request');
    expect(session.calls[1]?.options.json).toMatchObject({
      share_token: 'vid123',
      share_record_id: 'rec99',
      from_h5: true,
    });
    expect(output.title).toBe('AI 视频变换');
    expect(output.videoUrl).toBe('https://v-butterfly.douyinvod.com/video1.mp4');
    expect(output.coverUrl).toBe('https://v-butterfly.douyinvod.com/cover1.jpg');
    expect(output.author?.nickname).toBe('特效大师');
  });
});

describe('Pinecone Moment parser (pinecone_moment)', () => {
  it('extracts story parameters and maps story videos, images, and dubbing audio', async () => {
    const storyUrl =
      'https://m.pineconemoment.com/h5/share/story/3473384016073334784?sharer_id=3458889976808366080&author_id=3458889976808366080&channel=7&version=1.19.0.47&share_id=3474647521796464640&story_type=1';

    expect(extractPineconeParams(new URL(storyUrl))).toMatchObject({
      item_id: '3473384016073334784',
      item_type: '1',
      channel: '7',
    });

    const session = new FixtureSession();
    session.json.push({
      code: 0,
      data: {
        story: {
          title: '有一種信念叫越野跑',
          creator: {
            user_id: '3458889976808366080',
            nickname: 'MissK',
            avatar: 'https://oss.example.com/avatar.png',
          },
          images: [
            {
              url: 'https://oss.example.com/page1.webp',
              video_url: 'https://oss.example.com/page1.mp4',
              video_cover_url: 'https://oss.example.com/cover.jpg',
            },
            {
              url: 'https://oss.example.com/page2.webp',
              video_url: 'https://oss.example.com/page2.mp4',
            },
          ],
          dubbing: { h5_audio: { audio_url: 'https://oss.example.com/dubbing.m4a' } },
        },
      },
    });

    const output = await parse('pinecone_moment', storyUrl, session);
    expect(output.title).toBe('有一種信念叫越野跑');
    expect(output.author).toEqual({
      nickname: 'MissK',
      authorId: '3458889976808366080',
      avatar: 'https://oss.example.com/avatar.png',
    });
    expect(output.imageList).toEqual([
      'https://oss.example.com/page1.webp',
      'https://oss.example.com/page2.webp',
    ]);
    expect(output.videoList).toEqual([
      'https://oss.example.com/page1.mp4',
      'https://oss.example.com/page2.mp4',
    ]);
    expect(output.videoUrl).toBe('https://oss.example.com/page1.mp4');
    expect(output.audioUrl).toBe('https://oss.example.com/dubbing.m4a');
    expect(output.coverUrl).toBe('https://oss.example.com/cover.jpg');
  });

  it('returns empty result without network request when story_id is absent', async () => {
    const session = new FixtureSession();
    const output = await parse(
      'pinecone_moment',
      'https://m.pineconemoment.com/o/4buqAENzZFE',
      session,
    );
    expect(session.calls).toHaveLength(0);
    expect(output.videoUrl).toBeNull();
    expect(output.imageList).toEqual([]);
  });
});

describe('Kwaiying parser (kwaiying)', () => {
  it('computes 64-bit BigInt MD5 signature matching upstream Python algorithm', () => {
    const signed = generateKwaiyingSignParams(1_700_000_000_000, 123_456_789_012);
    expect(signed).toEqual({
      timestamp: 1_700_000_000_000,
      nonce: 123_456_789_012,
      sign: '19655b4033397b24f60ca6a0ed4742be',
    });
  });

  it('extracts template ID variants and maps template video, audio, cover, and author', async () => {
    expect(
      extractKwaiyingTemplateId(
        new URL('https://share.kwaiying.com/share/template/index.html?templateId=999888'),
      ),
    ).toBe('999888');
    expect(
      extractKwaiyingTemplateId(
        new URL('https://share.kwaiying.com/share/template/index.html#/detail?template_id=777666'),
      ),
    ).toBe('777666');

    const session = new FixtureSession();
    session.json.push({
      result: 1,
      resource: {
        id: '8467216',
        name: '测试快影模板',
        videoUrl: 'https://video.example.com/kwaiying_video.mp4',
        templateBean: {
          coverUrl: 'https://image.example.com/kwaiying_cover.jpg',
          description: '快影描述文案',
          videoDuration: 25_000,
        },
        user: {
          nickName: '快影测试作者',
          userId: '12345678',
          iconUrlList: ['https://image.example.com/kwaiying_avatar.jpg'],
        },
        music: {
          url: 'https://audio.example.com/kwaiying_music.mp3',
        },
      },
    });

    const output = await parse(
      'kwaiying',
      'https://share.kwaiying.com/share/template/index.html?id=8467216&userId=702561542395651960',
      session,
    );
    expect(session.calls[0]?.url).toBe(
      'https://api.kmovie.gifshow.com/rest/n/kmovie/app/resource/getTemplateById',
    );
    expect(session.calls[0]?.options.searchParams).toMatchObject({ templateId: '8467216' });
    expect(output.title).toBe('测试快影模板');
    expect(output.desc).toBe('快影描述文案');
    expect(output.videoUrl).toBe('https://video.example.com/kwaiying_video.mp4');
    expect(output.videoList).toEqual(['https://video.example.com/kwaiying_video.mp4']);
    expect(output.coverUrl).toBe('https://image.example.com/kwaiying_cover.jpg');
    expect(output.audioUrl).toBe('https://audio.example.com/kwaiying_music.mp3');
    expect(output.author).toEqual({
      nickname: '快影测试作者',
      authorId: '12345678',
      avatar: 'https://image.example.com/kwaiying_avatar.jpg',
    });

    const missingIdSession = new FixtureSession();
    const missingOutput = await parse(
      'kwaiying',
      'https://share.kwaiying.com/share/template/index.html',
      missingIdSession,
    );
    expect(missingIdSession.calls).toHaveLength(0);
    expect(missingOutput.videoUrl).toBeNull();
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
