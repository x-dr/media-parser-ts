import {
  CheckCircleOutlined,
  ClockCircleOutlined,
  DashboardOutlined,
  LineChartOutlined,
  ReloadOutlined,
  WarningOutlined,
} from '@ant-design/icons';
import { Alert, App, Button, Card, Empty, Flex, Progress, Segmented, Skeleton, Statistic, Table, Tag, Typography } from 'antd';
import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import { PageHeader } from '../components/PageHeader';
import { adminApi, errorMessage } from '../lib/api';
import { formatDuration, formatPercent } from '../lib/format';
import type { Client, ErrorAggregate, Platform, Stats } from '../types';

const ranges = {
  '24h': { label: '最近 24 小时', milliseconds: 86_400_000 },
  '7d': { label: '最近 7 天', milliseconds: 7 * 86_400_000 },
  '30d': { label: '最近 30 天', milliseconds: 30 * 86_400_000 },
} as const;

type RangeKey = keyof typeof ranges;

interface DashboardData {
  overview: Stats;
  platforms: Stats;
  clients: Stats;
  platformNames: Map<string, string>;
  clientNames: Map<string, string>;
  ready: boolean;
}

function rangeQuery(range: RangeKey): string {
  const to = new Date();
  const from = new Date(to.getTime() - ranges[range].milliseconds);
  return new URLSearchParams({ from: from.toISOString(), to: to.toISOString() }).toString();
}

function errorGradient(errors: ErrorAggregate[]): string {
  const colors = ['#dc2626', '#18181b', '#525252', '#a3a3a3', '#d4d4d4', '#e5e5e5'];
  const total = errors.reduce((sum, item) => sum + item.total, 0);
  if (!total) return '#f5f5f5';
  let start = 0;
  const segments = errors.slice(0, 6).map((item, index) => {
    const end = start + item.total / total * 100;
    const segment = `${colors[index]} ${start}% ${end}%`;
    start = end;
    return segment;
  });
  if (start < 100) segments.push(`#e5e5e5 ${start}% 100%`);
  return `conic-gradient(${segments.join(', ')})`;
}

