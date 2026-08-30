import acfun from '../assets/acfun.webp';
import bilibili from '../assets/bilibili.webp';
import doubao from '../assets/doubao.webp';
import douyin from '../assets/douyin.webp';
import haokan from '../assets/haokan.webp';
import huya from '../assets/huya.webp';
import jianying from '../assets/jianying.webp';
import jimeng from '../assets/jimeng.webp';
import kling from '../assets/kling.webp';
import kuaishou from '../assets/kuaishou.webp';
import lishipin from '../assets/lishipin.webp';
import lvzhou from '../assets/lvzhou.webp';
import meipai from '../assets/meipai.webp';
import pipigaoxiao from '../assets/pipigaoxiao.webp';
import pipixia from '../assets/pipixia.webp';
import qianwen from '../assets/qianwen.webp';
import qsmusic from '../assets/qsmusic.webp';
import quanminkge from '../assets/quanminkge.webp';
import quarkAi from '../assets/quark_ai.webp';
import soul from '../assets/soul.webp';
import tencentChannel from '../assets/tencent_channel.webp';
import wechatChannels from '../assets/wechat_channels.webp';
import weibo from '../assets/weibo.webp';
import weishi from '../assets/weishi.webp';
import xianyu from '../assets/xianyu.webp';
import xiaohongshu from '../assets/xiaohongshu.webp';
import xiaoyunque from '../assets/xiaoyunque.webp';
import xigua from '../assets/xigua.webp';
import xinpianchang from '../assets/xinpianchang.webp';
import zhihu from '../assets/zhihu.webp';
import zuiyou from '../assets/zuiyou.webp';

const iconUrls: Readonly<Record<string, string>> = Object.freeze({
  acfun,
  bilibili,
  doubao,
  douyin,
  haokan,
  huya,
  jianying,
  jimeng,
  kling,
  kuaishou,
  lishipin,
  lvzhou,
  meipai,
  pipigaoxiao,
  pipixia,
  qianwen,
  qsmusic,
  quanminkge,
  quark_ai: quarkAi,
  soul,
  tencent_channel: tencentChannel,
  wechat_channels: wechatChannels,
  weibo,
  weishi,
  xianyu,
  xiaohongshu,
  xiaoyunque,
  xigua,
  xinpianchang,
  zhihu,
  zuiyou,
});

const fallbackColors: Readonly<Record<string, string>> = Object.freeze({
  bilibili: '#fb7299',
  douyin: '#161823',
  kuaishou: '#ff5000',
  qsmusic: '#13d3a1',
  wechat_channels: '#1f2329',
  weibo: '#e6162d',
  xianyu: '#ffe10b',
  xiaohongshu: '#ff2442',
  zhihu: '#0066ff',
});

export function platformIconUrl(platformId: string): string | null {
  return iconUrls[platformId] ?? null;
}

export function platformFallbackColor(platformId: string): string {
  return fallbackColors[platformId] ?? '#6c4de6';
}

export function platformFallbackMark(name: string): string {
  const latin = /[A-Za-z]+/u.exec(name)?.[0];
  if (latin) return latin.slice(0, 1).toUpperCase();
  const segments = new Intl.Segmenter('zh-CN', { granularity: 'grapheme' }).segment(name);
  return Array.from(segments, ({ segment }) => segment).slice(0, 1).join('');
}
