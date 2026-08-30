import { Button } from 'antd';
import { ReloadOutlined } from '@ant-design/icons';

export type ServiceState = 'checking' | 'ready' | 'unready' | 'unreachable';

interface BrandHeaderProps {
  serviceState: ServiceState;
  platformCount: number;
  onRefresh: () => void;
}

const statusCopy: Record<ServiceState, string> = {
  checking: '正在检查服务',
  ready: '服务已就绪',
  unready: '服务暂未就绪',
  unreachable: '无法连接服务',
};

export function BrandHeader({ serviceState, platformCount, onRefresh }: BrandHeaderProps) {
  return (
    <header className="site-header">
      <div className="site-header-inner">
        <a className="brand" href="#top" aria-label="Media Parser 首页">
          <span className="brand-mark">MP</span>
          <span className="brand-copy">
            <strong>Media Parser</strong>
            <span>匿名媒体解析工具</span>
          </span>
        </a>
        <nav className="header-actions" aria-label="页面导航">
          <span className={`service-status status-${serviceState}`} role="status" aria-live="polite">
            <i aria-hidden="true" />
            {statusCopy[serviceState]}
          </span>
          <Button type="text" icon={<ReloadOutlined />} onClick={onRefresh} loading={serviceState === 'checking'}>
            重新检查
          </Button>
          <a href="#platforms">
            支持平台{platformCount > 0 ? ` ${platformCount}` : ''}
          </a>
        </nav>
      </div>
    </header>
  );
}
