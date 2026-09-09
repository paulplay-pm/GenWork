import { useState } from 'react';

import { i18nService } from '../services/i18n';

const t = (key: string): string => i18nService.t(key);

export type EnterpriseSetupModalMode = 'firstTime' | 'edit';

interface EnterpriseSetupModalProps {
  initialUrl: string;
  /**
   * Validate the URL by hitting <url>/health. Resolves with ok=false on
   * any non-200, timeout, or network error.
   */
  onVerify: (url: string) => Promise<{ ok: boolean; error?: string }>;
  /**
   * Persist the URL after verify succeeds. Resolves with ok=false only on
   * a storage-side failure (very rare). The verify has already been run
   * separately, so onSave does NOT re-verify.
   */
  onSave: (url: string) => Promise<{ ok: boolean; error?: string }>;
  /** firstTime mode: user has no working server yet, allow Quit. */
  onQuit: () => void;
  /** edit mode: dismiss modal without saving. firstTime mode: not used. */
  onCancel?: () => void;
  /**
   * First-launch mode (default) renders the Quit button and Save&Continue
   * label. Edit mode (opened from Settings) renders Cancel + Save, plus a
   * Test Connection button and a restart-required notice.
   */
  mode?: EnterpriseSetupModalMode;
}

/**
 * First-launch / persistence-error modal for the enterprise server URL.
 *
 * Flow:
 *   1. User types URL → clicks "Save and continue".
 *   2. Modal calls `onVerify(url)` to hit <url>/health (5s timeout on
 *      main-process side).
 *   3. If ok=false, show "Cannot reach this address" inline; modal stays
 *      open so the user can correct the URL or hit Quit.
 *   4. If ok=true, call `onSave(url)` to persist + re-point the in-memory
 *      client. Parent should call App.tsx's probeEnterpriseBootstrap after
 *      onSave resolves to transition past the modal.
 *
 * Edit mode (`mode="edit"`) is opened from Settings after the server is
 * already configured. It swaps Quit → Cancel, Save&Continue → Save, and
 * surfaces a Test Connection button. Saving the new URL only takes effect
 * after the user restarts the app, so the modal reminds them of that.
 */
export function EnterpriseSetupModal({
  initialUrl,
  onVerify,
  onSave,
  onQuit,
  onCancel,
  mode = 'firstTime',
}: EnterpriseSetupModalProps): JSX.Element {
  const [url, setUrl] = useState(initialUrl);
  const [busy, setBusy] = useState(false);
  const [verifyStatus, setVerifyStatus] = useState<'idle' | 'success' | 'failure'>('idle');
  const [err, setErr] = useState<string | null>(null);

  async function handleSaveUrl(): Promise<void> {
    const trimmed = url.trim();
    if (!trimmed) {
      setErr(t('enterpriseSetup.urlRequired'));
      setVerifyStatus('failure');
      return;
    }
    setBusy(true);
    setErr(null);
    try {
      const verifyResult = await onVerify(trimmed);
      if (!verifyResult.ok) {
        setErr(verifyResult.error ?? t('enterpriseSetup.unreachable'));
        setVerifyStatus('failure');
        return;
      }
      setVerifyStatus('success');
      const saveResult = await onSave(trimmed);
      if (!saveResult.ok) {
        setErr(saveResult.error ?? t('enterpriseSetup.unreachable'));
        setVerifyStatus('failure');
        return;
      }
    } catch (e) {
      setErr((e as Error).message);
      setVerifyStatus('failure');
    } finally {
      setBusy(false);
    }
  }

  async function handleTestConnection(): Promise<void> {
    const trimmed = url.trim();
    if (!trimmed) {
      setErr(t('enterpriseSetup.urlRequired'));
      setVerifyStatus('failure');
      return;
    }
    setBusy(true);
    setErr(null);
    try {
      const verifyResult = await onVerify(trimmed);
      if (!verifyResult.ok) {
        setErr(verifyResult.error ?? t('enterpriseSetup.unreachable'));
        setVerifyStatus('failure');
        return;
      }
      setVerifyStatus('success');
      setErr(null);
    } catch (e) {
      setErr((e as Error).message);
      setVerifyStatus('failure');
    } finally {
      setBusy(false);
    }
  }

  const isEdit = mode === 'edit';
  const saveLabel = isEdit ? t('enterpriseSetup.saveEdit') : t('enterpriseSetup.save');
  const busyLabel = isEdit ? t('enterpriseSetup.testing') : t('enterpriseSetup.verifying');

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
      <div className="bg-white rounded-xl shadow-2xl max-w-md w-full p-7 space-y-4">
        <h2 className="text-xl font-semibold text-gray-900">{t('enterpriseSetup.title')}</h2>
        <p className="text-sm text-gray-600">{t('enterpriseSetup.description')}</p>
        <input
          type="url"
          placeholder={t('enterpriseSetup.urlPlaceholder')}
          value={url}
          onChange={(e) => {
            setUrl(e.target.value);
            setVerifyStatus('idle');
            setErr(null);
          }}
          disabled={busy}
          className="w-full px-3 py-2 border border-gray-300 rounded text-sm focus:outline-none focus:border-blue-500"
        />
        {verifyStatus === 'success' && !err && (
          <p className="text-sm text-green-600">{t('enterpriseSetup.testSuccess')}</p>
        )}
        {err && <p className="text-sm text-red-600">{err}</p>}
        {isEdit && (
          <p className="text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded px-3 py-2">
            {t('enterpriseSetup.restartRequired')}
          </p>
        )}
        <div className="flex gap-2 justify-end pt-2">
          {isEdit ? (
            <>
              <button
                type="button"
                onClick={() => onCancel?.()}
                disabled={busy}
                className="px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-100 rounded"
              >
                {t('enterpriseSetup.cancel')}
              </button>
              <button
                type="button"
                onClick={() => { void handleTestConnection(); }}
                disabled={busy}
                className="px-4 py-2 text-sm font-medium text-gray-700 border border-gray-300 hover:bg-gray-100 rounded disabled:opacity-50"
              >
                {t('enterpriseSetup.testConnection')}
              </button>
              <button
                type="button"
                onClick={() => { void handleSaveUrl(); }}
                disabled={busy}
                className="px-4 py-2 text-sm font-medium text-white bg-blue-600 hover:bg-blue-700 rounded disabled:opacity-50"
              >
                {busy ? busyLabel : saveLabel}
              </button>
            </>
          ) : (
            <>
              <button
                type="button"
                onClick={onQuit}
                disabled={busy}
                className="px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-100 rounded"
              >
                {t('enterpriseSetup.quit')}
              </button>
              <button
                type="button"
                onClick={() => { void handleSaveUrl(); }}
                disabled={busy}
                className="px-4 py-2 text-sm font-medium text-white bg-blue-600 hover:bg-blue-700 rounded disabled:opacity-50"
              >
                {busy ? t('enterpriseSetup.verifying') : t('enterpriseSetup.save')}
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}