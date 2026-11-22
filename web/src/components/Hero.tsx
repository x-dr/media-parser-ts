import {
  LinkOutlined,
  PlaySquareOutlined,
  SafetyOutlined,
} from '@ant-design/icons';

export function Hero() {
  return (
    <section className="hero" aria-labelledby="hero-title">
      <h1 id="hero-title">
        粘贴分享文本，<span className="hero-highlight">提取可用媒体资源</span>
      </h1>
      <div className="hero-points" aria-label="功能特点">
        <span className="hero-point">
          <i aria-hidden="true"><LinkOutlined /></i>
          <span>自动识别完整分享文案</span>
        </span>
        <span className="hero-dot" aria-hidden="true" />
        <span className="hero-point">
          <i aria-hidden="true"><PlaySquareOutlined /></i>
          <span>视频、图集、音频与字幕</span>
        </span>
        <span className="hero-dot" aria-hidden="true" />
        <span className="hero-point">
          <i aria-hidden="true"><SafetyOutlined /></i>
          <span>匿名免登录直用</span>
        </span>
      </div>
    </section>
  );
}
