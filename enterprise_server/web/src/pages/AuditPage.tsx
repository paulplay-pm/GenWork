import { useQuery } from '@tanstack/react-query';
import type { JSX } from 'react';
import { useState } from 'react';

import { auditApi, type AuditEvent } from '../api/audit';
import { usersApi } from '../api/users';
import { useAuth } from '../auth/useAuth';
import { Badge } from '../components/Badge';
import { DataTable } from '../components/DataTable';
import { PageHeader } from '../components/PageHeader';
import { useToast } from '../components/toastStore';

const ACTION_OPTIONS = [
  'login',
  'login_failed',
  'token_refresh',
  'provider_call',
  'quota_exceeded',
  'quota_warning',
  'admin_access_denied',
  'setup_redeem',
  'provider_key_add',
  'provider_key_disable',
  'provider_key_enable',
  'user_disable',
  'user_create',
  'user_patch',
  'workspace_archive',
  'read_user_workspace',
  'password_change',
];

export function AuditPage(): JSX.Element {
  const { claims } = useAuth();
  const toast = useToast();
  const [userId, setUserId] = useState('');
  const [action, setAction] = useState('');

  const orgId = claims?.orgId ?? 'default-org';

  const usersQuery = useQuery({
    queryKey: ['users', orgId],
    queryFn: () => usersApi.list(orgId),
  });

  const auditQuery = useQuery({
    queryKey: ['audit', orgId, userId, action],
    queryFn: () =>
      auditApi.list({
        orgId,
        userId: userId || undefined,
        limit: 200,
      }).then((events) =>
        action ? events.filter((e) => e.action === action) : events
      ),
  });

  const exportCsv = async (): Promise<void> => {
    try {
      const csv = await auditApi.exportCsv({ orgId, userId: userId || undefined });
      const blob = new Blob([csv], { type: 'text/csv' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `audit-${orgId}-${new Date().toISOString().slice(0, 10)}.csv`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (e) {
      toast.error((e as Error).message);
    }
  };

  const columns = [
    {
      key: 'ts',
      header: 'Time',
      render: (r: AuditEvent) => (
        <span className="text-xs text-[var(--text-secondary)]">{new Date(r.ts).toLocaleString()}</span>
      ),
    },
    {
      key: 'action',
      header: 'Action',
      render: (r: AuditEvent) => (
        <Badge tone="info">{r.action}</Badge>
      ),
    },
    {
      key: 'user_id',
      header: 'User',
      render: (r: AuditEvent) => (
        <span className="text-xs font-mono text-[var(--text-primary)]">{r.user_id ?? '—'}</span>
      ),
    },
    {
      key: 'target_user_id',
      header: 'Target',
      render: (r: AuditEvent) => (
        <span className="text-xs font-mono text-[var(--text-primary)]">{r.target_user_id ?? '—'}</span>
      ),
    },
    {
      key: 'target_id',
      header: 'Target ID',
      render: (r: AuditEvent) => (
        <span className="text-xs font-mono text-[var(--text-secondary)]">{r.target_id ?? '—'}</span>
      ),
    },
  ];

  return (
    <div className="p-8">
      <PageHeader
        title="Audit"
        actions={
          <button
            onClick={exportCsv}
            className="px-4 py-2 border border-[var(--border-default)] rounded-[var(--radius-md)] text-[var(--text-primary)] hover:bg-[var(--bg-hover)]"
          >
            Export CSV
          </button>
        }
      />
      <div className="flex gap-3 mb-4">
        <select
          className="border border-[var(--border-default)] p-2 rounded-[var(--radius-md)] text-sm bg-[var(--bg-secondary)] text-[var(--text-primary)] focus:border-[var(--accent-primary)] focus:outline-none"
          value={userId}
          onChange={(e) => setUserId(e.target.value)}
        >
          <option value="">All users</option>
          {(usersQuery.data ?? []).map((u) => (
            <option key={u.id} value={u.id}>
              {u.username}
            </option>
          ))}
        </select>
        <select
          className="border border-[var(--border-default)] p-2 rounded-[var(--radius-md)] text-sm bg-[var(--bg-secondary)] text-[var(--text-primary)] focus:border-[var(--accent-primary)] focus:outline-none"
          value={action}
          onChange={(e) => setAction(e.target.value)}
        >
          <option value="">All actions</option>
          {ACTION_OPTIONS.map((a) => (
            <option key={a} value={a}>
              {a}
            </option>
          ))}
        </select>
      </div>
      <DataTable<AuditEvent>
        columns={columns}
        rows={auditQuery.data ?? []}
        loading={auditQuery.isLoading}
        emptyMessage="No audit events."
      />
    </div>
  );
}