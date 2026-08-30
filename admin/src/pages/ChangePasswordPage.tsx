import { ApiOutlined, LockOutlined } from '@ant-design/icons';
import { Alert, App, Button, Card, Form, Input, Typography } from 'antd';
import { useState, type ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../auth/AuthContext';
import { errorMessage } from '../lib/api';

interface PasswordValues {
  currentPassword: string;
  newPassword: string;
  confirmPassword: string;
}

export function ChangePasswordPage(): ReactNode {
  const { message } = App.useApp();
  const navigate = useNavigate();
  const { changePassword, busy } = useAuth();
  const [error, setError] = useState<string | null>(null);
  const [form] = Form.useForm<PasswordValues>();

  const submit = async (values: PasswordValues): Promise<void> => {
    setError(null);
    try {
      await changePassword(values.currentPassword, values.newPassword);
      form.resetFields();
      void message.success('密码已更新');
      void navigate('/dashboard', { replace: true });
    } catch (cause) {
      setError(errorMessage(cause));
    }
  };

  return (
    <main className="single-task-page">
      <Card className="single-task-card">
        <div className="single-task-brand"><span><ApiOutlined /></span> Media Parser</div>
        <LockOutlined className="task-icon" />
        <Typography.Title level={2}>首次登录，请修改密码</Typography.Title>
        <Typography.Paragraph type="secondary">
          新密码需要 12–128 个字符。修改成功后当前会话会自动更新。
        </Typography.Paragraph>
        {error ? <Alert className="form-alert" type="error" showIcon title={error} /> : null}
        <Form<PasswordValues>
          form={form}
          layout="vertical"
          size="large"
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
          <Button type="primary" htmlType="submit" block loading={busy}>保存并进入后台</Button>
        </Form>
      </Card>
    </main>
  );
}
