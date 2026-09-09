import { Check, Copy } from 'lucide-react';
import type { JSX } from 'react';
import { useState } from 'react';

import { t } from '../i18n';
import { copyText } from '../lib/clipboard';

export interface TempPasswordEntry {
  username?: string;
  tempPassword: string;
}

interface PanelProps {
  open: boolean;
  title: string;
  entries: TempPasswordEntry[];
  onClose: () => void;
}

/**
 * In-app result panel for server-generated temporary passwords (single-user
 * reset, batch reset, user creation). The password is shown ONCE, with a copy
 * affordance — there is no second password input anywhere.
 */
export function TempPasswordPanel({ open, title, entries, onClose }: PanelProps): JSX.Element | null {
  if (!open || entries.length === 0) return null;
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40"
      onClick={onClose}
    >
      <div
        className="w-full max-w-md rounded-xl bg-[var(--bg-secondary)] p-6 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 className="mb-1 text-base font-semibold text-[var(--text-primary)]">{title}</h2>
        <p className="mb-4 text-sm text-[var(--text-secondary)]">{t('users.pw.hint')}</p>
        <div className="space-y-2">
          {entries.map((e, i) => (
            <TempPasswordRow key={e.username ?? i} username={e.username} tempPassword={e.tempPassword} />
          ))}
        </div>
        <div className="mt-5 flex justify-end">
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg bg-[var(--accent-primary)] px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-[var(--accent-primary-hover)]"
          >
            {t('users.pw.close')}
          </button>
        </div>
      </div>
    </div>
  );
}

/** One `{ username, tempPassword }` row with a copy button. */
export function TempPasswordRow({
  username,
  tempPassword,
}: {
  username?: string;
  tempPassword: string;
}): JSX.Element {
  const [copied, setCopied] = useState(false);
  const onCopy = async (): Promise<void> => {
    if (await copyText(tempPassword)) {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    }
  };
  return (
    <div className="flex items-center justify-between gap-3 rounded-lg border border-[var(--border-subtle)] px-3 py-2">
      <div className="min-w-0">
        <div className="text-xs text-[var(--text-tertiary)]">{t('users.pw.username')}</div>
        <div className="truncate text-sm font-medium text-[var(--text-primary)]">
          {username ?? '—'}
        </div>
      </div>
      <div className="flex items-center gap-2">
        <code className="rounded bg-[var(--bg-tertiary)] px-2 py-1 font-mono text-sm text-[var(--text-primary)]">
          {tempPassword}
        </code>
        <button
          type="button"
          onClick={onCopy}
          className="inline-flex items-center gap-1 rounded-md border border-[var(--border-default)] px-2 py-1 text-xs text-[var(--text-secondary)] transition-colors hover:bg-[var(--bg-hover)]"
        >
          {copied ? (
            <Check className="h-3.5 w-3.5 text-[var(--success-primary)]" />
          ) : (
            <Copy className="h-3.5 w-3.5" />
          )}
          {copied ? t('users.pw.copied') : t('users.pw.copy')}
        </button>
      </div>
    </div>
  );
}
