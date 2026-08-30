import { App as AntApp, ConfigProvider } from 'antd';
import zhCN from 'antd/locale/zh_CN';
import { lazy, Suspense, type ReactNode } from 'react';
import { Navigate, Outlet, Route, Routes } from 'react-router-dom';
import { useAuth } from './auth/AuthContext';
import { AppShell } from './components/AppShell';
import { Skeleton } from 'antd';

const AuditPage = lazy(async () => ({ default: (await import('./pages/AuditPage')).AuditPage }));
const ChangePasswordPage = lazy(async () => ({ default: (await import('./pages/ChangePasswordPage')).ChangePasswordPage }));
const ClientDetailPage = lazy(async () => ({ default: (await import('./pages/ClientDetailPage')).ClientDetailPage }));
const ClientsPage = lazy(async () => ({ default: (await import('./pages/ClientsPage')).ClientsPage }));
const DashboardPage = lazy(async () => ({ default: (await import('./pages/DashboardPage')).DashboardPage }));
const LoginPage = lazy(async () => ({ default: (await import('./pages/LoginPage')).LoginPage }));
const LogsPage = lazy(async () => ({ default: (await import('./pages/LogsPage')).LogsPage }));
const PlatformsPage = lazy(async () => ({ default: (await import('./pages/PlatformsPage')).PlatformsPage }));
const SettingsPage = lazy(async () => ({ default: (await import('./pages/SettingsPage')).SettingsPage }));

function RequireSession(): ReactNode {
  const { user, initializing } = useAuth();
  if (initializing) return <div className="route-loading"><Skeleton active paragraph={{ rows: 8 }} /></div>;
  return user ? <Outlet /> : <Navigate to="/login" replace />;
}

function RequireChangedPassword(): ReactNode {
  const { user } = useAuth();
  return user?.must_change_password ? <Navigate to="/change-password" replace /> : <Outlet />;
}

function PublicOnly(): ReactNode {
  const { user, initializing } = useAuth();
  if (initializing) return <div className="route-loading"><Skeleton active paragraph={{ rows: 8 }} /></div>;
  if (!user) return <Outlet />;
  return <Navigate to={user.must_change_password ? '/change-password' : '/dashboard'} replace />;
}

export function App(): ReactNode {
  return (
    <ConfigProvider
      locale={zhCN}
      theme={{
        token: {
          colorPrimary: '#18181b',
          colorSuccess: '#16a34a',
          colorWarning: '#d97706',
          colorError: '#dc2626',
          colorInfo: '#2563eb',
          colorText: '#171717',
          colorTextSecondary: '#525252',
          colorBorder: '#e5e5e5',
          colorBgLayout: '#fafafa',
          borderRadius: 6,
          borderRadiusLG: 8,
          fontFamily: '"PingFang SC", Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
        },
        components: {
          Card: { boxShadow: '0 1px 2px rgb(0 0 0 / 4%)' },
          Layout: { headerBg: '#ffffff', siderBg: '#fafafa' },
          Menu: { itemSelectedBg: '#f0f0f0', itemSelectedColor: '#171717', itemColor: '#525252' },
          Table: { headerBg: '#fafafa', rowHoverBg: '#f5f5f5' },
        },
      }}
    >
      <AntApp>
        <Suspense fallback={<div className="route-loading"><Skeleton active paragraph={{ rows: 8 }} /></div>}>
        <Routes>
          <Route element={<PublicOnly />}>
            <Route path="/login" element={<LoginPage />} />
          </Route>
          <Route element={<RequireSession />}>
            <Route path="/change-password" element={<ChangePasswordPage />} />
            <Route element={<RequireChangedPassword />}>
              <Route element={<AppShell />}>
                <Route path="/dashboard" element={<DashboardPage />} />
                <Route path="/clients" element={<ClientsPage />} />
                <Route path="/clients/:clientId" element={<ClientDetailPage />} />
                <Route path="/platforms" element={<PlatformsPage />} />
                <Route path="/logs" element={<LogsPage />} />
                <Route path="/audit" element={<AuditPage />} />
                <Route path="/settings" element={<SettingsPage />} />
              </Route>
            </Route>
          </Route>
          <Route path="*" element={<Navigate to="/dashboard" replace />} />
        </Routes>
        </Suspense>
      </AntApp>
    </ConfigProvider>
  );
}
