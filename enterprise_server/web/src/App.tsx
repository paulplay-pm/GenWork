import type { JSX } from 'react';
import { BrowserRouter, Navigate,Route, Routes } from 'react-router-dom';

import { AuthGuard } from './auth/AuthGuard';
import { ErrorBoundary } from './components/ErrorBoundary';
import { Sidebar } from './components/Sidebar';
import { ToastViewport } from './components/Toast';
import { AgentManagePage } from './pages/AgentManagePage';
import { AuditPage } from './pages/AuditPage';
import { SsoBindingsPage } from './pages/account/SsoBindingsPage';
import { BindSsoPage } from './pages/auth/BindSsoPage';
import { DepartmentsPage } from './pages/DepartmentsPage';
import { KitManagePage } from './pages/KitManagePage';
import { LoginPage } from './pages/LoginPage';
import { MCPManagePage } from './pages/MCPManagePage';
import { ProvidersModelsPage } from './pages/ProvidersModelsPage';
import { RolesPage } from './pages/RolesPage';
import { SetupPage } from './pages/SetupPage';
import { SkillManagePage } from './pages/SkillManagePage';
import { SSOConnectionsPage } from './pages/sso/SSOConnectionsPage';
import { UsagePage } from './pages/UsagePage';
import { UserDetailPage } from './pages/UserDetailPage';
import { UsersPage } from './pages/UsersPage';
import { VersionsPage } from './pages/VersionsPage';

function Shell({ children }: { children: JSX.Element }): JSX.Element {
  return (
    <div className="flex h-screen bg-gray-50">
      <Sidebar />
      <main className="flex-1 overflow-y-auto">
        <ErrorBoundary>
          {children}
        </ErrorBoundary>
      </main>
      <ToastViewport />
    </div>
  );
}

export function App(): JSX.Element {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/setup" element={<SetupPage />} />
        <Route path="/login" element={<LoginPage />} />
        {/* Public iframe shell for the server-rendered /bind-sso form
            (src/routes/auth/ssoBind.ts). Mounted outside AuthGuard so
            users who aren't signed in yet (the typical strict-mode flow)
            can still reach it. */}
        <Route path="/bind-sso" element={<BindSsoPage />} />
        <Route
          path="/"
          element={
            <AuthGuard>
              <Shell><div className="p-8"><h1 className="text-2xl font-bold">Dashboard</h1></div></Shell>
            </AuthGuard>
          }
        />
        <Route
          path="/orgs/users"
          element={
            <AuthGuard requires="org_admin">
              <Shell><UsersPage /></Shell>
            </AuthGuard>
          }
        />
        <Route
          path="/orgs/users/:id"
          element={
            <AuthGuard requires="org_admin">
              <Shell><UserDetailPage /></Shell>
            </AuthGuard>
          }
        />
        <Route
          path="/orgs/departments"
          element={
            <AuthGuard requires="org_admin">
              <Shell><DepartmentsPage /></Shell>
            </AuthGuard>
          }
        />
        <Route
          path="/orgs/roles"
          element={
            <AuthGuard requires="org_admin">
              <Shell><RolesPage /></Shell>
            </AuthGuard>
          }
        />
        <Route
          path="/config/providers"
          element={
            <AuthGuard requires="model_admin">
              <Shell><ProvidersModelsPage /></Shell>
            </AuthGuard>
          }
        />
        <Route
          path="/config/versions"
          element={
            <AuthGuard requires="org_admin">
              <Shell><VersionsPage /></Shell>
            </AuthGuard>
          }
        />
        <Route
          path="/config/mcp-manage"
          element={
            <AuthGuard requires="org_admin">
              <Shell><MCPManagePage /></Shell>
            </AuthGuard>
          }
        />
        <Route
          path="/config/sso"
          element={
            <AuthGuard requires="org_admin">
              <Shell><SSOConnectionsPage /></Shell>
            </AuthGuard>
          }
        />
        <Route
          path="/config/skill"
          element={
            <AuthGuard requires="policy_admin">
              <Shell><SkillManagePage /></Shell>
            </AuthGuard>
          }
        />
        <Route
          path="/config/kits"
          element={
            <AuthGuard requires="org_admin">
              <Shell><KitManagePage /></Shell>
            </AuthGuard>
          }
        />
        <Route
          path="/config/agents"
          element={
            <AuthGuard requires="agent_admin">
              <Shell><AgentManagePage /></Shell>
            </AuthGuard>
          }
        />
        <Route
          path="/monitoring/usage"
          element={
            <AuthGuard>
              <Shell><UsagePage /></Shell>
            </AuthGuard>
          }
        />
        <Route
          path="/monitoring/audit"
          element={
            <AuthGuard requires="auditor">
              <Shell><AuditPage /></Shell>
            </AuthGuard>
          }
        />
        <Route
          path="/account/sso-bindings"
          element={
            <AuthGuard>
              <Shell><SsoBindingsPage /></Shell>
            </AuthGuard>
          }
        />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </BrowserRouter>
  );
}