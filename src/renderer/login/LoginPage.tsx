import { EyeIcon, EyeSlashIcon } from '@heroicons/react/24/outline';
import { useEffect, useState } from 'react';

import { i18nService } from '../services/i18n';

declare global {
  interface Window {
    enterpriseMt?: {
      login(args: {
        orgId: string;
        username: string;
        password: string;
      }): Promise<{ ok: true } | { ok: false; error: string }>;
      logout(): Promise<void>;
      listOrgs(): Promise<{ orgs: { id: string; name: string }[] }>;
      getModels(): Promise<unknown[]>;
      getUsageToday?(): Promise<{ items: { model_id: string; used: number }[] }>;
    };
  }
}

interface LoginPageProps {
  onSuccess?: () => void;
}

export function LoginPage({ onSuccess }: LoginPageProps = {}) {
  // `orgs` is null while the initial fetch is in flight. Once it resolves
  // we either show a dropdown (length > 1), auto-fill the single org's
  // name (length === 1), or fall back to a free-form text input
  // (length === 0 / fetch failed).
  const [orgs, setOrgs] = useState<{ id: string; name: string }[] | null>(null);
  const [orgId, setOrgId] = useState('');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [ssoProviders, setSsoProviders] = useState<Array<{ id: string; name: string; provider_type: string; sort_order: number; logoUrl: string | null }>>([]);

  useEffect(() => {
    if (!orgId || !window.electron?.enterpriseMt?.ssoProviders) {
      // No org selected, or the SSO bridge is unavailable (running outside
      // Electron or a build without the enterprise SSO methods).
      setSsoProviders([]);
      return;
    }
    window.electron.enterpriseMt
      .ssoProviders(orgId)
      .then((r) => setSsoProviders(r.providers ?? []))
      .catch(() => setSsoProviders([]));
  }, [orgId]);

  useEffect(() => {
    if (!window.electron?.enterpriseMt?.listOrgs) {
      // Bridge not available (e.g. running outside Electron). Leave
      // orgId as a free-form field the user can fill in.
      setOrgs([]);
      return;
    }
    window.electron.enterpriseMt
      .listOrgs()
      .then((r) => {
        setOrgs(r.orgs);
        if (r.orgs.length === 1) setOrgId(r.orgs[0]!.name);
      })
      .catch(() => {
        // Network/server down. Fall back to the text input so the user
        // can still try a login; the server will surface a clearer error.
        setOrgs([]);
      });
  }, []);

  const submit = async (): Promise<void> => {
    setErr(null);
    setBusy(true);
    try {
      if (!window.electron?.enterpriseMt) {
        setErr('enterprise bridge unavailable');
        return;
      }
      const r = await window.electron.enterpriseMt.login({ orgId, username, password });
      if (r.ok) {
        if (onSuccess) onSuccess();
        else window.location.reload();
      } else {
        setErr(r.error);
      }
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const t = (key: string): string => i18nService.t(key);

  const onSso = async (connectionId: string): Promise<void> => {
    setErr(null);
    setBusy(true);
    try {
      if (!window.electron?.enterpriseMt?.ssoLogin) {
        setErr('enterprise bridge unavailable');
        return;
      }
      // The `orgId` state holds the org NAME (see the `<select>` options
      // above); the SSO wire key is `orgName`.
      const r = await window.electron.enterpriseMt.ssoLogin({ orgName: orgId, connectionId });
      if (r.ok) {
        if (onSuccess) onSuccess();
        else window.location.reload();
      } else {
        setErr(t('sso.login.failed').replace('{error}', r.error));
      }
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  // Three states for the org field:
  //   - `orgs === null`     : still loading; render nothing yet (avoids
  //                           a flash of the wrong control)
  //   - `orgs.length > 1`   : render a dropdown
  //   - `orgs.length === 1` : orgId state is auto-filled; don't render
  //                           any field at all (the user's request)
  //   - `orgs.length === 0` : server has no orgs (or fetch failed);
  //                           render the text input so the user can still
  //                           try a manual entry
  const showOrgSelector = orgs !== null && orgs.length > 1;
  const showOrgTextInput = orgs !== null && orgs.length === 0;

  // Enter in any input submits. Most natural target is the password
  // field (the last input before the submit button) but supporting all
  // three keeps muscle memory consistent.
  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement | HTMLSelectElement>): void => {
    if (e.key === 'Enter' && !busy) {
      e.preventDefault();
      void submit();
    }
  };

  return (
    <div className="flex items-center justify-center min-h-screen bg-[var(--bg-primary)]">
      <div className="w-full max-w-sm p-8 bg-[var(--bg-secondary)] rounded-[var(--radius-lg)]" style={{ boxShadow: 'var(--shadow-md)' }}>
        <div className="flex items-center gap-2.5 mb-6">
          <div
            className="w-8 h-8 rounded-[var(--radius-md)] flex items-center justify-center text-white font-bold text-sm"
            style={{ background: 'linear-gradient(135deg, var(--accent-primary), #8b5cf6)' }}
          >
            AI
          </div>
          <div className="font-semibold text-base text-[var(--text-primary)]">
            GenWork
          </div>
        </div>
        <h1 className="text-base font-semibold text-[var(--text-primary)] mb-1.5">
          {t('enterpriseLoginTitle')}
        </h1>
        <p className="text-[13px] text-[var(--text-secondary)] mb-5">
          {t('enterpriseLoginHint')}
        </p>
        {showOrgSelector && (
          <select
            className="w-full px-3 py-2 mb-2 bg-[var(--bg-tertiary)] border border-[var(--border-default)] rounded-[var(--radius-sm)] text-sm text-[var(--text-primary)] focus:outline-none focus:bg-[var(--bg-secondary)] focus:border-[var(--accent-primary)] focus:ring-2 focus:ring-[var(--accent-primary)]/10 transition-colors"
            value={orgId}
            onChange={(e) => setOrgId(e.target.value)}
            onKeyDown={onKeyDown}
          >
            <option value="">{t('enterpriseLoginOrgId')}</option>
            {orgs!.map((o) => (
              <option key={o.id} value={o.name}>
                {o.name}
              </option>
            ))}
          </select>
        )}
        {showOrgTextInput && (
          <input
            className="w-full px-3 py-2 mb-2 bg-[var(--bg-tertiary)] border border-[var(--border-default)] rounded-[var(--radius-sm)] text-sm text-[var(--text-primary)] focus:outline-none focus:bg-[var(--bg-secondary)] focus:border-[var(--accent-primary)] focus:ring-2 focus:ring-[var(--accent-primary)]/10 transition-colors"
            placeholder={t('enterpriseLoginOrgId')}
            value={orgId}
            onChange={(e) => setOrgId(e.target.value)}
            onKeyDown={onKeyDown}
          />
        )}
        <input
          className="w-full px-3 py-2 mb-2 bg-[var(--bg-tertiary)] border border-[var(--border-default)] rounded-[var(--radius-sm)] text-sm text-[var(--text-primary)] focus:outline-none focus:bg-[var(--bg-secondary)] focus:border-[var(--accent-primary)] focus:ring-2 focus:ring-[var(--accent-primary)]/10 transition-colors"
          placeholder={t('enterpriseLoginUsername')}
          value={username}
          onChange={(e) => setUsername(e.target.value)}
          onKeyDown={onKeyDown}
        />
        <div className="relative mb-4">
          <input
            className="w-full px-3 py-2 pr-10 bg-[var(--bg-tertiary)] border border-[var(--border-default)] rounded-[var(--radius-sm)] text-sm text-[var(--text-primary)] focus:outline-none focus:bg-[var(--bg-secondary)] focus:border-[var(--accent-primary)] focus:ring-2 focus:ring-[var(--accent-primary)]/10 transition-colors"
            type={showPassword ? 'text' : 'password'}
            placeholder={t('enterpriseLoginPassword')}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            onKeyDown={onKeyDown}
            autoComplete="current-password"
          />
          <button
            type="button"
            className="absolute inset-y-0 right-0 flex items-center justify-center w-9 text-[var(--text-secondary)] hover:text-[var(--text-primary)]"
            aria-label={showPassword ? t('enterpriseLoginHidePassword') : t('enterpriseLoginShowPassword')}
            onClick={() => setShowPassword((v) => !v)}
            tabIndex={-1}
          >
            {showPassword ? (
              <EyeSlashIcon className="h-4 w-4" aria-hidden="true" />
            ) : (
              <EyeIcon className="h-4 w-4" aria-hidden="true" />
            )}
          </button>
        </div>
        <button
          className="w-full px-3 py-2 bg-[var(--accent-primary)] hover:bg-[var(--accent-primary-hover)] text-white text-sm font-medium rounded-[var(--radius-sm)] transition-colors disabled:opacity-50"
          style={{ boxShadow: 'var(--shadow-sm)' }}
          disabled={busy}
          onClick={submit}
        >
          {t('enterpriseLoginSubmit')}
        </button>
        {err && <p className="text-[var(--danger-primary)] mt-2 text-sm">{err}</p>}

        {ssoProviders.length > 0 && (
          <>
            <div className="my-4 flex items-center gap-3 text-[var(--text-tertiary)] text-[12px]">
              <span className="flex-1 border-t border-[var(--border-subtle)]" />
              <span className="uppercase tracking-wide">{t('sso.login.otherMethods')}</span>
              <span className="flex-1 border-t border-[var(--border-subtle)]" />
            </div>
            <div className="flex flex-wrap items-center justify-center gap-3">
              {ssoProviders.map((p) => (
                <button
                  key={p.id}
                  type="button"
                  disabled={busy}
                  title={t('sso.login.with').replace('{name}', p.name)}
                  aria-label={t('sso.login.with').replace('{name}', p.name)}
                  onClick={() => void onSso(p.id)}
                  className="flex h-10 w-10 items-center justify-center rounded-full border border-[var(--border-subtle)] bg-white hover:bg-[var(--bg-secondary)] transition-colors disabled:opacity-50"
                >
                  {p.logoUrl ? (
                    <img
                      src={p.logoUrl}
                      alt=""
                      draggable={false}
                      className="h-5 w-5 rounded object-contain"
                    />
                  ) : (
                    <span className="text-[10px] text-[var(--text-secondary)] font-medium">
                      {p.name.slice(0, 2).toUpperCase()}
                    </span>
                  )}
                </button>
              ))}
            </div>
            {busy && (
              <div className="mt-1.5 text-[12px] text-[var(--text-secondary)] text-center">
                {t('sso.login.opening')}
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}