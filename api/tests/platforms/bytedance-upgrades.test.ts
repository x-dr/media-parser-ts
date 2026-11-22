import { Buffer } from 'node:buffer';
import { describe, expect, it } from 'vitest';
import type { PlatformId } from '../../src/config/platforms.js';
import type { MediaResult } from '../../src/core/media-result.js';
import type { ParseContext, PlatformCredentials } from '../../src/core/parse-context.js';
import { getParserRegistration } from '../../src/core/parser-registry.js';
import type {
  HttpRequestOptions,
  HttpResponse,
  HttpSession,
} from '../../src/http/http-session.js';
import {
  buildDouyinCookieHeader,
  extractDouyinUifid,
  parseWebVttSubtitles,
  sanitizeDouyinPlayUrl,
  signDouyinSecsdk,
} from '../../src/platforms/douyin-shared.js';
import { sanitizeJimengVideoUrl } from '../../src/platforms/jimeng.js';
import {
  cleanToutiaoDescription,
  normalizeToutiaoArticle,
} from '../../src/platforms/toutiao.js';
import '../../src/platforms/doubao.js';
import '../../src/platforms/douyin.js';
import '../../src/platforms/jianying.js';
import '../../src/platforms/jimeng.js';
import '../../src/platforms/qsmusic.js';
import '../../src/platforms/toutiao.js';
import '../../src/platforms/xiaoyunque.js';
import '../../src/platforms/xigua.js';

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

  public async request(
    url: URL | string,
    options: HttpRequestOptions = {},
  ): Promise<HttpResponse> {
    this.calls.push({ kind: 'request', url: String(url), options });
    const value = this.responses.shift();
    if (!value) throw new Error('missing response fixture');
    return value;
  }
}

