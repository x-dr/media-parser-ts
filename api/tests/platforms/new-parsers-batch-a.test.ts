import { Buffer } from 'node:buffer';
import { describe, expect, it } from 'vitest';
import type { PlatformId } from '../../src/config/platforms.js';
import type { MediaResult } from '../../src/core/media-result.js';
import type { ParseContext, PlatformCredentials } from '../../src/core/parse-context.js';
import { getParserRegistration } from '../../src/core/parser-registry.js';
import type { HttpRequestOptions, HttpResponse, HttpSession } from '../../src/http/http-session.js';
import { detectMedia as detectQQMedia } from '../../src/platforms/qqmusic.js';
import { detectNeteaseMedia } from '../../src/platforms/netease-music.js';
import { detectKugouMedia, signKugouParams } from '../../src/platforms/kugou-music.js';
import '../../src/platforms/peiyinxiu.js';
import '../../src/platforms/lofter.js';
import '../../src/platforms/dewu.js';

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

describe('QQMusic parser (qqmusic)', () => {
  it('parses SSR MV metadata and ranks streams from highest to lowest quality', async () => {
    const session = new FixtureSession();
    const ssrPayload = {
      data: {
        video: {
          name: '《Speed of Summer》WINTER Teaser',
          cover_pic: 'http://img.tencentmusic.com/cover.jpg',
          uploader_nick: '普通搞笑人类',
        },
        creator: [
          {
            nick: '普通搞笑人类',
            mid: 'creator-id',
            avatar: 'https://y.qq.com/avatar.png',
          },
        ],
      },
    };
    session.texts.push(
      `<script>window.__ssrFirstPageData__=${JSON.stringify(JSON.stringify(ssrPayload))}</script>`,
    );
    session.json.push({
      mvInfo: {
        data: {
          '012XViNT0znYUR': {
            name: 'API title',
            cover_pic: 'http://img.tencentmusic.com/api-cover.jpg',
          },
        },
      },
      mvUrl: {
        data: {
          '012XViNT0znYUR': {
            mp4: [
              { code: 0, filetype: 20, freeflow_url: ['http://v0.stream.tencentmusic.com/720.mp4'] },
              { code: 0, filetype: 40, freeflow_url: ['http://v0.stream.tencentmusic.com/1080.mp4'] },
              { code: 2000, filetype: 60, freeflow_url: ['http://v0.stream.tencentmusic.com/blocked.mp4'] },
            ],
          },
        },
      },
    });

    const output = await parse(
      'qqmusic',
      'https://i2.y.qq.com/n3/other/pages/details/mv.html?vid=012XViNT0znYUR',
      session,
    );

    expect(output.title).toBe('《Speed of Summer》WINTER Teaser');
    expect(output.coverUrl).toBe('http://img.tencentmusic.com/cover.jpg');
    expect(output.author).toEqual({
      nickname: '普通搞笑人类',
      authorId: 'creator-id',
      avatar: 'https://y.qq.com/avatar.png',
    });
    expect(output.videoUrl).toBe('http://v0.stream.tencentmusic.com/1080.mp4');
    expect(output.videoList).toEqual([
      'http://v0.stream.tencentmusic.com/1080.mp4',
      'http://v0.stream.tencentmusic.com/720.mp4',
    ]);
  });

  it('parses song detail, direct audio URL, album cover, singer avatar, and base64 LRC lyrics', async () => {
    const session = new FixtureSession();
    const ssrSong = {
      song: {
        id: 719193124,
        mid: '004chp124O5JXy',
        name: '梦的翅膀受了伤 (大圆哥版)',
        singer: [{ name: '大圆哥', mid: '004PgdSk0OGCqs' }],
        album: { mid: '004YmefT4GaMTV' },
      },
    };
    session.texts.push(
      `<script>window.__ssrFirstPageData__=${JSON.stringify(JSON.stringify(ssrSong))}</script>`,
    );

    const sampleLrc = '[00:00.74]梦的翅膀受了伤 (大圆哥版) - 大圆哥\n[00:04.80]词 Lyricist：周玉荣\n';
    const lrcB64 = Buffer.from(sampleLrc, 'utf8').toString('base64');

    session.json.push({
      songinfo: {
        data: {
          track_info: {
            name: '梦的翅膀受了伤 (大圆哥版)',
            album: { mid: '004YmefT4GaMTV' },
            singer: [{ name: '大圆哥', mid: '004PgdSk0OGCqs' }],
          },
        },
      },
      playUrl: {
        data: {
          sip: ['http://aqqmusic.tc.qq.com/'],
          midurlinfo: [{ songmid: '004chp124O5JXy', purl: 'C400004chp124O5JXy.m4a?guid=233' }],
        },
      },
      lyric: {
        data: {
          lyric: lrcB64,
        },
      },
    });

    const output = await parse(
      'qqmusic',
      'https://i.y.qq.com/v8/playsong.html?songid=719193124#webchat_redirect',
      session,
    );

    expect(output.title).toBe('梦的翅膀受了伤 (大圆哥版)');
    expect(output.coverUrl).toBe(
      'https://y.qq.com/music/photo_new/T002R800x800M000004YmefT4GaMTV.jpg',
    );
    expect(output.author).toEqual({
      nickname: '大圆哥',
      authorId: '004PgdSk0OGCqs',
      avatar: 'https://y.qq.com/music/photo_new/T001R300x300M000004PgdSk0OGCqs.jpg',
    });
    expect(output.audioUrl).toBe('http://aqqmusic.tc.qq.com/C400004chp124O5JXy.m4a?guid=233');
    expect(output.subtitles).toEqual([
      { text: '梦的翅膀受了伤 (大圆哥版) - 大圆哥', startMs: 740, endMs: 4800 },
      { text: '词 Lyricist：周玉荣', startMs: 4800 },
    ]);
  });

  it('detects desktop MV and songDetail URLs and registers API hosts', () => {
    expect(detectQQMedia(new URL('https://y.qq.com/n/ryqq/mv/0140GhZ72SKjiQ'))).toEqual({
      mediaType: 'mv',
      vid: '0140GhZ72SKjiQ',
      songmid: '',
      songid: '',
    });
    expect(detectQQMedia(new URL('https://y.qq.com/n/ryqq/songDetail/004chp124O5JXy'))).toEqual({
      mediaType: 'song',
      vid: '',
      songmid: '004chp124O5JXy',
      songid: '',
    });
    const reg = getParserRegistration('qqmusic');
    expect(reg.allowedHosts).toContain('u.y.qq.com');
  });
});

