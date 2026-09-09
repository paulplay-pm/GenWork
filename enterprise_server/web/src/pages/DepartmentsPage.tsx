import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { JSX } from 'react';
import { useEffect, useMemo, useRef, useState } from 'react';

import { ApiError } from '../api/client';
import {
  departmentsApi,
  type DeptDetail,
  deptErrorMessage,
  type DeptNode,
  type DeptPatch
} from '../api/departments';
import { type UserRow, usersApi } from '../api/users';
import { useAuth } from '../auth/useAuth';
import { usePermissions } from '../auth/usePermissions';
import { ConfirmDialog } from '../components/ConfirmDialog';
import { DeptDetail as DeptDetailView, DeptSelectHint } from '../components/DeptDetail';
import { DeptFormDrawer, type DeptFormValues } from '../components/DeptFormDrawer';
import { DeptTree } from '../components/DeptTree';
import { PageHeader } from '../components/PageHeader';
import { useToast } from '../components/toastStore';
import { t } from '../i18n';
import { PermissionPoint } from '../shared/permissions';

/** Find a dept node by id (depth-first) in the forest. */
function findNode(nodes: DeptNode[], id: string): DeptNode | null {
  for (const n of nodes) {
    if (n.id === id) return n;
    const r = findNode(n.children, id);
    if (r) return r;
  }
  return null;
}

/** Ancestor chain of a dept id (last entry = the direct parent). */
function findAncestors(nodes: DeptNode[], id: string, chain: DeptNode[] = []): DeptNode[] | null {
  for (const n of nodes) {
    if (n.id === id) return chain;
    const r = findAncestors(n.children, id, [...chain, n]);
    if (r) return r;
  }
  return null;
}

