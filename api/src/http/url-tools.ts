import { detectPlatform, type PlatformId } from '../config/platforms.js';

const PASSTHROUGH_QUERY_PLATFORMS = new Set<PlatformId>([
  'xiaoyunque',
  'fanqie',
  'hongguo_duanju',
  'hongguo_manju',
]);

const PRESERVED_QUERY_PARAMETERS: Partial<Record<PlatformId, readonly string[]>> = {
  haokan: ['vid', 'id', 'context', 'pd', 'src', 'nid', 'sign', 'word', 'oword', 'atn', 'frsrcid'],
  weishi: ['id'],
  xiaohongshu: ['xsec_token', 'xsec_source', 'source', 'xhsshare', 'app_platform'],
  douyin: ['modal_id', 'ep_id', 'album_id', 'episode_id', 'playlet_id', 'series_id'],
  quanminkge: ['s'],
  zuiyou: ['pid'],
  doubao: ['share_id', 'source_type', 'video_id', 'share_scene', 'vid'],
  jimeng: [
    'item_id',
    'id',
    'published_item_id',
    'search_keyword',
    'share_token',
    'share_sec_uid',
    'share_sec_did',
    'share_campaign_key',
    'share_category',
    'share_from',
    'ct',
    'ab_vid',
    'scene',
    'reward_type',
    'is_self_create_apperance',
    'author_id',
    'template_type_id',
    'workDetailType',
    'itemType',
    'act_key',
  ],
  quark_ai: ['shareId', 'share_id', 'authorId', 'author_id', 'channel_from', 'biz_id', 'qwcontainer', 'url', 'env'],
  kling: ['creative_id', 'work_id', 'creative_type'],
  weibo: ['fid'],
  qsmusic: ['track_id', 'ugc_video_id'],
  qqmusic: ['vid', 'songid', 'songId', 'songmid', 'songMid', 'id', '__'],
  kugou_music: ['hash', 'chain', 'sruserid', 'kgsscty1', 'chl'],
  pinecone_moment: [
    'sharer_id',
    'author_id',
    'channel',
    'version',
    'style_id',
    'share_id',
    'project_id',
    'story_type',
    'story_id',
    'item_type',
    'item_id',
  ],
  tencent_channel: ['b'],
  jianying: ['template_id', 'item_type'],
  kwaiying: ['id', 'templateId', 'template_id', 'userId', 'app_name', 'page_name'],
  wechat_mp: [
    '__biz',
    'mid',
    'idx',
    'sn',
    'chksm',
    't',
    'vid',
    'vidsn',
    'voice_id',
    'item_show_type',
    'scene',
    'subscene',
    'clicktime',
    'enterid',
    'sharer_shareinfo',
    'sharer_shareinfo_first',
  ],
  wechat_channels: ['id'],
  lvzhou: ['sid'],
  qianwen: [
    'shareId',
    'share_id',
    'authorId',
    'author_id',
    'bizId',
    'biz_id',
    'enter_from',
    'fp_from',
    'channel_from',
    'image_index',
    'qwcontainer',
    'env',
  ],
  yuanbao: ['userId'],
  xianyu: ['tk', 'id', 'itemId', 'item_id', 'price', 'shareurl', 'short_name', 'sp_tk'],
  pinduoduo: [
    'goods_id',
    'feed_id',
    'review_id',
    'ps',
    '_oak_share_url',
    '_t_timestamp',
    'share_uin',
    'refer_share_uin',
    'refer_share_id',
    'channel',
    'page_from',
  ],
  dewu: ['trendId', 'shareId', 'source', 'shareType', 'shareChannel', 'isScreenShot'],
  lofter: ['incantation', 'permalink', 'postId', 'blogId'],
  butterflyai: ['share_code', 'share_id', 'entity_type', 'is_mine', 'resource_count', 'share_token'],
  cctv: ['item_id', 'articleId', 'pid', 'guid'],
  yangshipin: ['vid', 'cid', 'type', 'serverFrom', 'articleid', 'articleId', 'id'],
};

const SHORTLINK_SUFFIX_HOSTS = new Set(['v.douyin.com', 'v.kuaishou.com']);

function cleanShortLinkNumericSuffix(url: URL): URL {
  if (!SHORTLINK_SUFFIX_HOSTS.has(url.hostname.toLowerCase())) return url;
  const parts = url.pathname.split('/').filter(Boolean);
  const code = parts[0] ?? '';
  const suffix = parts[1] ?? '';
  if (parts.length === 2 && /^[a-zA-Z0-9_-]+$/u.test(code) && isNumericSuffix(suffix)) {
    const cleaned = new URL(url.href);
    cleaned.pathname = `/${code}/`;
    return cleaned;
  }
  return url;
}

function isNumericSuffix(value: string): boolean {
  if (!value || value.length > 13) return false;
  const segments = value.split('.');
  if (segments.length > 2) return false;
  return segments.every((segment) => /^\d{1,6}$/u.test(segment));
}

