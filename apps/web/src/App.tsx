import type { ReactNode } from 'react';
import { Navigate, Route, Routes, useLocation } from 'react-router-dom';
import type { Role } from '@firesafety/shared';
import { useAuth } from './lib/auth';
import { Layout } from './components/Layout';
import { Loading } from './components/Status';
import { LoginPage } from './pages/LoginPage';
import { BuildingsPage } from './pages/BuildingsPage';
import { BuildingDetailPage } from './pages/BuildingDetailPage';
import { AdminBuildingsPage } from './pages/AdminBuildingsPage';
import { AdminUsersPage } from './pages/AdminUsersPage';
import { AuditPage } from './pages/AuditPage';
import { AccessibilityPage, NotFoundPage, PrivacyPage } from './pages/StaticPages';

function RequireAuth({ children, roles }: { children: ReactNode; roles?: Role[] }) {
  const { me, loading, hasRole } = useAuth();
  const location = useLocation();
  if (loading) return <Loading />;
  if (!me) return <Navigate to={`/login?returnTo=${encodeURIComponent(location.pathname)}`} replace />;
  if (roles && !hasRole(...roles)) return <NotFoundPage />;
  return <>{children}</>;
}

export function App() {
  return (
    <Routes>
      <Route path="/login" element={<LoginPage />} />
      <Route element={<Layout />}>
        <Route path="/accessibility" element={<AccessibilityPage />} />
        <Route path="/privacy" element={<PrivacyPage />} />
        <Route path="/" element={<RequireAuth><BuildingsPage /></RequireAuth>} />
        <Route path="/buildings/:id" element={<RequireAuth><BuildingDetailPage /></RequireAuth>} />
        <Route path="/admin/buildings" element={<RequireAuth roles={['FireAdmin']}><AdminBuildingsPage /></RequireAuth>} />
        <Route path="/admin/users" element={<RequireAuth roles={['FireAdmin']}><AdminUsersPage /></RequireAuth>} />
        <Route path="/admin/audit" element={<RequireAuth roles={['FireAdmin']}><AuditPage /></RequireAuth>} />
        <Route path="*" element={<NotFoundPage />} />
      </Route>
    </Routes>
  );
}
