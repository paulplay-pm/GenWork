import type { JSX, ReactNode } from 'react';

export type BadgeTone = 'success' | 'danger' | 'info' | 'neutral' | 'warning';

const TONE_CLASS: Record<BadgeTone, string> = {
  success:
    'bg-[var(--success-light)] text-[var(--success-primary)] ring-1 ring-inset ring-[var(--success-primary)]/20',
  danger:
    'bg-[var(--danger-light)] text-[var(--danger-primary)] ring-1 ring-inset ring-[var(--danger-primary)]/20',
  info: 'bg-[var(--accent-light)] text-[var(--accent-primary)] ring-1 ring-inset ring-[var(--accent-primary)]/20',
  neutral:
    'bg-[var(--bg-tertiary)] text-[var(--text-secondary)] ring-1 ring-inset ring-[var(--border-subtle)]',
  warning:
    'bg-[var(--warning-light)] text-[var(--warning-primary)] ring-1 ring-inset ring-[var(--warning-primary)]/20',
};

interface Props {
  tone: BadgeTone;
  children: ReactNode;
  icon?: ReactNode;
  className?: string;
}

/**
 * Status / category pill. Use tone="success" for active, "danger" for
 * blocked, "info" for configured, "warning" for region=china or quota nearing,
 * "neutral" for catalog-only / unset.
 */
export function Badge({ tone, children, icon, className }: Props): JSX.Element {
  const cls = TONE_CLASS[tone];
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium ${cls}${className ? ' ' + className : ''}`}
    >
      {icon}
      {children}
    </span>
  );
}
