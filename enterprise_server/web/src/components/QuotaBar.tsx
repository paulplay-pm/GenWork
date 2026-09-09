import type { JSX, ReactNode } from 'react';

interface Props {
  used: number;
  quota: number;
  warningThreshold?: number;
}

export function QuotaBar({ used, quota, warningThreshold = 0.9 }: Props): JSX.Element {
  const ratio = quota === 0 ? 0 : Math.min(1, used / quota);
  const color =
    ratio >= warningThreshold
      ? 'bg-[var(--danger-primary)]'
      : ratio >= 0.7
        ? 'bg-[var(--warning-primary)]'
        : 'bg-[var(--success-primary)]';
  return (
    <div className="w-full">
      <div className="h-1.5 bg-[var(--bg-tertiary)] rounded-full overflow-hidden">
        <div className={`h-full ${color}`} style={{ width: `${ratio * 100}%` }} />
      </div>
      <div className="text-xs text-[var(--text-secondary)] mt-1 tabular-nums">
        {used.toLocaleString()} / {quota.toLocaleString()}
      </div>
    </div>
  );
}

export type { Props as QuotaBarProps };
export type _Unused = ReactNode;
