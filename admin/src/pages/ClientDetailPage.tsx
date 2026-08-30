import { ArrowLeftOutlined, CheckOutlined, CopyOutlined, EditOutlined, KeyOutlined, PlusOutlined, StopOutlined } from '@ant-design/icons';
import { Alert, App, Button, Card, Checkbox, DatePicker, Descriptions, Drawer, Form, Input, InputNumber, Modal, Space, Switch, Table, Tag, Typography } from 'antd';
import dayjs, { type Dayjs } from 'dayjs';
import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { PageHeader } from '../components/PageHeader';
import { adminApi, errorMessage } from '../lib/api';
import { formatDate } from '../lib/format';
import type { ApiKey, Client } from '../types';

interface KeyFormValues {
  name: string;
  rateLimit: number;
  maxConcurrency: number;
  expiresAt?: Dayjs | null;
  enabled?: boolean;
}

interface ClientValues { name: string; note?: string; enabled: boolean }
interface RevokeValues { reason?: string }

function keyStatus(key: ApiKey): { color?: string; text: string } {
  if (key.revoked_at) return { color: 'error', text: '已吊销' };
  if (key.expires_at && new Date(key.expires_at).getTime() <= Date.now()) return { color: 'warning', text: '已过期' };
  if (!key.enabled) return { text: '已停用' };
  return { color: 'success', text: '已启用' };
}

