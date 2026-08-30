import { CheckCircleOutlined, CloseCircleOutlined, DatabaseOutlined, DeleteOutlined, ExperimentOutlined, FilterOutlined, KeyOutlined, SearchOutlined, StopOutlined } from '@ant-design/icons';
import { Alert, App, Button, Card, Descriptions, Drawer, Empty, Flex, Form, Input, Modal, Select, Space, Switch, Table, Tag, Typography, type TableProps } from 'antd';
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { PageHeader } from '../components/PageHeader';
import { adminApi, AdminApiError, errorMessage } from '../lib/api';
import { formatDate, formatDuration } from '../lib/format';
import type { Credential, Platform, PlatformTest } from '../types';

const mediaLabels: Record<string, string> = {
  video: '视频', images: '图片', audio: '音频', subtitles: '字幕', live_media: '实况',
};

type StatusFilter = 'all' | 'enabled' | 'disabled';
type CredentialFilter = 'all' | 'configured' | 'missing' | 'none';

function credentialState(platform: Platform): { key: CredentialFilter; label: string; color?: string; icon: ReactNode } {
  if (platform.credentials.length === 0) return { key: 'none', label: '无需凭据', icon: <StopOutlined /> };
  const configured = platform.credentials.filter((item) => item.configured);
  if (configured.length === platform.credentials.length) {
    const environmentOnly = configured.every((item) => item.source === 'environment');
    return { key: 'configured', label: environmentOnly ? '环境配置' : '数据库配置', color: 'success', icon: <DatabaseOutlined /> };
  }
  return { key: 'missing', label: '未配置', color: 'error', icon: <CloseCircleOutlined /> };
}