export function extractShareUrl(text: string): URL | null {
  const candidates = text.match(/https?:\/\/[^\s<>"']+/giu) ?? [];
  for (const token of candidates) {
    const splitIndex = token.slice(8).search(/https?:\/\//iu);
    const firstToken = splitIndex >= 0 ? token.slice(0, splitIndex + 8) : token;
    const candidate = firstToken.replace(/[>\])},，。；;！!？?\u300d\u300f]+$/gu, '');
    if (!(candidate.startsWith('https://') || candidate.startsWith('http://'))) continue;
    try {
      const url = new URL(candidate);
      if (url.hostname.includes('.')) return cleanShortLinkNumericSuffix(url);
    } catch {
      // Continue scanning other tokens in the sharing text.
    }
  }
  return null;
}

export function normalizePlatformUrl(input: URL): URL {
  const url = new URL(input.href);
  url.hostname = url.hostname.toLowerCase().replace(/\.$/, '');
  url.username = '';
  url.password = '';
  url.hash = '';
  const platformId = detectPlatform(url);
  if (platformId === 'kuaishou') url.protocol = 'https:';

  if (platformId === 'soul') {
    const originalHash = input.hash;
    const questionMark = originalHash.indexOf('?');
    if (questionMark >= 0) {
      const fragmentPath = originalHash.slice(0, questionMark);
      const fragmentQuery = new URLSearchParams(originalHash.slice(questionMark + 1));
      const kept = new URLSearchParams();
      for (const key of ['postIdEcpt', 'sign', 'signVersion']) {
        const value = fragmentQuery.get(key);
        if (value !== null) kept.set(key, value);
      }
      url.hash = kept.size > 0 ? `${fragmentPath}?${kept.toString()}` : '';
    }
  } else if (platformId === 'netease_music') {
    let sourceParams = input.searchParams;
    const rawFragment = input.hash.startsWith('#') ? input.hash.slice(1).replace(/^\/+/u, '') : '';
    const questionIndex = rawFragment.indexOf('?');
    if (questionIndex >= 0) {
      const fragmentPath = rawFragment.slice(0, questionIndex);
      if (fragmentPath === 'song' || fragmentPath === 'mv' || fragmentPath === 'event') {
        url.pathname = `/${fragmentPath}`;
        sourceParams = new URLSearchParams(rawFragment.slice(questionIndex + 1));
      }
    }
    const kept = new URLSearchParams();
    for (const key of ['id', 'uid', 'userid', 'type', 'eventId', 'songId']) {
      const value = sourceParams.get(key);
      if (value !== null && value !== 'null') kept.set(key, value);
    }
    url.search = kept.toString();
  } else if (platformId && PASSTHROUGH_QUERY_PLATFORMS.has(platformId)) {
    url.search = input.search;
  } else {
    const kept = new URLSearchParams();
    for (const key of platformId ? (PRESERVED_QUERY_PARAMETERS[platformId] ?? []) : []) {
      const value = input.searchParams.get(key);
      if (value !== null) kept.set(key, value);
    }
    url.search = kept.toString();
  }

  if (url.pathname.length > 1 && url.pathname.endsWith('/')) {
    url.pathname = url.pathname.slice(0, -1);
  }
  return url;
}

export function convertMediaUrlToHttps(value: string | null): string | null {
  if (!value) return null;
  return value.startsWith('http://') ? `https://${value.slice(7)}` : value;
}

const VIDEO_ID_QUERY_KEYS = [
  'trendId',
  'shareId',
  'vid',
  'songid',
  'songId',
  'songmid',
  'songMid',
  'hash',
  'itemId',
  'item_id',
  'id',
  'modal_id',
  'ep_id',
  'episode_id',
  'album_id',
  'playlet_id',
  'series_id',
  'v',
  's',
  'pid',
  'video_id',
  'creative_id',
  'work_id',
  'track_id',
  'ugc_video_id',
  'template_id',
  'feed_id',
  'goods_id',
  'review_id',
  'ps',
  'share_code',
  'share_id',
  'articleId',
  'articleid',
  'guid',
] as const;

export function getVideoId(url: URL): string {
  const embeddedMatch = /(?:vid|video_id|content_id|material_id)(?:"|%22)?\s*(?:[:=]|%3A)\s*(?:"|%22)?(\d{15,22})/iu.exec(url.href);
  if (embeddedMatch?.[1]) return embeddedMatch[1];

  for (const key of VIDEO_ID_QUERY_KEYS) {
    const value = url.searchParams.get(key);
    if (value) return value;
  }
  const fragmentQuery = url.hash.includes('?')
    ? new URLSearchParams(url.hash.slice(url.hash.indexOf('?') + 1))
    : null;
  const postId = fragmentQuery?.get('postIdEcpt');
  if (postId) return postId;
  const parts = url.pathname.split('/').filter(Boolean);
  const last = parts.at(-1) ?? '';
  const stripped = last.replace(/\.(?:s?html)$/iu, '');
  const desktopMv = /^mv_([0-9a-fA-F]{32})$/u.exec(stripped);
  if (desktopMv?.[1]) return desktopMv[1];
  return stripped;
}
