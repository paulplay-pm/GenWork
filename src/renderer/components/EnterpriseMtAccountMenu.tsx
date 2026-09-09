import {
  ArrowRightStartOnRectangleIcon,
  KeyIcon,
  UserCircleIcon,
} from '@heroicons/react/24/outline';
import React, {
  useCallback,
  useEffect,
  useRef,
  useState,
} from 'react';

import { i18nService } from '../services/i18n';
import Modal from './common/Modal';
import LinkIcon from './icons/LinkIcon';
import UserAvatarIcon from './icons/UserAvatarIcon';

/**
 * Multi-tenant enterprise account menu for the sidebar footer.
 *
 * Replaces the old consumer `LoginButton` + bare logout icon. The avatar
 * trigger opens a dropdown with three actions: personal info (editable
 * display name), change password, and logout. Profile data is read from the
 * enterprise server's `GET /me`; the display name is editable via `PATCH /me`.
 *
 * This is distinct from `features/enterpriseAccount/EnterpriseAccountMenu`,
 * which belongs to the legacy Youdao-cloud consumer account system.
 */

export interface MeProfile {
  id: string;
  username: string;
  display_name: string | null;
  timezone: string | null;
  effective_roles: string[];
  dept_path: string | null;
  org_id: string;
}

interface EnterpriseMtAccountMenuProps {
  onLogout: () => void;
  isCollapsed?: boolean;
  /**
   * Render the dropdown as if the avatar had been clicked. Internal production
   * code toggles visibility through the avatar button; tests need the dropdown
   * expanded without a DOM-driven click, so this prop opts into the open state
   * from the parent.
   */
  initialShowMenu?: boolean;
}

/**
 * Custom DOM event the menu dispatches when the user picks "绑定 SSO 账号".
 *
 * App.tsx owns the `mainView` state — there is no `react-router-dom` here —
 * so the menu asks the top-level shell to navigate by emitting an event
 * instead of receiving a navigation callback via props (the menu is mounted
 * from `Sidebar.tsx`, which already has a long prop list).
 */
export const SSO_BINDINGS_OPEN_EVENT = 'app:show-sso-bindings';

const roleLabelKey = (role: string): string => {
  switch (role) {
    case 'super_admin':
      return 'enterpriseRoleSuperAdmin';
    case 'admin':
      return 'enterpriseRoleAdmin';
    default:
      return 'enterpriseRoleUser';
  }
};

const toast = (message: string): void => {
  window.dispatchEvent(new CustomEvent('app:showToast', { detail: message }));
};

interface MenuItemProps {
  icon: React.ReactNode;
  label: string;
  onClick: () => void;
  danger?: boolean;
}

const MenuItem: React.FC<MenuItemProps> = ({ icon, label, onClick, danger = false }) => (
  <button
    type="button"
    onClick={onClick}
    className={`flex w-full cursor-pointer items-center gap-2 px-3 py-2 text-left text-[13px] transition-colors hover:bg-surface-raised ${
      danger ? 'text-red-500' : 'text-foreground'
    }`}
  >
    {icon}
    <span className="min-w-0 flex-1 truncate">{label}</span>
  </button>
);

const FieldInput: React.FC<{
  type?: 'text' | 'password';
  value: string;
  onChange: (v: string) => void;
  placeholder: string;
  disabled?: boolean;
}> = ({ type = 'text', value, onChange, placeholder, disabled }) => (
  <input
    type={type}
    value={value}
    onChange={(e) => onChange(e.target.value)}
    placeholder={placeholder}
    disabled={disabled}
    className="w-full rounded-lg border border-border bg-surface-raised px-3 py-2 text-sm text-foreground outline-none transition-colors focus:border-primary disabled:cursor-not-allowed disabled:opacity-60"
  />
);

