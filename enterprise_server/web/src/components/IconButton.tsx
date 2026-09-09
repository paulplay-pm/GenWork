import type { ButtonHTMLAttributes, JSX, ReactNode } from 'react';

interface Props extends ButtonHTMLAttributes<HTMLButtonElement> {
  label: string;
  variant?: 'default' | 'danger';
  children: ReactNode;
}

const VARIANT_CLASS: Record<NonNullable<Props['variant']>, string> = {
  default: 'hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]',
  danger: 'hover:bg-[var(--danger-light)] hover:text-[var(--danger-primary)]',
};

export function IconButton({
  label,
  variant = 'default',
  className,
  children,
  ...rest
}: Props): JSX.Element {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      className={`w-7 h-7 rounded-[var(--radius-sm)] flex items-center justify-center text-[var(--text-tertiary)] transition-colors border-0 bg-transparent ${VARIANT_CLASS[variant]}${className ? ' ' + className : ''}`}
      {...rest}
    >
      {children}
    </button>
  );
}
