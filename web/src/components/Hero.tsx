import {
  LinkOutlined,
  PlaySquareOutlined,
  TeamOutlined,
} from '@ant-design/icons';

export function Hero() {
  return (
    <section className="hero" aria-labelledby="hero-title">
      <p className="eyebrow">MEDIA PARSER · PUBLIC WORKSPACE</p>
      <h1 id="hero-title">粘贴分享文本，提取可用媒体资源</h1>
      <p className="hero-copy">
        支持多个常见视频、图文与音频平台。请粘贴完整分享文案或链接，我们会自动识别平台并返回可用资源。
      </p>
      <div className="hero-points" aria-label="功能特点">
        <span><i><LinkOutlined /></i>自动识别分享链接</span>
        <span><i><PlaySquareOutlined /></i>视频、图集、音频与字幕</span>
        <span><i><TeamOutlined /></i>无需注册账号</span>
      </div>
    </section>
  );
}
