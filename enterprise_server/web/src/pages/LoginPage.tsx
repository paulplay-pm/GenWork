import type { JSX } from 'react';
import { useEffect, useState } from 'react';
import { useLocation,useNavigate } from 'react-router-dom';

import { authApi } from '../api/auth';
import { ApiError } from '../api/client';
import { ssoApi } from '../api/sso';
import type { OrgSummary } from '../api/types';
import { useAuth } from '../auth/useAuth';
import { t } from '../i18n';
import type { SsoPublicProvider } from './sso/types';

interface LocationState {
  from?: { pathname: string };
}

/**
 * Read and validate the `?next=` return path. Returns the decoded path only
 * when it is a same-origin absolute path (`/foo`, never `//evil` or
 * `https://evil`); otherwise null, so the caller falls back to `/`.
 */
export function safeNextRedirect(search: string): string | null {
  try {
    const next = new URLSearchParams(search).get('next');
    if (!next) return null;
    const decoded = decodeURIComponent(next);
    if (!decoded.startsWith('/') || decoded.startsWith('//')) return null;
    return decoded;
  } catch {
    return null;
  }
}

/** Map a `?error=` code from the SSO callback to a user-facing i18n message. */
export function ssoErrorMessage(search: string): string | null {
  const p = new URLSearchParams(search).get('error');
  if (!p) return null;
  const key =
    p === 'domain_not_allowed' ? 'sso.error.domainNotAllowed' :
    p === 'email_required' ? 'sso.error.emailRequired' :
    p === 'unknown_connection' ? 'sso.error.unknownConnection' :
    p === 'user_disabled' ? 'sso.error.userDisabled' :
    'sso.error.stateInvalid'; // covers sso_* / invalid_request / token_exchange_failed /
                              // id_token_aud_mismatch / missing_external_id / username_conflict
                              // / jit_failed / unknown raw codes — a generic retry message.
  return t(key);
}

function explainLoginError(e: unknown): string {
  if (e instanceof ApiError) {
    // Rate limit (429) takes priority over the status-based branches.
    if (e.body?.error === 'rate_limited') return t('auth.login.error.rateLimited');
    if (e.status === 401) {
      // Server replies `{"error":"invalid"}` for "unknown org", "user not
      // found", and "wrong password" — don't leak which one.
      return t('auth.login.error.invalid');
    }
    if (e.status >= 500) return t('auth.login.error.server');
    return t('auth.login.error.http').replace('{status}', String(e.status));
  }
  return t('auth.login.error.unknown');
}

// Eye / EyeOff icons for the password show-toggle. Inline so the bundle
// doesn't grow a dependency just for two glyphs.
const EyeIcon = ({ open }: { open: boolean }): JSX.Element =>
  open ? (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
      <circle cx="12" cy="12" r="3" />
    </svg>
  ) : (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M17.94 17.94A10.94 10.94 0 0 1 12 20c-7 0-11-8-11-8a19.5 19.5 0 0 1 5.06-5.94" />
      <path d="M9.9 4.24A10.94 10.94 0 0 1 12 4c7 0 11 8 11 8a19.5 19.5 0 0 1-3.16 4.19" />
      <path d="M1 1l22 22" />
    </svg>
  );