export function ClientDetailPage(): ReactNode {
  const { clientId } = useParams<{ clientId: string }>();
  const navigate = useNavigate();
  const { message } = App.useApp();
  const [keyForm] = Form.useForm<KeyFormValues>();
  const [clientForm] = Form.useForm<ClientValues>();
  const [revokeForm] = Form.useForm<RevokeValues>();
  const [client, setClient] = useState<Client | null>(null);
  const [keys, setKeys] = useState<ApiKey[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [keyDrawer, setKeyDrawer] = useState(false);
  const [clientDrawer, setClientDrawer] = useState(false);
  const [editingKey, setEditingKey] = useState<ApiKey | null>(null);
  const [createdSecret, setCreatedSecret] = useState<string | null>(null);
  const [acknowledged, setAcknowledged] = useState(false);
  const [revokeTarget, setRevokeTarget] = useState<ApiKey | null>(null);

  const load = useCallback(async (): Promise<void> => {
    if (!clientId) return;
    setLoading(true);
    setError(null);
    try {
      const [nextClient, nextKeys] = await Promise.all([
        adminApi.request<Client>(`/api/admin/v1/clients/${clientId}`),
        adminApi.request<ApiKey[]>(`/api/admin/v1/clients/${clientId}/keys`),
      ]);
      setClient(nextClient);
      setKeys(nextKeys);
    } catch (cause) { setError(errorMessage(cause)); }
    finally { setLoading(false); }
  }, [clientId]);

  useEffect(() => { void load(); }, [load]);

  const openCreate = (): void => {
    setEditingKey(null);
    keyForm.resetFields();
    keyForm.setFieldsValue({ rateLimit: 60, maxConcurrency: 2, expiresAt: null, enabled: true });
    setKeyDrawer(true);
  };

  const openEdit = (key: ApiKey): void => {
    setEditingKey(key);
    keyForm.setFieldsValue({
      name: key.name,
      rateLimit: key.rate_limit_per_minute,
      maxConcurrency: key.max_concurrency,
      expiresAt: key.expires_at ? dayjs(key.expires_at) : null,
      enabled: key.enabled,
    });
    setKeyDrawer(true);
  };

  const saveKey = async (values: KeyFormValues): Promise<void> => {
    if (!clientId) return;
    setSaving(true);
    const body = {
      name: values.name.trim(),
      rate_limit_per_minute: values.rateLimit,
      max_concurrency: values.maxConcurrency,
      expires_at: values.expiresAt?.toISOString() ?? null,
      ...(editingKey ? { enabled: values.enabled ?? true } : {}),
    };
    try {
      if (editingKey) {
        await adminApi.request(`/api/admin/v1/keys/${editingKey.id}`, { method: 'PATCH', body });
        void message.success('API Key 已更新');
      } else {
        const created = await adminApi.request<ApiKey>(`/api/admin/v1/clients/${clientId}/keys`, { method: 'POST', body });
        setCreatedSecret(created.api_key ?? null);
        setAcknowledged(false);
      }
      setKeyDrawer(false);
      await load();
    } catch (cause) { void message.error(errorMessage(cause)); }
    finally { setSaving(false); }
  };

  const closeSecret = (): void => {
    if (!acknowledged) return;
    setCreatedSecret(null);
    setAcknowledged(false);
  };

  const toggleKey = async (key: ApiKey, enabled: boolean): Promise<void> => {
    try {
      await adminApi.request(`/api/admin/v1/keys/${key.id}`, { method: 'PATCH', body: { enabled } });
      setKeys((items) => items.map((item) => item.id === key.id ? { ...item, enabled } : item));
      void message.success(enabled ? 'API Key 已启用' : 'API Key 已停用');
    } catch (cause) { void message.error(errorMessage(cause)); }
  };

  const revoke = async (values: RevokeValues): Promise<void> => {
    if (!revokeTarget) return;
    setSaving(true);
    try {
      await adminApi.request(`/api/admin/v1/keys/${revokeTarget.id}/revoke`, {
        method: 'POST', body: { reason: values.reason?.trim() || undefined },
      });
      void message.success('API Key 已吊销');
      setRevokeTarget(null);
      revokeForm.resetFields();
      await load();
    } catch (cause) { void message.error(errorMessage(cause)); }
    finally { setSaving(false); }
  };

  const openClientEdit = (): void => {
    if (!client) return;
    clientForm.setFieldsValue({ name: client.name, note: client.note, enabled: client.enabled });
    setClientDrawer(true);
  };

  const saveClient = async (values: ClientValues): Promise<void> => {
    if (!client) return;
    setSaving(true);
    try {
      await adminApi.request(`/api/admin/v1/clients/${client.id}`, {
        method: 'PATCH', body: { name: values.name.trim(), note: values.note?.trim() ?? '', enabled: values.enabled },
      });
      void message.success('调用方已更新');
      setClientDrawer(false);
      await load();
    } catch (cause) { void message.error(errorMessage(cause)); }
    finally { setSaving(false); }
  };

  const activeKeys = useMemo(() => keys.filter((key) => keyStatus(key).text === '已启用').length, [keys]);
  const columns = [
    { title: '名称', dataIndex: 'name', width: 180 },
    { title: '掩码', dataIndex: 'masked_key', width: 190, render: (value: string) => <Typography.Text code>{value}</Typography.Text> },
    { title: '状态', key: 'status', width: 100, render: (_: unknown, key: ApiKey) => { const status = keyStatus(key); return <Tag color={status.color}>{status.text}</Tag>; } },
    { title: '每分钟限频', dataIndex: 'rate_limit_per_minute', width: 118 },
    { title: '最大并发', dataIndex: 'max_concurrency', width: 100 },
    { title: '过期时间', dataIndex: 'expires_at', width: 178, render: (value: string | null) => value ? formatDate(value) : '永不过期' },
    { title: '最后使用', dataIndex: 'last_used_at', width: 178, render: (value: string | null) => value ? formatDate(value) : '从未使用' },
    { title: '创建时间', dataIndex: 'created_at', width: 178, render: formatDate },
    {
      title: '操作', key: 'actions', fixed: 'right' as const, width: 220,
      render: (_: unknown, key: ApiKey) => key.revoked_at ? '—' : (
        <Space size={4}>
          <Button type="link" icon={<EditOutlined />} onClick={() => openEdit(key)}>编辑</Button>
          <Switch size="small" checked={key.enabled} aria-label={`${key.name}${key.enabled ? '已启用' : '已停用'}`} onChange={(checked) => void toggleKey(key, checked)} />
          <Button danger type="link" icon={<StopOutlined />} onClick={() => { revokeForm.resetFields(); setRevokeTarget(key); }}>吊销</Button>
        </Space>
      ),
    },
  ];

  return (
    <div className="page-stack">
      <Button className="back-button" type="text" icon={<ArrowLeftOutlined />} onClick={() => { void navigate('/clients'); }}>返回调用方</Button>
      <PageHeader
        title={client?.name ?? '调用方详情'}
        description={client?.note || '管理调用方资料及 API Key'}
        extra={<><Button icon={<EditOutlined />} onClick={openClientEdit}>编辑调用方</Button><Button type="primary" icon={<PlusOutlined />} onClick={openCreate}>新建 API Key</Button></>}
      />
      {error ? <Alert type="error" showIcon title={error} action={<Button onClick={() => void load()}>重试</Button>} /> : null}
      <Card className="content-card summary-card" loading={loading}>
        <Descriptions column={{ xs: 1, sm: 2, lg: 4 }} items={[
          { key: 'status', label: '状态', children: client?.enabled ? <Tag color="success">已启用</Tag> : <Tag>已停用</Tag> },
          { key: 'keys', label: 'API Key', children: `${keys.length} 个，共 ${activeKeys} 个可用` },
          { key: 'created', label: '创建时间', children: formatDate(client?.created_at) },
          { key: 'updated', label: '更新时间', children: formatDate(client?.updated_at) },
        ]} />
      </Card>
      <Card className="content-card" title={<><KeyOutlined /> API Key</>}>
        <Table<ApiKey> rowKey="id" loading={loading} columns={columns} dataSource={keys} scroll={{ x: 1500 }} pagination={false} locale={{ emptyText: '尚未创建 API Key' }} />
      </Card>

      <Drawer title={editingKey ? '编辑 API Key' : '新建 API Key'} size={600} open={keyDrawer} onClose={() => setKeyDrawer(false)} destroyOnHidden extra={<Button type="primary" loading={saving} onClick={() => keyForm.submit()}>保存</Button>}>
        <Form<KeyFormValues> form={keyForm} layout="vertical" requiredMark={false} onFinish={(values) => void saveKey(values)} scrollToFirstError={{ focus: true }}>
          <Form.Item name="name" label="名称" rules={[{ required: true, whitespace: true, message: '请输入 Key 名称' }, { max: 100 }]}><Input placeholder="例如：生产环境网关" /></Form.Item>
          <div className="two-column-form">
            <Form.Item name="rateLimit" label="每分钟限频" rules={[{ required: true }]}><InputNumber min={1} max={10000} precision={0} /></Form.Item>
            <Form.Item name="maxConcurrency" label="最大并发" rules={[{ required: true }]}><InputNumber min={1} max={100} precision={0} /></Form.Item>
          </div>
          <Form.Item name="expiresAt" label="过期时间（可选）"><DatePicker showTime className="full-width" placeholder="不选择则永不过期" /></Form.Item>
          {editingKey ? <Form.Item name="enabled" label="启用状态" valuePropName="checked"><Switch checkedChildren="已启用" unCheckedChildren="已停用" /></Form.Item> : null}
        </Form>
      </Drawer>

      <Drawer title="编辑调用方" size={560} open={clientDrawer} onClose={() => setClientDrawer(false)} destroyOnHidden extra={<Button type="primary" loading={saving} onClick={() => clientForm.submit()}>保存</Button>}>
        <Form<ClientValues> form={clientForm} layout="vertical" requiredMark={false} onFinish={(values) => void saveClient(values)}>
          <Form.Item name="name" label="名称" rules={[{ required: true, whitespace: true }, { max: 100 }]}><Input /></Form.Item>
          <Form.Item name="note" label="备注" rules={[{ max: 1000 }]}><Input.TextArea rows={5} maxLength={1000} showCount /></Form.Item>
          <Form.Item name="enabled" label="启用状态" valuePropName="checked"><Switch checkedChildren="已启用" unCheckedChildren="已停用" /></Form.Item>
        </Form>
      </Drawer>

      <Modal
        title="保存新 API Key"
        open={createdSecret !== null}
        closable={acknowledged}
        mask={{ closable: false }}
        keyboard={acknowledged}
        onCancel={closeSecret}
        footer={<Button type="primary" disabled={!acknowledged} onClick={closeSecret}>我已安全保存</Button>}
      >
        <Alert type="warning" showIcon title="请立即安全保存。完整 API Key 只显示这一次，关闭后无法恢复。" />
        <div className="secret-value"><Typography.Text>{createdSecret}</Typography.Text><Button icon={<CopyOutlined />} onClick={() => void navigator.clipboard.writeText(createdSecret ?? '').then(() => message.success('已复制'))}>复制</Button></div>
        <Checkbox checked={acknowledged} onChange={(event) => setAcknowledged(event.target.checked)}><CheckOutlined /> 我已将 API Key 保存到安全位置</Checkbox>
      </Modal>

      <Modal title={`吊销“${revokeTarget?.name ?? ''}”`} open={revokeTarget !== null} confirmLoading={saving} okText="确认吊销" okButtonProps={{ danger: true }} onCancel={() => setRevokeTarget(null)} onOk={() => revokeForm.submit()}>
        <Alert type="error" showIcon title="吊销不可撤销。如需恢复访问，请创建新的 API Key。" description={`掩码：${revokeTarget?.masked_key ?? ''}；调用方：${client?.name ?? ''}`} />
        <Form<RevokeValues> form={revokeForm} layout="vertical" onFinish={(values) => void revoke(values)}><Form.Item name="reason" label="吊销原因（可选）" rules={[{ max: 500 }]}><Input.TextArea rows={3} maxLength={500} /></Form.Item></Form>
      </Modal>
    </div>
  );
}
