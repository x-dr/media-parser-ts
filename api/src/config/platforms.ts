export type MediaType = 'video' | 'images' | 'audio' | 'subtitles' | 'live_media';

export interface CredentialDefinition {
  name: string;
  environmentVariable: string;
  required: boolean;
}

export interface PlatformDefinition {
  displayName: string;
  domains: readonly string[];
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
    domains: ['kg.qq.com', 'kg2.qq.com', 'static-play.kg.qq.com'],
    mediaTypes: ['video'],
    credentials: [],
  },
  jianying: {
    displayName: '剪映',
    domains: ['lv.ulikecam.com'],
    mediaTypes: ['video', 'images', 'audio'],
    credentials: [],
  },
  jimeng: {
    displayName: '即梦AI',
    domains: ['jimeng.jianying.com', 'v.jimeng.aiseet.atry.com'],
    mediaTypes: ['video'],
    credentials: [],
  },
  xiaoyunque: {
    displayName: '小云雀AI',
    domains: ['xiaoyunque.jianying.com'],
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
    domains: ['www.bilibili.com', 'bilibili.com', 'b23.tv'],
    mediaTypes: ['video', 'audio'],
    credentials: [],
    bypassRedirectResolution: true,
  },
  haokan: {
    displayName: '好看视频',
    domains: ['haokan.baidu.com', 'haokan.hao123.com'],
    mediaTypes: ['video'],
    credentials: [],
  },
  xiaohongshu: {
    displayName: '小红书',
    domains: ['www.xiaohongshu.com', 'xiaohongshu.com', 'xhslink.com', 'xhslink.cn'],
    mediaTypes: ['video', 'images', 'live_media'],
    credentials: [
      { name: 'cookie', environmentVariable: 'XIAOHONGSHU_COOKIE', required: false },
    ],
  },
  wechat_channels: {
    displayName: '视频号',
    domains: ['weixin.qq.com', 'channels.weixin.qq.com'],
    mediaTypes: ['video'],
    credentials: [
      { name: 'yuanbao_cookie', environmentVariable: 'YUANBAO_COOKIE', required: false },
    ],
  },
  weibo: {
    displayName: '微博',
    domains: ['weibo.com', 'www.weibo.com', 'm.weibo.cn', 'video.weibo.com'],
    mediaTypes: ['video', 'images'],
    credentials: [],
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
    mediaTypes: ['video', 'images', 'audio'],
    credentials: [
      { name: 'cookie', environmentVariable: 'KUAISHOU_COOKIE', required: false },
    ],
  },
  douyin: {
    displayName: '抖音',
    domains: ['www.douyin.com', 'douyin.com', 'v.douyin.com', 'www.iesdouyin.com', 'iesdouyin.com'],
    mediaTypes: ['video', 'images', 'audio', 'live_media'],
    credentials: [],
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
    domains: ['izuiyou.com', 'www.izuiyou.com', 'share.xiaochuankeji.cn'],
    mediaTypes: ['video', 'images'],
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
    domains: ['h5.pipigx.com', 'pipigx.com'],
    mediaTypes: ['video'],
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
    credentials: [],
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
    domains: ['www.ixigua.com', 'ixigua.com', 'v.ixigua.com'],
    mediaTypes: ['video'],
    credentials: [],
  },
  doubao: {
    displayName: '豆包',
    domains: ['www.doubao.com', 'doubao.com'],
    mediaTypes: ['video', 'images'],
    credentials: [
      { name: 'cookie', environmentVariable: 'DOUBAO_COOKIE', required: false },
    ],
  },
  qianwen: {
    displayName: '通义千问',
    domains: ['activity.qianwen.com', 'qianwen.aliyun.com', 'tongyi.aliyun.com'],
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
    domains: ['e.tb.cn', 'm.tb.cn', 'tb.cn', 'h5.m.goofish.com', '2.taobao.com'],
    mediaTypes: ['images'],
    credentials: [],
  },
} as const satisfies Record<string, PlatformDefinition>;

export type PlatformId = keyof typeof platformDefinitions;

export const platformIds = Object.freeze(Object.keys(platformDefinitions) as PlatformId[]);

const domainEntries = platformIds.flatMap((platformId) =>
  platformDefinitions[platformId].domains.map((domain) => [domain, platformId] as const),
);

export const domainToPlatform = new Map<string, PlatformId>(domainEntries);

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
  return null;
}

export function getCredentialDefinition(
  platformId: PlatformId,
  credentialName: string,
): CredentialDefinition | null {
  return (
    platformDefinitions[platformId].credentials.find(
      (credential) => credential.name === credentialName,
    ) ?? null
  );
}
