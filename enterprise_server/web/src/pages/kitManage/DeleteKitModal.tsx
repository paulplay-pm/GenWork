import type { JSX } from 'react';
import { useEffect } from 'react';

import { t } from '../../i18n';
import { fill } from './types';

interface Props {
  open: boolean;
  name: string;
  scopeSummary: string;
  busy: boolean;
  onConfirm: () => Promise<void> | void;
  onCancel: () => void;
}

export function DeleteKitModal({ open, name, scopeSummary, busy, onConfirm, onCancel }: Props): JSX.Element | null {
  useEffect(() => {
    if (!open || busy) return;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onCancel();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, busy, onCancel]);

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-[110] flex items-center justify-center bg-black/40"
      onClick={busy ? undefined : onCancel}
    >
      <div
        className="w-full max-w-sm rounded-[8px] bg-[var(--bg-secondary)] p-5 shadow-lg"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 className="mb-2 text-[15px] font-semibold text-[var(--text-primary)]">
          {fill(t('kitmgmt.deleteKit.title'), { name })}
        </h2>
        <p className="text-[13px] text-[var(--text-secondary)]">{t('kitmgmt.deleteKit.intro')}</p>
        <ul className="my-3 list-disc space-y-1.5 pl-5 text-[13px] text-[var(--text-secondary)]">
          <li>{fill(t('kitmgmt.deleteKit.impactScope'), { scope: scopeSummary })}</li>
          <li>{t('kitmgmt.deleteKit.impactIrreversible')}</li>
          <li>{t('kitmgmt.deleteKit.impactAudit')}</li>
        </ul>
        <div className="flex justify-end gap-2">
          <button
            type="button"
            onClick={onCancel}
            disabled={busy}
            className="rounded-[6px] border border-[var(--border-default)] px-3.5 py-1.5 text-[13px] hover:bg-[var(--bg-tertiary)] disabled:opacity-50"
          >
            {t('common.cancel')}
          </button>
          <button
            type="button"
            onClick={() => void onConfirm()}
            disabled={busy}
            className="rounded-[6px] bg-[var(--danger-primary)] px-3.5 py-1.5 text-[13px] text-white hover:opacity-90 disabled:opacity-50"
          >
            {busy ? t('common.loading') : t('kitmgmt.deleteKit.confirm')}
          </button>
        </div>
      </div>
    </div>
  );
}