export function LoginPage(): JSX.Element {
  // Read once up front: a `?error=` set by the SSO callback's redirect is
  // seeded into the error state on mount (pure read, no effect).
  const loc = useLocation() as { state: LocationState | null; search: string };
  const [orgs, setOrgs] = useState<OrgSummary[] | null>(null);
  const [orgName, setOrgName] = useState<string>('');
  const [providers, setProviders] = useState<SsoPublicProvider[]>([]);
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [err, setErr] = useState<string | null>(() => ssoErrorMessage(loc.search));
  const [busy, setBusy] = useState(false);
  const { login } = useAuth();
  const nav = useNavigate();

  useEffect(() => {
    authApi
      .listOrgs()
      .then((r) => {
        setOrgs(r.orgs);
        // If there's exactly one org, pre-select it so the form submits
        // without forcing the user to interact with a single-item
        // dropdown. The selector itself stays hidden in that case.
        if (r.orgs.length === 1) setOrgName(r.orgs[0]!.name);
      })
      .catch(() => {
        // Org listing failed (server down, network). Let the form render
        // and let the user attempt to log in; the login call will surface
        // a clearer error than an "orgs" fetch failure.
        setOrgs([]);
      });
  }, []);

  // SSO connections for the chosen org, in server sort_order. The login
  // page is public (no token), so this uses the org-name-keyed public
  // route; a fetch failure just hides the buttons.
  useEffect(() => {
    if (!orgName) {
      setProviders([]);
      return;
    }
    ssoApi
      .providers(orgName)
      .then((r) => setProviders(r.providers ?? []))
      .catch(() => setProviders([]));
  }, [orgName]);

  const submit = async (): Promise<void> => {
    setErr(null);
    setBusy(true);
    try {
      // Only send orgName when the user actually chose one. With exactly
      // one org, the server picks it for us; with multiple, the SPA has
      // already populated `orgName` from the selector.
      const body = orgs && orgs.length > 1 ? { orgName, username, password } : { username, password };
      const r = await authApi.login(body);
      login(r.token);
      // A same-origin `?next=` (set by the server when an org-restricted
      // share page bounces a signed-out browser here) is followed with a
      // FULL navigation so the browser re-requests that path carrying the
      // session cookie the login response just set. A client-side nav would
      // skip the real page request and never authenticate the share.
      const queryNext = safeNextRedirect(loc.search);
      if (queryNext) {
        window.location.assign(queryNext);
        return;
      }
      const appNext = loc.state?.from?.pathname ?? '/';
      nav(appNext, { replace: true });
    } catch (e) {
      setErr(explainLoginError(e));
    } finally {
      setBusy(false);
    }
  };

  // Enter in any input submits. Most natural target is the password field
  // (the last input before the submit button) but supporting all three
  // keeps muscle memory consistent.
  const onInputKeyDown = (e: React.KeyboardEvent<HTMLInputElement>): void => {
    if (e.key === 'Enter' && !busy) {
      e.preventDefault();
      void submit();
    }
  };
  const onSelectKeyDown = (e: React.KeyboardEvent<HTMLSelectElement>): void => {
    if (e.key === 'Enter' && !busy) {
      e.preventDefault();
      void submit();
    }
  };

  const showOrgSelector = orgs !== null && orgs.length > 1;

  return (
    <div className="min-h-screen flex items-center justify-center bg-[var(--bg-primary)]">
      <div className="w-full max-w-sm">
        <div className="flex items-center justify-center gap-3 mb-6">
          <img
            src="/brand/genwork-small.png"
            alt="GenWork"
            draggable={false}
            className="w-12 h-12 rounded-[var(--radius-lg)] object-contain"
          />
          <h1 className="text-2xl font-bold text-[var(--text-primary)] tracking-tight">GenWork</h1>
        </div>
        <div className="w-full p-8 bg-[var(--bg-secondary)] rounded-[var(--radius-lg)] shadow border border-[var(--border-subtle)]">
          <h2 className="text-base font-semibold mb-4 text-[var(--text-primary)]">{t('auth.login.title')}</h2>
          {showOrgSelector && (
            <select
              className="border border-[var(--border-default)] w-full p-2 mb-2 rounded-[var(--radius-md)] bg-[var(--bg-secondary)] text-[var(--text-primary)] focus:border-[var(--accent-primary)] focus:outline-none"
              value={orgName}
              onChange={(e) => setOrgName(e.target.value)}
              onKeyDown={onSelectKeyDown}
            >
              <option value="">{t('auth.login.orgName')}</option>
              {orgs.map((o) => (
                <option key={o.id} value={o.name}>
                  {o.name}
                </option>
              ))}
            </select>
          )}
          <input
            className="border border-[var(--border-default)] w-full p-2 mb-2 rounded-[var(--radius-md)] bg-[var(--bg-secondary)] text-[var(--text-primary)] focus:border-[var(--accent-primary)] focus:outline-none"
            placeholder={t('auth.login.username')}
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            onKeyDown={onInputKeyDown}
          />
          <div className="relative mb-4">
            <input
              className="border border-[var(--border-default)] w-full p-2 pr-10 rounded-[var(--radius-md)] bg-[var(--bg-secondary)] text-[var(--text-primary)] focus:border-[var(--accent-primary)] focus:outline-none"
              type={showPassword ? 'text' : 'password'}
              placeholder={t('auth.login.password')}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              onKeyDown={onInputKeyDown}
              autoComplete="current-password"
            />
            <button
              type="button"
              className="absolute inset-y-0 right-0 flex items-center justify-center w-9 text-[var(--text-secondary)] hover:text-[var(--text-primary)]"
              aria-label={showPassword ? t('auth.login.hidePassword') : t('auth.login.showPassword')}
              onClick={() => setShowPassword((v) => !v)}
              tabIndex={-1}
            >
              <EyeIcon open={showPassword} />
            </button>
          </div>
          <button
            className="bg-[var(--accent-primary)] hover:bg-[var(--accent-primary-hover)] text-white p-2 w-full rounded-[var(--radius-md)] disabled:opacity-50"
            disabled={busy}
            onClick={submit}
          >
            {t('auth.login.submit')}
          </button>
          {err && <p className="text-[var(--danger-primary)] mt-2 text-sm">{err}</p>}

          {providers.length > 0 && (
            <>
              <div className="my-5 flex items-center gap-3 text-[var(--text-tertiary)] text-xs">
                <span className="flex-1 border-t border-[var(--border-subtle)]" />
                <span className="uppercase tracking-wide">{t('sso.login.otherMethods')}</span>
                <span className="flex-1 border-t border-[var(--border-subtle)]" />
              </div>
              <div className="flex flex-wrap items-center justify-center gap-3">
                {providers.map((p) => (
                  <button
                    key={p.id}
                    type="button"
                    title={t('sso.login.button.with').replace('{name}', p.name)}
                    aria-label={t('sso.login.button.with').replace('{name}', p.name)}
                    onClick={() => {
                      // Same-origin full-page redirect: the server starts
                      // the SSO dance and the callback lands back on this
                      // SPA.
                      window.location.href = `/auth/sso/${p.id}/authorize?orgName=${encodeURIComponent(orgName)}&return=console`;
                    }}
                    className="flex h-11 w-11 items-center justify-center rounded-full border border-[var(--border-subtle)] bg-white hover:bg-[var(--bg-hover)] transition-colors"
                  >
                    {p.logoUrl ? (
                      <img
                        src={p.logoUrl}
                        alt=""
                        draggable={false}
                        className="h-6 w-6 rounded object-contain"
                      />
                    ) : (
                      <span className="text-xs text-[var(--text-secondary)] font-medium">
                        {p.name.slice(0, 2).toUpperCase()}
                      </span>
                    )}
                  </button>
                ))}
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
