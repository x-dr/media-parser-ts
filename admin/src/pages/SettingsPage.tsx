import { CheckCircleOutlined, CloseCircleOutlined, LockOutlined, LogoutOutlined, SafetyOutlined } from '@ant-design/icons';
import { Alert, App, Button, Card, Descriptions, Form, Input, Space, Tag, Typography } from 'antd';
import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../auth/AuthContext';
import { errorMessage } from '../lib/api';
import { PageHeader } from '../components/PageHeader';

interface PasswordValues {
  currentPassword: string;
  newPassword: string;
  confirmPassword: string;
}

interface HealthState {
  health: boolean | null;
  ready: boolean | null;
  checkedAt: string | null;
}

export function SettingsPage(): ReactNode {
  const { message } = App.useApp();
  const navigate = useNavigate();
  const { user, changePassword, logout, busy } = useAuth();
  const [form] = Form.useForm<PasswordValues>();
  const [error, setError] = useState<string | null>(null);
  const [health, setHealth] = useState<HealthState>({ health: null, ready: null, checkedAt: null });

  const checkHealth = useCallback(async (): Promise<void> => {
    const [live, ready] = await Promise.allSettled([fetch('/api/health'), fetch('/api/ready')]);
    setHealth({
      health: live.status === 'fulfilled' ? live.value.ok : false,
      ready: ready.status === 'fulfilled' ? ready.value.ok : false,
      checkedAt: new Date().toISOString(),
    });
  }, []);

  useEffect(() => { void checkHealth(); }, [checkHealth]);

  const submit = async (values: PasswordValues): Promise<void> => {
    setError(null);
    try {
      await changePassword(values.currentPassword, values.newPassword);
      form.resetFields();
      void message.success('密码已更新，其他会话已失效');
    } catch (cause) {
      setError(errorMessage(cause));
    }
  };

  const statusTag = (ok: boolean | null): ReactNode => {
    if (ok === null) return <Tag>检查中</Tag>;
    return ok
      ? <Tag icon={<CheckCircleOutlined />} color="success">正常</Tag>
      : <Tag icon={<CloseCircleOutlined />} color="error">异常</Tag>;
  };

  return (
    <div className="page-stack settings-page">
      <PageHeader title="安全设置" description="管理当前管理员会话、密码和服务状态" />
      <div className="settings-grid">
        <Card className="content-card" title={<><SafetyOutlined /> 管理员资料</>}>
          <Descriptions column={1} size="small" items={[
            { key: 'id', label: '管理员 ID', children: <Typography.Text code copyable>{user?.id}</Typography.Text> },
            { key: 'username', label: '用户名', children: user?.username },
            { key: 'session', label: '会话', children: <Tag color="success">当前页面内存会话</Tag> },
          ]} />
          <Alert className="inline-alert" type="info" showIcon title="页面不会展示或持久化 Access Token、Refresh Token。" />
        </Card>
        <Card className="content-card" title="服务状态" extra={<Button onClick={() => void checkHealth()}>重新检查</Button>}>
          <Descriptions column={1} size="small" items={[
            { key: 'health', label: '进程存活', children: statusTag(health.health) },
            { key: 'ready', label: '依赖就绪', children: statusTag(health.ready) },
            { key: 'checked', label: '最近检查', children: health.checkedAt ? new Date(health.checkedAt).toLocaleString('zh-CN') : '—' },
          ]} />
          {health.ready === false ? (
            <Alert className="inline-alert" type="warning" showIcon title="服务进程存活，但依赖尚未就绪。部分操作可能失败。" />
          ) : null}
        </Card>
      </div>
      <Card className="content-card form-card" title={<><LockOutlined /> 修改密码</>}>
        {error ? <Alert className="form-alert" type="error" showIcon title={error} /> : null}
        <Form<PasswordValues>
          form={form}
          layout="vertical"
          requiredMark={false}
          scrollToFirstError={{ focus: true }}
          onFinish={(values) => void submit(values)}
        >
          <Form.Item name="currentPassword" label="当前密码" rules={[{ required: true, message: '请输入当前密码' }]}>
            <Input.Password autoComplete="current-password" />
          </Form.Item>
          <Form.Item name="newPassword" label="新密码" rules={[
            { required: true, message: '请输入新密码' },
            { min: 12, max: 128, message: '新密码长度为 12–128 个字符' },
          ]}>
            <Input.Password autoComplete="new-password" />
          </Form.Item>
          <Form.Item
            name="confirmPassword"
            label="确认新密码"
            dependencies={['newPassword']}
            rules={[
              { required: true, message: '请再次输入新密码' },
              ({ getFieldValue }) => ({
                validator(_, value: string) {
                  return !value || getFieldValue('newPassword') === value
                    ? Promise.resolve()
                    : Promise.reject(new Error('两次输入的新密码不一致'));
                },
              }),
            ]}
          >
            <Input.Password autoComplete="new-password" />
          </Form.Item>
          <Space wrap>
            <Button type="primary" htmlType="submit" loading={busy}>更新密码</Button>
            <Button
              danger
              icon={<LogoutOutlined />}
              onClick={() => { void logout().then(() => { void navigate('/login', { replace: true }); }); }}
            >退出登录</Button>
          </Space>
        </Form>
      </Card>
    </div>
  );
}
