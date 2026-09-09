import type { JSX } from 'react';

export interface TabItem {
  key: string;
  label: string;
}

interface Props {
  items: TabItem[];
  value: string;
  onChange: (key: string) => void;
}

export function Tabs({ items, value, onChange }: Props): JSX.Element {
  return (
    <div className="flex gap-1">
      {items.map((it) => {
        const active = it.key === value;
        return (
          <button
            key={it.key}
            onClick={() => !active && onChange(it.key)}
            className={`px-3.5 py-2 text-[13px] rounded-[var(--radius-sm)] transition-colors ${
              active
                ? 'text-[var(--accent-primary)] font-semibold bg-[var(--accent-light)]'
                : 'text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-hover)] font-medium'
            }`}
          >
            {it.label}
          </button>
        );
      })}
    </div>
  );
}
