import { Inbox } from 'lucide-react';
import type { JSX, ReactNode } from 'react';

interface Props {
  title: string;
  description?: string;
  action?: ReactNode;
  icon?: ReactNode;
}

/**
 * Friendly empty-state placeholder. Use when a list/section has zero rows.
 * The default icon is the lucide `Inbox`.
 */
export function EmptyState({
  title,
  description,
  action,
  icon,
}: Props): JSX.Element {
  return (
    <div className="flex flex-col items-center justify-center text-center rounded-xl border border-dashed border-[var(--border-default)] bg-[var(--bg-secondary)] px-6 py-12">
      <div className="text-[var(--text-tertiary)]">{icon ?? <Inbox className="h-10 w-10" />}</div>
      <p className="mt-4 text-base font-semibold text-[var(--text-primary)]">{title}</p>
      {description && (
        <p className="mt-1 max-w-sm text-sm text-[var(--text-secondary)]">{description}</p>
      )}
      {action && <div className="mt-6">{action}</div>}
    </div>
  );
}