describe('NetEase Music parser (netease_music)', () => {
  it('parses MV detail with highest quality stream first', async () => {
    const session = new FixtureSession();
    session.json.push({
      code: 200,
      data: {
        id: 34781314,
        name: '透明爱人',
        cover: 'http://p1.music.126.net/cover.jpg',
        artistName: '白鹿',
        artistId: 12603258,
        artists: [{ id: 12603258, name: '白鹿', img1v1Url: 'http://p1.music.126.net/artist.jpg' }],
        brs: {
          '480': 'http://vod.126.net/480.mp4',
          '1080': 'http://vod.126.net/1080.mp4',
          '720': 'http://vod.126.net/720.mp4',
        },
      },
    });

    const output = await parse(
      'netease_music',
      'https://fn.music.163.com/g/mlog/mlog-mobile/landing/mv?id=34781314',
      session,
    );

    expect(output.title).toBe('透明爱人');
    expect(output.author?.nickname).toBe('白鹿');
    expect(output.videoUrl).toBe('http://vod.126.net/1080.mp4');
    expect(output.videoList).toEqual([
      'http://vod.126.net/1080.mp4',
      'http://vod.126.net/720.mp4',
      'http://vod.126.net/480.mp4',
    ]);
  });

  it('parses mlog initial props video and profile', async () => {
    const session = new FixtureSession();
    const initialProps = {
      mlogInfo: {
        resource: {
          content: {
            title: '动态视频',
            image: [],
            video: {
              coverUrl: 'http://p1.music.126.net/mlog-cover.jpg',
              urlInfos: [
                { resolution: 360, url: 'http://vod.126.net/360.mp4' },
                { resolution: 1080, url: 'http://vod.126.net/1080.mp4' },
              ],
            },
          },
          profile: {
            userId: 123,
            nickname: '云村用户',
            avatarUrl: 'http://p1.music.126.net/avatar.jpg',
          },
        },
      },
      isServerError: false,
    };
    session.texts.push(`<script>window.__INITIAL_PROPS__ = ${JSON.stringify(initialProps)}\n</script>`);

    const output = await parse(
      'netease_music',
      'https://fn.music.163.com/g/mlog/mlog-mobile/landing/mlog?id=a123&type=2',
      session,
    );

    expect(output.title).toBe('动态视频');
    expect(output.author).toEqual({
      nickname: '云村用户',
      authorId: '123',
      avatar: 'http://p1.music.126.net/avatar.jpg',
    });
    expect(output.videoUrl).toBe('http://vod.126.net/1080.mp4');
    expect(output.videoList).toEqual([
      'http://vod.126.net/1080.mp4',
      'http://vod.126.net/360.mp4',
    ]);
  });

  it('parses event live photos, song audio, and LRC lyrics while preserving event title', async () => {
    const session = new FixtureSession();
    const eventObj = {
      user: {
        userId: 456,
        nickname: '动态作者',
        avatarUrl: 'http://p1.music.126.net/event-avatar.jpg',
      },
      json: JSON.stringify({
        title: '动态标题',
        msg: '动态正文',
        song: { id: 3383347615, name: '念张师' },
        videoData: null,
      }),
      pics: [
        {
          originUrl: 'http://p1.music.126.net/photo.jpg',
          videoOriginalUrl: 'http://vod.126.net/live.mov',
        },
      ],
    };
    const escapedEvent = JSON.stringify(eventObj)
      .replaceAll('&', '&amp;')
      .replaceAll('"', '&quot;')
      .replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;');
    session.texts.push(
      `<textarea name="txt" id="event-data" style="display:none;">${escapedEvent}</textarea>`,
    );
    session.json.push(
      {
        songs: [
          {
            id: 3383347615,
            name: '念张师',
            album: { picUrl: 'http://p1.music.126.net/album.jpg' },
            artists: [{ id: 1, name: '歌手' }],
          },
        ],
      },
      { data: [{ url: 'http://m801.music.126.net/song.mp3' }] },
      { lrc: { lyric: '[00:01.50]第一句\n[00:03.00]第二句' } },
    );

    const output = await parse(
      'netease_music',
      'https://music.163.com/event?id=37613855054&uid=13685426555',
      session,
    );

    expect(output.title).toBe('动态标题');
    expect(output.audioUrl).toBe('http://m801.music.126.net/song.mp3');
    expect(output.imageList).toEqual([
      {
        url: 'http://p1.music.126.net/photo.jpg',
        livePhotoUrl: 'http://vod.126.net/live.mov',
      },
    ]);
    expect(output.subtitles).toEqual([
      { text: '第一句', startMs: 1500, endMs: 3000 },
      { text: '第二句', startMs: 3000 },
    ]);
  });

  it('does not return fake audio for paid songs and skips network calls on invalid song IDs', async () => {
    const paidSession = new FixtureSession();
    paidSession.json.push(
      {
        songs: [
          {
            id: 472137906,
            name: '时差',
            album: { picUrl: 'http://p1.music.126.net/album.jpg' },
            artists: [{ id: 1, name: '鹿晗' }],
          },
        ],
      },
      { data: [{ url: null }] },
      { lrc: {} },
    );

    const paidOutput = await parse(
      'netease_music',
      'https://music.163.com/song?id=472137906',
      paidSession,
    );
    expect(paidOutput.title).toBe('时差');
    expect(paidOutput.audioUrl).toBeNull();

    const invalidSession = new FixtureSession();
    const invalidOutput = await parse(
      'netease_music',
      'https://music.163.com/song?id=invalid',
      invalidSession,
    );
    expect(invalidSession.calls).toHaveLength(0);
    expect(invalidOutput.audioUrl).toBeNull();

    expect(detectNeteaseMedia(new URL('https://music.163.com/#/song?id=472137906'))).toEqual({
      mediaType: 'song',
      mediaId: '472137906',
    });
  });
});

