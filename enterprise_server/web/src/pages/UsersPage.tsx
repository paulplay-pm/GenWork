import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Download, KeyRound, Power, PowerOff, Upload } from 'lucide-react';
import type { JSX } from 'react';
import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';

import {
  departmentsApi,
  type DeptNode,
  flattenDeptsOptions,
} from '../api/departments';
import { type Role, rolesApi } from '../api/roles';
import {
  type BatchInput,
  type CreateUserInput,
  userErrorMessage,
  type UserRow,
  usersApi,
} from '../api/users';
import { useAuth } from '../auth/useAuth';
import { usePermissions } from '../auth/usePermissions';
import { Badge } from '../components/Badge';
import { BatchBar } from '../components/BatchBar';
import { ConfirmDialog } from '../components/ConfirmDialog';
import { type Column, DataTable } from '../components/DataTable';
import { PageHeader } from '../components/PageHeader';
import { StatusPill } from '../components/StatusPill';
import { type TempPasswordEntry, TempPasswordPanel } from '../components/TempPasswordPanel';
import { useToast } from '../components/toastStore';
import { UserFormDrawer, type UserFormValues } from '../components/UserFormDrawer';
import { UserImportDialog } from '../components/UserImportDialog';
import { UserSsoBindingCell } from '../components/UserSsoBindingCell';
import { t } from '../i18n';
import { dataScopeLabelKey, PermissionPoint } from '../shared/permissions';

/** Defer the search box before it hits the server (one query per pause). */
const SEARCH_DEBOUNCE_MS = 300;

const selectCls =
  'rounded-lg border border-[var(--border-default)] bg-white px-3 py-2 text-sm text-[var(--text-primary)] focus:outline-none focus:ring-2 focus:ring-[var(--accent-primary)]/30 focus:border-[var(--accent-primary)]';

/**
 * Users: filter bar (search / dept / role / status), a selectable table with
 * role chips (each carrying its data-scope label), the floating batch bar,
 * the create drawer, the bulk import dialog and per-row enable/disable/reset
 * (the server-generated temp password is shown once, in-app). All mutating
 * affordances gate on the fine `user:*` points from `/me` — never on the
 * coarse JWT roles. Users are disabled, never deleted (no delete route
 * exists).
 */
