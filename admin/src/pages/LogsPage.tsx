import { CopyOutlined, DownloadOutlined, FilterOutlined, LinkOutlined, ReloadOutlined, SearchOutlined } from '@ant-design/icons';
import { Alert, App, Button, Card, Collapse, DatePicker, Descriptions, Drawer, Empty, Form, Input, InputNumber, Modal, Select, Space, Table, Tag, Tooltip, Typography } from 'antd';
import dayjs, { type Dayjs } from 'dayjs';
import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import { useSearchParams } from 'react-router-dom';
import { PageHeader } from '../components/PageHeader';
import { adminApi, errorMessage } from '../lib/api';
import { formatDate, formatDuration, jsonText, safeHttpUrl } from '../lib/format';
import type { ApiKey, Client, LogPage, ParseLog, Platform } from '../types';

const { RangePicker } = DatePicker;

interface FilterValues {
  range?: [Dayjs, Dayjs];
  clientId?: string;
  keyId?: string;
  platformId?: string;
  success?: 'all' | 'true' | 'false';
  httpStatus?: number;
  retcode?: number;
  errorCode?: string;
  requestId?: string;
}

interface ExportValues { range: [Dayjs, Dayjs] }

function stateTag(log: ParseLog): ReactNode {
  if (log.state === 'pending') return <Tag color="processing">处理中</Tag>;
  if (log.state === 'client_aborted') return <Tag color="warning">客户端取消</Tag>;
  return log.success ? <Tag color="success">成功</Tag> : <Tag color="error">失败</Tag>;
}

function summaryValue(value: unknown): string {
  if (value === null || value === undefined) return '—';
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return String(value);
  return jsonText(value);
}

function paramsToValues(params: URLSearchParams): FilterValues {
  const from = params.get('from');
  const to = params.get('to');
  const range = from && to ? [dayjs(from), dayjs(to)] as [Dayjs, Dayjs] : undefined;
  return {
    ...(range ? { range } : {}),
    ...(params.get('client_id') ? { clientId: params.get('client_id') as string } : {}),
    ...(params.get('key_id') ? { keyId: params.get('key_id') as string } : {}),
    ...(params.get('platform_id') ? { platformId: params.get('platform_id') as string } : {}),
    success: (params.get('success') as FilterValues['success']) ?? 'all',
    ...(params.get('http_status') ? { httpStatus: Number(params.get('http_status')) } : {}),
    ...(params.get('retcode') ? { retcode: Number(params.get('retcode')) } : {}),
    ...(params.get('error_code') ? { errorCode: params.get('error_code') as string } : {}),
    ...(params.get('request_id') ? { requestId: params.get('request_id') as string } : {}),
  };
}

function valuesToParams(values: FilterValues): URLSearchParams {
  const params = new URLSearchParams();
  if (values.range) { params.set('from', values.range[0].toISOString()); params.set('to', values.range[1].toISOString()); }
  if (values.clientId) params.set('client_id', values.clientId);
  if (values.keyId) params.set('key_id', values.keyId);
  if (values.platformId) params.set('platform_id', values.platformId);
  if (values.success && values.success !== 'all') params.set('success', values.success);
  if (values.httpStatus) params.set('http_status', String(values.httpStatus));
  if (values.retcode !== undefined) params.set('retcode', String(values.retcode));
  if (values.errorCode?.trim()) params.set('error_code', values.errorCode.trim());
  if (values.requestId?.trim()) params.set('request_id', values.requestId.trim());
  return params;
}