describe('Kugou Music parser (kugou_music)', () => {
  it('signs MV requests with MD5 and orders highest quality streams first', async () => {
    const session = new FixtureSession();
    session.json.push({
      errcode: 0,
      songname: '山海串烧',
      singer: '长啸',
      id: 1915905,
      mvicon: 'http://imge.kugou.com/mv/{size}/cover.jpg',
      mvdata: {
        sq: { downurl: 'https://mv.kugou.com/1080.mp4' },
        le: { downurl: 'https://mv.kugou.com/480.mp4' },
      },
    });

    const output = await parse(
      'kugou_music',
      'https://m.kugou.com/mv/?hash=48da1fe5cbe4f8774f73160042377b1e',
      session,
    );

    expect(output.title).toBe('山海串烧');
    expect(output.author?.nickname).toBe('长啸');
    expect(output.coverUrl).toBe('http://imge.kugou.com/mv/400/cover.jpg');
    expect(output.videoUrl).toBe('https://mv.kugou.com/1080.mp4');
    expect(output.videoList).toEqual([
      'https://mv.kugou.com/1080.mp4',
      'https://mv.kugou.com/480.mp4',
    ]);

    const searchParams = session.calls[0]?.options.searchParams as Record<string, string>;
    expect(searchParams.hash).toBe('48da1fe5cbe4f8774f73160042377b1e');
    const withoutSig = { ...searchParams };
    delete withoutSig.signature;
    expect(searchParams.signature).toBe(signKugouParams(withoutSig));
  });

  it('returns free song audio, blocks paid preview URLs, and supports desktop/share paths', async () => {
    const freeSession = new FixtureSession();
    const freeSong = {
      song_info: {
        data: {
          songName: '红红的太阳',
          pay_type: 0,
          album_img: 'https://imge.kugou.com/stdmusic/{size}/album.jpg',
          url: 'https://sharefs.kugou.com/full.mp3',
          authors: [{ author_name: '张韶涵', author_id: 123, avatar: 'https://imge.kugou.com/{size}/a.jpg' }],
        },
      },
    };
    freeSession.texts.push(`<script>var phpParam = ${JSON.stringify(freeSong)};</script>`);

    const freeOutput = await parse(
      'kugou_music',
      'http://www.kugou.com/share/1ixUXa2G5V3.html',
      freeSession,
    );
    expect(freeSession.calls[0]?.url).toBe('https://m.kugou.com/share/song.html?chain=1ixUXa2G5V3');
    expect(freeOutput.title).toBe('红红的太阳');
    expect(freeOutput.audioUrl).toBe('https://sharefs.kugou.com/full.mp3');
    expect(freeOutput.coverUrl).toBe('https://imge.kugou.com/stdmusic/400/album.jpg');
    expect(freeOutput.author).toEqual({
      nickname: '张韶涵',
      authorId: '123',
      avatar: 'https://imge.kugou.com/400/a.jpg',
    });

    const paidSession = new FixtureSession();
    const paidSong = {
      song_info: {
        data: {
          songName: '付费歌曲',
          pay_type: 3,
          error: '需要付费',
          url: 'https://sharefs.kugou.com/preview.mp3',
        },
      },
    };
    paidSession.texts.push(`<script>var phpParam = ${JSON.stringify(paidSong)};</script>`);
    const paidOutput = await parse(
      'kugou_music',
      'https://m.kugou.com/share/song.html?chain=paid',
      paidSession,
    );
    expect(paidOutput.title).toBe('付费歌曲');
    expect(paidOutput.audioUrl).toBeNull();

    expect(
      detectKugouMedia(
        new URL('https://www.kugou.com/mvweb/html/mv_48da1fe5cbe4f8774f73160042377b1e.html'),
      ),
    ).toEqual({
      mediaType: 'mv',
      contentId: '48da1fe5cbe4f8774f73160042377b1e',
    });
  });

  it('falls back to dataFromSmarty metadata when phpParam is absent', async () => {
    const session = new FixtureSession();
    session.texts.push(
      `<script>var dataFromSmarty = ${JSON.stringify([
        { song_name: 'Smarty 歌曲', author_name: '独立音乐人', author_id: 88 },
      ])};</script>`,
    );
    const output = await parse('kugou_music', 'https://m.kugou.com/share/song.html?chain=s1', session);
    expect(output.title).toBe('Smarty 歌曲');
    expect(output.author).toEqual({
      nickname: '独立音乐人',
      authorId: '88',
      avatar: '',
    });
  });
});