export function UsersPage(): JSX.Element {
  const { claims } = useAuth();
  const { hasPermission } = usePermissions();
  const nav = useNavigate();
  const qc = useQueryClient();
  const toast = useToast();

  const orgId = claims?.orgId ?? 'default-org';
  const canCreate = hasPermission(PermissionPoint.UserCreate);
  const canEdit = hasPermission(PermissionPoint.UserEdit);
  const canExport = hasPermission(PermissionPoint.UserExport);

  const [search, setSearch] = useState('');
  const [committedQ, setCommittedQ] = useState('');
  const [deptFilter, setDeptFilter] = useState('');
  const [roleFilter, setRoleFilter] = useState('');
  const [statusFilter, setStatusFilter] = useState('');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [openCreate, setOpenCreate] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  const [pendingDisable, setPendingDisable] = useState<UserRow | null>(null);
  const [pwResult, setPwResult] = useState<{ title: string; entries: TempPasswordEntry[] } | null>(
    null
  );

  useEffect(() => {
    const id = setTimeout(() => setCommittedQ(search.trim()), SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(id);
  }, [search]);

  // Query order matters for the test harness (and the request queue): the
  // list query fires first, then the vocabularies, then /me (deferred).
  const usersQuery = useQuery({
    queryKey: ['users', orgId, committedQ, deptFilter, roleFilter, statusFilter],
    queryFn: () =>
      usersApi.list(orgId, {
        q: committedQ || undefined,
        deptId: deptFilter || undefined,
        roleId: roleFilter || undefined,
        status:
          statusFilter === 'active' || statusFilter === 'disabled' ? statusFilter : undefined,
      }),
  });
  const rolesQuery = useQuery({
    queryKey: ['roles'],
    queryFn: () => rolesApi.list(),
  });
  const deptsQuery = useQuery({
    queryKey: ['departments', orgId],
    queryFn: () => departmentsApi.list(orgId),
  });

  const users = useMemo<UserRow[]>(
    () => (Array.isArray(usersQuery.data) ? usersQuery.data : []),
    [usersQuery.data]
  );
  const roles = useMemo<Role[]>(
    () => (Array.isArray(rolesQuery.data) ? rolesQuery.data : []),
    [rolesQuery.data]
  );
  const depts = useMemo<DeptNode[]>(
    () => (Array.isArray(deptsQuery.data) ? deptsQuery.data : []),
    [deptsQuery.data]
  );
  const deptOptions = useMemo(() => flattenDeptsOptions(depts), [depts]);
  /** Role code → data scope (for the chip suffix); a failed/absent role
   * lookup just leaves the suffix off. */
  const roleScope = useMemo(() => new Map(roles.map((r) => [r.name, r.dataScope])), [roles]);

  const invalidate = (): void => {
    qc.invalidateQueries({ queryKey: ['users'] });
  };

  const visibleSelected = users.filter((u) => selected.has(u.id)).map((u) => u.id);
  const allSelected = users.length > 0 && users.every((u) => selected.has(u.id));

  const toggleRow = (id: string): void => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const toggleAll = (): void => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (allSelected) users.forEach((u) => next.delete(u.id));
      else users.forEach((u) => next.add(u.id));
      return next;
    });
  };

  const createMut = useMutation({
    mutationFn: (input: CreateUserInput) => usersApi.create(input),
    onSuccess: () => {
      invalidate();
    },
    // Errors surface inline in the drawer (its submit handler catches them).
  });

  const disableMut = useMutation({
    mutationFn: (id: string) => usersApi.disable(id),
    onSuccess: () => {
      invalidate();
      toast.success(t('users.toast.disabled'));
      setPendingDisable(null);
    },
    onError: (e) => toast.error(userErrorMessage(e)),
  });

  const enableMut = useMutation({
    mutationFn: (id: string) => usersApi.enable(id),
    onSuccess: () => {
      invalidate();
      toast.success(t('users.toast.enabled'));
    },
    onError: (e) => toast.error(userErrorMessage(e)),
  });

  const resetMut = useMutation({
    mutationFn: (u: UserRow) => usersApi.resetPassword(u.id),
    onSuccess: (res, u) => {
      invalidate();
      setPwResult({
        title: t('users.pw.title'),
        entries: [{ username: u.username, tempPassword: res.tempPassword }],
      });
    },
    onError: (e) => toast.error(userErrorMessage(e)),
  });

  const batchMut = useMutation({
    mutationFn: (input: BatchInput) => usersApi.batch(input),
    onSuccess: (res, vars) => {
      invalidate();
      setSelected(new Set());
      if (vars.action === 'reset_password' && res.tempPasswords) {
        // Bulk reset is useless without the passwords — show them in-app.
        setPwResult({ title: t('users.batch.reset'), entries: res.tempPasswords });
      } else {
        toast.success(t('users.batch.toast.done').replaceAll('{n}', String(res.affected)));
      }
    },
    onError: (e) => toast.error(userErrorMessage(e)),
  });

  const runBatch = async (input: BatchInput): Promise<void> => {
    await batchMut.mutateAsync(input);
  };

  const exportCsv = async (): Promise<void> => {
    try {
      const csv = await usersApi.exportCsv(orgId);
      const blob = new Blob([csv], { type: 'text/csv' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `users-${orgId}-${new Date().toISOString().slice(0, 10)}.csv`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (e) {
      toast.error(userErrorMessage(e));
    }
  };

  const columns: Column<UserRow>[] = [
    {
      key: 'select',
      header: (
        <input
          type="checkbox"
          aria-label={t('users.col.selectAll')}
          checked={allSelected}
          onChange={toggleAll}
          className="h-4 w-4 accent-[var(--accent-primary)]"
        />
      ),
      render: (r) => (
        <input
          type="checkbox"
          aria-label={r.username}
          checked={selected.has(r.id)}
          onClick={(e) => e.stopPropagation()}
          onChange={() => toggleRow(r.id)}
          className="h-4 w-4 accent-[var(--accent-primary)]"
        />
      ),
    },
    {
      key: 'username',
      header: t('users.col.username'),
      render: (r) => <span className="font-mono text-[var(--text-primary)]">{r.username}</span>,
    },
    {
      key: 'display_name',
      header: t('users.col.displayName'),
      render: (r) => r.display_name ?? '—',
    },
    {
      key: 'email',
      header: t('users.col.email'),
      render: (r) => r.email ?? '—',
    },
    {
      key: 'sso_binding',
      header: t('sso.binding.column'),
      render: (r) => <UserSsoBindingCell userId={r.id} />,
    },
    {
      key: 'primary_dept_name',
      header: t('users.col.dept'),
      render: (r) => r.primary_dept_name ?? '—',
    },
    {
      key: 'extra_roles',
      header: t('users.col.roles'),
      render: (r) => (
        <div className="flex flex-wrap gap-1">
          {r.extra_roles.length === 0 ? (
            <span>—</span>
          ) : (
            r.extra_roles.map((code) => {
              const scope = roleScope.get(code);
              return (
                <Badge key={code} tone="neutral">
                  {code}
                  {scope && (
                    <span className="opacity-70">· {t(dataScopeLabelKey(scope))}</span>
                  )}
                </Badge>
              );
            })
          )}
        </div>
      ),
    },
    {
      key: 'status',
      header: t('users.col.status'),
      render: (r) => (
        <StatusPill tone={r.status === 'active' ? 'active' : 'disabled'}>
          {t(r.status === 'active' ? 'users.status.active' : 'users.status.disabled')}
        </StatusPill>
      ),
    },
    {
      key: 'actions',
      header: t('users.col.actions'),
      render: (r) =>
        canEdit ? (
          <div className="flex items-center justify-end gap-1.5">
            {r.status === 'active' ? (
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  setPendingDisable(r);
                }}
                className="inline-flex items-center gap-1 rounded-[var(--radius-sm)] border border-amber-200 bg-amber-50 px-2 py-1 text-[12px] font-medium text-amber-700 transition-colors hover:bg-amber-100"
              >
                <PowerOff className="h-3.5 w-3.5" />
                {t('users.action.disable')}
              </button>
            ) : (
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  enableMut.mutate(r.id);
                }}
                className="inline-flex items-center gap-1 rounded-[var(--radius-sm)] border border-emerald-200 bg-emerald-50 px-2 py-1 text-[12px] font-medium text-emerald-700 transition-colors hover:bg-emerald-100"
              >
                <Power className="h-3.5 w-3.5" />
                {t('users.action.enable')}
              </button>
            )}
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                resetMut.mutate(r);
              }}
              className="inline-flex items-center gap-1 rounded-[var(--radius-sm)] border border-[var(--border-default)] bg-[var(--bg-secondary)] px-2 py-1 text-[12px] font-medium text-[var(--text-secondary)] transition-colors hover:bg-[var(--bg-hover)]"
            >
              <KeyRound className="h-3.5 w-3.5" />
              {t('users.action.reset')}
            </button>
          </div>
        ) : null,
    },
  ];

  return (
    <div className="p-8">
      <PageHeader
        title={t('page.users.title')}
        subtitle={t('users.subtitle')}
        actions={
          <>
            {canExport && (
              <button
                type="button"
                onClick={() => void exportCsv()}
                className="inline-flex items-center gap-1.5 rounded-[var(--radius-md)] border border-[var(--border-default)] px-4 py-2 text-sm font-medium text-[var(--text-secondary)] transition-colors hover:bg-[var(--bg-hover)]"
              >
                <Download className="h-4 w-4" />
                {t('users.export')}
              </button>
            )}
            {canCreate && (
              <button
                type="button"
                onClick={() => setImportOpen(true)}
                className="inline-flex items-center gap-1.5 rounded-[var(--radius-md)] border border-[var(--border-default)] px-4 py-2 text-sm font-medium text-[var(--text-secondary)] transition-colors hover:bg-[var(--bg-hover)]"
              >
                <Upload className="h-4 w-4" />
                {t('users.import')}
              </button>
            )}
            {canCreate && (
              <button
                type="button"
                onClick={() => setOpenCreate(true)}
                className="rounded-[var(--radius-md)] bg-[var(--accent-primary)] px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-[var(--accent-primary-hover)]"
              >
                {t('users.create')}
              </button>
            )}
          </>
        }
      />

      <div className="mb-4 flex flex-wrap items-center gap-3">
        <input
          type="search"
          aria-label={t('users.search')}
          placeholder={t('users.search')}
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="w-64 rounded-lg border border-[var(--border-default)] bg-white px-3 py-2 text-sm text-[var(--text-primary)] placeholder:text-[var(--text-tertiary)] focus:outline-none focus:ring-2 focus:ring-[var(--accent-primary)]/30 focus:border-[var(--accent-primary)]"
        />
        <label className="flex items-center gap-1.5 text-sm text-[var(--text-secondary)]">
          {t('users.filter.dept')}
          <select
            className={selectCls}
            value={deptFilter}
            onChange={(e) => setDeptFilter(e.target.value)}
          >
            <option value="">{t('users.filter.all')}</option>
            {deptOptions.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        </label>
        <label className="flex items-center gap-1.5 text-sm text-[var(--text-secondary)]">
          {t('users.filter.role')}
          <select
            className={selectCls}
            value={roleFilter}
            onChange={(e) => setRoleFilter(e.target.value)}
          >
            <option value="">{t('users.filter.all')}</option>
            {roles.map((r) => (
              <option key={r.id} value={r.name}>
                {r.displayName ?? r.name}
              </option>
            ))}
          </select>
        </label>
        <label className="flex items-center gap-1.5 text-sm text-[var(--text-secondary)]">
          {t('users.filter.status')}
          <select
            className={selectCls}
            value={statusFilter}
            onChange={(e) => setStatusFilter(e.target.value)}
          >
            <option value="">{t('users.filter.all')}</option>
            <option value="active">{t('users.status.active')}</option>
            <option value="disabled">{t('users.status.disabled')}</option>
          </select>
        </label>
      </div>

      <DataTable<UserRow>
        columns={columns}
        rows={users}
        loading={usersQuery.isPending}
        emptyMessage={t('users.empty')}
        onRowClick={(r) => nav(`/orgs/users/${r.id}`)}
      />

      {canEdit && visibleSelected.length > 0 && (
        <BatchBar
          count={visibleSelected.length}
          roles={roles}
          depts={deptOptions}
          busy={batchMut.isPending}
          onAssignRole={(roleCodes) =>
            runBatch({ action: 'assign_role', userIds: visibleSelected, roleCodes })
          }
          onAdjustDept={(deptId) =>
            runBatch({ action: 'adjust_dept', userIds: visibleSelected, deptId })
          }
          onSetStatus={(status) =>
            runBatch({
              action: status === 'active' ? 'enable' : 'disable',
              userIds: visibleSelected,
            })
          }
          onResetPassword={() =>
            runBatch({ action: 'reset_password', userIds: visibleSelected })
          }
          onClear={() => setSelected(new Set())}
        />
      )}

      <UserFormDrawer
        open={openCreate}
        mode="create"
        editing={null}
        roles={roles}
        deptOptions={deptOptions}
        onSubmit={async (v: UserFormValues) => {
          const res = await createMut.mutateAsync({
            orgId,
            username: v.username.trim(),
            displayName: v.displayName || undefined,
            email: v.email || undefined,
            phone: v.phone || undefined,
            position: v.position || undefined,
            level: v.level || undefined,
            primaryDeptId: v.primaryDeptId || null,
            concurrentDeptIds: v.concurrentDeptIds,
            roles: v.roles,
            joinedAt: v.joinedAt || null,
            timezone: v.timezone || undefined,
          });
          return res.tempPassword;
        }}
        onClose={() => setOpenCreate(false)}
      />

      {importOpen && (
        <UserImportDialog
          orgId={orgId}
          onImported={invalidate}
          onClose={() => setImportOpen(false)}
        />
      )}

      <ConfirmDialog
        open={pendingDisable !== null}
        title={
          pendingDisable
            ? t('users.disable.title').replaceAll('{name}', pendingDisable.username)
            : ''
        }
        message={t('users.disable.body')}
        confirmLabel={t('users.action.disable')}
        destructive
        onConfirm={async () => {
          if (pendingDisable) await disableMut.mutateAsync(pendingDisable.id);
        }}
        onCancel={() => setPendingDisable(null)}
      />

      {pwResult && (
        <TempPasswordPanel
          open
          title={pwResult.title}
          entries={pwResult.entries}
          onClose={() => setPwResult(null)}
        />
      )}
    </div>
  );
}
