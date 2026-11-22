import { ReloadOutlined } from '@ant-design/icons';

export type ServiceState = 'checking' | 'ready' | 'unready' | 'unreachable';

interface BrandHeaderProps {
  serviceState: ServiceState;
  platformCount: number;
  onRefresh: () => void;
}

const statusCopy: Record<ServiceState, { full: string; short: string }> = {
  checking: { full: '正在检查服务', short: '检查中' },
  ready: { full: '服务已就绪', short: '就绪' },
  unready: { full: '服务暂未就绪', short: '未就绪' },
  unreachable: { full: '无法连接服务', short: '不可达' },
};

export function BrandHeader({ serviceState, platformCount, onRefresh }: BrandHeaderProps) {
  const label = statusCopy[serviceState];
  return (
    <header className="site-header">
      <div className="site-header-inner">
        <a className="brand" href="#top" aria-label="Media Parser 首页">
          <span className="brand-mark" aria-hidden="true">
            <svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
              <rect x="3" y="4.5" width="18" height="15" rx="4" stroke="currentColor" strokeWidth="1.9" />
              <path
                d="M10.2 9.25C10.2 8.78 10.72 8.49 11.12 8.74L15.48 11.49C15.85 11.72 15.85 12.28 15.48 12.51L11.12 15.26C10.72 15.51 10.2 15.22 10.2 14.75V9.25Z"
                fill="currentColor"
              />
            </svg>
          </span>
          <span className="brand-copy">
            <strong>Media Parser</strong>
            <span>匿名媒体解析工具</span>
          </span>
        </a>
        <nav className="header-actions" aria-label="页面导航">
          <div className={`service-pill status-${serviceState}`}>
            <span className="service-status" role="status" aria-live="polite">
              <i aria-hidden="true" />
              <span className="status-text-full">{label.full}</span>
              <span className="status-text-short" aria-hidden="true">{label.short}</span>
            </span>
            <button
              type="button"
              className="status-refresh"
              onClick={onRefresh}
              disabled={serviceState === 'checking'}
              aria-label="重新检查服务状态"
              title="重新检查服务状态"
            >
              <ReloadOutlined spin={serviceState === 'checking'} />
            </button>
          </div>
          <a className="header-link" href="#platforms">
            <span>支持平台</span>
            {platformCount > 0 && <span className="header-count">{platformCount}</span>}
          </a>
          <a className="header-link" href="#privacy">隐私说明</a>
        </nav>
      </div>
    </header>
  );
}
