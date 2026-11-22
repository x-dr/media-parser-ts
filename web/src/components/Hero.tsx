import {
  LinkOutlined,
  PlaySquareOutlined,
  SafetyOutlined,
} from '@ant-design/icons';

interface HeroProps {
  platformCount: number;
}

export function Hero({ platformCount }: HeroProps) {
  return (
    <section className="hero" aria-labelledby="hero-title">
      <div className="eyebrow-pill">
        <span className="eyebrow-dot" aria-hidden="true" />
        <span>MEDIA PARSER · 匿名工作台</span>
        {platformCount > 0 && (
          <>
            <span className="eyebrow-sep" aria-hidden="true" />
            <span className="eyebrow-stat">{platformCount} 个平台在线</span>
          </>
        )}
      </div>
      <h1 id="hero-title">
        粘贴分享文本，<span className="hero-highlight">提取可用媒体资源</span>
      </h1>
      <p className="hero-copy">
        支持常见视频、图文、音频与实况平台。直接粘贴 App 复制的完整分享文案或链接，自动识别来源并结构化呈现可用资源。
      </p>
      <div className="hero-points" aria-label="功能特点">
        <span className="hero-point">
          <i aria-hidden="true"><LinkOutlined /></i>
          <span>自动识别分享链接</span>
        </span>
        <span className="hero-point">
          <i aria-hidden="true"><PlaySquareOutlined /></i>
          <span>视频、图集、音频与字幕</span>
        </span>
        <span className="hero-point">
          <i aria-hidden="true"><SafetyOutlined /></i>
          <span>匿名免登录直用</span>
        </span>
      </div>
    </section>
  );
}