export function LogsPage(): ReactNode {
  const { message } = App.useApp();
  const [searchParams, setSearchParams] = useSearchParams();
  const [filterForm] = Form.useForm<FilterValues>();
  const [exportForm] = Form.useForm<ExportValues>();
  const [logs, setLogs] = useState<ParseLog[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [clients, setClients] = useState<Client[]>([]);
  const [keys, setKeys] = useState<ApiKey[]>([]);
  const [platforms, setPlatforms] = useState<Platform[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [detail, setDetail] = useState<ParseLog | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [exportOpen, setExportOpen] = useState(false);
  const queryString = searchParams.toString();

  const loadKeys = useCallback(async (clientId?: string): Promise<void> => {
    if (!clientId) { setKeys([]); return; }
    try { setKeys(await adminApi.request<ApiKey[]>(`/api/admin/v1/clients/${clientId}/keys`)); }
    catch { setKeys([]); }
  }, []);

  useEffect(() => {
    const values = paramsToValues(new URLSearchParams(queryString));
    filterForm.setFieldsValue(values);
    void loadKeys(values.clientId);
  }, [filterForm, loadKeys, queryString]);

  useEffect(() => {
    void Promise.all([
      adminApi.request<Client[]>('/api/admin/v1/clients'),
      adminApi.request<Platform[]>('/api/admin/v1/platforms'),
    ]).then(([nextClients, nextPlatforms]) => { setClients(nextClients); setPlatforms(nextPlatforms); })
      .catch((cause: unknown) => setError(errorMessage(cause)));
  }, []);

  const load = useCallback(async (cursor?: string): Promise<void> => {
    if (cursor) setLoadingMore(true); else setLoading(true);
    setError(null);
    const params = new URLSearchParams(queryString);
    params.set('limit', '50');
    if (cursor) params.set('cursor', cursor);
    try {
      const page = await adminApi.request<LogPage>(`/api/admin/v1/logs?${params.toString()}`);
      setLogs((items) => cursor ? [...items, ...page.items] : page.items);
      setNextCursor(page.next_cursor);
    } catch (cause) { setError(errorMessage(cause)); }
    finally { setLoading(false); setLoadingMore(false); }
  }, [queryString]);

  useEffect(() => { void load(); }, [load]);

  const applyFilters = (values: FilterValues): void => setSearchParams(valuesToParams(values), { replace: true });
  const clearFilters = (): void => {
    filterForm.resetFields();
    filterForm.setFieldValue('success', 'all');
    setKeys([]);
    setSearchParams({}, { replace: true });
  };

  const openDetail = async (log: ParseLog): Promise<void> => {
    setDetail(log);
    setDetailLoading(true);
    try { setDetail(await adminApi.request<ParseLog>(`/api/admin/v1/logs/${log.id}`)); }
    catch (cause) { void message.error(errorMessage(cause)); }
    finally { setDetailLoading(false); }
  };

  const exportLogs = async ({ range }: ExportValues): Promise<void> => {
    const duration = range[1].valueOf() - range[0].valueOf();
    if (duration < 0 || duration > 30 * 86_400_000) {
      exportForm.setFields([{ name: 'range', errors: ['导出时间范围不能超过 30 天'] }]);
      return;
    }
    setExporting(true);
    const params = new URLSearchParams(queryString);
    params.set('from', range[0].toISOString());
    params.set('to', range[1].toISOString());
    try {
      await adminApi.download(`/api/admin/v1/logs/export?${params.toString()}`, `media-parser-logs-${dayjs().format('YYYYMMDD-HHmmss')}.jsonl`);
      setExportOpen(false);
      void message.success('日志导出已开始下载');
    } catch (cause) { void message.error(errorMessage(cause)); }
    finally { setExporting(false); }
  };

  const clientNames = useMemo(() => new Map(clients.map((item) => [item.id, item.name])), [clients]);
  const keyNames = useMemo(() => new Map(keys.map((item) => [item.id, item.name])), [keys]);
  const platformNames = useMemo(() => new Map(platforms.map((item) => [item.id, item.name])), [platforms]);
  const activeFilterCount = [...searchParams.keys()].length;

  const columns = [
    { title: '时间', dataIndex: 'created_at', width: 178, render: (value: string) => <Tooltip title={value}>{formatDate(value)}</Tooltip> },
    { title: 'Request ID', dataIndex: 'request_id', width: 210, render: (value: string) => <Typography.Text className="mono-cell" copyable={{ icon: <CopyOutlined /> }}>{value}</Typography.Text> },
    { title: '调用方 / Key', key: 'client', width: 220, render: (_: unknown, log: ParseLog) => <div><strong>{clientNames.get(log.client_id) ?? log.client_id}</strong><Typography.Text type="secondary">{keyNames.get(log.api_key_id) ?? log.api_key_id}</Typography.Text></div> },
    { title: '平台', dataIndex: 'platform_id', width: 140, render: (value: string | null) => value ? platformNames.get(value) ?? value : '识别失败' },
    { title: '状态', key: 'state', width: 110, render: (_: unknown, log: ParseLog) => stateTag(log) },
    { title: 'HTTP / retcode', key: 'codes', width: 130, render: (_: unknown, log: ParseLog) => `${log.http_status ?? '—'} / ${log.retcode ?? '—'}` },
    { title: '错误码', dataIndex: 'error_code', width: 170, render: (value: string | null) => value ? <Tag color="error">{value}</Tag> : '—' },
    { title: '耗时', dataIndex: 'duration_ms', width: 100, render: formatDuration },
    { title: '操作', key: 'actions', fixed: 'right' as const, width: 90, render: (_: unknown, log: ParseLog) => <Button type="link" onClick={() => void openDetail(log)}>查看</Button> },
  ];

  return (
    <div className="page-stack logs-page">
      <PageHeader title="调用日志" description="按游标加载解析请求，时间按本地显示、以 UTC 查询" extra={<Button icon={<DownloadOutlined />} onClick={() => { exportForm.setFieldsValue({ range: [dayjs().subtract(24, 'hour'), dayjs()] }); setExportOpen(true); }}>导出 JSONL</Button>} />
      {error ? <Alert type="error" showIcon title={error} action={<Button onClick={() => void load()}>重试</Button>} /> : null}
      <Card className="filter-card">
        <Form<FilterValues> form={filterForm} layout="vertical" initialValues={{ success: 'all' }} onFinish={applyFilters}>
          <div className="log-filter-grid">
            <Form.Item name="range" label="起止时间"><RangePicker showTime className="full-width" /></Form.Item>
            <Form.Item name="clientId" label="调用方"><Select<string> allowClear showSearch={{ optionFilterProp: 'label' }} options={clients.map((item) => ({ value: item.id, label: item.name }))} onChange={(value) => { filterForm.setFieldValue('keyId', undefined); void loadKeys(value); }} /></Form.Item>
            <Form.Item name="keyId" label="API Key"><Select allowClear disabled={!filterForm.getFieldValue('clientId')} options={keys.map((item) => ({ value: item.id, label: `${item.name} · ${item.masked_key}` }))} /></Form.Item>
            <Form.Item name="platformId" label="平台"><Select<string> allowClear showSearch={{ optionFilterProp: 'label' }} options={platforms.map((item) => ({ value: item.id, label: item.name }))} /></Form.Item>
            <Form.Item name="success" label="成功状态"><Select options={[{ value: 'all', label: '全部' }, { value: 'true', label: '成功' }, { value: 'false', label: '失败' }]} /></Form.Item>
            <Form.Item name="httpStatus" label="HTTP 状态"><InputNumber min={100} max={599} precision={0} /></Form.Item>
            <Form.Item name="retcode" label="retcode"><InputNumber min={0} max={999} precision={0} /></Form.Item>
            <Form.Item name="errorCode" label="错误码"><Input allowClear /></Form.Item>
            <Form.Item name="requestId" label="Request ID"><Input allowClear prefix={<SearchOutlined />} /></Form.Item>
          </div>
          <Space wrap><Button type="primary" htmlType="submit" icon={<FilterOutlined />}>查询</Button><Button onClick={clearFilters}>清除筛选</Button><Button icon={<ReloadOutlined />} loading={loading} onClick={() => void load()}>刷新</Button>{activeFilterCount ? <Tag color="blue">已应用 {activeFilterCount} 项筛选</Tag> : null}</Space>
        </Form>
      </Card>
      <div className="table-card">
        <Table<ParseLog> rowKey="id" loading={loading} columns={columns} dataSource={logs} scroll={{ x: 1480 }} pagination={false} locale={{ emptyText: activeFilterCount ? '没有符合当前筛选的调用日志' : '尚无调用日志' }} />
        <div className="load-more"><Typography.Text type="secondary">已加载 {logs.length} 条</Typography.Text>{nextCursor ? <Button loading={loadingMore} onClick={() => void load(nextCursor)}>加载更多</Button> : logs.length ? <span>已加载全部结果</span> : null}</div>
      </div>

      <Drawer title="调用日志详情" size={760} open={detail !== null} loading={detailLoading} onClose={() => setDetail(null)} destroyOnHidden>
        {detail ? <div className="drawer-sections">
          <section><Typography.Title level={4}>请求摘要</Typography.Title><Descriptions column={1} size="small" items={[
            { key: 'status', label: '状态', children: stateTag(detail) },
            { key: 'request', label: 'Request ID', children: <Typography.Text code copyable>{detail.request_id}</Typography.Text> },
            { key: 'platform', label: '平台', children: detail.platform_id ? platformNames.get(detail.platform_id) ?? detail.platform_id : '识别失败' },
            { key: 'client', label: '调用方 / Key', children: `${clientNames.get(detail.client_id) ?? detail.client_id} / ${detail.api_key_id}` },
            { key: 'network', label: 'IP / User-Agent', children: <div className="break-text">{detail.request_ip}<br />{detail.user_agent}</div> },
            { key: 'time', label: '时间 / 耗时', children: `${formatDate(detail.created_at)} / ${formatDuration(detail.duration_ms)}` },
          ]} /></section>
          <section><Typography.Title level={4}>链接</Typography.Title>{[['分享 URL', detail.share_url], ['真实 URL', detail.real_url]].map(([label, value]) => { const safe = safeHttpUrl(value); return <div className="url-row" key={label}><strong>{label}</strong><Typography.Text className="break-text" copyable>{value ?? '—'}</Typography.Text>{safe ? <Button type="link" icon={<LinkOutlined />} href={safe} target="_blank" rel="noopener noreferrer">打开</Button> : null}</div>; })}</section>
          <section><Typography.Title level={4}>业务响应</Typography.Title>{detail.response && typeof detail.response === 'object' ? <Descriptions column={1} size="small" items={Object.entries(detail.response as Record<string, unknown>).filter(([key]) => ['retcode', 'message', 'title', 'author', 'type'].includes(key)).map(([key, value]) => ({ key, label: key, children: summaryValue(value) }))} /> : <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="无结构化响应" />}</section>
          <Collapse items={[
            { key: 'input', label: '原始输入（默认折叠）', children: <pre className="json-panel">{detail.input_text ?? '—'}</pre> },
            { key: 'response', label: '完整响应 JSON（默认折叠）', children: <pre className="json-panel">{jsonText(detail.response)}</pre> },
          ]} />
        </div> : null}
      </Drawer>

      <Modal title="导出调用日志" open={exportOpen} confirmLoading={exporting} okText="导出 JSONL" onCancel={() => setExportOpen(false)} onOk={() => exportForm.submit()}>
        <Alert type="warning" showIcon title="导出包含所选范围内的完整输入与响应，请按敏感数据妥善保存。" />
        <Form<ExportValues> form={exportForm} layout="vertical" onFinish={(values) => void exportLogs(values)}><Form.Item name="range" label="导出时间范围" rules={[{ required: true, message: '请选择起止时间' }]}><RangePicker showTime className="full-width" /></Form.Item></Form>
        <Typography.Paragraph type="secondary">将复用当前调用方、Key、平台、状态和错误筛选；导出范围最多 30 天。</Typography.Paragraph>
      </Modal>
    </div>
  );
}
