import { ApiOutlined, LockOutlined, SafetyCertificateOutlined, UserOutlined } from '@ant-design/icons';
import { Alert, App, Button, Card, Form, Input, Space, Typography } from 'antd';
import { useState, type ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../auth/AuthContext';
import { errorMessage } from '../lib/api';

interface LoginValues {
  username: string;
  password: string;
}

export function LoginPage(): ReactNode {
  const { message } = App.useApp();
  const navigate = useNavigate();
  const { login, busy } = useAuth();
  const [form] = Form.useForm<LoginValues>();
  const [error, setError] = useState<string | null>(null);

  const submit = async (values: LoginValues): Promise<void> => {
    setError(null);
    try {
      const user = await login(values.username.trim(), values.password);
      form.setFieldValue('password', '');
      void message.success('登录成功');
      void navigate(user.must_change_password ? '/change-password' : '/dashboard', { replace: true });
    } catch (cause) {
      form.setFieldValue('password', '');
      setError(errorMessage(cause));
    }
  };

  return (
    <main className="auth-page">
      <section className="auth-brand" aria-labelledby="brand-title">
        <div className="auth-brand-content">
          <div className="brand-mark brand-mark-large"><ApiOutlined /></div>
          <Typography.Title id="brand-title">Media Parser</Typography.Title>
          <Typography.Paragraph>
            统一管理解析平台、调用方与访问密钥，清晰掌握服务健康和调用质量。
          </Typography.Paragraph>
          <Space orientation="vertical" size={18} className="security-points">
            <span><SafetyCertificateOutlined /> 凭据加密保存且不回显明文</span>
            <span><LockOutlined /> 管理会话只保存在当前页面内存</span>
          </Space>
        </div>
      </section>
      <section className="auth-form-panel">
        <Card className="auth-card">
          <div className="mobile-auth-logo"><ApiOutlined /> Media Parser</div>
          <Typography.Title level={2}>欢迎回来</Typography.Title>
          <Typography.Paragraph type="secondary">使用超级管理员账号登录管理后台</Typography.Paragraph>
          {error ? <Alert className="form-alert" type="error" showIcon title={error} /> : null}
          <Form<LoginValues>
            form={form}
            layout="vertical"
            size="large"
            requiredMark={false}
            scrollToFirstError={{ focus: true }}
            onFinish={(values) => void submit(values)}
          >
            <Form.Item name="username" label="用户名" rules={[
              { required: true, message: '请输入用户名' },
              { min: 3, max: 64, message: '用户名长度为 3–64 个字符' },
            ]}>
              <Input prefix={<UserOutlined />} autoComplete="username" placeholder="admin" />
            </Form.Item>
            <Form.Item name="password" label="密码" rules={[{ required: true, message: '请输入密码' }]}>
              <Input.Password prefix={<LockOutlined />} autoComplete="current-password" placeholder="请输入密码" />
            </Form.Item>
            <Button type="primary" htmlType="submit" loading={busy} block>登录</Button>
          </Form>
          <Typography.Paragraph className="auth-footnote" type="secondary">
            为保护会话安全，刷新页面后需要重新登录。
          </Typography.Paragraph>
        </Card>
      </section>
    </main>
  );
}
