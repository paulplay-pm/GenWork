import type { JSX, ReactNode } from 'react';

export interface StatItem {
  label: string;
  value: ReactNode;
  trend?: { direction: 'up' | 'down' | 'flat'; text: string };
}

interface Props {
  stats: StatItem[];
}

const TREND_CLASS: Record<NonNullable<StatItem['trend']>['direction'], string> = {
  up: 'text-[var(--success-primary)]',
  down: 'text-[var(--danger-primary)]',
  flat: 'text-[var(--text-tertiary)]',
};

export function StatsRow({ stats }: Props): JSX.Element {
  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3 mb-7">
      {stats.map((s, i) => (
        <div
          key={i}
          className="bg-white border border-[var(--border-subtle)] rounded-[var(--radius-lg)] px-4 py-4"
          style={{ boxShadow: 'var(--shadow-sm)' }}
        >
          <div className="text-xs font-medium text-[var(--text-tertiary)] mb-2">{s.label}</div>
          <div className="text-2xl font-bold tracking-tight text-[var(--text-primary)] leading-tight mb-1.5">
            {s.value}
          </div>
          {s.trend && (
            <div
              data-trend={s.trend.direction}
              className={`text-xs flex items-center gap-1 ${TREND_CLASS[s.trend.direction]}`}
            >
              {s.trend.text}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}
