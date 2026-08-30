import { SafetyCertificateOutlined } from '@ant-design/icons';

export function PrivacySection() {
  return (
    <section className="privacy-section" id="privacy" aria-labelledby="privacy-title">
      <div className="privacy-icon"><SafetyCertificateOutlined /></div>
      <div>
        <p className="eyebrow">USE &amp; PRIVACY</p>
        <h2 id="privacy-title">使用与隐私提示</h2>
        <ul>
          <li>只提交你有权访问和处理的内容，不要提交账号密码、Cookie、Token 或其他秘密。</li>
          <li>平台可能限制跨域播放、临时 URL、Referer 或登录状态。</li>
          <li>页面预览失败不等于解析失败，可尝试打开资源链接。</li>
          <li>服务不会替你绕过平台授权、验证码或隐私限制。</li>
          <li>分享文本、解析结果、IP 与 User-Agent 默认保留 30 天，用于提供服务和排查故障。</li>
        </ul>
      </div>
    </section>
  );
}
