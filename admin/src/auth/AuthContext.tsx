import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { adminApi } from '../lib/api';
import type { AdminUser, TokenPair } from '../types';

interface AuthContextValue {
  user: AdminUser | null;
  initializing: boolean;
  busy: boolean;
  login: (username: string, password: string) => Promise<AdminUser>;
  changePassword: (currentPassword: string, newPassword: string) => Promise<void>;
  logout: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }): ReactNode {
  const [user, setUser] = useState<AdminUser | null>(null);
  const [initializing, setInitializing] = useState(true);
  const [busy, setBusy] = useState(false);

  const loadUser = useCallback(async (): Promise<AdminUser> => {
    const current = await adminApi.request<AdminUser>('/api/admin/v1/auth/me');
    setUser(current);
    return current;
  }, []);

  useEffect(() => {
    const unsubscribe = adminApi.setSessionListener((tokens) => {
      if (!tokens) setUser(null);
    });
    if (!adminApi.hasSession()) {
      setInitializing(false);
      return unsubscribe;
    }
    void loadUser()
      .catch(() => { adminApi.setTokens(null); })
      .finally(() => { setInitializing(false); });
    return unsubscribe;
  }, [loadUser]);

  const login = useCallback(async (username: string, password: string): Promise<AdminUser> => {
    setBusy(true);
    try {
      await adminApi.login(username, password);
      return await loadUser();
    } catch (error) {
      adminApi.setTokens(null);
      throw error;
    } finally {
      setBusy(false);
    }
  }, [loadUser]);

  const changePassword = useCallback(async (currentPassword: string, newPassword: string): Promise<void> => {
    setBusy(true);
    try {
      const pair = await adminApi.request<TokenPair>('/api/admin/v1/auth/password', {
        method: 'PUT',
        body: { current_password: currentPassword, new_password: newPassword },
      });
      adminApi.setTokens(pair);
      await loadUser();
    } finally {
      setBusy(false);
    }
  }, [loadUser]);

  const logout = useCallback(async (): Promise<void> => {
    setBusy(true);
    try {
      await adminApi.request('/api/admin/v1/auth/logout', { method: 'POST' });
    } catch {
      // Local session is cleared even when the network request cannot complete.
    } finally {
      adminApi.setTokens(null);
      setUser(null);
      setBusy(false);
    }
  }, []);

  const value = useMemo(() => ({ user, initializing, busy, login, changePassword, logout }), [
    user, initializing, busy, login, changePassword, logout,
  ]);
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const value = useContext(AuthContext);
  if (!value) throw new Error('useAuth 必须在 AuthProvider 内使用');
  return value;
}
