import type { JSX, ReactNode } from 'react';

export interface InfoItem {
  label: string;
  value: ReactNode;
}

interface Props {
  items: InfoItem[];
  columns?: 2 | 3 | 4;
}

const COL_CLASS: Record<NonNullable<Props['columns']>, string> = {
  2: 'grid-cols-1 sm:grid-cols-2',
  3: 'grid-cols-1 sm:grid-cols-3',
  4: 'grid-cols-1 sm:grid-cols-2 lg:grid-cols-4',
};

export function InfoGrid({ items, columns = 3 }: Props): JSX.Element {
  return (
    <div
      className={`grid ${COL_CLASS[columns]} gap-px bg-[var(--border-subtle)] rounded-[var(--radius-lg)] overflow-hidden`}
      style={{ boxShadow: 'var(--shadow-sm)' }}
    >
      {items.map((it, i) => (
        <div key={i} className="bg-white px-5 py-4">
          <div className="text-xs font-medium text-[var(--text-tertiary)] mb-1.5">{it.label}</div>
          <div className="text-[13.5px] font-medium text-[var(--text-primary)] font-mono break-all">{it.value}</div>
        </div>
      ))}
    </div>
  );
}
