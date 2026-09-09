import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, Pencil } from 'lucide-react';
import type { JSX } from 'react';
import { useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';

import { departmentsApi, type DeptNode, flattenDeptsOptions } from '../api/departments';
import { type Role, rolesApi } from '../api/roles';
import { adminDeleteUserSsoBinding, getUserSsoBinding, type SsoBinding } from '../api/sso';
import { type PatchUserInput, userErrorMessage, type UserFull, usersApi } from '../api/users';
import { useAuth } from '../auth/useAuth';
import { usePermissions } from '../auth/usePermissions';
import { Badge } from '../components/Badge';
import { ConfirmDialog } from '../components/ConfirmDialog';
import { type Column, DataTable } from '../components/DataTable';
import { InfoGrid } from '../components/InfoGrid';
import { PageHeader } from '../components/PageHeader';
import { StatusPill } from '../components/StatusPill';
import { useToast } from '../components/toastStore';
import { UserFormDrawer, type UserFormValues } from '../components/UserFormDrawer';
import { t } from '../i18n';
import { dataScopeLabelKey, PermissionPoint } from '../shared/permissions';

function fmtTs(ts: string | null): string {
  return ts ? new Date(ts).toLocaleString() : '—';
}

function trimExternalId(id: string): string {
  return id.length > 16 ? `${id.slice(0, 16)}…` : id;
}

/** Renders a user's SSO binding (connection name + truncated external id) and,
 *  when the caller holds `sso:edit` and a binding exists, an "Unbind" button.
 *  Loading → ellipsis; null/absent → i18n "Unbound". */
function renderSsoBinding(
  binding: SsoBinding | null | undefined,
  canUnbind: boolean,
  onUnbind: () => void
): JSX.Element {
  if (binding === undefined)
    return <span className="text-[var(--text-tertiary)]">{t('common.loading')}</span>;
  if (!binding)
    return <span className="text-[var(--text-tertiary)]">{t('sso.binding.unbound')}</span>;
  return (
    <span className="flex items-center gap-2">
      <span className="text-[var(--text-primary)]">
        {binding.connectionName}
        <span className="ml-1 font-mono text-xs text-[var(--text-tertiary)]">
          · {trimExternalId(binding.externalId)}
        </span>
      </span>
      {canUnbind && (
        <button
          type="button"
          onClick={onUnbind}
          className="rounded-[var(--radius-md)] border border-[var(--border-default)] px-2 py-0.5 text-xs font-medium text-[var(--danger-primary)] hover:bg-[var(--bg-hover)]"
        >
          {t('sso.binding.unbind')}
        </button>
      )}
    </span>
  );
}

/**
 * User detail: profile (incl. department memberships with the primary flag),
 * the recent-logins table, and the 停用/启用 toggle. Editing goes through the
 * shared `UserFormDrawer` (edit mode). All mutating affordances gate on the
 * fine `user:edit` point from `/me`; users are disabled, never deleted.
 */
export function UserDetailPage(): JSX.Element {
  const { id = '' } = useParams<{ id: string }>();
  const { claims } = useAuth();
  const { hasPermission } = usePermissions();
  const nav = useNavigate();
  const qc = useQueryClient();
  const toast = useToast();

  const orgId = claims?.orgId ?? 'default-org';
  const canEdit = hasPermission(PermissionPoint.UserEdit);

  const [editing, setEditing] = useState(false);
  const [confirmDisable, setConfirmDisable] = useState(false);
  const [confirmUnbind, setConfirmUnbind] = useState(false);

  const canUnbind = hasPermission(PermissionPoint.SsoEdit);

  const userQuery = useQuery({
    queryKey: ['user', id],
    queryFn: () => usersApi.get(id),
  });
  const ssoBindingQuery = useQuery({
    queryKey: ['user-sso-binding', id],
    queryFn: () => getUserSsoBinding(id),
  });
  const rolesQuery = useQuery({
    queryKey: ['roles'],
    queryFn: () => rolesApi.list(),
  });
  const deptsQuery = useQuery({
    queryKey: ['departments', orgId],
    queryFn: () => departmentsApi.list(orgId),
  });

  const roles = useMemo<Role[]>(
    () => (Array.isArray(rolesQuery.data) ? rolesQuery.data : []),
    [rolesQuery.data]
  );
  const depts = useMemo<DeptNode[]>(
    () => (Array.isArray(deptsQuery.data) ? deptsQuery.data : []),
    [deptsQuery.data]
  );
  const deptOptions = useMemo(() => flattenDeptsOptions(depts), [depts]);
  const roleScope = useMemo(() => new Map(roles.map((r) => [r.name, r.dataScope])), [roles]);

  const invalidate = (): void => {
    qc.invalidateQueries({ queryKey: ['user', id] });
    qc.invalidateQueries({ queryKey: ['users'] });
  };

  const patchMut = useMutation({
    mutationFn: (input: PatchUserInput) => usersApi.patch(id, input),
    onSuccess: () => {
      invalidate();
      toast.success(t('users.toast.updated'));
      setEditing(false);
    },
    onError: (e) => toast.error(userErrorMessage(e)),
  });

  const disableMut = useMutation({
    mutationFn: () => usersApi.disable(id),
    onSuccess: () => {
      invalidate();
      toast.success(t('users.toast.disabled'));
      setConfirmDisable(false);
    },
    onError: (e) => toast.error(userErrorMessage(e)),
  });

  const enableMut = useMutation({
    mutationFn: () => usersApi.enable(id),
    onSuccess: () => {
      invalidate();
      toast.success(t('users.toast.enabled'));
    },
    onError: (e) => toast.error(userErrorMessage(e)),
  });

  const unbindMut = useMutation({
    mutationFn: () => adminDeleteUserSsoBinding(id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['user-sso-binding', id] });
      toast.success(t('sso.binding.unbound'));
      setConfirmUnbind(false);
    },
    onError: (e) => toast.error(userErrorMessage(e)),
  });

  const u = userQuery.data as UserFull | undefined;

  if (userQuery.isLoading)
    return <div className="p-8 text-sm text-[var(--text-secondary)]">{t('common.loading')}</div>;
  if (!u)
    return <div className="p-8 text-sm text-[var(--text-secondary)]">{t('users.detail.notFound')}</div>;

  const logins: Column<UserFull['recent_logins'][number]>[] = [
    {
      key: 'ts',
      header: t('users.detail.login.time'),
      render: (l) => <span className="text-xs text-[var(--text-secondary)]">{fmtTs(l.ts)}</span>,
    },
    { key: 'ip', header: t('users.detail.login.ip'), render: (l) => l.ip ?? '—' },
    { key: 'device', header: t('users.detail.login.device'), render: (l) => l.device ?? '—' },
    {
      key: 'result',
      header: t('users.detail.login.result'),
      render: (l) => (
        <Badge tone={l.result === 'success' ? 'success' : 'danger'}>{l.result}</Badge>
      ),
    },
  ];

  return (
    <div className="p-8">
      <PageHeader
        title={u.display_name ?? u.username}
        subtitle={u.username}
        actions={
          <>
            <button
              type="button"
              onClick={() => nav('/orgs/users')}
              className="inline-flex items-center gap-1.5 rounded-[var(--radius-md)] border border-[var(--border-default)] px-3 py-2 text-sm font-medium text-[var(--text-secondary)] transition-colors hover:bg-[var(--bg-hover)]"
            >
              <ArrowLeft className="h-4 w-4" />
              {t('common.back')}
            </button>
            {canEdit && (
              <button
                type="button"
                onClick={() => setEditing(true)}
                className="inline-flex items-center gap-1.5 rounded-[var(--radius-md)] border border-[var(--border-default)] px-4 py-2 text-sm font-medium text-[var(--text-primary)] transition-colors hover:bg-[var(--bg-hover)]"
              >
                <Pencil className="h-4 w-4" />
                {t('users.detail.edit')}
              </button>
            )}
            {canEdit &&
              (u.status === 'active' ? (
                <button
                  type="button"
                  onClick={() => setConfirmDisable(true)}
                  className="rounded-[var(--radius-md)] bg-[var(--danger-primary)] px-4 py-2 text-sm font-medium text-white transition-colors hover:opacity-90"
                >
                  {t('users.action.disable')}
                </button>
              ) : (
                <button
                  type="button"
                  onClick={() => enableMut.mutate()}
                  className="rounded-[var(--radius-md)] bg-[var(--accent-primary)] px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-[var(--accent-primary-hover)]"
                >
                  {t('users.action.enable')}
                </button>
              ))}
          </>
        }
      />

      <div className="mb-5 flex items-center gap-3">
        <StatusPill tone={u.status === 'active' ? 'active' : 'disabled'}>
          {t(u.status === 'active' ? 'users.status.active' : 'users.status.disabled')}
        </StatusPill>
        <div className="flex flex-wrap gap-1">
          {u.extra_roles.map((code) => {
            const scope = roleScope.get(code);
            return (
              <Badge key={code} tone="neutral">
                {code}
                {scope && (
                  <span className="opacity-70">· {t(dataScopeLabelKey(scope))}</span>
                )}
              </Badge>
            );
          })}
        </div>
      </div>

      <h2 className="mb-2 text-sm font-semibold text-[var(--text-primary)]">
        {t('users.detail.profile')}
      </h2>
      <InfoGrid
        columns={2}
        items={[
          { label: t('users.col.username'), value: u.username },
          { label: t('users.form.displayName'), value: u.display_name ?? '—' },
          { label: t('users.form.email'), value: u.email ?? '—' },
          { label: t('users.form.phone'), value: u.phone ?? '—' },
          { label: t('users.form.position'), value: u.position ?? '—' },
          { label: t('users.form.level'), value: u.level ?? '—' },
          { label: t('users.form.timezone'), value: u.timezone ?? '—' },
          { label: t('users.form.joinedAt'), value: u.joined_at ? fmtTs(u.joined_at) : '—' },
          { label: t('users.detail.created'), value: fmtTs(u.created_at) },
          {
            label: t('sso.binding.column'),
            value: renderSsoBinding(ssoBindingQuery.data, canUnbind, () => setConfirmUnbind(true)),
          },
          {
            label: t('users.detail.lastLogin'),
            value: u.last_login_at ? `${fmtTs(u.last_login_at)}` : '—',
          },
        ]}
      />

      <h2 className="mb-2 mt-6 text-sm font-semibold text-[var(--text-primary)]">
        {t('users.detail.depts')}
      </h2>
      {u.departments.length === 0 ? (
        <p className="text-sm text-[var(--text-tertiary)]">{t('users.detail.deptsEmpty')}</p>
      ) : (
        <div className="overflow-hidden rounded-[var(--radius-lg)] border border-[var(--border-subtle)]">
          {u.departments.map((d, i) => (
            <div
              key={d.id}
              className={`flex items-center justify-between gap-3 px-4 py-2.5 text-sm ${
                i > 0 ? 'border-t border-[var(--border-subtle)]' : ''
              }`}
            >
              <span className="text-[var(--text-primary)]">{d.name}</span>
              <span className="flex items-center gap-2">
                <code className="text-xs text-[var(--text-tertiary)]">{d.path}</code>
                <Badge tone={d.is_primary ? 'info' : 'neutral'}>
                  {t(d.is_primary ? 'users.detail.deptPrimary' : 'users.detail.deptConcurrent')}
                </Badge>
              </span>
            </div>
          ))}
        </div>
      )}

      <h2 className="mb-2 mt-6 text-sm font-semibold text-[var(--text-primary)]">
        {t('users.detail.logins')}
      </h2>
      <DataTable
        columns={logins}
        rows={u.recent_logins}
        emptyMessage={t('users.detail.loginsEmpty')}
        rowKey={(l) => l.id}
      />

      <UserFormDrawer
        open={editing}
        mode="edit"
        editing={u}
        roles={roles}
        deptOptions={deptOptions}
        onSubmit={async (v: UserFormValues): Promise<string | null | undefined> => {
          await patchMut.mutateAsync({
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
            status: v.status,
          });
          return undefined;
        }}
        onClose={() => setEditing(false)}
      />

      <ConfirmDialog
        open={confirmDisable}
        title={t('users.disable.title').replaceAll('{name}', u.username)}
        message={t('users.disable.body')}
        confirmLabel={t('users.action.disable')}
        destructive
        onConfirm={async () => {
          await disableMut.mutateAsync();
        }}
        onCancel={() => setConfirmDisable(false)}
      />

      <ConfirmDialog
        open={confirmUnbind}
        title={t('sso.binding.unbind')}
        message={t('sso.binding.unbind.confirm')}
        confirmLabel={t('sso.binding.unbind')}
        destructive
        onConfirm={async () => {
          await unbindMut.mutateAsync();
        }}
        onCancel={() => setConfirmUnbind(false)}
      />
    </div>
  );
}
