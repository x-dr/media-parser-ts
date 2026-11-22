import {
  ClockCircleOutlined,
  EyeOutlined,
  GlobalOutlined,
  SafetyCertificateOutlined,
  StopOutlined,
} from '@ant-design/icons';

const privacyItems = [
  {
    icon: <SafetyCertificateOutlined />,
    title: '合规使用与敏感信息保护',
    text: '只提交你有权访问和处理的内容，请勿提交账号密码、Cookie、Token 或其他私密凭据。',
  },
  {
    icon: <ClockCircleOutlined />,
    title: '30 天服务日志留存',
    text: '分享文本、解析结果、IP 与 User-Agent 默认保留 30 天，仅用于提供解析服务与排查故障。',
  },
  {
    icon: <GlobalOutlined />,
    title: '上游平台限制说明',
    text: '各平台可能动态限制跨域播放、临时 URL 有效期、Referer 校验或登录态。',
  },
  {
    icon: <EyeOutlined />,
    title: '预览与下载降级',
    text: '浏览器内预览失败不代表解析失败，可通过资源外链在新窗口打开或复制直链查看。',
  },
  {
    icon: <StopOutlined />,
    title: '服务能力边界',
    text: '本工具不提供账号与历史记录同步，也不会替你绕过平台授权、验证码或隐私访问限制。',
  },
] as const;

export function PrivacySection() {
  return (
    <section className="privacy-section" id="privacy" aria-labelledby="privacy-title">
      <div className="privacy-header">
        <div className="privacy-title-row">
          <div className="privacy-icon" aria-hidden="true">
            <SafetyCertificateOutlined />
          </div>
          <div>
            <p className="section-eyebrow">USE &amp; PRIVACY</p>
            <h2 id="privacy-title">使用与隐私提示</h2>
          </div>
        </div>
        <span className="privacy-badge">数据默认留存 30 天</span>
      </div>

      <ul className="privacy-grid">
        {privacyItems.map((item) => (
          <li className="privacy-item" key={item.title}>
            <span className="privacy-item-icon" aria-hidden="true">{item.icon}</span>
            <div className="privacy-item-copy">
              <strong>{item.title}</strong>
              <p>{item.text}</p>
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}
