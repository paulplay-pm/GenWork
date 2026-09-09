import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { JSX } from 'react';
import { useState } from 'react';

import { ApiError } from '../api/client';
import { type Role, rolesApi,type RoleType } from '../api/roles';
import { usePermissions } from '../auth/usePermissions';
import { Badge } from '../components/Badge';
import { ConfirmDialog } from '../components/ConfirmDialog';
import { PageHeader } from '../components/PageHeader';
import { RoleFormDrawer3 } from '../components/RoleFormDrawer3';
import { useToast } from '../components/toastStore';
import { t } from '../i18n';
import { dataScopeLabelKey, PermissionPoint } from '../shared/permissions';

const NAME_RE = /^[a-z0-9_]+$/;

type DrawerState = { open: boolean; editing: Role | null };

/**
 * Roles: a segmented (built-in / custom) card grid over the fine-grained
 * catalog, plus the 3-step create/edit drawer (`RoleFormDrawer3`). Mutations
 * are gated on the fine `role:*` points from `/me`; built-in roles are
 * delete-locked (the server 409s with `builtin_role` as a backstop).
 */
export function RolesPage(): JSX.Element {
  const { hasPermission } = usePermissions();
  const qc = useQueryClient();
  const toast = useToast();

  const canCreate = hasPermission(PermissionPoint.RoleCreate);
  const canEdit = hasPermission(PermissionPoint.RoleEdit);
  const canDelete = hasPermission(PermissionPoint.RoleDelete);

  const [seg, setSeg] = useState<RoleType>('builtin');
  const [drawer, setDrawer] = useState<DrawerState>({ open: false, editing: null });
  const [pendingDelete, setPendingDelete] = useState<Role | null>(null);

  const query = useQuery({
    queryKey: ['roles', seg],
    queryFn: () => rolesApi.list(seg),
  });
  const invalidate = () => qc.invalidateQueries({ queryKey: ['roles'] });

  const del = useMutation({
    mutationFn: (id: string) => rolesApi.remove(id),
    onSuccess: () => {
      invalidate();
      toast.success(t('roles.toast.deleted'));
      setPendingDelete(null);
    },
    onError: (e: Error) => {
      const code = e instanceof ApiError ? e.body?.error : undefined;
      toast.error(
        code === 'role_in_use'
          ? t('roles.page.error.inUse')
          : code === 'builtin_role'
            ? t('roles.page.error.builtin')
            : e.message
      );
    },
  });

  const startCopy = (r: Role): void => {
    const input = window.prompt(t('roles.page.copyPrompt'), `${r.name}_copy`);
    if (input === null) return;
    const newCode = input.trim();
    if (!NAME_RE.test(newCode)) {
      toast.error(t('roles.page.copyInvalid'));
      return;
    }
    rolesApi
      .copy(r.id, newCode)
      .then(() => {
        invalidate();
        toast.success(t('roles.page.copiedToast'));
      })
      .catch((e: unknown) => {
        const code = e instanceof ApiError ? e.body?.error : undefined;
        toast.error(
          code === 'duplicate' ? t('roles.page.error.duplicate') : (e as Error).message
        );
      });
  };

  const roles = query.data ?? [];

  return (
    <div className="p-8">
      <PageHeader
        title={t('page.roles.title')}
        actions={
          canCreate && (
            <button
              onClick={() => setDrawer({ open: true, editing: null })}
              className="px-4 py-2 bg-[var(--accent-primary)] hover:bg-[var(--accent-primary-hover)] text-white rounded-[var(--radius-md)]"
            >
              {t('roles.page.add')}
            </button>
          )
        }
      />
      <div className="flex w-fit rounded-lg border border-[var(--border-subtle)] p-0.5 mb-5 bg-[var(--bg-tertiary)]/40">
        {(['builtin', 'custom'] as const).map((k) => (
          <button
            key={k}
            onClick={() => setSeg(k)}
            className={`px-3.5 py-1.5 text-sm rounded-md ${
              seg === k
                ? 'bg-white shadow-sm text-[var(--text-primary)] font-semibold'
                : 'text-[var(--text-secondary)] hover:text-[var(--text-primary)]'
            }`}
          >
            {t(k === 'builtin' ? 'roles.page.builtin' : 'roles.page.custom')}
          </button>
        ))}
      </div>

      {query.isLoading ? (
        <div className="text-sm text-[var(--text-secondary)]">{t('common.loading')}</div>
      ) : roles.length === 0 ? (
        <div className="rounded-xl border border-dashed border-[var(--border-default)] bg-[var(--bg-secondary)] px-6 py-10 text-center text-sm text-[var(--text-secondary)]">
          {t('roles.empty')}
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
          {roles.map((r) => (
            <article
              key={r.id}
              className="group rounded-xl border border-[var(--border-subtle)] bg-white p-5 hover:shadow-md transition-shadow"
            >
              <div className="flex items-start justify-between gap-2">
                <h3 className="text-base font-semibold text-[var(--text-primary)] truncate">
                  {r.displayName ?? r.name}
                </h3>
                <Badge tone={r.isBuiltin ? 'info' : 'neutral'}>
                  {t(r.isBuiltin ? 'roles.page.builtin' : 'roles.page.custom')}
                </Badge>
              </div>
              <code className="text-xs text-[var(--text-secondary)]">{r.name}</code>
              {r.description && (
                <p className="mt-2 text-sm text-[var(--text-secondary)] line-clamp-2">
                  {r.description}
                </p>
              )}
              <div className="mt-3 flex items-center gap-3 text-xs text-[var(--text-secondary)]">
                <span>{t('roles.page.memberCount').replace('{n}', String(r.memberCount ?? 0))}</span>
                <span>{t(dataScopeLabelKey(r.dataScope))}</span>
              </div>
              <div className="mt-4 flex items-center gap-2 opacity-0 group-hover:opacity-100 transition-opacity">
                {canEdit && (
                  <button
                    onClick={() => setDrawer({ open: true, editing: r })}
                    className="px-3 py-1.5 text-xs rounded-md border border-[var(--border-default)] hover:bg-[var(--bg-hover)]"
                  >
                    {t('roles.page.edit')}
                  </button>
                )}
                {canCreate && (
                  <button
                    onClick={() => startCopy(r)}
                    className="px-3 py-1.5 text-xs rounded-md border border-[var(--border-default)] hover:bg-[var(--bg-hover)]"
                  >
                    {t('roles.page.copy')}
                  </button>
                )}
                {canDelete && !r.isBuiltin && (
                  <button
                    onClick={() => setPendingDelete(r)}
                    className="px-3 py-1.5 text-xs rounded-md border border-[var(--danger-primary)]/30 text-[var(--danger-primary)] hover:bg-[var(--danger-light)]"
                  >
                    {t('roles.page.delete')}
                  </button>
                )}
              </div>
            </article>
          ))}
        </div>
      )}

      {drawer.open && (
        <RoleFormDrawer3
          open={drawer.open}
          editing={drawer.editing}
          onClose={() => setDrawer({ open: false, editing: null })}
          onSaved={() => {
            invalidate();
            toast.success(drawer.editing ? t('roles.toast.updated') : t('roles.toast.created'));
            setDrawer({ open: false, editing: null });
          }}
        />
      )}

      <ConfirmDialog
        open={pendingDelete !== null}
        title={t('roles.page.deleteTitle').replace(
          '{name}',
          pendingDelete?.displayName ?? pendingDelete?.name ?? ''
        )}
        message={t('roles.page.deleteBody')}
        confirmLabel={t('common.delete')}
        cancelLabel={t('common.cancel')}
        destructive
        onConfirm={async () => {
          if (pendingDelete) await del.mutateAsync(pendingDelete.id);
        }}
        onCancel={() => setPendingDelete(null)}
      />
    </div>
  );
}