describe('Peiyinxiu parser (peiyinxiu)', () => {
  it('parses public dubbing work HTML and script values', async () => {
    const session = new FixtureSession();
    session.texts.push(`
      <div id="wlui" data-fid="535482401" data-uid="186214518"></div>
      <div class="athorName"><span>@DY_苏苏</span></div>
      <img class="userHead" src="//img7.peiyinxiu.com/avatar/test.jpg">
      <div class="filmName" data-title="七夕节你怎么过？">七夕节你怎么过？</div>
      <script>PlayByShowplay.play({filmurl: 'https://video7.peiyinxiu.com/download/test.mp4', filmimg: 'https://img7.peiyinxiu.com/test.jpg'});</script>
    `);

    const output = await parse('peiyinxiu', 'https://www.peiyinxiu.com/m/535482401', session);

    expect(output.title).toBe('七夕节你怎么过？');
    expect(output.videoUrl).toBe('https://video7.peiyinxiu.com/download/test.mp4');
    expect(output.videoList).toEqual(['https://video7.peiyinxiu.com/download/test.mp4']);
    expect(output.coverUrl).toBe('https://img7.peiyinxiu.com/test.jpg');
    expect(output.author).toEqual({
      nickname: 'DY_苏苏',
      authorId: '186214518',
      avatar: 'https://img7.peiyinxiu.com/avatar/test.jpg',
    });
  });

  it('handles missing media gracefully', async () => {
    const session = new FixtureSession();
    session.texts.push('<div id="wlui" data-uid="1"></div>');
    const output = await parse('peiyinxiu', 'https://www.peiyinxiu.com/m/535482401', session);
    expect(output.videoUrl).toBeNull();
    expect(output.videoList).toEqual([]);
  });
});

