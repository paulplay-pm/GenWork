import type { JSX, ReactNode } from 'react';

export type StatusPillTone = 'active' | 'disabled' | 'error' | 'warning' | 'info';

const TONE_CLASS: Record<StatusPillTone, string> = {
  active: 'bg-[var(--success-light)] text-[var(--success-primary)] [&_.dot]:bg-[var(--success-primary)]',
  disabled: 'bg-[#f1f5f9] text-[var(--text-tertiary)] [&_.dot]:bg-[var(--text-tertiary)]',
  error: 'bg-[var(--danger-light)] text-[var(--danger-primary)] [&_.dot]:bg-[var(--danger-primary)]',
  warning: 'bg-[var(--warning-light)] text-[var(--warning-primary)] [&_.dot]:bg-[var(--warning-primary)]',
  info: 'bg-[var(--accent-light)] text-[var(--accent-primary)] [&_.dot]:bg-[var(--accent-primary)]',
};

interface Props {
  tone: StatusPillTone;
  children: ReactNode;
}

export function StatusPill({ tone, children }: Props): JSX.Element {
  return (
    <span className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium ${TONE_CLASS[tone]}`}>
      <span className="dot w-1.5 h-1.5 rounded-full" />
      {children}
    </span>
  );
}