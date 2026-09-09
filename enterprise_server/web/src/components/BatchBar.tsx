import { X } from 'lucide-react';
import type { JSX } from 'react';
import { useState } from 'react';

import type { Role } from '../api/roles';
import { t } from '../i18n';
import { dataScopeLabelKey } from '../shared/permissions';

type PanelKind = 'role' | 'dept' | 'status' | null;

interface Props {
  /** Number of selected users (the bar only renders when > 0). */
  count: number;
  /** All org roles, for the 分配角色 panel. */
  roles: Role[];
  /** Flattened dept options, for the 调整部门 panel. */
  depts: { value: string; label: string }[];
  busy: boolean;
  onAssignRole: (roleCodes: string[]) => Promise<void>;
  onAdjustDept: (deptId: string) => Promise<void>;
  /** `status` is the target state: 'active' → enable, 'disabled' → disable. */
  onSetStatus: (status: 'active' | 'disabled') => Promise<void>;
  onResetPassword: () => Promise<void>;
  onClear: () => void;
}

const btnCls =
  'inline-flex items-center gap-1.5 rounded-lg bg-white/10 px-3 py-1.5 text-sm font-medium text-white transition-colors hover:bg-white/20 disabled:opacity-50';

/**
 * Floating dark batch-action bar over the users table. Shown while rows are
 * selected; the four actions call `usersApi.batch` (via the page's mutation)
 * with `action` ∈ assign_role / adjust_dept / enable / disable /
 * reset_password. A panel opens per action for the ones needing an argument.
 */
export function BatchBar({
  count,
  roles,
  depts,
  busy,
  onAssignRole,
  onAdjustDept,
  onSetStatus,
  onResetPassword,
  onClear,
}: Props): JSX.Element {
  const [panel, setPanel] = useState<PanelKind>(null);
  const [roleCodes, setRoleCodes] = useState<string[]>([]);
  const [deptId, setDeptId] = useState('');

  const toggleRole = (code: string): void => {
    setRoleCodes((prev) =>
      prev.includes(code) ? prev.filter((c) => c !== code) : [...prev, code]
    );
  };

  const submitRoles = async (): Promise<void> => {
    await onAssignRole(roleCodes);
    setRoleCodes([]);
    setPanel(null);
  };

  const submitDept = async (): Promise<void> => {
    await onAdjustDept(deptId);
    setDeptId('');
    setPanel(null);
  };

  const setStatus = async (status: 'active' | 'disabled'): Promise<void> => {
    await onSetStatus(status);
    setPanel(null);
  };

  return (
    <div className="pointer-events-none fixed inset-x-0 bottom-6 z-40 flex justify-center">
      <div className="pointer-events-auto relative flex items-center gap-2 rounded-xl bg-slate-900 px-4 py-3 shadow-2xl">
        <span className="mr-1 text-sm font-semibold text-white">
          {t('users.batch.selected').replaceAll('{n}', String(count))}
        </span>
        <button
          type="button"
          onClick={() => setPanel(panel === 'role' ? null : 'role')}
          disabled={busy}
          className={btnCls}
        >
          {t('users.batch.assignRole')}
        </button>
        <button
          type="button"
          onClick={() => setPanel(panel === 'dept' ? null : 'dept')}
          disabled={busy}
          className={btnCls}
        >
          {t('users.batch.adjustDept')}
        </button>
        <button
          type="button"
          onClick={() => setPanel(panel === 'status' ? null : 'status')}
          disabled={busy}
          className={btnCls}
        >
          {t('users.batch.setStatus')}
        </button>
        <button type="button" onClick={onResetPassword} disabled={busy} className={btnCls}>
          {t('users.batch.reset')}
        </button>
        <button
          type="button"
          onClick={onClear}
          aria-label={t('common.cancel')}
          className="ml-1 rounded-md p-1 text-white/70 transition-colors hover:bg-white/10 hover:text-white"
        >
          <X className="h-4 w-4" />
        </button>

        {panel === 'role' && (
          <div className="absolute bottom-full left-0 mb-2 w-72 rounded-xl border border-[var(--border-subtle)] bg-white p-3 shadow-xl">
            <p className="mb-2 text-xs text-[var(--text-tertiary)]">{t('users.batch.rolesHint')}</p>
            <div className="max-h-48 overflow-y-auto">
              {roles.map((r) => (
                <label
                  key={r.id}
                  className="flex cursor-pointer items-center gap-2 py-1.5 text-sm text-[var(--text-primary)]"
                >
                  <input
                    type="checkbox"
                    className="h-4 w-4 accent-[var(--accent-primary)]"
                    checked={roleCodes.includes(r.name)}
                    onChange={() => toggleRole(r.name)}
                  />
                  <span className="font-medium">{r.displayName ?? r.name}</span>
                  <span className="text-xs text-[var(--text-tertiary)]">
                    · {t(dataScopeLabelKey(r.dataScope))}
                  </span>
                </label>
              ))}
            </div>
            <div className="mt-2 flex justify-end">
              <button
                type="button"
                onClick={submitRoles}
                disabled={busy || roleCodes.length === 0}
                className="rounded-lg bg-[var(--accent-primary)] px-3.5 py-1.5 text-sm font-medium text-white transition-colors hover:bg-[var(--accent-primary-hover)] disabled:opacity-50"
              >
                {t('common.confirm')}
              </button>
            </div>
          </div>
        )}

        {panel === 'dept' && (
          <div className="absolute bottom-full left-0 mb-2 w-72 rounded-xl border border-[var(--border-subtle)] bg-white p-3 shadow-xl">
            <label className="block text-sm font-medium text-[var(--text-secondary)]" htmlFor="batch-dept">
              {t('users.filter.dept')}
            </label>
            <select
              id="batch-dept"
              value={deptId}
              onChange={(e) => setDeptId(e.target.value)}
              className="mt-1 w-full rounded-lg border border-[var(--border-default)] px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[var(--accent-primary)]/30"
            >
              <option value="">{t('users.filter.all')}</option>
              {depts.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
            <div className="mt-2 flex justify-end">
              <button
                type="button"
                onClick={submitDept}
                disabled={busy || deptId === ''}
                className="rounded-lg bg-[var(--accent-primary)] px-3.5 py-1.5 text-sm font-medium text-white transition-colors hover:bg-[var(--accent-primary-hover)] disabled:opacity-50"
              >
                {t('common.confirm')}
              </button>
            </div>
          </div>
        )}

        {panel === 'status' && (
          <div className="absolute bottom-full left-0 mb-2 flex gap-2 rounded-xl border border-[var(--border-subtle)] bg-white p-3 shadow-xl">
            <button
              type="button"
              onClick={() => void setStatus('active')}
              disabled={busy}
              className="rounded-lg border border-emerald-200 bg-emerald-50 px-3.5 py-1.5 text-sm font-medium text-emerald-700 transition-colors hover:bg-emerald-100 disabled:opacity-50"
            >
              {t('users.batch.enable')}
            </button>
            <button
              type="button"
              onClick={() => void setStatus('disabled')}
              disabled={busy}
              className="rounded-lg border border-amber-200 bg-amber-50 px-3.5 py-1.5 text-sm font-medium text-amber-700 transition-colors hover:bg-amber-100 disabled:opacity-50"
            >
              {t('users.batch.disable')}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
