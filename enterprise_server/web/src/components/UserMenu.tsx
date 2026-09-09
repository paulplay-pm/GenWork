import type { JSX, ReactNode } from 'react';
import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';

import { authApi } from '../api/auth';
import { useAuth } from '../auth/useAuth';
import { clearMeProfileCache, useMe } from '../auth/useMe';
import { t } from '../i18n';
import { useToast } from './toastStore';

type ModalKind = 'personal' | 'password' | null;

/**
 * The sidebar footer. Replaces the former "系统 → 账户" nav item: the account
 * (profile / change password / logout) now lives in a popover anchored to the
 * user's avatar, which shows the display name / username rather than the user
 * ID (the JWT only carries `sub`, so the name comes from `/me`).
 */
export function UserMenu(): JSX.Element {
  const { claims, logout } = useAuth();
  const { profile, saveDisplayName } = useMe();
  const toast = useToast();
  const nav = useNavigate();

  const [open, setOpen] = useState(false);
  const [modal, setModal] = useState<ModalKind>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  const name = profile?.display_name?.trim() || profile?.username || claims?.sub || '';
  const initials = name.slice(0, 2).toUpperCase();
  const userRole = claims?.roles?.includes('super_admin')
    ? t('sidebar.user.role.superAdmin')
    : (claims?.roles?.[0] ?? '');

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent): void => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    window.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      window.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const openModal = (kind: ModalKind): void => {
    setModal(kind);
    setOpen(false);
  };

  const doLogout = (): void => {
    // Clear the server-side session cookie (HttpOnly) before dropping the
    // local token; best-effort — a failure here must not block logging out.
    void authApi.logout().catch(() => {});
    // The cached /me profile belongs to the outgoing session; drop it so the
    // next login (possibly a different user) refetches.
    clearMeProfileCache();
    logout();
    nav('/login');
  };

  return (
    <div ref={containerRef} className="p-3 border-t border-[var(--border-subtle)]">
      {/* Anchor the dropdown to the trigger button itself so it sits flush
          above the avatar (the outer container's padding would otherwise open
          a visible gap between the menu and the button). */}
      <div className="relative">
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          className="w-full flex items-center gap-2.5 p-2 rounded-[var(--radius-md)] hover:bg-[var(--bg-hover)] transition-colors text-left"
        >
          <div
            className="w-8 h-8 rounded-full flex items-center justify-center text-white font-semibold text-xs flex-shrink-0"
            style={{ background: 'linear-gradient(135deg, var(--global-primary), #a855f7)' }}
          >
            {initials}
          </div>
          <div className="flex-1 min-w-0">
            <div className="text-[13px] font-semibold text-[var(--text-primary)] truncate">{name}</div>
            <div className="text-[11.5px] text-[var(--text-tertiary)] truncate">{userRole}</div>
          </div>
        </button>

        {open && (
          <div className="absolute bottom-full left-0 mb-[5px] w-[120px]" role="menu">
            <div
              className="p-2 bg-white rounded-[16px] border border-[#E5E7EB]"
              style={{ boxShadow: '0 10px 24px rgba(0,0,0,0.08)' }}
            >
              <MenuItem label={t('usermenu.personal')} onClick={() => openModal('personal')} />
              <MenuItem label={t('usermenu.password')} onClick={() => openModal('password')} />
              <MenuItem label={t('sso.profile.bindMenuItem')} onClick={() => { setOpen(false); nav('/account/sso-bindings'); }} />
              <MenuItem label={t('usermenu.logout')} danger onClick={doLogout} />
            </div>
            {/* Caret pointing at the account button below (ChatGPT-style menu pointer). */}
            <div
              className="absolute -bottom-[5px] left-6 w-3 h-3 rotate-45 bg-white border-b border-r border-[#E5E7EB]"
              aria-hidden
            />
          </div>
        )}
      </div>

      {modal === 'personal' && (
        <PersonalModal
          username={profile?.username ?? ''}
          displayName={profile?.display_name ?? ''}
          orgId={claims?.orgId ?? ''}
          roles={claims?.roles ?? []}
          onSave={saveDisplayName}
          onClose={() => setModal(null)}
        />
      )}
      {modal === 'password' && (
        <PasswordModal toast={toast} onClose={() => setModal(null)} />
      )}
    </div>
  );
}

function MenuItem({
  label,
  onClick,
  danger,
}: {
  label: string;
  onClick: () => void;
  danger?: boolean;
}): JSX.Element {
  return (
    <button
      type="button"
      role="menuitem"
      onClick={onClick}
      className="w-full text-left text-[14px] font-normal px-2.5 py-2 rounded-[8px] hover:bg-[#F3F4F6]"
      style={{ color: danger ? '#EF4444' : '#333333' }}
    >
      {label}
    </button>
  );
}

