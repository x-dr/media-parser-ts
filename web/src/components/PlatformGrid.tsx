import { useMemo, useState, type ReactNode } from 'react';
import {
  AppstoreOutlined,
  AudioOutlined,
  CloseCircleFilled,
  CodeOutlined,
  FileImageOutlined,
  PauseCircleOutlined,
  PlayCircleOutlined,
  SearchOutlined,
  VideoCameraOutlined,
} from '@ant-design/icons';
import {
  platformFallbackColor,
  platformFallbackMark,
  platformIconUrl,
} from '@media-parser/platform-icons';
import type { PublicPlatform } from '../types';

const mediaNames: Record<string, string> = {
  video: '视频',
  images: '图片',
  audio: '音频',
  live_media: '实况',
  subtitles: '字幕',
};

const mediaOrder = ['video', 'images', 'audio', 'live_media', 'subtitles'] as const;

const mediaIcons: Record<string, ReactNode> = {
  video: <PlayCircleOutlined />,
  images: <FileImageOutlined />,
  audio: <AudioOutlined />,
  subtitles: <CodeOutlined />,
  live_media: <VideoCameraOutlined />,
};

interface PlatformGridProps {
  platforms: PublicPlatform[];
  loading: boolean;
}

export function PlatformGrid({ platforms, loading }: PlatformGridProps) {
  const [viewMode, setViewMode] = useState<'marquee' | 'grid'>('marquee');
  const [activeType, setActiveType] = useState<string>('all');
  const [query, setQuery] = useState('');

  const enabledCount = useMemo(
    () => platforms.filter((item) => item.enabled).length,
    [platforms],
  );

  const typeCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const platform of platforms) {
      for (const type of platform.media_types) {
        counts.set(type, (counts.get(type) ?? 0) + 1);
      }
    }
    return counts;
  }, [platforms]);

  const availableTypes = useMemo(
    () => mediaOrder.filter((type) => (typeCounts.get(type) ?? 0) > 0),
    [typeCounts],
  );

  const normalizedQuery = query.trim().toLowerCase();
  const isFiltering = activeType !== 'all' || normalizedQuery.length > 0;
  const effectiveMode = isFiltering ? 'grid' : viewMode;

  const filteredPlatforms = useMemo(() => {
    return platforms.filter((platform) => {
      if (activeType !== 'all' && !platform.media_types.includes(activeType)) {
        return false;
      }
      if (!normalizedQuery) return true;
      return (
        platform.name.toLowerCase().includes(normalizedQuery)
        || platform.id.toLowerCase().includes(normalizedQuery)
        || platform.domains.some((domain) => domain.toLowerCase().includes(normalizedQuery))
      );
    });
  }, [activeType, normalizedQuery, platforms]);

  const firstRow = useMemo(
    () => platforms.filter((_, index) => index % 2 === 0),
    [platforms],
  );
  const secondRow = useMemo(
    () => platforms.filter((_, index) => index % 2 === 1),
    [platforms],
  );

  const resetFilters = () => {
    setActiveType('all');
    setQuery('');
  };

  return (
    <section className="platform-section" id="platforms" aria-labelledby="platform-title">
      <div className="support-heading">
        <p className="section-eyebrow">SUPPORTED SOURCES</p>
        <h2 id="platform-title">支持平台</h2>
        <p className="support-subtitle">
          {platforms.length > 0
            ? `已接入 ${platforms.length} 个主流内容平台（当前 ${enabledCount} 个可用），实际能力随上游策略实时更新。`
            : '可用状态来自当前服务，实际能力随上游策略实时更新。'}
        </p>
      </div>

      {!loading && platforms.length > 0 && (
        <div className="platform-controls">
          <div className="platform-filters" role="tablist" aria-label="按媒体类型筛选平台">
            <button
              type="button"
              role="tab"
              aria-selected={activeType === 'all'}
              className={`filter-chip${activeType === 'all' ? ' is-active' : ''}`}
              onClick={() => setActiveType('all')}
            >
              <span>全部</span>
              <em>{platforms.length}</em>
            </button>
            {availableTypes.map((type) => (
              <button
                key={type}
                type="button"
                role="tab"
                aria-selected={activeType === type}
                className={`filter-chip${activeType === type ? ' is-active' : ''}`}
                onClick={() => setActiveType(type)}
              >
                <i aria-hidden="true">{mediaIcons[type]}</i>
                <span>{mediaNames[type] ?? type}</span>
                <em>{typeCounts.get(type) ?? 0}</em>
              </button>
            ))}
          </div>

          <div className="platform-tools">
            <label className="platform-search">
              <SearchOutlined className="platform-search-icon" aria-hidden="true" />
              <input
                type="search"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="搜索平台名或域名…"
                aria-label="搜索支持平台"
              />
              {query.length > 0 && (
                <button
                  type="button"
                  className="platform-search-clear"
                  onClick={() => setQuery('')}
                  aria-label="清空搜索"
                >
                  <CloseCircleFilled />
                </button>
              )}
            </label>
            <button
              type="button"
              className={`view-toggle-btn${effectiveMode === 'grid' ? ' is-grid' : ''}`}
              onClick={() => {
                if (isFiltering) {
                  resetFilters();
                  setViewMode('marquee');
                } else {
                  setViewMode((current) => current === 'marquee' ? 'grid' : 'marquee');
                }
              }}
            >
              {effectiveMode === 'marquee' ? <AppstoreOutlined /> : <PauseCircleOutlined />}
              <span>{effectiveMode === 'marquee' ? '展开全部' : '滚动总览'}</span>
            </button>
          </div>
        </div>
      )}

      {loading ? (
        <div className="platform-skeleton-grid" aria-live="polite" aria-label="正在读取支持平台">
          {Array.from({ length: 8 }, (_, index) => (
            <div className="platform-skeleton-card" key={index} aria-hidden="true">
              <span className="skel-avatar" />
              <div className="skel-copy">
                <span className="skel-name" />
                <span className="skel-meta" />
              </div>
            </div>
          ))}
        </div>
      ) : platforms.length === 0 ? (
        <div className="platform-empty">暂未获取到平台目录，请稍后刷新页面重试。</div>
      ) : effectiveMode === 'marquee' ? (
        <div className="platform-marquee">
          <MarqueeRow items={firstRow.length > 0 ? firstRow : platforms} />
          {secondRow.length > 0 && <MarqueeRow items={secondRow} reverse />}
        </div>
      ) : filteredPlatforms.length === 0 ? (
        <div className="platform-empty">
          <p>未找到与“{query.trim()}”匹配的平台</p>
          <button type="button" className="platform-reset-btn" onClick={resetFilters}>
            重置筛选条件
          </button>
        </div>
      ) : (
        <div className="platform-grid">
          {filteredPlatforms.map((platform) => (
            <PlatformCard key={platform.id} platform={platform} showDomain />
          ))}
        </div>
      )}
    </section>
  );
}

