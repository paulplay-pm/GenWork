import type { JSX } from 'react';
import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';

import { authApi } from '../api/auth';
import { setupApi } from '../api/setup';
import { ApiError } from '../api/client';
import { useAuth } from '../auth/useAuth';
import { t } from '../i18n';

type Step = 'loading' | 'org' | 'credentials' | 'done';

interface Invite {
  orgId: string;
  orgName: string;
  code: string;
  expiresAt: string;
}

function explainSetupError(e: unknown): string {
  if (e instanceof ApiError) {
    if (e.body?.error === 'setup_closed') return t('setup.error.setupClosed');
    if (e.body?.error === 'duplicate_org_name') return t('setup.error.duplicateName');
    if (e.body?.error === 'invitation_unavailable') return t('setup.error.invitation');
    if (e.status === 0) return t('setup.error.network');
    return t('setup.error.unknown');
  }
  return t('setup.error.unknown');
}

export function SetupPage(): JSX.Element {
  const [step, setStep] = useState<Step>('loading');
  const [orgName, setOrgName] = useState('');
  const [invite, setInvite] = useState<Invite | null>(null);
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [doneOrgName, setDoneOrgName] = useState('');
  const nav = useNavigate();
  const { login } = useAuth();

  useEffect(() => {
    setupApi
      .status()
      .then((s) => {
        if (s.superAdminExists) nav('/login', { replace: true });
        else setStep('org');
      })
      .catch((e) => {
        setErr(explainSetupError(e));
        setStep('org');
      });
  }, [nav]);

  const start = async (): Promise<void> => {
    setErr(null);
    setBusy(true);
    try {
      const r = await setupApi.start(orgName);
      setInvite({ orgId: r.orgId, orgName: r.orgName, code: r.code, expiresAt: r.expiresAt });
      setStep('credentials');
    } catch (e) {
      setErr(explainSetupError(e));
    } finally {
      setBusy(false);
    }
  };

  const redeem = async (): Promise<void> => {
    if (!invite) return;
    setErr(null);
    setBusy(true);
    try {
      // Single round-trip: redeem also returns a signed JWT, so the SPA
      // can drop the user straight into the dashboard without a separate
      // /auth/login call.
      const r = await setupApi.redeem({
        orgId: invite.orgId,
        code: invite.code,
        username,
        password,
      });
      login(r.token);
      setDoneOrgName(r.orgName);
      setStep('done');
    } catch (e) {
      setErr(explainSetupError(e));
    } finally {
      setBusy(false);
    }
  };

  if (step === 'loading') {
    return <div className="p-8 text-[var(--text-secondary)]">{t('common.loading')}</div>;
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-[var(--bg-primary)]">
      <div className="w-full max-w-md p-8 bg-[var(--bg-secondary)] rounded-[var(--radius-lg)] shadow border border-[var(--border-subtle)]">
        <h1 className="text-xl font-bold mb-2 text-[var(--text-primary)]">{t('setup.title')}</h1>
        <p className="text-sm text-[var(--text-secondary)] mb-4">{t('setup.intro')}</p>

        {step === 'org' && (
          <>
            <label className="block text-sm text-[var(--text-secondary)] mb-1">
              {t('setup.orgName.label')}
            </label>
            <input
              className="border border-[var(--border-default)] w-full p-2 mb-4 rounded-[var(--radius-md)] bg-[var(--bg-secondary)] text-[var(--text-primary)] focus:border-[var(--accent-primary)] focus:outline-none"
              placeholder={t('setup.orgName.placeholder')}
              value={orgName}
              onChange={(e) => setOrgName(e.target.value)}
            />
            <button
              className="bg-[var(--accent-primary)] hover:bg-[var(--accent-primary-hover)] text-white p-2 w-full rounded-[var(--radius-md)] disabled:opacity-50"
              disabled={busy || orgName.trim().length === 0}
              onClick={start}
            >
              {t('setup.continue')}
            </button>
          </>
        )}

        {step === 'credentials' && invite && (
          <>
            <div className="mb-3 p-3 bg-[var(--bg-tertiary)] rounded-[var(--radius-md)] text-sm font-mono break-all text-[var(--text-primary)]">
              {invite.code}
            </div>
            <div className="text-xs text-[var(--text-secondary)] mb-4">
              {t('setup.inviteCode.expires').replace(
                '{time}',
                new Date(invite.expiresAt).toLocaleString()
              )}
            </div>
            <input
              className="border border-[var(--border-default)] w-full p-2 mb-2 rounded-[var(--radius-md)] bg-[var(--bg-secondary)] text-[var(--text-primary)] focus:border-[var(--accent-primary)] focus:outline-none"
              placeholder={t('setup.credentials.username')}
              value={username}
              onChange={(e) => setUsername(e.target.value)}
            />
            <input
              className="border border-[var(--border-default)] w-full p-2 mb-4 rounded-[var(--radius-md)] bg-[var(--bg-secondary)] text-[var(--text-primary)] focus:border-[var(--accent-primary)] focus:outline-none"
              type="password"
              placeholder={t('setup.credentials.password')}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
            <button
              className="bg-[var(--accent-primary)] hover:bg-[var(--accent-primary-hover)] text-white p-2 w-full rounded-[var(--radius-md)] disabled:opacity-50"
              disabled={busy || !username || password.length < 8}
              onClick={redeem}
            >
              {t('setup.credentials.submit')}
            </button>
          </>
        )}

        {step === 'done' && (
          <>
            <p className="text-sm text-[var(--text-secondary)] mb-2">
              {t('setup.done.orgNameLabel')}
            </p>
            <p className="text-lg font-semibold mb-6 text-[var(--text-primary)]">
              {doneOrgName}
            </p>
            <button
              className="bg-[var(--accent-primary)] hover:bg-[var(--accent-primary-hover)] text-white p-2 w-full rounded-[var(--radius-md)]"
              onClick={() => nav('/', { replace: true })}
            >
              {t('setup.done.continue')}
            </button>
          </>
        )}

        {err && <p className="text-[var(--danger-primary)] mt-3 text-sm">{err}</p>}
      </div>
    </div>
  );
}