describe('Douyin upgrades', () => {
  it('sanitizes SecSDK cookies, extracts UIFID header, signs x-secsdk-web-signature, and completes client params', async () => {
    const rawCookie =
      'sessionid=my_sess; UIFID=deadbeef123456; bd_ticket_guard_client_data=toxic; ' +
      '_bd_ticket_crypt_cookie=toxic; __security_mc_1_s_sdk_cert_key=toxic; fpk1=toxic; ' +
      'x_tt_token=toxic; sdk_source_info=toxic; s_v_web_id=verify_expired; odin_tt=safe_odin';
    expect(extractDouyinUifid(rawCookie)).toBe('deadbeef123456');
    expect(
      extractDouyinUifid('ccaf4ddfc567c2ea7983832ca74975440c9b4528762c7e101401412a981d7e99'),
    ).toBe('ccaf4ddfc567c2ea7983832ca74975440c9b4528762c7e101401412a981d7e99');

    const cleanedCookie = buildDouyinCookieHeader(rawCookie, 'ttwid_1', false);
    expect(cleanedCookie).toContain('sessionid=my_sess');
    expect(cleanedCookie).toContain('UIFID=deadbeef123456');
    expect(cleanedCookie).toContain('odin_tt=safe_odin');
    expect(cleanedCookie).toContain('ttwid=ttwid_1');
    expect(cleanedCookie).not.toContain('bd_ticket_guard');
    expect(cleanedCookie).not.toContain('_bd_ticket_crypt_cookie');
    expect(cleanedCookie).not.toContain('__security');
    expect(cleanedCookie).not.toContain('fpk');
    expect(cleanedCookie).not.toContain('x_tt_token');
    expect(cleanedCookie).not.toContain('sdk_source_info');
    expect(cleanedCookie).not.toContain('verify_expired');

    const signed = signDouyinSecsdk(
      'https://www.douyin.com/aweme/v1/web/aweme/detail/?aweme_id=123',
      'deadbeef123456',
      1_789_880_000,
    );
    expect(signed).toContain('uifid=deadbeef123456');
    expect(signed).toContain('timestamp=1789880000');
    expect(signed).toContain('x-secsdk-web-signature=');

    const session = new FixtureSession();
    session.responses.push(ttwidResponse('ttwid-cookie'));
    session.json.push({
      aweme_detail: {
        itemTitle: '独立标题',
        desc: '视频文案正文',
        video: {
          origin_cover: { url_list: ['https://p3.douyinpic.com/static_origin.jpg'] },
          cover: { url_list: ['https://p3.douyinpic.com/normal.jpg'] },
          dynamic_cover: { url_list: ['https://p3.douyinpic.com/dynamic.webp'] },
          bit_rate: [
            {
              bit_rate: 1_500_000,
              is_h265: 0,
              width: 1280,
              height: 720,
              play_addr: { url_list: ['https://v26-web.douyinvod.com/720p.mp4'] },
            },
            {
              bit_rate: 1_200_000,
              is_h265: 0,
              width: 1920,
              height: 1080,
              play_addr: {
                url_list: [
                  'https://aweme.snssdk.com/aweme/v1/playwm/?video_id=v0d00fg1&ratio=720p',
                  'https://v11-weba.douyinvod.com/1080p.mp4',
                ],
              },
            },
          ],
          cla_info: {
            caption_infos: [
              {
                language_code: 'zh-Hans',
                url: 'http://p3-sign.douyinpic.com/tos-cn-p-0015/zh.vtt',
              },
            ],
          },
        },
        author: { nickname: '创作者', unique_id: 'dy_01' },
      },
    });
    session.texts.push(
      'WEBVTT\n\n1\n00:00:01.000 --> 00:00:03.500\n<c.yellow>大家好</c>\n\n2\n00:00:04.000 --> 00:00:06.000\n欢迎观看\n',
    );

    const output = await parse('douyin', 'https://www.douyin.com/video/734123456', session, {
      cookie: rawCookie,
    });
    const detailCall = session.calls.find((call) => call.kind === 'json');
    expect(detailCall?.url).toContain('version_code=190500');
    expect(detailCall?.url).toContain('version_name=19.5.0');
    expect(detailCall?.url).toContain('a_bogus=');
    expect(detailCall?.url).toContain('x-secsdk-web-signature=');
    expect(detailCall?.options.headers).toMatchObject({ uifid: 'deadbeef123456' });

    expect(output.title).toBe('独立标题');
    expect(output.desc).toBe('视频文案正文');
    expect(output.coverUrl).toBe('https://p3.douyinpic.com/static_origin.jpg');
    expect(output.videoUrl).toBe('https://v11-weba.douyinvod.com/1080p.mp4');
    expect(output.videoList[1]).toContain('/aweme/v1/play/');
    expect(output.videoList[1]).toContain('ratio=1080p');
    expect(output.videoList[1]).toContain('line=0');
    expect(output.subtitles).toEqual([
      { text: '大家好', startMs: 1000, endMs: 3500 },
      { text: '欢迎观看', startMs: 4000, endMs: 6000 },
    ]);
  });

  it('cleans playwm endpoints, extracts new LivePhoto motion fields, and suppresses BGM on image galleries', async () => {
    expect(
      sanitizeDouyinPlayUrl(
        'https://aweme.snssdk.com/aweme/v1/playwm/?video_id=v0d00abc&ratio=720p',
      ),
    ).toBe('https://aweme.snssdk.com/aweme/v1/play/?video_id=v0d00abc&ratio=1080p&line=0');

    const session = new FixtureSession();
    session.responses.push(ttwidResponse('ttwid-note'));
    session.json.push({
      aweme_detail: {
        aweme_type: 68,
        desc: '新版实况图集',
        image_post_info: {
          images: [
            {
              url_list: ['https://p1.douyinpic.com/thumb.jpg', 'https://p3.douyinpic.com/hd.jpg'],
              clip_video: {
                play_addr: { url_list: ['https://v11-weba.douyinvod.com/motion1.mp4'] },
              },
            },
            {
              display_image: { url_list: ['https://p3.douyinpic.com/img2.jpg'] },
              video: { play_addr: { uri: 'v0200fg10000abc12345' } },
            },
          ],
        },
        music: { play_url: { url_list: ['https://sf6-cdn-tos.douyinstatic.com/ies-music/bgm.mp3'] } },
        video: {
          play_addr: { url_list: ['https://sf6-cdn-tos.douyinstatic.com/ies-music/bgm.mp3'] },
        },
      },
    });

    const output = await parse('douyin', 'https://www.douyin.com/note/733754783', session);
    expect(output.videoUrl).toBeNull();
    expect(output.videoList).toEqual([]);
    expect(output.audioUrl).toBeNull();
    expect(output.desc).toBe('新版实况图集');
    expect(output.imageList).toEqual([
      {
        url: 'https://p3.douyinpic.com/hd.jpg',
        livePhotoUrl: 'https://v11-weba.douyinvod.com/motion1.mp4',
      },
      {
        url: 'https://p3.douyinpic.com/img2.jpg',
        livePhotoUrl:
          'https://www.iesdouyin.com/aweme/v1/play/?video_id=v0200fg10000abc12345&ratio=1080p&line=0&is_play_url=1&watermark=0&source=PackSourceEnum_PUBLISH',
      },
    ]);
  });

  it('falls back to Share-page SSR (_ROUTER_DATA / RENDER_DATA) when Web detail API fails', async () => {
    const session = new FixtureSession();
    session.responses.push(ttwidResponse('ttwid-ssr'));
    session.json.push({ status_code: 0 }, { status_code: 0 });
    const routerPayload = {
      loaderData: {
        'video_(id)/page': {
          videoInfoRes: {
            item_list: [
              {
                aweme_id: '7675236180098600202',
                desc: '分享页 SSR 兜底成功',
                video: {
                  play_addr: { url_list: ['https://v11-weba.douyinvod.com/ssr_video.mp4'] },
                  cover: { url_list: ['https://p3.douyinpic.com/ssr_cover.jpg'] },
                },
                author: { nickname: 'SSR作者', short_id: '888' },
              },
            ],
          },
        },
      },
    };
    session.texts.push(`<script>window._ROUTER_DATA = ${JSON.stringify(routerPayload)};</script>`);

    const output = await parse(
      'douyin',
      'https://www.iesdouyin.com/share/video/7675236180098600202',
      session,
    );
    expect(output.videoUrl).toBe('https://v11-weba.douyinvod.com/ssr_video.mp4');
    expect(output.coverUrl).toBe('https://p3.douyinpic.com/ssr_cover.jpg');
    expect(output.desc).toBe('分享页 SSR 兜底成功');
    expect(output.author?.nickname).toBe('SSR作者');
  });

  it('parses /lvdetail/ screening-room long videos and playlets, and short-circuits deleted/private works', async () => {
    const lvSession = new FixtureSession();
    lvSession.responses.push(ttwidResponse('ttwid-lv'));
    lvSession.json.push({
      status_code: 0,
      album_info: {
        album_id: '7677129845654061500',
        album_name: '放映厅热播剧',
        cover_url: { url_list: ['https://p3.douyinpic.com/album_cover.jpg'] },
        author: { nickname: '影视出品方', unique_id: 'film_studio' },
      },
      episode_info: {
        episode_id: '7677129845654061595',
        episode_name: '第01集 精彩开播',
        video: {
          bit_rate: [
            {
              bit_rate: 2_500_000,
              is_h265: 0,
              play_addr: { url_list: ['https://v11-weba.douyinvod.com/lv_ep1.mp4'] },
            },
          ],
        },
      },
    });
    const lvOutput = await parse(
      'douyin',
      'https://www.douyin.com/lvdetail/7677129845654061595',
      lvSession,
    );
    expect(lvOutput.title).toBe('【放映厅】放映厅热播剧 - 第01集 精彩开播');
    expect(lvOutput.videoUrl).toBe('https://v11-weba.douyinvod.com/lv_ep1.mp4');
    expect(lvOutput.coverUrl).toBe('https://p3.douyinpic.com/album_cover.jpg');

    const deletedSession = new FixtureSession();
    deletedSession.responses.push(ttwidResponse('ttwid-del'));
    deletedSession.json.push({
      status_code: 0,
      aweme_detail: null,
      filter_detail: {
        aweme_id: '7000000000000000001',
        detail_msg: '因作品权限或已被删除，无法观看，去看看其他作品吧',
        filter_reason: 'status_deleted',
      },
    });
    const deletedOutput = await parse(
      'douyin',
      'https://www.douyin.com/video/7000000000000000001',
      deletedSession,
    );
    expect(deletedSession.calls.filter((call) => call.kind === 'json')).toHaveLength(1);
    expect(deletedOutput.terminalError).toEqual({
      code: 'MEDIA_DELETED_OR_PRIVATE',
      message: '因作品权限或已被删除，无法观看，去看看其他作品吧',
    });

    expect(
      parseWebVttSubtitles('WEBVTT\n\n00:01:05.120 --> 00:01:08.500 line:0%\n<b>测试</b>字幕\n'),
    ).toEqual([{ text: '测试字幕', startMs: 65120, endMs: 68500 }]);
  });
});

