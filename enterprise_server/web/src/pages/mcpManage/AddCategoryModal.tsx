import type { JSX } from 'react';
import { useEffect, useRef, useState } from 'react';

import { ApiError } from '../../api/client';
import { t } from '../../i18n';

interface Props {
  open: boolean;
  /**
   * Called with the trimmed category name. May return a Promise (the caller
   * performs the API write); a rejection is surfaced inline as an error.
   */
  onSave: (name: string) => void | Promise<unknown>;
  onCancel: () => void;
}

/** Map known API error codes to their i18n messages; fall back to the message. */
function errorText(e: unknown): string {
  if (e instanceof ApiError) {
    if (e.body?.error === 'category_name_taken') return t('mcp.categoryError.duplicate');
    if (e.body?.error === 'category_cap') return t('mcp.categoryError.cap');
  }
  return e instanceof Error ? e.message : String(e);
}

export function AddCategoryModal({ open, onSave, onCancel }: Props): JSX.Element | null {
  const [name, setName] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!open) return;
    setName('');
    setError(null);
    const timer = window.setTimeout(() => inputRef.current?.focus(), 0);
    const handler = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onCancel();
    };
    window.addEventListener('keydown', handler);
    return () => {
      window.clearTimeout(timer);
      window.removeEventListener('keydown', handler);
    };
  }, [open, onCancel]);

  if (!open) return null;

  const trimmed = name.trim();
  const canSave = trimmed.length > 0 && !saving;

  async function submit(): Promise<void> {
    if (!trimmed || saving) return;
    setSaving(true);
    setError(null);
    try {
      await onSave(trimmed);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setSaving(false);
    }
  }

  const btnBase = 'px-4 py-2 rounded-[6px] text-[13px]';
  const cancelCls = `${btnBase} border border-[var(--border-default)] text-[var(--text-primary)] hover:bg-[var(--bg-tertiary)]`;
  const saveCls = `${btnBase} bg-[var(--accent-primary)] text-white hover:bg-[var(--accent-primary-hover)] disabled:cursor-not-allowed disabled:opacity-50`;

  return (
    <div
      className="fixed inset-0 z-[102] flex items-center justify-center bg-black/40"
      onClick={onCancel}
    >
      <div
        className="w-[360px] max-w-[92vw] rounded-[8px] border border-[var(--border-default)] bg-[var(--bg-secondary)] p-5 shadow-lg"
        role="dialog"
        aria-modal="true"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 className="mb-3 text-[15px] font-semibold text-[var(--text-primary)]">{t('mcp.addCategory.title')}</h2>
        <input
          ref={inputRef}
          value={name}
          onChange={(e) => { setName(e.target.value); if (error) setError(null); }}
          onKeyDown={(e) => { if (e.key === 'Enter') void submit(); }}
          placeholder={t('mcp.addCategory.placeholder')}
          aria-label={t('mcp.addCategory.title')}
          className="mb-4 w-full rounded-[6px] border border-[var(--border-default)] bg-[var(--bg-tertiary)] px-3 py-2 text-[13px] text-[var(--text-primary)] outline-none focus:border-[var(--accent-primary)]"
        />
        {error && (
          <p role="alert" className="mb-3 rounded-[6px] bg-[var(--danger-light)] px-3 py-2 text-[12px] text-[var(--danger-primary)]">
            {error}
          </p>
        )}
        <div className="flex justify-end gap-2">
          <button type="button" onClick={onCancel} className={cancelCls}>{t('mcp.cancel')}</button>
          <button type="button" onClick={() => void submit()} disabled={!canSave} className={saveCls}>{t('common.confirm')}</button>
        </div>
      </div>
    </div>
  );
}
