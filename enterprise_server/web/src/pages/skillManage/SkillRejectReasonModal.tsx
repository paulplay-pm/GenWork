import type { JSX } from 'react';
import { useEffect, useRef, useState } from 'react';

import { useToast } from '../../components/toastStore';
import { t } from '../../i18n';
import { fill } from './types';

interface Props {
  open: boolean;
  /** Submission name, shown in the title: 驳回「{name}」. */
  name: string;
  /** While the reject request is in flight (buttons lock, Esc is inert). */
  busy: boolean;
  /** Called with the trimmed, non-empty reason. Never called with an empty
   * reason — an empty one is blocked here with a toast instead. */
  onConfirm: (reason: string) => Promise<void> | void;
  onCancel: () => void;
}

/**
 * Forced-reason modal for rejecting a skill submission (mirrors the
 * prototype's `rejectReview` confirm): an empty reason is blocked with a
 * toast and the API is never called. Esc / backdrop click cancel; both are
 * inert while busy.
 */
export function SkillRejectReasonModal({ open, name, busy, onConfirm, onCancel }: Props): JSX.Element | null {
  const toast = useToast();
  const [reason, setReason] = useState('');
  const taRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (!open) return;
    setReason('');
    const timer = window.setTimeout(() => taRef.current?.focus(), 0);
    const handler = (e: KeyboardEvent): void => {
      if (e.key === 'Escape' && !busy) onCancel();
    };
    window.addEventListener('keydown', handler);
    return () => {
      window.clearTimeout(timer);
      window.removeEventListener('keydown', handler);
    };
  }, [open, busy, onCancel]);

  if (!open) return null;

  async function submit(): Promise<void> {
    const r = reason.trim();
    if (busy) return;
    if (!r) {
      toast.error(t('skillmgmt.review.reject.empty'));
      return;
    }
    await onConfirm(r);
  }

  const btnBase = 'px-4 py-2 rounded-[6px] text-[13px] disabled:cursor-not-allowed disabled:opacity-50';

  return (
    <div
      className="fixed inset-0 z-[102] flex items-center justify-center bg-black/40"
      onClick={busy ? undefined : onCancel}
    >
      <div
        className="w-[400px] max-w-[92vw] rounded-[8px] border border-[var(--border-default)] bg-[var(--bg-secondary)] p-5 shadow-lg"
        role="dialog"
        aria-modal="true"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 className="mb-2 text-[15px] font-semibold text-[var(--text-primary)]">
          {fill(t('skillmgmt.review.reject.title'), { name })}
        </h2>
        <p className="mb-3 text-[13px] leading-relaxed text-[var(--text-secondary)]">{t('skillmgmt.review.reject.intro')}</p>
        <textarea
          ref={taRef}
          value={reason}
          rows={3}
          onChange={(e) => setReason(e.target.value)}
          placeholder={t('skillmgmt.review.reject.placeholder')}
          aria-label={t('skillmgmt.review.reject.intro')}
          className="w-full resize-none rounded-[6px] border border-[var(--border-default)] bg-[var(--bg-tertiary)] px-3 py-2 text-[13px] text-[var(--text-primary)] outline-none focus:border-[var(--accent-primary)]"
        />
        <div className="mt-4 flex justify-end gap-2">
          <button
            type="button"
            onClick={onCancel}
            disabled={busy}
            className={`${btnBase} border border-[var(--border-default)] text-[var(--text-primary)] hover:bg-[var(--bg-tertiary)]`}
          >
            {t('common.cancel')}
          </button>
          <button
            type="button"
            onClick={() => void submit()}
            disabled={busy}
            className={`${btnBase} bg-[var(--danger-primary)] text-white hover:opacity-90`}
          >
            {busy ? t('common.loading') : t('skillmgmt.review.reject.confirm')}
          </button>
        </div>
      </div>
    </div>
  );
}
