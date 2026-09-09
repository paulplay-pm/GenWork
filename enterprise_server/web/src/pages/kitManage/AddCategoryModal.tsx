import type { JSX } from 'react';
import { useEffect, useRef, useState } from 'react';

import { t } from '../../i18n';

interface Props {
  open: boolean;
  onSave: (name: string) => void;
  onCancel: () => void;
}

export function AddCategoryModal({ open, onSave, onCancel }: Props): JSX.Element | null {
  const [name, setName] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!open) return;
    setName('');
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
  const canSave = trimmed.length > 0;

  function submit(): void {
    if (!canSave) return;
    onSave(trimmed);
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
        <h2 className="mb-3 text-[15px] font-semibold text-[var(--text-primary)]">{t('kitmgmt.addCategory.title')}</h2>
        <input
          ref={inputRef}
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') submit(); }}
          placeholder={t('kitmgmt.addCategory.placeholder')}
          aria-label={t('kitmgmt.addCategory.title')}
          className="mb-4 w-full rounded-[6px] border border-[var(--border-default)] bg-[var(--bg-tertiary)] px-3 py-2 text-[13px] text-[var(--text-primary)] outline-none focus:border-[var(--accent-primary)]"
        />
        <div className="flex justify-end gap-2">
          <button type="button" onClick={onCancel} className={cancelCls}>{t('common.cancel')}</button>
          <button type="button" onClick={submit} disabled={!canSave} className={saveCls}>{t('common.confirm')}</button>
        </div>
      </div>
    </div>
  );
}
