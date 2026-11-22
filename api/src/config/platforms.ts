export type MediaType = 'video' | 'images' | 'audio' | 'subtitles' | 'live_media';

export interface CredentialDefinition {
  name: string;
  environmentVariable: string;
  aliases?: readonly string[];
  required: boolean;
}

export interface PlatformDefinition {
  displayName: string;
  domains: readonly string[];
  wildcardHosts?: readonly string[];
  mediaTypes: readonly MediaType[];
  credentials: readonly CredentialDefinition[];
  bypassRedirectResolution?: boolean;
}

export const platformDefinitions = {
  acfun: {
    displayName: 'AcFun',
    domains: ['www.acfun.cn', 'acfun.cn', 'm.acfun.cn'],
    mediaTypes: ['video'],
    credentials: [],
  },
  soul: {
    displayName: 'Soul',
    domains: ['w13.soulsmile.cn'],
    mediaTypes: ['video', 'images'],
    credentials: [],
  },
  quanminkge: {
    displayName: '全民K歌',
    domains: ['kg.qq.com', 'kg2.qq.com', 'kg3.qq.com', 'static-play.kg.qq.com'],
    mediaTypes: ['video'],
    credentials: [],
  },
  jianying: {
    displayName: '剪映',
    domains: ['lv.ulikecam.com', 'www.capcut.cn', 'capcut.cn', 'www.capcut.com', 'capcut.com'],
    mediaTypes: ['video', 'images', 'audio'],
    credentials: [],
  },
  jimeng: {
    displayName: '即梦AI',
    domains: [
      'jimeng.jianying.com',
      'm.jimeng.jianying.com',
      'v.jimeng.aiseet.atry.com',
      'jimeng.ai',
      'www.jimeng.ai',
    ],
    mediaTypes: ['video', 'images'],
    credentials: [
      { name: 'cookie', environmentVariable: 'JIMENG_COOKIE', required: false },
    ],
  },
  xiaoyunque: {
    displayName: '小云雀AI',
    domains: ['xiaoyunque.jianying.com', 'xyq.jianying.com'],
    mediaTypes: ['video', 'images'],
    credentials: [],
    bypassRedirectResolution: true,
  },
  kling: {
    displayName: '可灵AI',
    domains: ['klingai-share.kuaishou.com'],
    mediaTypes: ['video'],
    credentials: [],
  },
  bilibili: {
    displayName: '哔哩哔哩',
    domains: ['www.bilibili.com', 'bilibili.com', 'b23.tv', 'm.bilibili.com', 't.bilibili.com'],
    mediaTypes: ['video', 'images', 'audio'],
    credentials: [],
    bypassRedirectResolution: true,
  },
  haokan: {
    displayName: '好看视频',
    domains: [
      'haokan.baidu.com',
      'haokan.hao123.com',
      'mr.baidu.com',
      'sv.baidu.com',
      'baijiahao.baidu.com',
      'm.baidu.com',
      'mbd.baidu.com',
    ],
    mediaTypes: ['video'],
    credentials: [],
  },
  xiaohongshu: {
    displayName: '小红书',
    domains: ['www.xiaohongshu.com', 'xiaohongshu.com', 'xhslink.com', 'xhslink.cn'],
    mediaTypes: ['video', 'images', 'live_media'],
    credentials: [
      {
        name: 'cookie',
        environmentVariable: 'XIAOHONGSHU_COOKIE',
        aliases: ['XHS_COOKIE'],
        required: false,
      },
    ],
  },
  wechat_channels: {
    displayName: '视频号',
    domains: ['weixin.qq.com', 'channels.weixin.qq.com', 'finder.video.qq.com'],
    mediaTypes: ['video', 'images', 'audio'],
    credentials: [
      {
        name: 'yuanbao_cookie',
        environmentVariable: 'YUANBAO_COOKIE',
        aliases: ['WECHAT_CHANNELS_COOKIE'],
        required: false,
      },
    ],
  },
  weibo: {
    displayName: '微博',
    domains: [
      'weibo.com',
      'www.weibo.com',
      'weibo.cn',
      'm.weibo.cn',
      'video.weibo.com',
      'h5.video.weibo.com',
      't.cn',
      'mapp.api.weibo.cn',
    ],
    mediaTypes: ['video', 'images', 'live_media'],
    credentials: [
      { name: 'cookie', environmentVariable: 'WEIBO_COOKIE', required: false },
    ],
    bypassRedirectResolution: true,
  },
  weishi: {
    displayName: '微视',
    domains: ['isee.weishi.qq.com', 'video.weishi.qq.com'],
    mediaTypes: ['video'],
    credentials: [],
  },
  kuaishou: {
    displayName: '快手',
    domains: [
      'www.kuaishou.com',
      'kuaishou.com',
      'v.kuaishou.com',
      'm.kuaishou.com',
      'c.kuaishou.com',
      'v.m.chenzhongtech.com',
      'm.chenzhongtech.com',
    ],
    wildcardHosts: ['*.m.chenzhongtech.com'],
    mediaTypes: ['video', 'images', 'audio'],
    credentials: [
      {
        name: 'cookie',
        environmentVariable: 'KUAISHOU_COOKIE',
        aliases: ['KS_COOKIE'],
        required: false,
      },
    ],
  },
  douyin: {
    displayName: '抖音',
    domains: [
      'www.douyin.com',
      'douyin.com',
      'v.douyin.com',
      'm.douyin.com',
      'www.iesdouyin.com',
      'iesdouyin.com',
    ],
    mediaTypes: ['video', 'images', 'audio', 'subtitles', 'live_media'],
    credentials: [
      {
        name: 'cookie',
        environmentVariable: 'DOUYIN_COOKIE',
        aliases: ['DY_COOKIE'],
        required: false,
      },
    ],
  },
  xinpianchang: {
    displayName: '新片场',
    domains: ['www.xinpianchang.com', 'xinpianchang.com'],
    mediaTypes: ['video'],
    credentials: [],
    bypassRedirectResolution: true,
  },
  zuiyou: {
    displayName: '最右',
    domains: ['izuiyou.com', 'www.izuiyou.com', 's.izuiyou.com', 'share.xiaochuankeji.cn'],
    mediaTypes: ['video', 'images', 'live_media'],
    credentials: [],
  },
  lishipin: {
    displayName: '梨视频',
    domains: ['www.pearvideo.com', 'pearvideo.com'],
    mediaTypes: ['video'],
    credentials: [],
  },
  qsmusic: {
    displayName: '汽水音乐',
    domains: ['qishui.douyin.com', 'music.douyin.com'],
    mediaTypes: ['video', 'audio', 'subtitles'],
    credentials: [],
  },
  pipigaoxiao: {
    displayName: '皮皮搞笑',
    domains: ['h5.pipigx.com', 'pipigx.com', 'h5.ippzone.com'],
    mediaTypes: ['video', 'images'],
    credentials: [],
  },
  pipixia: {
    displayName: '皮皮虾',
    domains: ['pipix.com', 'www.pipix.com', 'h5.pipix.com'],
    mediaTypes: ['video', 'images'],
    credentials: [],
  },
  zhihu: {
    displayName: '知乎',
    domains: ['www.zhihu.com', 'zhihu.com', 'zhuanlan.zhihu.com'],
    mediaTypes: ['video', 'images'],
    credentials: [
      { name: 'cookie', environmentVariable: 'ZHIHU_COOKIE', required: false },
    ],
    bypassRedirectResolution: true,
  },
  lvzhou: {
    displayName: '绿洲',
    domains: ['oasis.weibo.cn'],
    mediaTypes: ['video', 'images'],
    credentials: [],
    bypassRedirectResolution: true,
  },
  meipai: {
    displayName: '美拍',
    domains: ['www.meipai.com', 'meipai.com'],
    mediaTypes: ['video'],
    credentials: [],
  },
  tencent_channel: {
    displayName: '腾讯频道',
    domains: ['pd.qq.com'],
    mediaTypes: ['video'],
    credentials: [],
  },
  huya: {
    displayName: '虎牙',
    domains: ['www.huya.com', 'huya.com', 'v.huya.com', 'm.huya.com', 'hy.fan'],
    mediaTypes: ['video'],
    credentials: [],
  },
  xigua: {
    displayName: '西瓜视频',
    domains: ['www.ixigua.com', 'ixigua.com', 'v.ixigua.com', 'm.ixigua.com'],
    mediaTypes: ['video'],
    credentials: [],
  },
  doubao: {
    displayName: '豆包',
    domains: ['www.doubao.com', 'doubao.com'],
    mediaTypes: ['video', 'images', 'audio'],
    credentials: [
      { name: 'cookie', environmentVariable: 'DOUBAO_COOKIE', required: false },
    ],
  },
  qianwen: {
    displayName: '通义千问',
    domains: [
      'qianwen.com',
      'www.qianwen.com',
      'activity.qianwen.com',
      'qianwen.aliyun.com',
      'tongyi.aliyun.com',
      'qianwen.my.cn',
      'pages.tongyi.com',
      'tongyi.com',
      'www.tongyi.com',
    ],
    mediaTypes: ['video', 'images'],
    credentials: [],
    bypassRedirectResolution: true,
  },
  quark_ai: {
    displayName: '夸克AI',
    domains: ['pages.quark.cn', 'act.quark.cn'],
    mediaTypes: ['video', 'images'],
    credentials: [],
    bypassRedirectResolution: true,
  },
  xianyu: {
    displayName: '闲鱼',
    domains: [
      'e.tb.cn',
      'm.tb.cn',
      'tb.cn',
      'goofish.com',
      'www.goofish.com',
      'market.m.taobao.com',
      'h5.m.goofish.com',
      '2.taobao.com',
    ],
    mediaTypes: ['video', 'images'],
    credentials: [],
  },
  wechat_mp: {
    displayName: '微信公众号',
    domains: ['mp.weixin.qq.com'],
    mediaTypes: ['video', 'images', 'audio'],
    credentials: [],
    bypassRedirectResolution: true,
  },
  toutiao: {
    displayName: '今日头条',
    domains: [
      'm.toutiao.com',
      'www.toutiao.com',
      'toutiao.com',
      'is.snssdk.com',
      'adshare.toutiao.com',
    ],
    mediaTypes: ['video', 'images'],
    credentials: [],
  },
  hailuo: {
    displayName: '海螺AI',
    domains: ['hailuoai.com', 'www.hailuoai.com', 'hailuoai.video', 'www.hailuoai.video'],
    mediaTypes: ['video', 'images'],
    credentials: [],
    bypassRedirectResolution: true,
  },
  yuanbao: {
    displayName: '腾讯元宝',
    domains: ['yb.tencent.com', 'yuanbao.tencent.com'],
    mediaTypes: ['video', 'images'],
    credentials: [
      {
        name: 'cookie',
        environmentVariable: 'YUANBAO_COOKIE',
        aliases: ['WECHAT_CHANNELS_COOKIE'],
        required: false,
      },
    ],
  },
  pinduoduo: {
    displayName: '拼多多',
    domains: [
      'mobile.yangkeduo.com',
      'yangkeduo.com',
      'pinduoduo.com',
      'www.pinduoduo.com',
      'mobile.pinduoduo.com',
    ],
    mediaTypes: ['video', 'images', 'audio'],
    credentials: [
      {
        name: 'cookie',
        environmentVariable: 'PINDUODUO_COOKIE',
        aliases: ['PDD_COOKIE'],
        required: false,
      },
    ],
  },
  qqmusic: {
    displayName: 'QQ音乐',
    domains: ['c6.y.qq.com', 'i.y.qq.com', 'i2.y.qq.com', 'y.qq.com', 'www.y.qq.com'],
    mediaTypes: ['video', 'audio', 'subtitles'],
    credentials: [],
  },
  netease_music: {
    displayName: '网易云音乐',
    domains: [
      '163cn.tv',
      'music.163.com',
      'www.music.163.com',
      'y.music.163.com',
      'fn.music.163.com',
    ],
    mediaTypes: ['video', 'images', 'audio', 'subtitles'],
    credentials: [],
  },
  kugou_music: {
    displayName: '酷狗音乐',
    domains: ['kugou.com', 't1.kugou.com', 'm.kugou.com', 'm3ws.kugou.com', 'www.kugou.com'],
    mediaTypes: ['video', 'audio'],
    credentials: [],
  },
  peiyinxiu: {
    displayName: '配音秀',
    domains: ['peiyinxiu.com', 'www.peiyinxiu.com'],
    mediaTypes: ['video'],
    credentials: [],
  },
  pinecone_moment: {
    displayName: '松果时刻',
    domains: ['pineconemoment.com', 'm.pineconemoment.com'],
    mediaTypes: ['video', 'images', 'audio'],
    credentials: [],
  },
  kwaiying: {
    displayName: '快影',
    domains: ['share.kwaiying.com', 'kwaiying.com', 'www.kwaiying.com'],
    mediaTypes: ['video', 'audio'],
    credentials: [],
    bypassRedirectResolution: true,
  },
  fanqie: {
    displayName: '番茄小说',
    domains: ['fqnovel.com', 'zlink.fqnovel.com', 'changdunovel.com'],
    mediaTypes: ['video'],
    credentials: [],
  },
  hongguo_duanju: {
    displayName: '红果短剧',
    domains: ['novelquickapp.com', 'qznovel.com'],
    mediaTypes: ['video'],
    credentials: [],
  },
  hongguo_manju: {
    displayName: '红果漫剧',
    domains: ['kylin.hainanyuyue.com', 'hainanyuyue.com'],
    mediaTypes: ['video'],
    credentials: [],
  },
  dewu: {
    displayName: '得物',
    domains: [
      'dw4.co',
      'dewu.com',
      'www.dewu.com',
      'm.dewu.com',
      'poizon.com',
      'www.poizon.com',
    ],
    wildcardHosts: ['*.dewu.com', '*.poizon.com'],
    mediaTypes: ['video', 'images'],
    credentials: [],
    bypassRedirectResolution: true,
  },
  lofter: {
    displayName: '网易LOFTER',
    domains: ['lofter.com', 'www.lofter.com'],
    wildcardHosts: ['*.lofter.com'],
    mediaTypes: ['video', 'images'],
    credentials: [],
    bypassRedirectResolution: true,
  },
  butterflyai: {
    displayName: '星绘AI',
    domains: ['butterflyai.cn', 'www.butterflyai.cn'],
    wildcardHosts: ['*.butterflyai.cn'],
    mediaTypes: ['video', 'images'],
    credentials: [],
  },
  cctv: {
    displayName: '央视',
    domains: [
      'cctv.com',
      'tv.cctv.com',
      'cctv.cn',
      'tv.cctv.cn',
      'content-static.cctvnews.cctv.com',
      'cctvnews.cctv.com',
      'news.cctv.com',
    ],
    wildcardHosts: ['*.cctv.com', '*.cctv.cn'],
    mediaTypes: ['video'],
    credentials: [],
    bypassRedirectResolution: true,
  },
  yangshipin: {
    displayName: '央视频',
    domains: ['yspapp.cn', 'www.yspapp.cn', 'yangshipin.cn', 'm.yangshipin.cn'],
    wildcardHosts: ['*.yangshipin.cn', '*.yspapp.cn'],
    mediaTypes: ['video', 'images'],
    credentials: [],
  },
} as const satisfies Record<string, PlatformDefinition>;

