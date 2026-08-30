import { CheckCircleFilled, ClockCircleFilled } from '@ant-design/icons';
import type { PublicPlatform } from '../types';
import { platformMark } from '../lib/media';

const mediaNames: Record<string, string> = {
  video: '视频',
  images: '图片',
  audio: '音频',
  subtitles: '字幕',
  live_media: '实况',
};

interface PlatformGridProps {
  platforms: PublicPlatform[];
  loading: boolean;
}

export function PlatformGrid({ platforms, loading }: PlatformGridProps) {
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
        <div className="platform-grid">
          {platforms.map((platform, index) => (
            <article className="platform-card" key={platform.id}>
              <span className={`platform-logo platform-color-${index % 7}`} aria-hidden="true">
                {platformMark(platform.name)}
              </span>
              <div>
                <strong>{platform.name}</strong>
                <p>{platform.media_types.map((type) => mediaNames[type] ?? type).join(' / ')}</p>
                <span className={platform.enabled ? 'available' : 'maintenance'}>
                  {platform.enabled ? <CheckCircleFilled /> : <ClockCircleFilled />}
                  {platform.enabled ? '可用' : '维护中'}
                </span>
              </div>
            </article>
          ))}
        </div>
      )}
    </section>
  );
}
