import { Flex, Typography } from 'antd';
import type { ReactNode } from 'react';

interface PageHeaderProps {
  title: string;
  description?: ReactNode;
  extra?: ReactNode;
}

export function PageHeader({ title, description, extra }: PageHeaderProps): ReactNode {
  return (
    <Flex className="page-heading" justify="space-between" align="flex-start" gap={16} wrap>
      <div>
        <Typography.Title level={1}>{title}</Typography.Title>
        {description ? <Typography.Paragraph type="secondary">{description}</Typography.Paragraph> : null}
      </div>
      {extra ? <Flex className="page-heading-actions" gap={10} wrap>{extra}</Flex> : null}
    </Flex>
  );
}