export type PlatformId = keyof typeof platformDefinitions;

export const platformIds = Object.freeze(Object.keys(platformDefinitions) as PlatformId[]);

const domainEntries = platformIds.flatMap((platformId) =>
  platformDefinitions[platformId].domains.map((domain) => [domain, platformId] as const),
);

export const domainToPlatform = new Map<string, PlatformId>(domainEntries);

export const allPlatformAllowedHosts: readonly string[] = Object.freeze([
  ...new Set(
    platformIds.flatMap((platformId) => {
      const definition: PlatformDefinition = platformDefinitions[platformId];
      return [...definition.domains, ...(definition.wildcardHosts ?? [])];
    }),
  ),
]);

export function getPlatformAllowedHosts(platformId: PlatformId): string[] {
  const definition: PlatformDefinition = platformDefinitions[platformId];
  return [...definition.domains, ...(definition.wildcardHosts ?? [])];
}

export function detectPlatform(url: URL): PlatformId | null {
  const hostname = url.hostname.toLowerCase().replace(/\.$/, '');
  if (
    (hostname === 'www.iesdouyin.com' || hostname === 'iesdouyin.com') &&
    url.pathname.startsWith('/xg/')
  ) {
    return 'xigua';
  }
  const exact = domainToPlatform.get(hostname);
  if (exact) return exact;
  if (hostname.endsWith('.m.chenzhongtech.com')) return 'kuaishou';
  if (hostname.endsWith('.lofter.com')) return 'lofter';
  if (hostname.endsWith('.dewu.com') || hostname.endsWith('.poizon.com')) return 'dewu';
  if (hostname.endsWith('.butterflyai.cn')) return 'butterflyai';
  if (hostname.endsWith('.cctv.com') || hostname.endsWith('.cctv.cn')) return 'cctv';
  if (hostname.endsWith('.yangshipin.cn') || hostname.endsWith('.yspapp.cn')) return 'yangshipin';
  return null;
}

export function getCredentialDefinition(
  platformId: PlatformId,
  credentialName: string,
): CredentialDefinition | null {
  const definition: PlatformDefinition = platformDefinitions[platformId];
  return (
    definition.credentials.find(
      (credential) => credential.name === credentialName,
    ) ?? null
  );
}
