import { CheckCircle2, X } from 'lucide-react';
import type { JSX, ReactNode } from 'react';
import { useEffect, useRef, useState } from 'react';

import type { Role } from '../api/roles';
import type { UserFull } from '../api/users';
import { userErrorMessage } from '../api/users';
import { t } from '../i18n';
import { dataScopeLabelKey } from '../shared/permissions';
import { TempPasswordRow } from './TempPasswordPanel';

export interface UserFormValues {
  username: string;
  displayName: string;
  email: string;
  phone: string;
  position: string;
  level: string;
  /** `YYYY-MM-DD` (or '' when unset). */
  joinedAt: string;
  timezone: string;
  /** '' = no primary department. */
  primaryDeptId: string;
  concurrentDeptIds: string[];
  roles: string[];
  status: 'active' | 'disabled';
}

interface Props {
  open: boolean;
  mode: 'create' | 'edit';
  /** The user being edited (edit mode only). */
  editing: UserFull | null;
  /** All org roles (chips carry each role's data-scope label). */
  roles: Role[];
  /** Flattened dept options (tree-select style, indented labels). */
  deptOptions: { value: string; label: string }[];
  /** Persists the form; resolves the temp password on create (shown once
   * in-drawer), or nothing on edit. */
  onSubmit: (values: UserFormValues) => Promise<string | null | undefined>;
  onClose: () => void;
}

const inputCls =
  'w-full rounded-lg border border-[var(--border-default)] px-3 py-2 text-sm text-[var(--text-primary)] placeholder:text-[var(--text-tertiary)] focus:outline-none focus:ring-2 focus:ring-[var(--accent-primary)]/30 focus:border-[var(--accent-primary)] disabled:cursor-not-allowed disabled:bg-[var(--bg-tertiary)] disabled:text-[var(--text-tertiary)]';

function SectionTitle({ children }: { children: ReactNode }): JSX.Element {
  return (
    <div className="mb-2 mt-5 text-[11px] font-semibold uppercase tracking-wider text-[var(--text-tertiary)] first:mt-0">
      {children}
    </div>
  );
}

function chipCls(on: boolean, disabled = false): string {
  return `rounded-full border px-3 py-1 text-xs font-medium transition-colors ${
    on
      ? 'border-[var(--accent-primary)] bg-[var(--accent-light)] text-[var(--accent-primary)]'
      : 'border-[var(--border-default)] bg-[var(--bg-secondary)] text-[var(--text-secondary)] hover:bg-[var(--bg-hover)]'
  }${disabled ? ' cursor-not-allowed opacity-50' : ''}`;
}

/**
 * Create/edit drawer for users: 基本信息 (identity + contact + join date +
 * timezone), 组织归属 (primary dept tree-select + concurrent dept chips),
 * 角色与权限 (multi-select role chips, each labelled with its data-scope, plus
 * the union-of-points / intersection-of-scopes explainer). On create the
 * server-returned temp password is shown once in the drawer.
 */
