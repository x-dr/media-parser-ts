import {
  ApiOutlined,
  AppstoreOutlined,
  DashboardOutlined,
  FileSearchOutlined,
  LockOutlined,
  LogoutOutlined,
  MenuFoldOutlined,
  MenuUnfoldOutlined,
  SafetyCertificateOutlined,
  TeamOutlined,
  UserOutlined,
} from '@ant-design/icons';
import { Avatar, Badge, Button, Drawer, Dropdown, Layout, Menu, type MenuProps, Typography } from 'antd';
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { Outlet, useLocation, useNavigate } from 'react-router-dom';
import { useAuth } from '../auth/AuthContext';

const { Header, Sider, Content } = Layout;

const navigation = [
  { key: '/dashboard', icon: <DashboardOutlined />, label: '运行概览' },
  { key: '/clients', icon: <TeamOutlined />, label: '调用方' },
  { key: '/platforms', icon: <AppstoreOutlined />, label: '平台管理' },
  { key: '/logs', icon: <FileSearchOutlined />, label: '调用日志' },
  { key: '/audit', icon: <SafetyCertificateOutlined />, label: '审计日志' },
  { key: '/settings', icon: <LockOutlined />, label: '安全设置' },
];

const titleByPath = new Map(navigation.map((item) => [item.key, item.label]));

function selectedPath(pathname: string): string {
  if (pathname.startsWith('/clients')) return '/clients';
  return navigation.find((item) => pathname.startsWith(item.key))?.key ?? '/dashboard';
}

export function AppShell(): ReactNode {
  const navigate = useNavigate();
  const location = useLocation();
  const { user, logout } = useAuth();
  const [collapsed, setCollapsed] = useState(false);
  const [mobile, setMobile] = useState(() => window.matchMedia('(max-width: 959px)').matches);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [ready, setReady] = useState<boolean | null>(null);
  const current = selectedPath(location.pathname);

  useEffect(() => {
    const query = window.matchMedia('(max-width: 959px)');
    const update = (): void => setMobile(query.matches);
    query.addEventListener('change', update);
    return () => query.removeEventListener('change', update);
  }, []);

  useEffect(() => setDrawerOpen(false), [location.pathname]);

  useEffect(() => {
    let active = true;
    const check = async (): Promise<void> => {
      try {
        const response = await fetch('/api/ready');
        if (active) setReady(response.ok);
      } catch {
        if (active) setReady(false);
      }
    };
    void check();
    const timer = window.setInterval(() => { void check(); }, 30_000);
    return () => { active = false; window.clearInterval(timer); };
  }, []);

  const accountItems = useMemo<MenuProps['items']>(() => [
    { key: 'settings', icon: <UserOutlined />, label: '安全设置' },
    { type: 'divider' },
    { key: 'logout', icon: <LogoutOutlined />, label: '退出登录', danger: true },
  ], []);

  const onAccountClick: MenuProps['onClick'] = ({ key }) => {
    if (key === 'settings') void navigate('/settings');
    if (key === 'logout') {
      void logout().then(() => { void navigate('/login', { replace: true }); });
    }
  };

  const menu = (
    <Menu
      className="brand-menu"
      mode="inline"
      theme="light"
      selectedKeys={[current]}
      items={navigation}
      onClick={({ key }) => { void navigate(key); }}
    />
  );

  const brand = (
    <div className="brand-lockup">
      <div className="brand-mark"><ApiOutlined /></div>
      <div className="brand-copy">
        <strong>Media Parser</strong>
        <span>管理后台</span>
      </div>
    </div>
  );

  return (
    <Layout className="app-layout" hasSider={!mobile}>
      {!mobile ? (
        <Sider className="app-sider" width={232} collapsedWidth={72} collapsed={collapsed} trigger={null}>
          {brand}
          {menu}
          <Button
            className="sider-collapse"
            type="text"
            icon={collapsed ? <MenuUnfoldOutlined /> : <MenuFoldOutlined />}
            aria-label={collapsed ? '展开导航' : '折叠导航'}
            onClick={() => setCollapsed((value) => !value)}
          />
        </Sider>
      ) : null}
      <Layout className="workspace-layout">
        <Header className="app-header">
          <div className="header-left">
            <Button
              type="text"
              icon={mobile || collapsed ? <MenuUnfoldOutlined /> : <MenuFoldOutlined />}
              aria-label={mobile ? '打开导航' : collapsed ? '展开导航' : '折叠导航'}
              onClick={() => mobile ? setDrawerOpen(true) : setCollapsed((value) => !value)}
            />
            <Typography.Text strong>{titleByPath.get(current)}</Typography.Text>
          </div>
          <div className="header-actions">
            <Badge
              status={ready === null ? 'processing' : ready ? 'success' : 'warning'}
              text={<span className="ready-label">{ready === null ? '检查中' : ready ? '服务就绪' : '服务未就绪'}</span>}
            />
            <Dropdown menu={{ items: accountItems, onClick: onAccountClick }} trigger={['click']}>
              <Button type="text" className="admin-menu" aria-label="管理员菜单">
                <Avatar size={30} icon={<UserOutlined />} />
                <span>{user?.username}</span>
              </Button>
            </Dropdown>
          </div>
        </Header>
        <Content className="app-content"><Outlet /></Content>
      </Layout>
      <Drawer
        className="nav-drawer"
        placement="left"
        size={280}
        open={drawerOpen}
        onClose={() => setDrawerOpen(false)}
        styles={{ body: { padding: 0, background: '#fafafa' }, header: { display: 'none' } }}
      >
        {brand}
        {menu}
      </Drawer>
    </Layout>
  );
}
