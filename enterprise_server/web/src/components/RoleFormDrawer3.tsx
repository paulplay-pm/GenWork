import { useQuery } from '@tanstack/react-query';
import type { JSX } from 'react';
import { useState } from 'react';

import { ApiError } from '../api/client';
import { departmentsApi, type DeptNode } from '../api/departments';
import { type Role, rolesApi } from '../api/roles';
import { useAuth } from '../auth/useAuth';
import { t } from '../i18n';
import { DATA_SCOPE_VALUES, DataScope, dataScopeLabelKey, type PermissionPoint } from '../shared/permissions';
import { PermissionGroupTree } from './PermissionGroupTree';

const NAME_RE = /^[a-z0-9_]+$/;
const STEP_KEYS = ['roles.page.step1', 'roles.page.step2', 'roles.page.step3'] as const;

interface Props {
  open: boolean;
  /** The role being edited, or null when creating a new role. */
  editing: Role | null;
  /** Called after a successful create/patch (the page invalidates + toasts). */
  onSaved: () => void;
  onClose: () => void;
}

/** Flatten a dept forest into selectable rows (id + display path). */
function flattenDepts(nodes: DeptNode[], out: { id: string; label: string }[] = []): { id: string; label: string }[] {
  for (const n of nodes) {
    out.push({ id: n.id, label: n.path.replace(/^\//, '') });
    if (n.children.length > 0) flattenDepts(n.children, out);
  }
  return out;
}

/**
 * 3-step role create/edit drawer: (1) 基本信息 — code / display name /
 * description; (2) 数据范围 — one radio card per `DATA_SCOPE_VALUES`, with a
 * dept multi-select revealed when `custom_dept_tree` is selected; (3)
 * 功能权限点 — the grouped fine-grained permission tree. Submits via
 * `rolesApi.create` (new) or `rolesApi.patch` (edit). Built-in roles keep
 * edit enabled; only their code is locked.
 */
export function RoleFormDrawer3({ open, editing, onSaved, onClose }: Props): JSX.Element | null {
  const { claims } = useAuth();
  const orgId = claims?.orgId ?? 'default-org';
  const lockName = editing?.isBuiltin ?? false;

  const [step, setStep] = useState(0);
  const [name, setName] = useState(editing?.name ?? '');
  const [displayName, setDisplayName] = useState(editing?.displayName ?? '');
  const [description, setDescription] = useState(editing?.description ?? '');
  const [scope, setScope] = useState<DataScope>(editing?.dataScope ?? DataScope.Self);
  const [deptIds, setDeptIds] = useState<string[]>(editing?.customDeptIds ?? []);
  const [points, setPoints] = useState<PermissionPoint[]>(editing?.permissions ?? []);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  // Lazy dept fetch: only needed while `custom_dept_tree` is selected.
  const deptsQuery = useQuery({
    queryKey: ['departments', orgId],
    queryFn: () => departmentsApi.list(orgId),
    enabled: open && scope === DataScope.CustomDeptTree,
  });

  if (!open) return null;

  const inputCls =
    'w-full rounded-lg border border-[var(--border-default)] px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[var(--accent-primary)]/30 disabled:bg-[var(--bg-tertiary)] disabled:text-[var(--text-secondary)]';

  const goNext = (): void => {
    if (step === 0 && !NAME_RE.test(name.trim())) {
      setErr(t('roles.page.nameInvalid'));
      return;
    }
    setErr(null);
    setStep((s) => Math.min(s + 1, 2));
  };

  const submit = async (): Promise<void> => {
    if (!NAME_RE.test(name.trim())) {
      setErr(t('roles.page.nameInvalid'));
      return;
    }
    setBusy(true);
    setErr(null);
    const body = {
      name: name.trim(),
      displayName: displayName.trim() || null,
      description: description.trim() || null,
      dataScope: scope,
      customDeptIds: scope === DataScope.CustomDeptTree ? deptIds : [],
      permissions: points,
    };
    try {
      if (editing) await rolesApi.patch(editing.id, body);
      else await rolesApi.create(body);
      onSaved();
    } catch (e) {
      const code = e instanceof ApiError ? e.body?.error : undefined;
      setErr(code === 'duplicate' ? t('roles.page.error.duplicate') : (e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const toggleDept = (id: string): void => {
    setDeptIds((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));
  };

  const depts = flattenDepts(deptsQuery.data ?? []);

  return (
    <div className="fixed inset-0 z-50 flex justify-end bg-[var(--text-primary)]/40">
      <div data-testid="role-drawer" className="h-full w-[480px] bg-white shadow-lg flex flex-col">
        <div className="flex items-center justify-between px-5 py-4 border-b border-[var(--border-subtle)]">
          <h2 className="text-base font-semibold">
            {editing ? t('roles.editTitle') : t('roles.addTitle')}
          </h2>
          <button
            onClick={onClose}
            aria-label={t('common.close')}
            className="text-[var(--text-secondary)] hover:text-[var(--text-primary)] rounded-md p-1"
          >
            ✕
          </button>
        </div>
        <ol className="flex items-center gap-4 px-5 py-3 border-b border-[var(--border-subtle)]">
          {STEP_KEYS.map((k, i) => (
            <li
              key={k}
              className={`flex items-center gap-1.5 text-xs ${
                i === step
                  ? 'text-[var(--accent-primary)] font-semibold'
                  : i < step
                    ? 'text-[var(--text-primary)]'
                    : 'text-[var(--text-secondary)]'
              }`}
            >
              <span
                className={`h-5 w-5 flex items-center justify-center rounded-full text-[11px] ${
                  i === step ? 'bg-[var(--accent-primary)] text-white' : 'bg-[var(--bg-tertiary)] text-[var(--text-secondary)]'
                }`}
              >
                {i + 1}
              </span>
              {t(k)}
            </li>
          ))}
        </ol>
        <div className="flex-1 overflow-y-auto p-5 space-y-4">
          {step === 0 && (
            <>
              <label className="block">
                <span className="block text-sm font-medium mb-1">
                  {t('roles.name')} <span className="text-[var(--danger-primary)]">*</span>
                </span>
                <input
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="role_code"
                  disabled={lockName}
                  className={inputCls}
                />
                <span className="block text-xs text-[var(--text-secondary)] mt-1">
                  {lockName ? t('roles.page.builtinNameLocked') : t('roles.page.nameHelp')}
                </span>
              </label>
              <label className="block">
                <span className="block text-sm font-medium mb-1">{t('roles.page.displayName')}</span>
                <input
                  value={displayName}
                  onChange={(e) => setDisplayName(e.target.value)}
                  className={inputCls}
                />
              </label>
              <label className="block">
                <span className="block text-sm font-medium mb-1">{t('roles.description')}</span>
                <input
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                  className={inputCls}
                />
              </label>
            </>
          )}
          {step === 1 && (
            <>
              <p className="text-sm text-[var(--text-secondary)]">{t('roles.page.scopeHint')}</p>
              <div className="space-y-2" role="radiogroup">
                {DATA_SCOPE_VALUES.map((s) => {
                  const active = scope === s;
                  return (
                    <label
                      key={s}
                      className={`flex items-center gap-3 rounded-lg border px-3.5 py-3 cursor-pointer select-none ${
                        active
                          ? 'border-[var(--accent-primary)] bg-[var(--accent-light)]/40'
                          : 'border-[var(--border-default)] hover:bg-[var(--bg-hover)]'
                      }`}
                    >
                      <input
                        type="radio"
                        name="roleDataScope"
                        value={s}
                        checked={active}
                        onChange={() => {
                          setScope(s);
                          setErr(null);
                        }}
                        className="h-4 w-4 text-[var(--accent-primary)]"
                      />
                      <span className="text-sm">{t(dataScopeLabelKey(s))}</span>
                    </label>
                  );
                })}
              </div>
              {scope === DataScope.CustomDeptTree && (
                <div className="rounded-lg border border-[var(--border-subtle)] p-3">
                  <div className="text-sm font-medium mb-2">{t('roles.page.customDepts')}</div>
                  {deptsQuery.isLoading && (
                    <div className="text-sm text-[var(--text-secondary)]">{t('common.loading')}</div>
                  )}
                  {deptsQuery.isError && (
                    <div className="text-sm text-[var(--danger-primary)]">{t('common.error')}</div>
                  )}
                  {!deptsQuery.isLoading && !deptsQuery.isError &&
                    (depts.length === 0 ? (
                      <div className="text-sm text-[var(--text-secondary)]">
                        {t('roles.page.customDeptsEmpty')}
                      </div>
                    ) : (
                      <div className="max-h-56 overflow-y-auto space-y-1.5">
                        {depts.map((d) => (
                          <label
                            key={d.id}
                            className="flex items-center gap-2 text-sm cursor-pointer select-none"
                          >
                            <input
                              type="checkbox"
                              checked={deptIds.includes(d.id)}
                              onChange={() => toggleDept(d.id)}
                              className="h-4 w-4 rounded border-[var(--border-default)] text-[var(--accent-primary)]"
                            />
                            {d.label}
                          </label>
                        ))}
                      </div>
                    ))}
                </div>
              )}
            </>
          )}
          {step === 2 && <PermissionGroupTree value={points} onChange={setPoints} />}
        </div>
        <div className="px-5 py-4 border-t border-[var(--border-subtle)] flex items-center gap-2">
          {err && <p className="text-[var(--danger-primary)] text-sm mr-auto">{err}</p>}
          <div className="flex items-center gap-2 ml-auto">
            {step > 0 && (
              <button
                onClick={() => {
                  setErr(null);
                  setStep((s) => s - 1);
                }}
                className="rounded-lg border border-[var(--border-default)] px-3.5 py-2 text-sm"
              >
                {t('roles.page.prev')}
              </button>
            )}
            {step < 2 ? (
              <button
                onClick={goNext}
                className="rounded-lg bg-[var(--accent-primary)] text-white px-3.5 py-2 text-sm"
              >
                {t('roles.page.next')}
              </button>
            ) : (
              <button
                onClick={submit}
                disabled={busy || !NAME_RE.test(name.trim())}
                className="rounded-lg bg-[var(--accent-primary)] text-white px-3.5 py-2 text-sm disabled:opacity-50"
              >
                {t('common.save')}
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
