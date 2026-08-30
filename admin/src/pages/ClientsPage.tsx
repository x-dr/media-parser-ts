import { EditOutlined, PlusOutlined, SearchOutlined } from '@ant-design/icons';
import { Alert, App, Button, Drawer, Form, Input, Select, Space, Switch, Table, Tag, Tooltip, Typography } from 'antd';
import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';
import { PageHeader } from '../components/PageHeader';
import { adminApi, errorMessage } from '../lib/api';
import { formatDate } from '../lib/format';
import type { Client } from '../types';

interface ClientFormValues {
  name: string;
  note?: string;
  enabled: boolean;
}

type StatusFilter = 'all' | 'enabled' | 'disabled';

export function ClientsPage(): ReactNode {
  const { message, modal } = App.useApp();
  const navigate = useNavigate();
  const [form] = Form.useForm<ClientFormValues>();
  const [clients, setClients] = useState<Client[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [status, setStatus] = useState<StatusFilter>('all');
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [editing, setEditing] = useState<Client | null>(null);

  const load = useCallback(async (): Promise<void> => {
    setLoading(true);
    setError(null);
    try { setClients(await adminApi.request<Client[]>('/api/admin/v1/clients')); }
    catch (cause) { setError(errorMessage(cause)); }
    finally { setLoading(false); }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const visible = useMemo(() => clients.filter((client) => {
    const keyword = query.trim().toLocaleLowerCase();
    const matchesQuery = !keyword || client.name.toLocaleLowerCase().includes(keyword) || client.note.toLocaleLowerCase().includes(keyword);
    const matchesStatus = status === 'all' || (status === 'enabled' ? client.enabled : !client.enabled);
    return matchesQuery && matchesStatus;
  }), [clients, query, status]);

  const openCreate = (): void => {
    setEditing(null);
    form.resetFields();
    form.setFieldsValue({ enabled: true });
    setDrawerOpen(true);
  };

  const openEdit = (client: Client): void => {
    setEditing(client);
    form.setFieldsValue({ name: client.name, note: client.note, enabled: client.enabled });
    setDrawerOpen(true);
  };

  const save = async (values: ClientFormValues): Promise<void> => {
    setSaving(true);
    try {
      const body = { name: values.name.trim(), note: values.note?.trim() ?? '', enabled: values.enabled };
      if (editing) {
        await adminApi.request(`/api/admin/v1/clients/${editing.id}`, { method: 'PATCH', body });
      } else {
        await adminApi.request('/api/admin/v1/clients', { method: 'POST', body });
      }
      void message.success(editing ? '调用方已更新' : '调用方已创建');
      setDrawerOpen(false);
      await load();
    } catch (cause) {
      void message.error(errorMessage(cause));
    } finally {
      setSaving(false);
    }
  };

  const toggle = (client: Client, enabled: boolean): void => {
    const execute = async (): Promise<void> => {
      try {
        await adminApi.request(`/api/admin/v1/clients/${client.id}`, { method: 'PATCH', body: { enabled } });
        setClients((items) => items.map((item) => item.id === client.id ? { ...item, enabled } : item));
        void message.success(enabled ? '调用方已启用' : '调用方已停用');
      } catch (cause) { void message.error(errorMessage(cause)); }
    };
    if (enabled) { void execute(); return; }
    modal.confirm({
      title: `停用“${client.name}”？`,
      content: '停用后，该调用方下的所有 API Key 将无法发起解析请求。',
      okText: '确认停用',
      okButtonProps: { danger: true },
      onOk: execute,
    });
  };

  const columns = [
    {
      title: '名称', dataIndex: 'name', width: 220,
      render: (value: string, client: Client) => <Button className="table-link" type="link" onClick={() => { void navigate(`/clients/${client.id}`); }}>{value}</Button>,
    },
    {
      title: '备注', dataIndex: 'note', width: 260, ellipsis: true,
      render: (value: string) => value ? <Tooltip title={value}><span>{value}</span></Tooltip> : '—',
    },
    { title: '状态', dataIndex: 'enabled', width: 112, render: (value: boolean) => value ? <Tag color="success">已启用</Tag> : <Tag>已停用</Tag> },
    { title: 'Key 数量', key: 'keys', width: 100, render: () => <Tooltip title="进入详情后获取">—</Tooltip> },
    { title: '创建时间', dataIndex: 'created_at', width: 178, render: formatDate },
    { title: '更新时间', dataIndex: 'updated_at', width: 178, render: formatDate },
    {
      title: '操作', key: 'actions', fixed: 'right' as const, width: 190,
      render: (_: unknown, client: Client) => (
        <Space size={4}>
          <Button type="link" onClick={() => { void navigate(`/clients/${client.id}`); }}>查看</Button>
          <Button type="link" icon={<EditOutlined />} onClick={() => openEdit(client)}>编辑</Button>
          <Switch size="small" checked={client.enabled} aria-label={`${client.name}${client.enabled ? '已启用' : '已停用'}`} onChange={(checked) => toggle(client, checked)} />
        </Space>
      ),
    },
  ];

  return (
    <div className="page-stack">
      <PageHeader
        title="调用方"
        description={`共 ${clients.length} 个调用方，管理业务接入主体及其访问状态`}
        extra={<Button type="primary" icon={<PlusOutlined />} onClick={openCreate}>新建调用方</Button>}
      />
      {error ? <Alert type="error" showIcon title={error} action={<Button onClick={() => void load()}>重试</Button>} /> : null}
      <div className="filter-bar">
        <Input
          allowClear
          prefix={<SearchOutlined />}
          placeholder="搜索名称或备注"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
        <Select<StatusFilter>
          aria-label="启用状态"
          value={status}
          onChange={setStatus}
          options={[
            { value: 'all', label: '全部状态' },
            { value: 'enabled', label: '已启用' },
            { value: 'disabled', label: '已停用' },
          ]}
        />
        <Typography.Text type="secondary">当前显示 {visible.length} 项</Typography.Text>
      </div>
      <div className="table-card">
        <Table<Client>
          rowKey="id"
          loading={loading}
          columns={columns}
          dataSource={visible}
          scroll={{ x: 1240 }}
          pagination={{ pageSize: 20, showSizeChanger: false }}
          locale={{ emptyText: query || status !== 'all' ? '没有符合当前筛选的调用方' : '尚未创建调用方' }}
        />
      </div>
      <Drawer
        title={editing ? '编辑调用方' : '新建调用方'}
        size={560}
        open={drawerOpen}
        onClose={() => setDrawerOpen(false)}
        destroyOnHidden
        extra={<Button type="primary" loading={saving} onClick={() => form.submit()}>保存</Button>}
      >
        <Form<ClientFormValues>
          form={form}
          layout="vertical"
          requiredMark={false}
          scrollToFirstError={{ focus: true }}
          onFinish={(values) => void save(values)}
        >
          <Form.Item name="name" label="名称" rules={[
            { required: true, whitespace: true, message: '请输入调用方名称' },
            { max: 100, message: '名称不能超过 100 个字符' },
          ]}>
            <Input placeholder="例如：内容运营后台" />
          </Form.Item>
          <Form.Item name="note" label="备注" rules={[{ max: 1000, message: '备注不能超过 1000 个字符' }]}>
            <Input.TextArea rows={5} showCount maxLength={1000} placeholder="说明用途、负责人或接入环境" />
          </Form.Item>
          <Form.Item name="enabled" label="启用状态" valuePropName="checked">
            <Switch checkedChildren="已启用" unCheckedChildren="已停用" />
          </Form.Item>
        </Form>
      </Drawer>
    </div>
  );
}
