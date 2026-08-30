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
          colorPrimary: '#e85d35',
          colorSuccess: '#167a59',
          colorWarning: '#b86a12',
          colorError: '#b83a3a',
          colorInfo: '#2f6f91',
          colorText: '#18211d',
          colorTextSecondary: '#68736d',
          colorBorder: '#d9ded7',
          colorBgLayout: '#f3f5f0',
          borderRadius: 9,
          borderRadiusLG: 14,
          fontFamily: 'Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
        },
        components: {
          Card: { boxShadow: '0 14px 36px rgb(24 33 29 / 8%)' },
          Layout: { headerBg: '#ffffff', siderBg: '#18211d' },
          Menu: { darkItemBg: '#18211d', darkItemSelectedBg: '#e85d35' },
          Table: { headerBg: '#f9faf6', rowHoverBg: '#fff8f4' },
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
