import type { JSX } from 'react';

export function PageHeader({ title, actions, subtitle }: Props): JSX.Element {
  return (
    <div className="flex items-start justify-between mb-6">
      <div>
        <h1 className="text-xl font-semibold tracking-tight text-[var(--text-primary)]">
          {title}
        </h1>
        {subtitle && <p className="text-sm text-[var(--text-secondary)] mt-1">{subtitle}</p>}
      </div>
      {actions && <div className="flex items-center gap-2">{actions}</div>}
    </div>
  );
}

interface Props {
  title: string;
  actions?: React.ReactNode;
  subtitle?: string;
}