export function DepartmentsPage(): JSX.Element {
  const { claims } = useAuth();
  const { hasPermission } = usePermissions();
  const qc = useQueryClient();
  const toast = useToast();

  const orgId = claims?.orgId ?? 'default-org';
  const canCreate = hasPermission(PermissionPoint.DeptCreate);
  const canEdit = hasPermission(PermissionPoint.DeptEdit);
  const canDelete = hasPermission(PermissionPoint.DeptDelete);

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [drawer, setDrawer] = useState<{ open: boolean; editing: DeptDetail | null }>({
    open: false,
    editing: null
  });
  const [pendingDelete, setPendingDelete] = useState<DeptDetail | null>(null);

  const treeQuery = useQuery({
    queryKey: ['departments', orgId],
    queryFn: () => departmentsApi.list(orgId),
  });
  const usersQuery = useQuery({
    queryKey: ['users', orgId],
    queryFn: () => usersApi.list(orgId),
  });
  const detailQuery = useQuery({
    queryKey: ['department', orgId, selectedId],
    queryFn: () => departmentsApi.get(selectedId as string),
    enabled: selectedId !== null,
  });

  // Load failures (e.g. a 403 `forbidden` when a dept is outside the caller's
  // data scope) surface as a toast, once per distinct error.
  const treeErrRef = useRef<unknown>(null);
  const detailErrRef = useRef<unknown>(null);
  useEffect(() => {
    if (treeQuery.isError && treeQuery.error !== treeErrRef.current) {
      treeErrRef.current = treeQuery.error;
      toast.error(deptErrorMessage(treeQuery.error));
    }
  }, [treeQuery.isError, treeQuery.error, toast]);
  useEffect(() => {
    if (detailQuery.isError && detailQuery.error !== detailErrRef.current) {
      detailErrRef.current = detailQuery.error;
      toast.error(deptErrorMessage(detailQuery.error));
    }
  }, [detailQuery.isError, detailQuery.error, toast]);

  // Defensive: the server returns arrays, but a stale/corrupt body must not
  // crash the panes.
  const tree = useMemo<DeptNode[]>(
    () => (Array.isArray(treeQuery.data) ? treeQuery.data : []),
    [treeQuery.data]
  );
  const users = useMemo<UserRow[]>(
    () => (Array.isArray(usersQuery.data) ? usersQuery.data : []),
    [usersQuery.data]
  );
  const detail = detailQuery.data;
  const detailNotFound =
    detailQuery.isError && detailQuery.error instanceof ApiError && detailQuery.error.status === 404;

  const invalidate = (): void => {
    qc.invalidateQueries({ queryKey: ['departments', orgId] });
    qc.invalidateQueries({ queryKey: ['department', orgId] });
  };

  const createMut = useMutation({
    mutationFn: (v: DeptFormValues) =>
      departmentsApi.create({
        orgId,
        name: v.name,
        code: v.code || undefined,
        parentId: v.parentId,
        leaderId: v.leaderId,
        sort: v.sort ?? undefined,
        description: v.description
      }),
    onSuccess: () => {
      invalidate();
      toast.success(t('dept.toast.created'));
      setDrawer({ open: false, editing: null });
    },
    onError: (e) => toast.error(deptErrorMessage(e)),
  });

  const patchMut = useMutation({
    mutationFn: (v: { id: string; body: DeptPatch }) => departmentsApi.patch(v.id, v.body),
    onSuccess: () => {
      invalidate();
      toast.success(t('dept.toast.updated'));
      setDrawer({ open: false, editing: null });
    },
    onError: (e) => toast.error(deptErrorMessage(e)),
  });

  const deleteMut = useMutation({
    mutationFn: (id: string) => departmentsApi.remove(id),
    onSuccess: (_res, id) => {
      invalidate();
      toast.success(t('dept.toast.deleted'));
      setPendingDelete(null);
      setDrawer({ open: false, editing: null });
      if (selectedId === id) setSelectedId(null);
    },
    onError: (e) => {
      // 409 delete guard → cannot-delete notice; never retry.
      toast.error(deptErrorMessage(e));
      setPendingDelete(null);
    }
  });

  const reorderMut = useMutation({
    mutationFn: (v: { parentId: string | null; orderedIds: string[] }) =>
      departmentsApi.reorder(orgId, v.parentId, v.orderedIds),
    onSuccess: () => {
      invalidate();
      toast.success(t('dept.toast.reordered'));
    },
    onError: (e) => toast.error(deptErrorMessage(e)),
  });

  /** Move a dept one step among its siblings and persist the new order. */
  const handleMove = (id: string, dir: -1 | 1): void => {
    const ancestors = findAncestors(tree, id) ?? [];
    const siblings = ancestors.length ? ancestors[ancestors.length - 1].children : tree;
    const idx = siblings.findIndex((n) => n.id === id);
    const j = idx + dir;
    if (idx < 0 || j < 0 || j >= siblings.length) return;
    const orderedIds = siblings.map((n) => n.id);
    [orderedIds[idx], orderedIds[j]] = [orderedIds[j], orderedIds[idx]];
    reorderMut.mutate({
      parentId: ancestors.length ? ancestors[ancestors.length - 1].id : null,
      orderedIds
    });
  };

  const parentOptions = useMemo(() => {
    const opts: { value: string; label: string }[] = [{ value: '', label: t('dept.rootOption') }];
    // When editing, exclude the dept itself and its descendants (the server
    // would reject a circular parent with 400).
    const excluded = new Set<string>();
    const editingNode = drawer.editing ? findNode(tree, drawer.editing.id) : null;
    if (editingNode) {
      const addDesc = (ns: DeptNode[]): void => {
        for (const c of ns) {
          excluded.add(c.id);
          addDesc(c.children);
        }
      };
      excluded.add(editingNode.id);
      addDesc(editingNode.children);
    }
    const walk = (ns: DeptNode[], prefix: string): void => {
      for (const n of ns) {
        if (excluded.has(n.id)) continue;
        opts.push({ value: n.id, label: `${prefix}${n.name}` });
        walk(n.children, `${prefix}  `);
      }
    };
    walk(tree, '');
    return opts;
  }, [tree, drawer.editing]);

  const leaderOptions = useMemo(() => {
    const opts: { value: string; label: string }[] = [{ value: '', label: t('dept.leaderNone') }];
    for (const u of users) opts.push({ value: u.id, label: u.display_name ?? u.username });
    return opts;
  }, [users]);

  const subs = useMemo(
    () => (selectedId ? (findNode(tree, selectedId)?.children ?? []) : []),
    [tree, selectedId]
  );

  const leaderLabel = useMemo(() => {
    if (!detail?.leader_id) return null;
    const u = users.find((x) => x.id === detail.leader_id);
    return u ? (u.display_name ?? u.username) : null;
  }, [detail, users]);

  return (
    <div className="p-8">
      <PageHeader
        title={t('page.departments.title')}
        subtitle={t('dept.subtitle')}
        actions={
          <>
            <button
              type="button"
              disabled
              title={t('dept.importHint')}
              className="cursor-not-allowed rounded-[var(--radius-md)] border border-[var(--border-default)] px-4 py-2 text-sm text-[var(--text-tertiary)] opacity-60"
            >
              {t('dept.import')}
            </button>
            {canCreate && (
              <button
                type="button"
                onClick={() => setDrawer({ open: true, editing: null })}
                className="rounded-[var(--radius-md)] bg-[var(--accent-primary)] px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-[var(--accent-primary-hover)]"
              >
                {t('dept.add')}
              </button>
            )}
          </>
        }
      />

      <div className="flex items-start gap-6">
        <div className="w-[320px] shrink-0 lg:sticky lg:top-6">
          <DeptTree
            nodes={tree}
            loading={treeQuery.isPending}
            selectedId={selectedId}
            onSelect={setSelectedId}
            canReorder={canEdit}
            onMove={canEdit ? handleMove : undefined}
          />
        </div>
        <div className="min-w-0 flex-1">
          {selectedId === null ? (
            <DeptSelectHint />
          ) : (
            <DeptDetailView
              key={selectedId}
              detail={detail}
              loading={detailQuery.isPending}
              notFound={detailNotFound}
              canEdit={canEdit}
              canDelete={canDelete}
              subs={subs}
              leaderLabel={leaderLabel}
              onEdit={() => detail && setDrawer({ open: true, editing: detail })}
              onDelete={() => detail && setPendingDelete(detail)}
              onPickSub={setSelectedId}
            />
          )}
        </div>
      </div>

      <DeptFormDrawer
        open={drawer.open}
        mode={drawer.editing ? 'edit' : 'create'}
        editing={drawer.editing}
        parentOptions={parentOptions}
        leaderOptions={leaderOptions}
        onSubmit={async (v) => {
          if (drawer.editing) {
            // code is immutable — never send it in the PATCH body.
            await patchMut.mutateAsync({
              id: drawer.editing.id,
              body: {
                name: v.name,
                parentId: v.parentId,
                leaderId: v.leaderId,
                sort: v.sort ?? undefined,
                description: v.description
              }
            });
          } else {
            await createMut.mutateAsync(v);
          }
        }}
        onRequestDelete={
          drawer.editing && canDelete ? () => setPendingDelete(drawer.editing) : undefined
        }
        onClose={() => setDrawer({ open: false, editing: null })}
      />

      <ConfirmDialog
        open={!!pendingDelete}
        title={
          pendingDelete
            ? t('dept.delete.title').replaceAll('{name}', pendingDelete.name)
            : ''
        }
        message={t('dept.delete.body')}
        confirmLabel={t('common.delete')}
        destructive
        onConfirm={() => {
          if (pendingDelete) deleteMut.mutate(pendingDelete.id);
        }}
        onCancel={() => setPendingDelete(null)}
      />
    </div>
  );
}