export function DashboardPage(): ReactNode {
  const { message } = App.useApp();
  const [range, setRange] = useState<RangeKey>('24h');
  const [data, setData] = useState<DashboardData | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (background = false): Promise<void> => {
    if (background) setRefreshing(true); else setLoading(true);
    setError(null);
    try {
      const query = rangeQuery(range);
      const [overview, platforms, clients, platformList, clientList, readyResponse] = await Promise.all([
        adminApi.request<Stats>(`/api/admin/v1/stats/overview?${query}`),
        adminApi.request<Stats>(`/api/admin/v1/stats/platforms?${query}`),
        adminApi.request<Stats>(`/api/admin/v1/stats/clients?${query}`),
        adminApi.request<Platform[]>('/api/admin/v1/platforms'),
        adminApi.request<Client[]>('/api/admin/v1/clients'),
        fetch('/api/ready'),
      ]);
      setData({
        overview,
        platforms,
        clients,
        platformNames: new Map(platformList.map((item) => [item.id, item.name])),
        clientNames: new Map(clientList.map((item) => [item.id, item.name])),
        ready: readyResponse.ok,
      });
      if (background) void message.success('数据已刷新');
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [message, range]);

  useEffect(() => { void load(); }, [load]);

  const aggregate = data?.overview.aggregates[0];
  const total = aggregate?.total ?? 0;
  const successful = aggregate?.successful ?? 0;
  const failures = data?.overview.errors.reduce((sum, item) => sum + item.total, 0) ?? 0;
  const errorTotal = data?.overview.errors.reduce((sum, item) => sum + item.total, 0) ?? 0;
  const donut = useMemo(() => errorGradient(data?.overview.errors ?? []), [data?.overview.errors]);

  const rankColumns = [
    { title: '排名', key: 'rank', width: 62, render: (_: unknown, __: unknown, index: number) => <span className={`rank rank-${index + 1}`}>{index + 1}</span> },
    { title: '名称', dataIndex: 'name', ellipsis: true },
    { title: '请求量', dataIndex: 'total', width: 100 },
    { title: '成功率', key: 'success', width: 150, render: (_: unknown, row: { total: number; successful: number }) => (
      <div className="success-cell"><span>{formatPercent(row.successful, row.total)}</span><Progress percent={row.total ? row.successful / row.total * 100 : 0} showInfo={false} size="small" strokeColor="#16a34a" /></div>
    ) },
  ];

  const platformRows = (data?.platforms.aggregates ?? []).slice(0, 5).map((item) => ({
    ...item,
    key: item.group_id ?? 'unknown',
    name: item.group_id ? data?.platformNames.get(item.group_id) ?? item.group_id : '识别失败',
  }));
  const clientRows = (data?.clients.aggregates ?? []).slice(0, 5).map((item) => ({
    ...item,
    key: item.group_id ?? 'unknown',
    name: item.group_id ? data?.clientNames.get(item.group_id) ?? item.group_id : '未知调用方',
  }));

  if (loading && !data) return <div className="page-stack"><Skeleton active paragraph={{ rows: 12 }} /></div>;

  return (
    <div className="page-stack dashboard-page">
      <PageHeader
        title="运行概览"
        description={`${ranges[range].label} · 时间按本地显示，查询以 UTC 发送`}
        extra={
          <>
            <Segmented
              value={range}
              options={Object.entries(ranges).map(([value, item]) => ({ value, label: item.label }))}
              onChange={(value) => setRange(value as RangeKey)}
            />
            <Button icon={<ReloadOutlined />} loading={refreshing} onClick={() => void load(true)}>刷新</Button>
          </>
        }
      />
      {error ? <Alert type="error" showIcon title={error} action={<Button onClick={() => void load()}>重试</Button>} /> : null}
      <Alert
        className="service-banner"
        type={data?.ready ? 'success' : 'warning'}
        showIcon
        title={data?.ready ? '服务已就绪，系统运行正常' : '服务进程存活，但依赖尚未就绪。部分操作可能失败。'}
      />
      <div className="kpi-grid">
        <Card className="kpi-card"><Statistic title="请求总数" value={total} prefix={<DashboardOutlined />} /></Card>
        <Card className="kpi-card kpi-success"><Statistic title="成功率" value={total ? successful / total * 100 : 0} precision={1} suffix="%" prefix={<CheckCircleOutlined />} /></Card>
        <Card className="kpi-card"><Statistic title="平均耗时" value={formatDuration(aggregate?.average_duration_ms)} prefix={<ClockCircleOutlined />} /></Card>
        <Card className="kpi-card"><Statistic title="P95 耗时" value={formatDuration(data?.overview.percentiles.p95)} prefix={<LineChartOutlined />} /></Card>
      </div>
      <div className="dashboard-main-grid">
        <Card className="content-card trend-card" title="请求量与成功率" extra={<Tag color="blue">建议接口</Tag>}>
          <Empty
            image={<LineChartOutlined className="empty-feature-icon" />}
            description={
              <div><strong>暂缺趋势数据</strong><br /><Typography.Text type="secondary">时间序列接口实现后展示请求量与成功率趋势</Typography.Text></div>
            }
          />
        </Card>
        <Card className="content-card error-card" title="错误分布" extra={failures ? <Tag color="error">{failures} 次失败</Tag> : null}>
          {errorTotal > 0 ? (
            <Flex className="error-visual" align="center" justify="space-around" gap={24} wrap>
              <div className="donut" style={{ background: donut }} aria-label={`错误总数 ${errorTotal}`}>
                <div><strong>{errorTotal}</strong><span>错误总数</span></div>
              </div>
              <div className="error-legend">
                {data?.overview.errors.slice(0, 6).map((item, index) => (
                  <div key={item.error_code}><i className={`legend-dot legend-${index}`} /><span>{item.error_code}</span><strong>{item.total}</strong><em>{formatPercent(item.total, errorTotal)}</em></div>
                ))}
              </div>
            </Flex>
          ) : <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="当前时间范围内没有失败请求" />}
        </Card>
      </div>
      <div className="ranking-grid">
        <Card className="content-card" title="平台调用量">
          <Table rowKey="key" columns={rankColumns} dataSource={platformRows} pagination={false} size="small" scroll={{ x: 520 }} locale={{ emptyText: '暂无平台调用' }} />
        </Card>
        <Card className="content-card" title="调用方调用量">
          <Table rowKey="key" columns={rankColumns} dataSource={clientRows} pagination={false} size="small" scroll={{ x: 520 }} locale={{ emptyText: '暂无调用方调用' }} />
        </Card>
      </div>
      {!data?.ready ? <Typography.Text type="warning"><WarningOutlined /> 请先检查安全设置中的服务状态。</Typography.Text> : null}
    </div>
  );
}