describe('LOFTER parser (lofter)', () => {
  it('parses photo gallery post from window.__initialize_data__', async () => {
    const session = new FixtureSession();
    const initData = {
      postData: {
        data: {
          blogInfo: {
            blogId: 1001,
            blogNickName: '画师小张',
            bigAvaImg: 'https://avaimg.lf127.net/ava.jpg',
          },
          postData: {
            postView: {
              title: '原创新画',
              type: 2,
              photoPostView: {
                caption: '<p>水彩练习作品</p>',
                photoLinks: [
                  { raw: 'https://imglf3.lf127.net/raw1.jpg', orign: 'https://imglf3.lf127.net/orig1.jpg' },
                  { raw: 'https://imglf3.lf127.net/raw2.jpg', orign: 'https://imglf3.lf127.net/orig2.jpg' },
                ],
                firstImage: { raw: 'https://imglf3.lf127.net/raw1.jpg' },
              },
            },
          },
        },
      },
    };
    session.texts.push(`<html><head><script>window.__initialize_data__ = ${JSON.stringify(initData)}</script></head></html>`);

    const output = await parse('lofter', 'https://author.lofter.com/post/abc_123', session);

    expect(output.title).toBe('原创新画');
    expect(output.desc).toBe('水彩练习作品');
    expect(output.videoUrl).toBeNull();
    expect(output.coverUrl).toBe('https://imglf3.lf127.net/raw1.jpg');
    expect(output.imageList).toEqual([
      'https://imglf3.lf127.net/raw1.jpg',
      'https://imglf3.lf127.net/raw2.jpg',
    ]);
    expect(output.author).toEqual({
      nickname: '画师小张',
      authorId: '1001',
      avatar: 'https://avaimg.lf127.net/ava.jpg',
    });
  });

  it('parses video post and legacy HTML fallback', async () => {
    const videoSession = new FixtureSession();
    const videoInitData = {
      postData: {
        data: {
          blogInfo: {
            blogNickName: '剪辑君',
            bigAvaImg: 'https://avaimg.lf127.net/ava2.jpg',
          },
          postData: {
            postView: {
              title: '同人短片',
              type: 4,
              videoPostView: {
                videoInfo: {
                  originUrl: 'https://vod.126.net/video.mp4',
                  video_img_url: 'https://imglf4.lf127.net/cover.jpg',
                },
              },
            },
          },
        },
      },
    };
    videoSession.texts.push(`<script>window.__initialize_data__ = ${JSON.stringify(videoInitData)};</script>`);

    const videoOutput = await parse('lofter', 'https://video.lofter.com/post/def_456', videoSession);
    expect(videoOutput.title).toBe('同人短片');
    expect(videoOutput.videoUrl).toBe('https://vod.126.net/video.mp4');
    expect(videoOutput.coverUrl).toBe('https://imglf4.lf127.net/cover.jpg');
    expect(videoOutput.author?.nickname).toBe('剪辑君');

    const fallbackSession = new FixtureSession();
    fallbackSession.texts.push(`
      <html>
        <head>
          <title>老页面标题 - LOFTER</title>
          <meta property="og:image" content="https://imglf3.lf127.net/fallback_cover.jpg">
        </head>
        <body>
          <video src="https://vod.126.net/fallback.mp4"></video>
          <img src="https://imglf3.lf127.net/gallery_1.jpg">
          <img src="https://avaimg.lf127.net/ava_skip.jpg">
        </body>
      </html>
    `);
    const fallbackOutput = await parse('lofter', 'https://author.lofter.com/post/old_789', fallbackSession);
    expect(fallbackOutput.title).toBe('老页面标题 - LOFTER');
    expect(fallbackOutput.videoUrl).toBe('https://vod.126.net/fallback.mp4');
    expect(fallbackOutput.coverUrl).toBe('https://imglf3.lf127.net/fallback_cover.jpg');
    expect(fallbackOutput.imageList).toEqual(['https://imglf3.lf127.net/gallery_1.jpg']);
  });
});

