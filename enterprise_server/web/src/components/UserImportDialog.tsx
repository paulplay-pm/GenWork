import { Download } from 'lucide-react';
import type { ChangeEvent, JSX } from 'react';
import { useState } from 'react';

import { ApiError } from '../api/client';
import { type ImportResult, userErrorMessage, usersApi } from '../api/users';
import { t } from '../i18n';
import { TempPasswordRow } from './TempPasswordPanel';

/** Static template sample: the export/import header plus one example row.
 * (The live export endpoint is not required for the template.) */
const TEMPLATE_CSV = [
  'username,display_name,email,phone,position,level,primary_dept_code,roles,status,timezone',
  'zhangwei,张伟,zhangwei@corp.example,,Engineer,P5,ENG,user,,Asia/Shanghai',
].join('\n');

interface Props {
  orgId: string;
  /** Called after a successful (partial or full) import so the page can refresh. */
  onImported: () => void;
  onClose: () => void;
}

/**
 * Bulk user import: template download, CSV file upload, then a report of
 * `{ created, skipped }`, the per-row `errors[]` and the per-user
 * `tempPasswords[]`. Imported users are always created active; re-importing
 * an existing username is a row error, not a re-activation.
 */
export function UserImportDialog({ orgId, onImported, onClose }: Props): JSX.Element {
  const [fileText, setFileText] = useState<string | null>(null);
  const [fileName, setFileName] = useState<string | null>(null);
  const [result, setResult] = useState<ImportResult | null>(null);
  const [partialFailed, setPartialFailed] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const downloadTemplate = (): void => {
    const blob = new Blob([TEMPLATE_CSV], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'users-template.csv';
    a.click();
    URL.revokeObjectURL(url);
  };

  const onFile = (e: ChangeEvent<HTMLInputElement>): void => {
    const f = e.target.files?.[0];
    if (!f) return;
    const reader = new FileReader();
    reader.onload = (): void => {
      const text = typeof reader.result === 'string' ? reader.result : '';
      setFileName(f.name);
      setFileText(text);
      setResult(null);
      setPartialFailed(false);
      setErr(null);
    };
    reader.readAsText(f);
  };

  const submit = async (): Promise<void> => {
    if (fileText === null || busy) return;
    setBusy(true);
    setErr(null);
    setResult(null);
    setPartialFailed(false);
    try {
      const res = await usersApi.importUsers(orgId, fileText);
      setResult(res);
      onImported();
    } catch (e) {
      if (e instanceof ApiError && e.body?.error === 'partial_import_failed') {
        // The server commits per row, so some users were created despite the
        // 500 — report that body like a normal result (temp passwords are
        // one-time only and would otherwise be lost).
        const b = e.body as unknown as Partial<ImportResult>;
        setResult({
          created: b.created ?? 0,
          skipped: b.skipped ?? 0,
          errors: b.errors ?? [],
          tempPasswords: b.tempPasswords ?? [],
        });
        setPartialFailed(true);
        onImported();
      } else {
        setErr(userErrorMessage(e));
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40"
      onClick={onClose}
    >
      <div
        data-testid="import-dialog"
        className="max-h-[85vh] w-full max-w-lg overflow-y-auto rounded-xl bg-[var(--bg-secondary)] p-6 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 className="text-base font-semibold text-[var(--text-primary)]">
          {t('users.import.title')}
        </h2>
        <p className="mb-4 mt-1 text-sm text-[var(--text-secondary)]">{t('users.import.hint')}</p>

        <div className="mb-3 flex items-center gap-3">
          <button
            type="button"
            onClick={downloadTemplate}
            className="inline-flex items-center gap-1.5 rounded-lg border border-[var(--border-default)] px-3.5 py-2 text-sm font-medium text-[var(--text-secondary)] transition-colors hover:bg-[var(--bg-hover)]"
          >
            <Download className="h-4 w-4" />
            {t('users.import.template')}
          </button>
          <label className="block text-sm text-[var(--text-secondary)]">
            {t('users.import.file')}
            <input
              type="file"
              accept=".csv,text/csv"
              onChange={onFile}
              className="mt-1 block w-full cursor-pointer text-sm file:mr-3 file:cursor-pointer file:rounded-lg file:border-0 file:bg-[var(--bg-tertiary)] file:px-3 file:py-1.5 file:text-sm"
            />
          </label>
        </div>

        {fileName && !result && (
          <p className="mb-3 truncate text-xs text-[var(--text-tertiary)]">{fileName}</p>
        )}

        {err && <p className="mb-3 text-sm text-[var(--danger-primary)]">{err}</p>}

        {result && partialFailed && (
          <p className="mb-3 text-sm font-medium text-[var(--danger-primary)]">
            {t('users.import.partialFailed')}
          </p>
        )}

        {result && (
          <div className="mb-4 rounded-lg border border-[var(--border-subtle)] bg-[var(--bg-tertiary)]/40 p-4">
            <p className="text-sm font-medium text-[var(--text-primary)]">
              {t('users.import.result')
                .replaceAll('{created}', String(result.created))
                .replaceAll('{skipped}', String(result.skipped))}
            </p>
            {result.errors.length > 0 && (
              <div className="mt-2">
                <h3 className="text-xs font-semibold uppercase tracking-wide text-[var(--text-tertiary)]">
                  {t('users.import.errors')}
                </h3>
                <ul className="mt-1 max-h-32 list-disc overflow-y-auto pl-4 text-xs text-[var(--danger-primary)]">
                  {result.errors.map((e) => (
                    <li key={e.row}>
                      {t('users.import.rowError')
                        .replaceAll('{row}', String(e.row))
                        .replaceAll('{reason}', e.reason)}
                    </li>
                  ))}
                </ul>
              </div>
            )}
            {result.tempPasswords.length > 0 && (
              <div className="mt-3">
                <h3 className="mb-1 text-xs font-semibold uppercase tracking-wide text-[var(--text-tertiary)]">
                  {t('users.import.tempTitle')}
                </h3>
                <div className="space-y-2">
                  {result.tempPasswords.map((tp) => (
                    <TempPasswordRow
                      key={tp.username}
                      username={tp.username}
                      tempPassword={tp.tempPassword}
                    />
                  ))}
                </div>
              </div>
            )}
          </div>
        )}

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
            disabled={busy || fileText === null}
            className="rounded-lg bg-[var(--accent-primary)] px-3.5 py-2 text-sm font-medium text-white shadow-sm transition-colors hover:bg-[var(--accent-primary-hover)] disabled:opacity-50"
          >
            {t('users.import.submit')}
          </button>
        </div>
      </div>
    </div>
  );
}
