import type { JSX, ReactNode } from 'react';

interface Props {
  children: ReactNode;
  /** Optional `selected` ring + hover affordance for clickable cards. */
  selected?: boolean;
  onClick?: () => void;
  className?: string;
  /** `header` slot renders above children inside its own bordered border. */
  header?: ReactNode;
  /** `actions` slot rendered to the right of the header. */
  headerActions?: ReactNode;
}

/**
 * White surface with soft shadow + subtle border. Used for every elevated
 * block on the merged providers/models page. If `header` is provided it
 * renders in a bordered top section.
 */
export function Card({
  children,
  selected,
  onClick,
  className,
  header,
  headerActions,
}: Props): JSX.Element {
  const base =
    'rounded-xl bg-[var(--bg-secondary)] border border-[var(--border-subtle)] shadow-sm overflow-hidden';
  const interactive = onClick
    ? `cursor-pointer transition-colors hover:border-[var(--border-default)] ${
        selected
          ? 'ring-2 ring-[var(--accent-primary)]/40 bg-[var(--accent-light)]/30'
          : 'hover:bg-[var(--bg-hover)]/50'
      }`
    : '';
  const finalCls = `${base} ${interactive}${className ? ' ' + className : ''}`;
  return (
    <div className={finalCls} onClick={onClick}>
      {header && (
        <div className="flex items-center justify-between px-5 py-4 border-b border-[var(--border-subtle)]">
          <div className="text-sm font-medium text-[var(--text-primary)]">{header}</div>
          {headerActions && <div className="flex items-center gap-2">{headerActions}</div>}
        </div>
      )}
      <div className="px-5 py-4">{children}</div>
    </div>
  );
}