describe('Dewu parser (dewu)', () => {
  it('prefers unwatermarked media.list video over videoShareUrl and extracts gallery images', async () => {
    const session = new FixtureSession();
    const nextData = {
      props: {
        pageProps: {
          metaOGInfo: {
            data: [
              {
                content: {
                  contentId: 514124663,
                  title: '复古运动感跑鞋',
                  content: '好鞋分享灰绿渐变跑鞋',
                  cover: { url: 'https://image-cdn.dewu.com/cover.jpg' },
                  media: {
                    list: [
                      { mediaType: 'video', url: 'https://videocdn.poizon.com/video_clean.mp4' },
                      { mediaType: 'img', url: 'https://image-cdn.poizon.com/pic1.jpg' },
                    ],
                  },
                  videoShareUrl: 'https://videocdn.poizon.com/video_watermark.mp4',
                },
                userInfo: {
                  userId: 99,
                  userName: '888hdx',
                  icon: 'https://image-cdn.poizon.com/avatar.jpg',
                },
              },
            ],
          },
        },
      },
    };
    session.texts.push(`<html><head><script>${JSON.stringify(nextData)}</script></head></html>`);

    const output = await parse(
      'dewu',
      'https://m.dewu.com/rn-activity/community-share?trendId=514124663',
      session,
    );

    expect(output.title).toBe('复古运动感跑鞋');
    expect(output.desc).toBe('好鞋分享灰绿渐变跑鞋');
    expect(output.videoUrl).toBe('https://videocdn.poizon.com/video_clean.mp4');
    expect(output.coverUrl).toBe('https://image-cdn.dewu.com/cover.jpg');
    expect(output.imageList).toEqual(['https://image-cdn.poizon.com/pic1.jpg']);
    expect(output.author).toEqual({
      nickname: '888hdx',
      authorId: '99',
      avatar: 'https://image-cdn.poizon.com/avatar.jpg',
    });
  });

  it('parses pure image post with description and handles broken HTML cleanly', async () => {
    const imageSession = new FixtureSession();
    const imageData = {
      props: {
        pageProps: {
          metaOGInfo: {
            data: [
              {
                content: {
                  contentId: 452256836,
                  title: '',
                  content: '新年第一条项链',
                  cover: { url: 'https://image-cdn.poizon.com/cover.jpg' },
                  media: {
                    list: [
                      { mediaType: 'img', url: 'https://image-cdn.poizon.com/img1.jpg' },
                      { mediaType: 'img', url: 'https://image-cdn.poizon.com/img2.jpg' },
                    ],
                  },
                },
                userInfo: {
                  userName: 'YUTONG',
                  icon: 'https://image-cdn.poizon.com/ava.jpg',
                },
              },
            ],
          },
        },
      },
    };
    imageSession.texts.push(`<script id="__NEXT_DATA__" type="application/json">${JSON.stringify(imageData)}</script>`);

    const imageOutput = await parse(
      'dewu',
      'https://m.dewu.com/rn-activity/community-share?trendId=452256836',
      imageSession,
    );
    expect(imageOutput.title).toBe('');
    expect(imageOutput.desc).toBe('新年第一条项链');
    expect(imageOutput.videoUrl).toBeNull();
    expect(imageOutput.coverUrl).toBe('https://image-cdn.poizon.com/cover.jpg');
    expect(imageOutput.imageList).toEqual([
      'https://image-cdn.poizon.com/img1.jpg',
      'https://image-cdn.poizon.com/img2.jpg',
    ]);

    const brokenSession = new FixtureSession();
    brokenSession.texts.push('<html><body>404 Not Found</body></html>');
    const brokenOutput = await parse(
      'dewu',
      'https://m.dewu.com/rn-activity/community-share?trendId=1',
      brokenSession,
    );
    expect(brokenOutput.title).toBe('');
    expect(brokenOutput.videoUrl).toBeNull();
    expect(brokenOutput.imageList).toEqual([]);
    expect(brokenOutput.author).toBeNull();
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