const ProfileModal: React.FC<{
  open: boolean;
  onClose: () => void;
}> = ({ open, onClose }) => {
  const [profile, setProfile] = useState<MeProfile | null>(null);
  const [displayName, setDisplayName] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    let active = true;
    setLoading(true);
    setError(null);
    (async () => {
      try {
        const me = (await window.electron.enterpriseMt.getMe()) as unknown as MeProfile | { ok: false; error: string };
        if (!active) return;
        if (me && typeof me === 'object' && 'ok' in me && me.ok === false) {
          setError(i18nService.t('enterpriseProfileLoadFailed'));
        } else {
          const profile = me as MeProfile;
          setProfile(profile);
          setDisplayName(profile.display_name ?? '');
        }
      } catch {
        if (!active) return;
        setError(i18nService.t('enterpriseProfileLoadFailed'));
      } finally {
        if (active) setLoading(false);
      }
    })();
    return () => {
      active = false;
    };
  }, [open]);

  const dirty = profile !== null && displayName !== (profile.display_name ?? '');

  const save = async () => {
    if (!dirty) {
      onClose();
      return;
    }
    try {
      await window.electron.enterpriseMt.updateMe(displayName);
      setProfile((prev) => (prev ? { ...prev, display_name: displayName } : prev));
      toast(i18nService.t('enterpriseProfileUpdated'));
      onClose();
    } catch {
      setError(i18nService.t('enterpriseProfileSaveFailed'));
    }
  };

  return (
    <Modal isOpen={open} onClose={onClose} onEscape={onClose} className="w-full max-w-sm bg-surface rounded-2xl shadow-xl overflow-hidden">
      <div className="px-5 py-4 border-b border-border">
        <h2 className="text-base font-semibold text-foreground">
          {i18nService.t('enterpriseProfileTitle')}
        </h2>
      </div>
      <div className="px-5 py-4 space-y-3">
        {error && (
          <p className="text-sm text-red-500">{error}</p>
        )}
        {loading && !profile ? (
          <p className="text-sm text-secondary">—</p>
        ) : profile ? (
          <>
            <div>
              <label className="mb-1 block text-xs font-medium text-secondary">
                {i18nService.t('enterpriseProfileDisplayName')}
              </label>
              <FieldInput
                value={displayName}
                onChange={setDisplayName}
                placeholder={profile.username}
              />
            </div>
            <div className="grid grid-cols-2 gap-3 text-sm">
              <div>
                <div className="text-xs text-secondary">{i18nService.t('enterpriseProfileUsername')}</div>
                <div className="truncate text-foreground">{profile.username}</div>
              </div>
              <div>
                <div className="text-xs text-secondary">{i18nService.t('enterpriseProfileOrg')}</div>
                <div className="truncate text-foreground">{profile.org_id}</div>
              </div>
              <div>
                <div className="text-xs text-secondary">{i18nService.t('enterpriseProfileDepartment')}</div>
                <div className="truncate text-foreground">
                  {profile.dept_path || '—'}
                </div>
              </div>
              <div>
                <div className="text-xs text-secondary">{i18nService.t('enterpriseProfileTimezone')}</div>
                <div className="truncate text-foreground">{profile.timezone || '—'}</div>
              </div>
              <div className="col-span-2">
                <div className="text-xs text-secondary">{i18nService.t('enterpriseProfileRoles')}</div>
                <div className="mt-1 flex flex-wrap gap-1">
                  {profile.effective_roles.length > 0 ? (
                    profile.effective_roles.map((role) => (
                      <span
                        key={role}
                        className="rounded bg-surface-raised px-1.5 py-0.5 text-xs text-secondary"
                      >
                        {i18nService.t(roleLabelKey(role))}
                      </span>
                    ))
                  ) : (
                    <span className="text-foreground">—</span>
                  )}
                </div>
              </div>
            </div>
          </>
        ) : null}
      </div>
      <div className="flex items-center justify-end gap-3 border-t border-border px-5 py-4">
        <button
          type="button"
          onClick={onClose}
          className="px-4 py-2 text-sm font-medium rounded-lg text-secondary hover:bg-surface-raised transition-colors"
        >
          {i18nService.t('cancel')}
        </button>
        <button
          type="button"
          onClick={() => void save()}
          disabled={!dirty}
          className="px-4 py-2 text-sm font-medium rounded-lg bg-primary text-white transition-colors hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {i18nService.t('enterpriseProfileSave')}
        </button>
      </div>
    </Modal>
  );
};

