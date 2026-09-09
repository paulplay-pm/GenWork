import type { JSX } from 'react';

export type StatusDotStatus = 'connected' | 'failed' | 'unknown';

const TONE_CLASS: Record<StatusDotStatus, string> = {
  connected: 'bg-[var(--success-primary)]',
  failed: 'bg-[var(--danger-primary)]',
  unknown: 'bg-[var(--text-tertiary)]',
};

interface Props {
  status: StatusDotStatus;
  className?: string;
}

export function StatusDot({ status, className = '' }: Props): JSX.Element {
  return (
    <span
      aria-label={`status-${status}`}
      className={`inline-block h-2 w-2 rounded-full ${TONE_CLASS[status]} ${className}`}
    />
  );
}