interface PersonalModalProps {
  username: string;
  displayName: string;
  orgId: string;
  roles: string[];
  onSave: (displayName: string) => Promise<void>;
  onClose: () => void;
}

function PersonalModal({ username, displayName, orgId, roles, onSave, onClose }: PersonalModalProps): JSX.Element {
  const toast = useToast();
  const [draft, setDraft] = useState(displayName);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    setDraft(displayName);
  }, [displayName]);

  const save = async (): Promise<void> => {
    setBusy(true);
    try {
      await onSave(draft.trim());
      toast.success(t('usermenu.saved'));
      onClose();
    } catch {
      toast.error(t('usermenu.saveFailed'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <ModalShell title={t('usermenu.personal.title')} onClose={onClose}>
      <dl className="text-sm space-y-2 mb-4">
        <Row label={t('usermenu.username')} value={username} />
        <Row label={t('usermenu.org')} value={orgId} />
        <Row label={t('usermenu.roles')} value={roles.join(', ')} />
      </dl>
      <label className="block text-[13px] font-medium text-[var(--text-secondary)] mb-1.5">
        {t('usermenu.displayName')}
      </label>
      <input
        className="border border-[var(--border-default)] w-full p-2 rounded-[var(--radius-md)] bg-[var(--bg-secondary)] text-[var(--text-primary)] focus:border-[var(--accent-primary)] focus:outline-none"
        value={draft}
        placeholder={t('usermenu.displayName.placeholder')}
        onChange={(e) => setDraft(e.target.value)}
      />
      <p className="text-[11.5px] text-[var(--text-tertiary)] mt-1.5">{t('usermenu.displayName.hint')}</p>
      <div className="flex justify-end gap-2 mt-5">
        <button
          onClick={onClose}
          className="px-4 py-2 border border-[var(--border-default)] rounded-[var(--radius-md)] text-[var(--text-secondary)] hover:bg-[var(--bg-hover)]"
        >
          {t('common.cancel')}
        </button>
        <button
          onClick={save}
          disabled={busy}
          className="px-4 py-2 bg-[var(--accent-primary)] hover:bg-[var(--accent-primary-hover)] text-white rounded-[var(--radius-md)] disabled:opacity-50"
        >
          {t('common.save')}
        </button>
      </div>
    </ModalShell>
  );
}

interface PasswordModalProps {
  toast: ReturnType<typeof useToast>;
  onClose: () => void;
}

function PasswordModal({ toast, onClose }: PasswordModalProps): JSX.Element {
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [busy, setBusy] = useState(false);

  const changePassword = async (): Promise<void> => {
    setBusy(true);
    try {
      await authApi.changePassword(current, next);
      toast.success(t('usermenu.password.changed'));
      setCurrent('');
      setNext('');
      onClose();
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const inputClass =
    'border border-[var(--border-default)] w-full p-2 rounded-[var(--radius-md)] bg-[var(--bg-secondary)] text-[var(--text-primary)] focus:border-[var(--accent-primary)] focus:outline-none';

  return (
    <ModalShell title={t('usermenu.password.title')} onClose={onClose}>
      <input
        className={`${inputClass} mb-3`}
        type="password"
        placeholder={t('usermenu.password.current')}
        value={current}
        onChange={(e) => setCurrent(e.target.value)}
      />
      <input
        className={`${inputClass} mb-4`}
        type="password"
        placeholder={t('usermenu.password.new')}
        value={next}
        onChange={(e) => setNext(e.target.value)}
      />
      <div className="flex justify-end gap-2">
        <button
          onClick={onClose}
          className="px-4 py-2 border border-[var(--border-default)] rounded-[var(--radius-md)] text-[var(--text-secondary)] hover:bg-[var(--bg-hover)]"
        >
          {t('common.cancel')}
        </button>
        <button
          onClick={changePassword}
          disabled={busy || !current || next.length < 8}
          className="px-4 py-2 bg-[var(--accent-primary)] hover:bg-[var(--accent-primary-hover)] text-white rounded-[var(--radius-md)] disabled:opacity-50"
        >
          {t('usermenu.password.submit')}
        </button>
      </div>
    </ModalShell>
  );
}

function Row({ label, value }: { label: string; value: string }): JSX.Element {
  return (
    <div className="flex justify-between gap-4">
      <dt className="text-[var(--text-secondary)]">{label}</dt>
      <dd className="text-[var(--text-primary)] text-right break-words">{value || '—'}</dd>
    </div>
  );
}

/** A minimal centered modal that reuses the `ConfirmDialog` visual language. */
function ModalShell({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }): JSX.Element {
  useEffect(() => {
    const handler = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [onClose]);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40" onClick={onClose}>
      <div
        className="bg-[var(--bg-secondary)] rounded shadow p-6 w-[24rem] max-w-[calc(100vw-2rem)]"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 className="text-base font-semibold text-[var(--text-primary)] mb-4">{title}</h2>
        {children}
      </div>
    </div>
  );
}