function MarqueeRow({ items, reverse = false }: { items: PublicPlatform[]; reverse?: boolean }) {
  return (
    <div className={`marquee-row${reverse ? ' reverse' : ''}`}>
      {items.map((platform) => <PlatformCard key={platform.id} platform={platform} />)}
      {items.map((platform) => (
        <div className="marquee-clone" key={`${platform.id}-clone`} aria-hidden="true">
          <PlatformCard platform={platform} />
        </div>
      ))}
    </div>
  );
}

function PlatformCard({
  platform,
  showDomain = false,
}: {
  platform: PublicPlatform;
  showDomain?: boolean;
}) {
  const iconUrl = platformIconUrl(platform.id);
  const primaryDomain = platform.domains[0]?.replace(/^www\./u, '') ?? '';

  return (
    <article className={`platform-card${showDomain ? ' is-grid-card' : ''}${platform.enabled ? '' : ' is-maintenance'}`}>
      <span
        className={`platform-logo${iconUrl ? ' has-icon' : ' is-fallback'}`}
        style={iconUrl ? undefined : { background: platformFallbackColor(platform.id) }}
        aria-hidden="true"
      >
        {iconUrl
          ? <img src={iconUrl} alt="" loading="lazy" decoding="async" />
          : <span>{platformFallbackMark(platform.name)}</span>}
      </span>
      <div className="platform-body">
        <div className="platform-name-row">
          <strong title={platform.name}>{platform.name}</strong>
          <span className={`platform-status ${platform.enabled ? 'available' : 'maintenance'}`}>
            <i aria-hidden="true" />
            {platform.enabled ? '可用' : '维护'}
          </span>
        </div>
        <p className="platform-sub" title={showDomain && primaryDomain ? primaryDomain : undefined}>
          {showDomain && primaryDomain
            ? primaryDomain
            : platform.media_types.map((type) => mediaNames[type] ?? type).join(' · ')}
        </p>
        <div className="platform-type-icons" aria-label={`支持类型：${platform.media_types.map((type) => mediaNames[type] ?? type).join('、')}`}>
          {platform.media_types.map((type) => (
            <span key={type} className="type-badge" title={mediaNames[type] ?? type}>
              {mediaIcons[type] ?? <PlayCircleOutlined />}
              {showDomain && <em>{mediaNames[type] ?? type}</em>}
            </span>
          ))}
        </div>
      </div>
    </article>
  );
}