const ChangePasswordModal: React.FC<{
  open: boolean;
  onClose: () => void;
}> = ({ open, onClose }) => {
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open) return;
    setCurrent('');
    setNext('');
    setError(null);
  }, [open]);

  const submit = async () => {
    if (!current || !next) {
      setError(i18nService.t('enterpriseChangePasswordFailed'));
      return;
    }
    if (next.length < 8) {
      setError(i18nService.t('enterpriseChangePasswordMin'));
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const r = await window.electron.enterpriseMt.changePassword({
        currentPassword: current,
        newPassword: next,
      });
      if (r.ok) {
        toast(i18nService.t('enterpriseChangePasswordSuccess'));
        onClose();
        return;
      }
      if (r.error === 'invalid_current') {
        setError(i18nService.t('enterpriseChangePasswordInvalidCurrent'));
        return;
      }
      setError(i18nService.t('enterpriseChangePasswordFailed'));
    } catch {
      setError(i18nService.t('enterpriseChangePasswordFailed'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal isOpen={open} onClose={onClose} onEscape={onClose} className="w-full max-w-sm bg-surface rounded-2xl shadow-xl overflow-hidden">
      <div className="px-5 py-4 border-b border-border">
        <h2 className="text-base font-semibold text-foreground">
          {i18nService.t('enterpriseChangePasswordTitle')}
        </h2>
      </div>
      <div className="px-5 py-4 space-y-3">
        {error && (
          <p className="text-sm text-red-500">{error}</p>
        )}
        <div>
          <label className="mb-1 block text-xs font-medium text-secondary">
            {i18nService.t('enterpriseChangePasswordCurrent')}
          </label>
          <FieldInput
            type="password"
            value={current}
            onChange={setCurrent}
            placeholder={i18nService.t('enterpriseChangePasswordCurrent')}
          />
        </div>
        <div>
          <label className="mb-1 block text-xs font-medium text-secondary">
            {i18nService.t('enterpriseChangePasswordNew')}
          </label>
          <FieldInput
            type="password"
            value={next}
            onChange={setNext}
            placeholder={i18nService.t('enterpriseChangePasswordNew')}
          />
        </div>
      </div>
      <div className="flex items-center justify-end gap-3 border-t border-border px-5 py-4">
        <button
          type="button"
          onClick={onClose}
          className="px-4 py-2 text-sm font-medium rounded-lg text-secondary hover:bg-surface-raised transition-colors"
        >
          {i18nService.t('cancel')}
        </button>
        <button
          type="button"
          onClick={() => void submit()}
          disabled={busy}
          className="px-4 py-2 text-sm font-medium rounded-lg bg-primary text-white transition-colors hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {i18nService.t('enterpriseChangePasswordSubmit')}
        </button>
      </div>
    </Modal>
  );
};

export const EnterpriseMtAccountMenu: React.FC<EnterpriseMtAccountMenuProps> = ({
  onLogout,
  isCollapsed = false,
  initialShowMenu = false,
}) => {
  const [showMenu, setShowMenu] = useState(initialShowMenu);
  const [profileOpen, setProfileOpen] = useState(false);
  const [passwordOpen, setPasswordOpen] = useState(false);
  const [displayName, setDisplayName] = useState<string | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  // Load the display name once so the trigger can show it without blocking render.
  useEffect(() => {
    let active = true;
    (async () => {
      try {
        const me = (await window.electron.enterpriseMt.getMe()) as unknown as MeProfile | { ok: false; error: string };
        if (!active) return;
        if (me && typeof me === 'object' && 'ok' in me && me.ok === false) {
          setDisplayName(null);
        } else {
          const profile = me as MeProfile;
          setDisplayName(profile.display_name || profile.username);
        }
      } catch {
        if (active) setDisplayName(null);
      }
    })();
    return () => {
      active = false;
    };
  }, []);

  const closeMenu = useCallback(() => setShowMenu(false), []);

  useEffect(() => {
    if (!showMenu) return;
    const handleClickOutside = (event: MouseEvent) => {
      const target = event.target;
      if (containerRef.current && !containerRef.current.contains(target as Node)) {
        setShowMenu(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [showMenu]);

  return (
    <div ref={containerRef} className="relative">
      <button
        type="button"
        onClick={() => setShowMenu((s) => !s)}
        className="inline-flex h-7 items-center justify-start gap-2 rounded-md px-1.5 text-sm font-normal text-foreground/80 transition-colors hover:bg-black/[0.03] dark:hover:bg-white/[0.04] cursor-pointer"
        aria-haspopup="menu"
        aria-expanded={showMenu}
        aria-label={displayName || i18nService.t('myAccount')}
      >
        <UserAvatarIcon className="h-4 w-4 shrink-0" />
        {!isCollapsed && displayName && (
          <span className="truncate max-w-[80px]">{displayName}</span>
        )}
      </button>

      {showMenu && (
        <div
          role="menu"
          className="absolute bottom-full left-[-0.5rem] z-50 mb-1 w-[13rem] overflow-hidden rounded-xl border border-border bg-surface shadow-popover popover-enter py-1"
        >
          <div className="border-b border-border px-3 py-2">
            <div className="truncate text-sm font-medium text-foreground">
              {displayName || i18nService.t('myAccount')}
            </div>
          </div>
          <MenuItem
            icon={<UserCircleIcon className="h-4 w-4 shrink-0 text-secondary" />}
            label={i18nService.t('enterpriseProfileTitle')}
            onClick={() => {
              closeMenu();
              setProfileOpen(true);
            }}
          />
          <MenuItem
            icon={<KeyIcon className="h-4 w-4 shrink-0 text-secondary" />}
            label={i18nService.t('enterpriseChangePasswordTitle')}
            onClick={() => {
              closeMenu();
              setPasswordOpen(true);
            }}
          />
          <MenuItem
            icon={<LinkIcon className="h-4 w-4 shrink-0 text-secondary" />}
            label={i18nService.t('sso.profile.bindMenuItem')}
            onClick={() => {
              closeMenu();
              window.dispatchEvent(new CustomEvent(SSO_BINDINGS_OPEN_EVENT));
            }}
          />
          <div className="my-1 border-t border-border" />
          <MenuItem
            icon={<ArrowRightStartOnRectangleIcon className="h-4 w-4 shrink-0" />}
            label={i18nService.t('enterpriseAccountLogout')}
            danger
            onClick={() => {
              closeMenu();
              onLogout();
            }}
          />
        </div>
      )}

      <ProfileModal open={profileOpen} onClose={() => setProfileOpen(false)} />
      <ChangePasswordModal open={passwordOpen} onClose={() => setPasswordOpen(false)} />
    </div>
  );
};

export default EnterpriseMtAccountMenu;
