import { createContext, useContext, type ReactNode } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { Me, Role } from '@firesafety/shared';
import { api, ApiRequestError } from './api';

interface AuthState {
  me: Me | null;
  loading: boolean;
  hasRole: (...roles: Role[]) => boolean;
  logout: () => Promise<void>;
}

const AuthContext = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const qc = useQueryClient();
  const { data, isLoading } = useQuery({
    queryKey: ['me'],
    queryFn: async () => {
      try {
        return await api.get<Me>('/api/me');
      } catch (err) {
        if (err instanceof ApiRequestError && err.status === 401) return null;
        throw err;
      }
    },
    staleTime: 60_000,
  });

  const value: AuthState = {
    me: data ?? null,
    loading: isLoading,
    // UI convenience only; every permission is enforced by the server.
    hasRole: (...roles) => !!data && data.roles.some((r) => roles.includes(r)),
    logout: async () => {
      await api.post('/auth/logout');
      qc.clear();
      window.location.assign('/login');
    },
  };
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthState {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used inside AuthProvider');
  return ctx;
}