describe('Xigua and Toutiao SSR + ByteDance VOD parsers', () => {
  it('parses Xigua mobile RENDER_DATA and resolves highest-bitrate ByteDance VOD stream', async () => {
    const tokenV2 = Buffer.from(
      JSON.stringify({ GetPlayInfoToken: 'Action=GetPlayInfo&video_id=v02004' }),
    ).toString('base64');
    const renderPayload = {
      articleInfo: {
        title: '测试西瓜视频',
        content: '西瓜视频正文',
        posterUrl: 'https://p3.ixigua.com/test_cover.jpg',
        mediaUser: {
          screenName: '西瓜创作者',
          avatarUrl: 'https://sf1.ixiguastatic.com/avatar.jpg',
        },
        playAuthTokenV2: tokenV2,
      },
    };
    const session = new FixtureSession();
    session.texts.push(
      `<script id="RENDER_DATA" type="application/json">${encodeURIComponent(
        JSON.stringify(renderPayload),
      )}</script>`,
    );
    session.json.push({
      Result: {
        Data: {
          CoverUrl: 'https://p3.ixigua.com/test_cover.jpg',
          PlayInfoList: [
            { Bitrate: 1_000_000, MainPlayUrl: 'https://v26.ixiguavod.com/720p.mp4' },
            { Bitrate: 2_500_000, MainPlayUrl: 'https://v26.ixiguavod.com/1080p.mp4' },
          ],
        },
      },
    });

    const output = await parse('xigua', 'https://www.ixigua.com/7676450021063735414', session);
    expect(output.title).toBe('测试西瓜视频');
    expect(output.desc).toBe('西瓜视频正文');
    expect(output.videoUrl).toBe('https://v26.ixiguavod.com/1080p.mp4');
    expect(output.coverUrl).toBe('https://p3.ixigua.com/test_cover.jpg');
    expect(output.author?.nickname).toBe('西瓜创作者');
  });

  it('parses Toutiao video VOD, micro-headline (微头条) images, article HTML images, and clean descriptions', async () => {
    expect(
      cleanToutiaoDescription(
        '<p>第一段&nbsp;<strong>重点</strong></p><p>第二段<br>换行 &amp; 更多</p><script>alert(1)</script>',
      ),
    ).toBe('第一段 重点\n第二段\n换行 & 更多');
    expect(cleanToutiaoDescription('<p> &nbsp; </p>')).toBeNull();

    const normalized = normalizeToutiaoArticle({
      seoTDK: { title: '突发热点观察-今日头条' },
      articleInfo: {
        bizTag: '微头条',
        thread: {
          threadBase: {
            content: '第一段\n\n第二段',
            largeImageList: [
              { url: 'https://p3-sign.toutiaoimg.com/a.jpeg' },
              { url: 'https://p3-sign.toutiaoimg.com/b.jpeg' },
            ],
            user: {
              info: {
                name: '头条作者',
                avatarUrl: 'https://p3-sign.toutiaoimg.com/avatar.jpeg',
              },
            },
          },
        },
      },
    });
    expect(normalized?.title).toBe('突发热点观察');

    const wSession = new FixtureSession();
    wSession.texts.push(
      `<script id="RENDER_DATA">${encodeURIComponent(
        JSON.stringify({
          seoTDK: { title: '微头条标题-今日头条' },
          articleInfo: {
            thread: {
              threadBase: {
                content: '<p>正文段落一</p><p>正文段落二</p>',
                largeImageList: [{ url: 'https://p3-sign.toutiaoimg.com/w1.jpeg' }],
                user: { info: { name: '微头条号', avatarUrl: 'https://p3.toutiaoimg.com/a.jpg' } },
              },
            },
          },
        }),
      )}</script>`,
    );
    const wOutput = await parse('toutiao', 'https://m.toutiao.com/w/1876628745217031/', wSession);
    expect(wOutput.title).toBe('微头条标题');
    expect(wOutput.desc).toBe('正文段落一\n正文段落二');
    expect(wOutput.imageList).toEqual(['https://p3-sign.toutiaoimg.com/w1.jpeg']);
    expect(wOutput.author?.nickname).toBe('微头条号');

    const vodSession = new FixtureSession();
    vodSession.texts.push(
      `<script id="TT_DATA">${JSON.stringify({
        articleInfo: {
          title: '头条视频测试',
          content: '<p>图文长文配图</p><img src="https://p3.toutiaoimg.com/inline1.jpg"><img data-src="https://p3.toutiaoimg.com/inline2.jpg">',
          videoId: 'v02004g10000toutiao',
        },
      })}</script>`,
    );
    vodSession.json.push({
      code: 0,
      data: {
        poster_url: 'https://p3.toutiaoimg.com/vod_poster.jpg',
        video_list: {
          video_1: { bitrate: 800_000, main_url: 'https://v26.toutiaovod.com/720p.mp4' },
          video_2: { bitrate: 1_800_000, main_url: 'https://v26.toutiaovod.com/1080p.mp4' },
        },
      },
    });
    const vodOutput = await parse(
      'toutiao',
      'https://www.toutiao.com/i7680960670263493172/',
      vodSession,
    );
    expect(vodOutput.videoUrl).toBe('https://v26.toutiaovod.com/1080p.mp4');
    expect(vodOutput.coverUrl).toBe('https://p3.toutiaoimg.com/vod_poster.jpg');
    expect(vodOutput.imageList).toEqual([
      'https://p3.toutiaoimg.com/inline1.jpg',
      'https://p3.toutiaoimg.com/inline2.jpg',
    ]);

    const reg = getParserRegistration('toutiao');
    expect(reg.allowedHosts).toEqual(
      expect.arrayContaining(['v.ixigua.com', 'ib.365yg.com', 'vas.snssdk.com']),
    );
  });
});

