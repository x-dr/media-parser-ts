import { FileProtectOutlined } from '@ant-design/icons';
import { Button, Card, Empty, Tag, Typography } from 'antd';
import type { ReactNode } from 'react';
import { PageHeader } from '../components/PageHeader';

export function AuditPage(): ReactNode {
  return (
    <div className="page-stack">
      <PageHeader title="审计日志" description="检索管理员敏感操作及其结果" />
      <Card className="content-card proposal-card">
        <Empty
          image={<FileProtectOutlined className="empty-feature-icon" />}
          description={
            <div>
              <Typography.Title level={4}>审计查询接口尚未提供</Typography.Title>
              <Typography.Paragraph type="secondary">
                服务端已记录登录、改密、凭据、平台测试和日志导出等操作，但当前没有只读查询 API。
                页面不会使用 Mock 数据代替真实审计记录。
              </Typography.Paragraph>
              <Tag color="blue">建议能力</Tag>
            </div>
          }
        >
          <Button disabled>等待 GET /api/admin/v1/audit-logs</Button>
        </Empty>
      </Card>
    </div>
  );
}
