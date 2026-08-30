import { describe, expect, it } from 'vitest';
import { detectPlatform, platformIds } from '../../src/config/platforms.js';
import {
  convertMediaUrlToHttps,
  extractShareUrl,
  getVideoId,
  normalizePlatformUrl,
} from '../../src/http/url-tools.js';

describe('platform URL tools', () => {
  it('defines exactly 31 stable platform IDs', () => {
    expect(platformIds).toHaveLength(31);
    expect(new Set(platformIds).size).toBe(31);
  });

  it('extracts a URL from sharing text', () => {
    expect(extractShareUrl('复制 https://www.douyin.com/video/123 试试')?.href)
      .toBe('https://www.douyin.com/video/123');
    expect(extractShareUrl('没有链接')).toBeNull();
  });

  it('extracts a URL adjacent to Chinese sharing text', () => {
    expect(extractShareUrl('复制这段话https://v.douyin.com/example/ 打开应用')?.href)
      .toBe('https://v.douyin.com/example/');
  });

  it('distinguishes xigua on the shared iesdouyin domain', () => {
    expect(detectPlatform(new URL('https://www.iesdouyin.com/xg/video/1'))).toBe('xigua');
    expect(detectPlatform(new URL('https://www.iesdouyin.com/share/video/1'))).toBe('douyin');
  });

  it('preserves only platform-specific query parameters', () => {
    const normalized = normalizePlatformUrl(new URL(
      'https://www.doubao.com/video-sharing?share_id=1&video_id=2&secret=discard',
    ));
    expect(normalized.searchParams.get('share_id')).toBe('1');
    expect(normalized.searchParams.get('video_id')).toBe('2');
    expect(normalized.searchParams.has('secret')).toBe(false);
  });

  it.each([
    ['https://haokan.baidu.com/v?vid=11&noise=x', 'https://haokan.baidu.com/v?vid=11'],
    ['https://isee.weishi.qq.com/ws/app-pages/share/index.html?id=22&noise=x', 'https://isee.weishi.qq.com/ws/app-pages/share/index.html?id=22'],
    ['https://www.xiaohongshu.com/explore/33?xsec_token=token&noise=x', 'https://www.xiaohongshu.com/explore/33?xsec_token=token'],
    ['https://www.douyin.com/?modal_id=44&noise=x', 'https://www.douyin.com/?modal_id=44'],
    ['https://kg.qq.com/node/play?s=66&noise=x', 'https://kg.qq.com/node/play?s=66'],
    ['https://izuiyou.com/post/detail?pid=77&noise=x', 'https://izuiyou.com/post/detail?pid=77'],
    ['https://weixin.qq.com/sph/AzGrUgqzFv?noise=x', 'https://weixin.qq.com/sph/AzGrUgqzFv'],
    ['https://klingai-share.kuaishou.com/h5-app/share?creative_id=123&work_id=123&creative_type=WORK&noise=x', 'https://klingai-share.kuaishou.com/h5-app/share?creative_id=123&work_id=123&creative_type=WORK'],
    ['https://w13.soulsmile.cn/activity/#/web/topic/detail?postIdEcpt=post&sign=signature&signVersion=0.0.1&noise=x', 'https://w13.soulsmile.cn/activity#/web/topic/detail?postIdEcpt=post&sign=signature&signVersion=0.0.1'],
    ['https://music.douyin.com/qishui/share/ugc_video?ugc_video_id=123&noise=x', 'https://music.douyin.com/qishui/share/ugc_video?ugc_video_id=123'],
    ['https://pd.qq.com/s/code?b=2&noise=x', 'https://pd.qq.com/s/code?b=2'],
    ['https://video.weibo.com/show?fid=1034:123&noise=x', 'https://video.weibo.com/show?fid=1034%3A123'],
    ['https://lv.ulikecam.com/activity/lv/sharevideo?template_id=123&item_type=0&noise=x', 'https://lv.ulikecam.com/activity/lv/sharevideo?template_id=123&item_type=0'],
    ['https://channels.weixin.qq.com/finder-preview/pages/sph?id=AzGrUgqzFv&noise=x', 'https://channels.weixin.qq.com/finder-preview/pages/sph?id=AzGrUgqzFv'],
    ['https://pages.quark.cn/r/ai-studio-mobile/external-share?shareId=abc&authorId=author&channel_from=ucpro&noise=x', 'https://pages.quark.cn/r/ai-studio-mobile/external-share?shareId=abc&authorId=author&channel_from=ucpro'],
    ['https://activity.qianwen.com/r/ai-studio-mobile/qwen-external-share?shareId=abc&authorId=author&channel_from=qwen&noise=x', 'https://activity.qianwen.com/r/ai-studio-mobile/qwen-external-share?shareId=abc&authorId=author&channel_from=qwen'],
  ])('normalizes %s with the full compatibility query table', (original, expected) => {
    expect(normalizePlatformUrl(new URL(original)).href).toBe(expected);
  });

  it('only upgrades explicit http media URLs', () => {
    expect(convertMediaUrlToHttps('http://cdn.example/video.mp4')).toBe('https://cdn.example/video.mp4');
    expect(convertMediaUrlToHttps('//cdn.example/video.mp4')).toBe('//cdn.example/video.mp4');
    expect(convertMediaUrlToHttps(null)).toBeNull();
  });

  it('preserves legacy video ID precedence and Soul fragment IDs', () => {
    expect(getVideoId(new URL('https://activity.qianwen.com/share?shareId=qwen-id&id=other')))
      .toBe('qwen-id');
    expect(getVideoId(new URL('https://w13.soulsmile.cn/#/detail?postIdEcpt=soul-id')))
      .toBe('soul-id');
  });

  it.each([
    ['https://www.doubao.com/video-sharing?video_id=video-id', 'video-id'],
    ['https://klingai-share.kuaishou.com/h5-app/share?creative_id=123', '123'],
    ['https://w13.soulsmile.cn/activity#/web/topic/detail?postIdEcpt=post', 'post'],
    ['https://music.douyin.com/qishui/share/ugc_video?ugc_video_id=123', '123'],
    ['https://lv.ulikecam.com/activity/lv/sharevideo?template_id=123', '123'],
    ['https://www.bilibili.com/video/BV123', 'BV123'],
    ['https://www.pearvideo.com/video_123.html', 'video_123'],
  ])('extracts the compatible video ID from %s', (url, expected) => {
    expect(getVideoId(new URL(url))).toBe(expected);
  });

  it.each([
    ['https://random-value.m.chenzhongtech.com/fw/photo/123', 'kuaishou'],
    ['https://weixin.qq.com/sph/id', 'wechat_channels'],
    ['https://channels.weixin.qq.com/finder-preview/pages/sph?id=abc', 'wechat_channels'],
    ['https://klingai-share.kuaishou.com/h5-app/share', 'kling'],
    ['https://w13.soulsmile.cn/activity/', 'soul'],
    ['https://qishui.douyin.com/s/code/', 'qsmusic'],
    ['https://music.douyin.com/track/123', 'qsmusic'],
    ['https://pd.qq.com/s/code', 'tencent_channel'],
    ['https://video.weibo.com/show', 'weibo'],
    ['https://lv.ulikecam.com/activity/lv/sharevideo', 'jianying'],
    ['https://xhslink.cn/o/20TUYRVv4eV', 'xiaohongshu'],
    ['https://pages.quark.cn/r/ai-studio-mobile/external-share', 'quark_ai'],
    ['https://act.quark.cn/apps/sharepages/routes/share', 'quark_ai'],
  ])('recognizes registered platform domain %s', (url, expected) => {
    expect(detectPlatform(new URL(url))).toBe(expected);
  });

  it.each([
    'https://random-value.m.chenzhongtech.com.evil.example/fw/photo/123',
    'https://random-valuem.chenzhongtech.com/fw/photo/123',
    'https://fakechenzhongtech.com/fw/photo/123',
  ])('rejects deceptive Kuaishou-like host %s', (url) => {
    expect(detectPlatform(new URL(url))).toBeNull();
  });
});