export function UserFormDrawer({
  open,
  mode,
  editing,
  roles,
  deptOptions,
  onSubmit,
  onClose,
}: Props): JSX.Element | null {
  const isCreate = mode === 'create';
  const [username, setUsername] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [email, setEmail] = useState('');
  const [phone, setPhone] = useState('');
  const [position, setPosition] = useState('');
  const [level, setLevel] = useState('');
  const [joinedAt, setJoinedAt] = useState('');
  const [timezone, setTimezone] = useState('');
  const [primaryDeptId, setPrimaryDeptId] = useState('');
  const [concurrentDeptIds, setConcurrentDeptIds] = useState<string[]>([]);
  const [rolesSel, setRolesSel] = useState<string[]>([]);
  const [status, setStatus] = useState<'active' | 'disabled'>('active');
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  /** Server-generated temp password after a successful create (shown once). */
  const [tempPw, setTempPw] = useState<string | null>(null);

  // Reset the fields each time the drawer opens (create: blank, edit: seeded).
  const wasOpen = useRef(open);
  useEffect(() => {
    if (open && !wasOpen.current) {
      setUsername(editing?.username ?? '');
      setDisplayName(editing?.display_name ?? '');
      setEmail(editing?.email ?? '');
      setPhone(editing?.phone ?? '');
      setPosition(editing?.position ?? '');
      setLevel(editing?.level ?? '');
      setJoinedAt(editing?.joined_at ? editing.joined_at.slice(0, 10) : '');
      setTimezone(editing?.timezone ?? '');
      const primary = editing?.departments.find((d) => d.is_primary);
      setPrimaryDeptId(primary?.id ?? '');
      setConcurrentDeptIds(
        editing ? editing.departments.filter((d) => !d.is_primary).map((d) => d.id) : []
      );
      setRolesSel(editing?.extra_roles ?? []);
      setStatus(editing?.status ?? 'active');
      setErr(null);
      setBusy(false);
      setTempPw(null);
    }
    wasOpen.current = open;
  }, [open, editing]);

  if (!open) return null;

  const setPrimary = (id: string): void => {
    setPrimaryDeptId(id);
    // A dept that becomes primary is no longer concurrent.
    if (id !== '') setConcurrentDeptIds((prev) => prev.filter((d) => d !== id));
  };

  const toggleConcurrent = (id: string): void => {
    if (id === primaryDeptId) return;
    setConcurrentDeptIds((prev) =>
      prev.includes(id) ? prev.filter((d) => d !== id) : [...prev, id]
    );
  };

  const toggleRole = (code: string): void => {
    setRolesSel((prev) => (prev.includes(code) ? prev.filter((c) => c !== code) : [...prev, code]));
  };

  const submit = async (): Promise<void> => {
    setErr(null);
    if (isCreate) {
      if (username.trim() === '') {
        setErr(t('users.form.err.username'));
        return;
      }
    }
    setBusy(true);
    try {
      const pw = await onSubmit({
        username: username.trim(),
        displayName: displayName.trim(),
        email: email.trim(),
        phone: phone.trim(),
        position: position.trim(),
        level: level.trim(),
        joinedAt,
        timezone: timezone.trim(),
        primaryDeptId,
        concurrentDeptIds,
        roles: rolesSel,
        status,
      });
      if (isCreate && pw) {
        setTempPw(pw);
      } else {
        onClose();
      }
    } catch (e) {
      setErr(userErrorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex justify-end bg-[var(--text-primary)]/40"
      onClick={onClose}
    >
      <div
        data-testid="user-drawer"
        className="flex h-full w-full max-w-md flex-col bg-[var(--bg-secondary)] shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-[var(--border-subtle)] px-5 py-4">
          <h2 className="text-base font-semibold text-[var(--text-primary)]">
            {isCreate ? t('users.form.create') : t('users.form.edit')}
          </h2>
          <button
            type="button"
            onClick={onClose}
            aria-label={t('common.close')}
            className="rounded-md p-1 text-[var(--text-secondary)] transition-colors hover:text-[var(--text-primary)]"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {tempPw !== null ? (
          <div className="flex flex-1 flex-col items-center justify-center gap-4 p-8 text-center">
            <CheckCircle2 className="h-10 w-10 text-[var(--success-primary)]" />
            <h3 className="text-base font-semibold text-[var(--text-primary)]">
              {t('users.pw.created')}
            </h3>
            <p className="text-sm text-[var(--text-secondary)]">{t('users.pw.hint')}</p>
            <div className="w-full">
              <TempPasswordRow username={username} tempPassword={tempPw} />
            </div>
            <button
              type="button"
              onClick={onClose}
              className="rounded-lg bg-[var(--accent-primary)] px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-[var(--accent-primary-hover)]"
            >
              {t('users.pw.close')}
            </button>
          </div>
        ) : (
          <>
            <div className="flex-1 overflow-y-auto px-5 py-4">
              <SectionTitle>{t('users.form.section.basic')}</SectionTitle>
              <label className="mb-3 block">
                <span className="mb-1 block text-sm font-medium text-[var(--text-secondary)]">
                  {t('users.form.username')}
                </span>
                <input
                  className={`${inputCls} font-mono`}
                  value={username}
                  required={isCreate}
                  disabled={!isCreate}
                  onChange={(e) => setUsername(e.target.value)}
                />
                {!isCreate && (
                  <p className="mt-1 text-xs text-[var(--text-tertiary)]">
                    {t('users.form.usernameLocked')}
                  </p>
                )}
              </label>

              <div className="grid grid-cols-2 gap-3">
                <label className="mb-3 block">
                  <span className="mb-1 block text-sm font-medium text-[var(--text-secondary)]">
                    {t('users.form.displayName')}
                  </span>
                  <input
                    className={inputCls}
                    value={displayName}
                    onChange={(e) => setDisplayName(e.target.value)}
                  />
                </label>
                <label className="mb-3 block">
                  <span className="mb-1 block text-sm font-medium text-[var(--text-secondary)]">
                    {t('users.form.email')}
                  </span>
                  <input
                    className={inputCls}
                    type="email"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                  />
                </label>
                <label className="mb-3 block">
                  <span className="mb-1 block text-sm font-medium text-[var(--text-secondary)]">
                    {t('users.form.phone')}
                  </span>
                  <input
                    className={inputCls}
                    value={phone}
                    onChange={(e) => setPhone(e.target.value)}
                  />
                </label>
                <label className="mb-3 block">
                  <span className="mb-1 block text-sm font-medium text-[var(--text-secondary)]">
                    {t('users.form.position')}
                  </span>
                  <input
                    className={inputCls}
                    value={position}
                    onChange={(e) => setPosition(e.target.value)}
                  />
                </label>
                <label className="mb-3 block">
                  <span className="mb-1 block text-sm font-medium text-[var(--text-secondary)]">
                    {t('users.form.level')}
                  </span>
                  <input
                    className={inputCls}
                    value={level}
                    onChange={(e) => setLevel(e.target.value)}
                  />
                </label>
                <label className="mb-3 block">
                  <span className="mb-1 block text-sm font-medium text-[var(--text-secondary)]">
                    {t('users.form.joinedAt')}
                  </span>
                  <input
                    className={inputCls}
                    type="date"
                    value={joinedAt}
                    onChange={(e) => setJoinedAt(e.target.value)}
                  />
                </label>
              </div>
              <label className="mb-3 block">
                <span className="mb-1 block text-sm font-medium text-[var(--text-secondary)]">
                  {t('users.form.timezone')}
                </span>
                <input
                  className={`${inputCls} font-mono`}
                  placeholder="Asia/Shanghai"
                  value={timezone}
                  onChange={(e) => setTimezone(e.target.value)}
                />
              </label>

              <SectionTitle>{t('users.form.section.org')}</SectionTitle>
              <label className="mb-3 block">
                <span className="mb-1 block text-sm font-medium text-[var(--text-secondary)]">
                  {t('users.form.primaryDept')}
                </span>
                <select
                  className={inputCls}
                  value={primaryDeptId}
                  onChange={(e) => setPrimary(e.target.value)}
                >
                  <option value="">{t('users.form.noDept')}</option>
                  {deptOptions.map((o) => (
                    <option key={o.value} value={o.value}>
                      {o.label}
                    </option>
                  ))}
                </select>
              </label>
              <div>
                <span className="mb-1.5 block text-sm font-medium text-[var(--text-secondary)]">
                  {t('users.form.concurrentDepts')}
                </span>
                {deptOptions.length === 0 ? (
                  <p className="text-xs text-[var(--text-tertiary)]">{t('users.form.noDept')}</p>
                ) : (
                  <div className="flex flex-wrap gap-1.5">
                    {deptOptions.map((o) => {
                      const isPrimary = o.value === primaryDeptId;
                      const on = concurrentDeptIds.includes(o.value);
                      return (
                        <button
                          key={o.value}
                          type="button"
                          disabled={isPrimary}
                          onClick={() => toggleConcurrent(o.value)}
                          className={chipCls(on, isPrimary)}
                        >
                          {o.label.trim()}
                        </button>
                      );
                    })}
                  </div>
                )}
              </div>

              <SectionTitle>{t('users.form.section.roles')}</SectionTitle>
              {roles.length === 0 ? (
                <p className="text-xs text-[var(--text-tertiary)]">{t('users.form.noDept')}</p>
              ) : (
                <div className="flex flex-wrap gap-1.5">
                  {roles.map((r) => {
                    const on = rolesSel.includes(r.name);
                    return (
                      <button
                        key={r.id}
                        type="button"
                        onClick={() => toggleRole(r.name)}
                        className={chipCls(on)}
                      >
                        {r.name}
                        <span className="opacity-60">· {t(dataScopeLabelKey(r.dataScope))}</span>
                      </button>
                    );
                  })}
                </div>
              )}
              <p className="mt-2 text-xs text-[var(--text-tertiary)]">
                {t('users.form.rolesHint')}
              </p>

              {!isCreate && (
                <>
                  <SectionTitle>{t('users.form.status')}</SectionTitle>
                  <label className="block">
                    <span className="sr-only">{t('users.form.status')}</span>
                    <select
                      className={inputCls}
                      value={status}
                      onChange={(e) => setStatus(e.target.value as 'active' | 'disabled')}
                    >
                      <option value="active">{t('users.status.active')}</option>
                      <option value="disabled">{t('users.status.disabled')}</option>
                    </select>
                  </label>
                </>
              )}
            </div>

            <div className="border-t border-[var(--border-subtle)] px-5 py-4">
              {err && <p className="mb-2 text-sm text-[var(--danger-primary)]">{err}</p>}
              <div className="flex justify-end gap-2">
                <button
                  type="button"
                  onClick={onClose}
                  disabled={busy}
                  className="rounded-lg border border-[var(--border-default)] px-3.5 py-2 text-sm font-medium text-[var(--text-secondary)] transition-colors hover:bg-[var(--bg-hover)] disabled:opacity-50"
                >
                  {t('common.cancel')}
                </button>
                <button
                  type="button"
                  onClick={() => void submit()}
                  disabled={busy}
                  className="rounded-lg bg-[var(--accent-primary)] px-3.5 py-2 text-sm font-medium text-white shadow-sm transition-colors hover:bg-[var(--accent-primary-hover)] disabled:opacity-50"
                >
                  {isCreate ? t('users.form.submit.create') : t('common.save')}
                </button>
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
