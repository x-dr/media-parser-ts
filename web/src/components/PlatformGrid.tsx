import type { ReactNode } from 'react';
import {
  AudioOutlined,
  CodeOutlined,
  FileImageOutlined,
  PlayCircleOutlined,
  VideoCameraOutlined,
} from '@ant-design/icons';
import type { PublicPlatform } from '../types';
import { platformBrand, platformMark } from '../lib/media';

const mediaNames: Record<string, string> = {
  video: '视频',
  images: '图片',
  audio: '音频',
  subtitles: '字幕',
  live_media: '实况',
};

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
  const firstRow = platforms.filter((_, index) => index % 2 === 0);
  const secondRow = platforms.filter((_, index) => index % 2 === 1);
  return (
    <section className="platform-section" id="platforms" aria-labelledby="platform-title">
      <div className="support-heading">
        <div>
          <p className="eyebrow">SUPPORTED SOURCES</p>
          <h2 id="platform-title">支持平台</h2>
        </div>
        <p>可用状态来自当前服务；上游能力可能随时变化。</p>
      </div>
      {loading ? (
        <div className="platform-loading" aria-live="polite">正在读取支持平台…</div>
      ) : (
        <div className="platform-marquee">
          <MarqueeRow items={firstRow.length > 0 ? firstRow : platforms} />
          {secondRow.length > 0 && <MarqueeRow items={secondRow} reverse />}
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

function PlatformCard({ platform }: { platform: PublicPlatform }) {
  return (
    <article className="platform-card">
      <span
        className="platform-logo"
        style={{ background: platformBrand(platform.name) }}
        aria-hidden="true"
      >
        {platformMark(platform.name)}
      </span>
      <div>
        <strong>{platform.name}</strong>
        <p>{platform.media_types.map((type) => mediaNames[type] ?? type).join(' / ')}</p>
        <span className="platform-meta">
          <span className="platform-type-icons" aria-hidden="true">
            {platform.media_types.map((type) => (
              <span key={type} title={mediaNames[type] ?? type}>{mediaIcons[type] ?? <PlayCircleOutlined />}</span>
            ))}
          </span>
          <span className={`platform-status ${platform.enabled ? 'available' : 'maintenance'}`}>
            <i aria-hidden="true" />
            {platform.enabled ? '可用' : '维护中'}
          </span>
        </span>
      </div>
    </article>
  );
}