describe('QSMusic, Jianying/CapCut, Jimeng, Xiaoyunque, and Doubao upgrades', () => {
  it('flags VIP preview tracks and resolves template image URIs on QSMusic', async () => {
    const routerSession = new FixtureSession();
    routerSession.texts.push(
      `<script>_ROUTER_DATA = ${JSON.stringify({
        loaderData: {
          track_page: {
            audioWithLyricsOption: {
              url: 'https://audio.example.com/clip.mp4',
              trackName: '会员歌曲',
              artistName: '会员歌手',
              artistIdStr: '10086',
              coverURL: 'https://image.example.com/cover.jpg',
              duration: 264.333,
              offsetDuration: 30.001,
            },
          },
        },
      })};</script>`,
    );
    const routerOut = await parse(
      'qsmusic',
      'https://music.douyin.com/qishui/share/track?track_id=6845',
      routerSession,
    );
    expect(routerOut.isPreview).toBe(true);
    expect(routerOut.fullDuration).toBe(264.333);
    expect(routerOut.title).toBe('会员歌曲');
    expect(routerOut.author?.authorId).toBe('10086');

    const fallbackSession = new FixtureSession();
    fallbackSession.texts.push('<html></html>');
    fallbackSession.json.push({
      track: {
        name: 'Just to Be in Love',
        duration: 264_333,
        artists: [
          {
            id: 6769,
            name: 'Alex Rasov',
            url_avatar: { urls: ['https://img.example.com'], uri: 'avatar.jpg' },
          },
        ],
        album: { url_cover: { urls: ['https://img.example.com/'], uri: '/cover.jpg' } },
      },
      track_player: {
        video_model: JSON.stringify({
          video_duration: 30.001,
          video_list: [{ main_url: 'https://audio.example.com/player-clip.mp4' }],
        }),
      },
    });
    const fallbackOut = await parse(
      'qsmusic',
      'https://music.douyin.com/qishui/share/track?track_id=6845376862',
      fallbackSession,
    );
    expect(fallbackOut.isPreview).toBe(true);
    expect(fallbackOut.fullDuration).toBe(264.333);
    expect(fallbackOut.coverUrl).toBe('https://img.example.com/cover.jpg');
    expect(fallbackOut.author?.avatar).toBe('https://img.example.com/avatar.jpg');
  });

  it('resolves Jianying unwatermarked template videos and CapCut collaborative share videos', async () => {
    const jySession = new FixtureSession();
    jySession.json.push({
      data: {
        templates: [
          {
            title: '测试剪映模板',
            video_url: 'https://video.ulikecam.com/preview_watermarked.mp4',
            cover_url: 'https://image.ulikecam.com/cover.jpg',
            author: { name: '模板作者', uid: 42 },
          },
        ],
      },
    });
    jySession.responses.push(
      {
        statusCode: 206,
        url: new URL('https://video.ulikecam.com/preview_watermarked.mp4'),
        headers: {},
        body: Buffer.from('ftypmp42...vid:v028c2testvid12345...moov', 'latin1'),
      },
      {
        statusCode: 302,
        url: new URL('https://www.iesdouyin.com/aweme/v1/play/?video_id=v028c2testvid12345'),
        headers: { location: 'https://v26-weba.douyinvod.com/clean_1080p.mp4' },
        body: Buffer.alloc(0),
      },
    );
    const jyOut = await parse(
      'jianying',
      'https://lv.ulikecam.com/activity/lv/sharevideo?template_id=123456&item_type=0',
      jySession,
    );
    expect(jyOut.videoUrl).toBe('https://v26-weba.douyinvod.com/clean_1080p.mp4');

    const capcutSession = new FixtureSession();
    capcutSession.json.push(
      { ret: '0', data: { share_info_list: [{ share_id: 'inner_share_999' }] } },
      {
        ret: '0',
        data: {
          file_name: 'CapCut协作视频.mp4',
          uploader_name: 'CapCut创作者',
          uploader_id: '88888',
          normal_video: {
            player_720p: { main_url: 'https://v.capcut.com/clean_720p.mp4' },
          },
          cover_image: { preview_1080p_url: 'https://img.capcut.com/cover.jpg' },
        },
      },
    );
    const capcutOut = await parse(
      'jianying',
      'https://www.capcut.cn/share/7678345113499604249',
      capcutSession,
    );
    expect(capcutOut.title).toBe('CapCut协作视频.mp4');
    expect(capcutOut.videoUrl).toBe('https://v.capcut.com/clean_720p.mp4');
    expect(capcutOut.author?.nickname).toBe('CapCut创作者');
  });

  it('supports Jimeng managed cookie headers, watermark sanitization, AI images, and campaign fallback', async () => {
    expect(
      sanitizeJimengVideoUrl(
        'https://v3.jimeng.com/v?a=4066&lr=display_watermark_ending&cd=0%7C0%7C1%7C0&cv=1',
      ),
    ).toBe('https://v3.jimeng.com/v?a=4066&cd=0%7C0%7C0%7C0&cv=1');
    expect(sanitizeJimengVideoUrl('https://v3.jimeng.com/v?a=4066&cd=0|0|1|3&cv=1')).toBe(
      'https://v3.jimeng.com/v?a=4066&cd=0|0|0|3&cv=1',
    );

    const session = new FixtureSession();
    session.json.push(
      { ret: '2032', errmsg: 'itemId not exist' },
      {
        err_no: 0,
        data: {
          page_info: {
            creation: {
              prompt: 'AI回流作品',
              desc: '即梦活动分享文案',
              metadata: {
                video_url: 'https://v3.jimeng.com/v?a=1&cd=0|0|1|3',
                download_info: {
                  watermark_ending_url:
                    'https://v3.jimeng.com/ending.mp4?lr=watermark&cd=0%7C0%7C1%7C0',
                },
                cover_url: 'https://img.jimeng.com/cover.jpg',
              },
              author: { name: '即梦作者', uid: 'u_1' },
            },
          },
        },
      },
    );
    const output = await parse(
      'jimeng',
      'https://jimeng.jianying.com/activities/reflux/mproject?id=7683715084807376153',
      session,
      { cookie: 'jimeng_sess=abc' },
    );
    expect(session.calls[0]?.options.headers).toMatchObject({
      cookie: 'jimeng_sess=abc',
      appid: '581595',
      'device-platform': 'web',
    });
    expect(output.title).toBe('AI回流作品');
    expect(output.desc).toBe('即梦活动分享文案');
    expect(output.videoUrl).toBe('https://v3.jimeng.com/ending.mp4?cd=0%7C0%7C0%7C0');
    expect(output.videoList).toEqual([
      'https://v3.jimeng.com/ending.mp4?cd=0%7C0%7C0%7C0',
      'https://v3.jimeng.com/v?a=1&cd=0|0|0|3',
    ]);
  });

  it('parses Xiaoyunque inspiration/mini-drama pages and flags pure-text items', async () => {
    const guguSession = new FixtureSession();
    guguSession.json.push({
      err_no: 0,
      data: {
        page_info: {
          gugu_page: {
            current_index: 1,
            item_list: [
              { title: 'Ep 1', video_info: [{ video_url: 'https://xyq.jianying.com/ep1.mp4' }] },
              {
                title: 'F级废物给鬼号脉',
                desc: '第二集剧情',
                author_info: { nick_name: '浅酱雨禾', user_id: '99' },
                video_info: [
                  {
                    video_url: 'https://xyq.jianying.com/ep2.mp4',
                    cover_url: 'https://xyq.jianying.com/ep2.jpg',
                  },
                ],
              },
            ],
          },
        },
      },
    });
    const guguOut = await parse(
      'xiaoyunque',
      'https://xiaoyunque.jianying.com/activities/pippit_share?gugu_id=12345',
      guguSession,
    );
    expect(guguOut.title).toBe('F级废物给鬼号脉');
    expect(guguOut.desc).toBe('第二集剧情');
    expect(guguOut.videoUrl).toBe('https://xyq.jianying.com/ep2.mp4');
    expect(guguOut.coverUrl).toBe('https://xyq.jianying.com/ep2.jpg');

    const textOnlySession = new FixtureSession();
    textOnlySession.json.push({
      err_no: 0,
      data: {
        page_info: {
          inspiration_page: {
            item_info: { title: '纯文本灵感', desc: '没有图片或视频' },
          },
        },
      },
    });
    const textOnlyOut = await parse(
      'xiaoyunque',
      'https://xiaoyunque.jianying.com/activities/pippit_share?inspiration_id=1',
      textOnlySession,
    );
    expect(textOnlyOut.noMediaInContent).toBe(true);
  });

  it('supports Doubao pure-text dialogue desc + noMediaInContent, /chat/ route, and /music-sharing', async () => {
    const routerPayload = {
      data: {
        message_snapshot: {
          message_list: [
            { content: '请写一首关于秋天的古诗' },
            { content: '空山新雨后，天气晚来秋。明月松间照，清泉石上流。' },
          ],
        },
      },
    };
    const scriptArgs = JSON.stringify([
      'thread_(token)/page',
      [{ key: 'shareInfo', routerDataFnArgs: [JSON.stringify(routerPayload)] }],
    ]).replaceAll('"', '&quot;');

    const textSession = new FixtureSession();
    textSession.texts.push(
      `<script data-fn-name="mergeLoaderData" data-fn-args="${scriptArgs}"></script>`,
    );
    const textOut = await parse('doubao', 'https://www.doubao.com/chat/pure-text', textSession);
    expect(textOut.noMediaInContent).toBe(true);
    expect(textOut.desc).toBe(
      '请写一首关于秋天的古诗\n\n空山新雨后，天气晚来秋。明月松间照，清泉石上流。',
    );

    const musicSession = new FixtureSession();
    musicSession.json.push(
      { code: 0, data: { results: [] } },
      {
        code: 0,
        data: {
          media_type: 'audio',
          original_media_info: { main_url: 'https://v9-videoweb.doubao.com/music.mp4?lr=1&k=v' },
          poster_url: 'https://img.doubao.com/music.jpg',
        },
      },
    );
    const musicOut = await parse(
      'doubao',
      'https://www.doubao.com/music-sharing?vid=v02292g10006',
      musicSession,
    );
    expect(musicOut.title).toBe('豆包AI音乐分享');
    expect(musicOut.audioUrl).toBe('https://v9-videoweb.doubao.com/music.mp4?k=v');
    expect(musicOut.coverUrl).toBe('https://img.doubao.com/music.jpg');
  });
});

async function parse(
  platformId: PlatformId,
  url: string,
  session: FixtureSession,
  credentials: PlatformCredentials = {},
): Promise<MediaResult> {
  const noop = (): void => undefined;
  const context: ParseContext = {
    requestId: 'test-request',
    apiClientId: 'test-client',
    apiKeyId: 'test-key',
    platform: platformId,
    originalUrl: new URL(url),
    realUrl: new URL(url),
    session: session as unknown as HttpSession,
    signal: AbortSignal.timeout(2_000),
    logger: { debug: noop, info: noop, warn: noop, error: noop },
    credentials,
  };
  return getParserRegistration(platformId).factory(context).parse(context);
}

function ttwidResponse(ttwid: string): HttpResponse {
  return {
    statusCode: 200,
    url: new URL('https://ttwid.bytedance.com/ttwid/union/register/'),
    headers: { 'set-cookie': [`ttwid=${ttwid}; Path=/; Secure`] },
    body: Buffer.from('{}'),
  };
}