export function PlatformsPage(): ReactNode {
  const { message, modal } = App.useApp();
  const [credentialForm] = Form.useForm<{ value: string }>();
  const [platforms, setPlatforms] = useState<Platform[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [status, setStatus] = useState<StatusFilter>('all');
  const [mediaType, setMediaType] = useState('all');
  const [credentialFilter, setCredentialFilter] = useState<CredentialFilter>('all');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [filterDrawer, setFilterDrawer] = useState(false);
  const [credentialTarget, setCredentialTarget] = useState<Credential | null>(null);
  const [testText, setTestText] = useState('');
  const [cooldowns, setCooldowns] = useState<Record<string, number>>({});
  const testController = useRef<AbortController | null>(null);

  const selected = platforms.find((item) => item.id === selectedId) ?? null;

  const load = useCallback(async (): Promise<void> => {
    setLoading(true);
    setError(null);
    try { setPlatforms(await adminApi.request<Platform[]>('/api/admin/v1/platforms')); }
    catch (cause) { setError(errorMessage(cause)); }
    finally { setLoading(false); }
  }, []);

  useEffect(() => { void load(); }, [load]);
  useEffect(() => {
    const timer = window.setInterval(() => {
      const now = Date.now();
      setCooldowns((current) => Object.fromEntries(Object.entries(current).filter(([, until]) => until > now)));
    }, 1000);
    return () => window.clearInterval(timer);
  }, []);

  const visible = useMemo(() => platforms.filter((platform) => {
    const keyword = query.trim().toLocaleLowerCase();
    const credentials = credentialState(platform);
    return (!keyword || platform.name.toLocaleLowerCase().includes(keyword) || platform.id.toLocaleLowerCase().includes(keyword))
      && (status === 'all' || (status === 'enabled' ? platform.enabled : !platform.enabled))
      && (mediaType === 'all' || platform.media_types.includes(mediaType))
      && (credentialFilter === 'all' || credentials.key === credentialFilter);
  }), [credentialFilter, mediaType, platforms, query, status]);

  const toggle = (platform: Platform, enabled: boolean): void => {
    const execute = async (): Promise<void> => {
      try {
        await adminApi.request(`/api/admin/v1/platforms/${platform.id}`, { method: 'PATCH', body: { enabled } });
        setPlatforms((items) => items.map((item) => item.id === platform.id ? { ...item, enabled } : item));
        void message.success(enabled ? `${platform.name}已启用` : `${platform.name}已停用`);
      } catch (cause) { void message.error(errorMessage(cause)); }
    };
    modal.confirm({
      title: `${enabled ? '启用' : '停用'}“${platform.name}”？`,
      content: enabled ? '启用后，该平台可接受新的解析请求。' : '停用后，该平台的新解析请求会被拒绝。',
      okText: `确认${enabled ? '启用' : '停用'}`,
      okButtonProps: { danger: !enabled },
      onOk: execute,
    });
  };

  const saveCredential = async ({ value }: { value: string }): Promise<void> => {
    if (!selected || !credentialTarget) return;
    setSaving(true);
    try {
      await adminApi.request(`/api/admin/v1/platforms/${selected.id}/credentials/${credentialTarget.name}`, {
        method: 'PUT', body: { value },
      });
      credentialForm.resetFields();
      setCredentialTarget(null);
      void message.success('凭据已安全更新');
      await load();
    } catch (cause) { void message.error(errorMessage(cause)); }
    finally { setSaving(false); }
  };

  const deleteCredential = (credential: Credential): void => {
    if (!selected || credential.source !== 'database') return;
    modal.confirm({
      title: `删除 ${selected.name} 的 ${credential.name}？`,
      content: '删除数据库凭据后，平台可能回退到环境变量配置或失去授权能力。',
      okText: '删除凭据',
      okButtonProps: { danger: true },
      onOk: async () => {
        try {
          await adminApi.request(`/api/admin/v1/platforms/${selected.id}/credentials/${credential.name}`, { method: 'DELETE' });
          void message.success('数据库凭据已删除');
          await load();
        } catch (cause) { void message.error(errorMessage(cause)); }
      },
    });
  };

  const runTest = async (): Promise<void> => {
    if (!selected) return;
    const controller = new AbortController();
    testController.current = controller;
    setTesting(true);
    try {
      const result = await adminApi.request<PlatformTest>(`/api/admin/v1/platforms/${selected.id}/test`, {
        method: 'POST', body: testText.trim() ? { text: testText.trim() } : {}, signal: controller.signal,
      });
      setPlatforms((items) => items.map((item) => item.id === selected.id ? { ...item, last_test: result } : item));
      setCooldowns((current) => ({ ...current, [selected.id]: Date.now() + 60_000 }));
      void message[result.success ? 'success' : 'warning'](result.success ? '平台测试成功' : `平台测试失败：${result.error_category ?? '未知错误'}`);
    } catch (cause) {
      if (cause instanceof DOMException && cause.name === 'AbortError') void message.info('已取消本次测试');
      else {
        if (cause instanceof AdminApiError && cause.status === 429) setCooldowns((current) => ({ ...current, [selected.id]: Date.now() + 60_000 }));
        void message.error(errorMessage(cause));
      }
    } finally {
      testController.current = null;
      setTesting(false);
    }
  };

  const filterControls = (
    <>
      <Select<StatusFilter> aria-label="平台状态" value={status} onChange={setStatus} options={[
        { value: 'all', label: '全部状态' }, { value: 'enabled', label: '已启用' }, { value: 'disabled', label: '已停用' },
      ]} />
      <Select aria-label="媒体类型" value={mediaType} onChange={setMediaType} options={[
        { value: 'all', label: '全部媒体类型' }, ...Object.entries(mediaLabels).map(([value, label]) => ({ value, label })),
      ]} />
      <Select<CredentialFilter> aria-label="凭据状态" value={credentialFilter} onChange={setCredentialFilter} options={[
        { value: 'all', label: '全部凭据状态' }, { value: 'configured', label: '已配置' }, { value: 'missing', label: '未配置' }, { value: 'none', label: '无需凭据' },
      ]} />
    </>
  );

  const columns: TableProps<Platform>['columns'] = [
    {
      title: '平台', key: 'platform', width: 250,
      render: (_: unknown, platform: Platform) => (
        <div className="platform-name"><span className="platform-mark">{platform.name.slice(0, 2)}</span><div><strong>{platform.name}</strong><Typography.Text type="secondary" code>{platform.id}</Typography.Text><div>{platform.media_types.map((type) => <Tag key={type}>{mediaLabels[type] ?? type}</Tag>)}</div></div></div>
      ),
    },
    {
      title: '状态', dataIndex: 'enabled', width: 130,
      render: (enabled: boolean, platform: Platform) => <div className="switch-status"><Switch checked={enabled} aria-label={`${platform.name}${enabled ? '已启用' : '已停用'}`} onChange={(checked) => toggle(platform, checked)} /><span className={enabled ? 'status-success' : 'status-muted'}>{enabled ? <CheckCircleOutlined /> : <StopOutlined />} {enabled ? '已启用' : '已停用'}</span></div>,
    },
    {
      title: '凭据', key: 'credential', width: 170,
      render: (_: unknown, platform: Platform) => { const state = credentialState(platform); return <Tag icon={state.icon} color={state.color}>{state.label}</Tag>; },
    },
    {
      title: '最近测试', dataIndex: 'last_test', width: 220, responsive: ['md'],
      render: (test: PlatformTest | null) => test ? <div><Tag icon={test.success ? <CheckCircleOutlined /> : <CloseCircleOutlined />} color={test.success ? 'success' : 'error'}>{test.success ? '成功' : '失败'}</Tag><span>{formatDuration(test.duration_ms)} · {formatDate(test.created_at)}</span></div> : '未测试',
    },
    { title: '操作', key: 'actions', fixed: 'right' as const, width: 160, render: (_: unknown, platform: Platform) => <Space size={4}><Button type="link" onClick={() => setSelectedId(platform.id)}>查看</Button><Button type="link" icon={<ExperimentOutlined />} onClick={() => setSelectedId(platform.id)}>测试</Button></Space> },
  ];

  const remaining = selected ? Math.max(0, Math.ceil(((cooldowns[selected.id] ?? 0) - Date.now()) / 1000)) : 0;

  return (
    <div className="page-stack platforms-page">
      <PageHeader title="平台管理" description={`${platforms.length} 个平台，管理状态、媒体能力与访问凭据`} />
      {error ? <Alert type="error" showIcon title={error} action={<Button onClick={() => void load()}>重试</Button>} /> : null}
      <div className="filter-bar platform-filter-bar">
        <Input allowClear prefix={<SearchOutlined />} placeholder="搜索平台名称或 ID" value={query} onChange={(event) => setQuery(event.target.value)} />
        <div className="desktop-platform-filters">{filterControls}</div>
        <Button className="mobile-filter-trigger" icon={<FilterOutlined />} onClick={() => setFilterDrawer(true)}>筛选</Button>
        <Typography.Text type="secondary">显示 {visible.length} 项</Typography.Text>
      </div>
      <div className="table-card platform-table-card">
        <Table<Platform> rowKey="id" loading={loading} columns={columns} dataSource={visible} scroll={{ x: 980 }} pagination={false} locale={{ emptyText: '没有符合当前筛选的平台' }} />
        <div className="table-scroll-hint">↔ 表格可横向滚动查看完整信息</div>
      </div>

      <Drawer title="筛选平台" placement="bottom" size="auto" open={filterDrawer} onClose={() => setFilterDrawer(false)} extra={<Button type="primary" onClick={() => setFilterDrawer(false)}>完成</Button>}>
        <Flex vertical gap={14}>{filterControls}</Flex>
      </Drawer>

      <Drawer
        title={selected ? `${selected.name} · 平台详情` : '平台详情'}
        size={680}
        open={selected !== null}
        onClose={() => { testController.current?.abort(); setSelectedId(null); setTestText(''); }}
        destroyOnHidden
      >
        {selected ? (
          <div className="drawer-sections">
            <section>
              <Typography.Title level={4}>基本信息</Typography.Title>
              <Descriptions column={1} size="small" items={[
                { key: 'id', label: '平台 ID', children: <Typography.Text code copyable>{selected.id}</Typography.Text> },
                { key: 'media', label: '媒体能力', children: selected.media_types.map((type) => <Tag key={type}>{mediaLabels[type] ?? type}</Tag>) },
                { key: 'enabled', label: '状态', children: <Space><Switch checked={selected.enabled} onChange={(checked) => toggle(selected, checked)} /><span>{selected.enabled ? '已启用' : '已停用'}</span></Space> },
                { key: 'updated', label: '更新时间', children: formatDate(selected.updated_at) },
              ]} />
            </section>
            <section>
              <Typography.Title level={4}>凭据</Typography.Title>
              {selected.credentials.length ? selected.credentials.map((credential) => (
                <Card key={credential.name} size="small" className="credential-card">
                  <Flex justify="space-between" align="flex-start" gap={12}>
                    <div><strong><KeyOutlined /> {credential.name}</strong><div><Tag color={credential.configured ? 'success' : 'error'}>{credential.configured ? '已配置' : '未配置'}</Tag><Tag>{credential.required ? '必需' : '可选'}</Tag><Tag>{credential.source === 'database' ? '数据库' : credential.source === 'environment' ? '环境变量' : '无来源'}</Tag></div><Typography.Text type="secondary">{credential.masked ?? '未提供凭据'} · {formatDate(credential.updated_at)}</Typography.Text></div>
                    <Space><Button onClick={() => { credentialForm.resetFields(); setCredentialTarget(credential); }}>更新</Button>{credential.source === 'database' ? <Button danger icon={<DeleteOutlined />} onClick={() => deleteCredential(credential)}>删除</Button> : null}</Space>
                  </Flex>
                </Card>
              )) : <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="该平台无需凭据" />}
            </section>
            <section>
              <Typography.Title level={4}>连通性测试</Typography.Title>
              <Alert type="warning" showIcon title="测试会访问真实上游，并受全局串行和 60 秒冷却限制。" />
              <Input.TextArea rows={4} maxLength={2000} showCount value={testText} onChange={(event) => setTestText(event.target.value)} placeholder="可选：输入该平台的分享文本；留空使用服务端样例" />
              <Space wrap><Button type="primary" icon={<ExperimentOutlined />} loading={testing} disabled={remaining > 0} onClick={() => void runTest()}>{remaining > 0 ? `${remaining} 秒后可重试` : '运行测试'}</Button>{testing ? <Button onClick={() => testController.current?.abort()}>取消请求</Button> : null}</Space>
              {selected.last_test ? <Card size="small" className="test-result"><Descriptions column={1} size="small" items={[
                { key: 'result', label: '结果', children: <Tag color={selected.last_test.success ? 'success' : 'error'}>{selected.last_test.success ? '成功' : '失败'}</Tag> },
                { key: 'duration', label: '耗时', children: formatDuration(selected.last_test.duration_ms) },
                { key: 'types', label: '媒体类型', children: selected.last_test.media_types.join('、') || '—' },
                { key: 'missing', label: '缺失字段', children: selected.last_test.missing_fields.join('、') || '无' },
                { key: 'error', label: '错误分类', children: selected.last_test.error_category ?? '—' },
                { key: 'time', label: '测试时间', children: formatDate(selected.last_test.created_at) },
              ]} /></Card> : null}
            </section>
          </div>
        ) : null}
      </Drawer>

      <Modal title={`更新 ${selected?.name ?? ''} 的 ${credentialTarget?.name ?? ''}`} open={credentialTarget !== null} confirmLoading={saving} okText="安全保存" onCancel={() => setCredentialTarget(null)} onOk={() => credentialForm.submit()}>
        <Alert type="info" showIcon title="输入框不会回填旧凭据，保存后服务端只返回掩码。" />
        <Form form={credentialForm} layout="vertical" onFinish={(values: { value: string }) => void saveCredential(values)}><Form.Item name="value" label="新凭据" rules={[{ required: true, whitespace: true, message: '请输入新凭据' }, { max: 16384 }]}><Input.Password autoComplete="new-password" /></Form.Item></Form>
      </Modal>
    </div>
  );
}
