import { detectPlatform, type PlatformId } from '../config/platforms.js';

const PRESERVED_QUERY_PARAMETERS: Partial<Record<PlatformId, readonly string[]>> = {
  haokan: ['vid'],
  weishi: ['id'],
  xiaohongshu: ['xsec_token'],
  douyin: ['modal_id'],
  quanminkge: ['s'],
  zuiyou: ['pid'],
  doubao: ['share_id', 'source_type', 'video_id', 'share_scene'],
  jimeng: ['item_id', 'id'],
  quark_ai: ['shareId', 'share_id', 'authorId', 'author_id', 'channel_from', 'biz_id', 'qwcontainer', 'url', 'env'],
  kling: ['creative_id', 'work_id', 'creative_type'],
  weibo: ['fid'],
  qsmusic: ['track_id', 'ugc_video_id'],
  tencent_channel: ['b'],
  jianying: ['template_id', 'item_type'],
  wechat_channels: ['id'],
  lvzhou: ['sid'],
  qianwen: ['shareId', 'authorId', 'enter_from', 'fp_from', 'channel_from', 'image_index'],
  xianyu: ['tk', 'id', 'price', 'shareurl', 'short_name', 'sp_tk'],
};

export function extractShareUrl(text: string): URL | null {
  const candidates = text.match(/https?:\/\/[^\s<>"']+/giu) ?? [];
  for (const token of candidates) {
    const candidate = token.replace(/[>\])},，。；;！!？?\u300d\u300f]+$/gu, '');
    if (!(candidate.startsWith('https://') || candidate.startsWith('http://'))) continue;
    try {
      const url = new URL(candidate);
      if (url.hostname.includes('.')) return url;
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
  } else if (platformId === 'xiaoyunque') {
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

export function getVideoId(url: URL): string {
  for (const key of [
    'shareId', 'vid', 'id', 'modal_id', 'v', 's', 'pid', 'video_id', 'creative_id',
    'work_id', 'track_id', 'ugc_video_id', 'template_id', 'item_id', 'share_id',
  ]) {
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
  return last.replace(/\.html$/u, '');
}
