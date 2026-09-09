import type { JSX } from 'react';

interface Props {
  checked: boolean;
  onChange: (checked: boolean) => void;
  disabled?: boolean;
  /** Accessible label announced by screen readers (also used as `title`). */
  label: string;
  className?: string;
}

/**
 * Accessible slide toggle (`role="switch"`). The "on" track uses the accent
 * color; the "off" track is a neutral border color. This is a control only —
 * callers render their own visible label / hint next to it (mirrors the
 * prototype's `switch-row` layout). Space and Enter toggle when focused.
 */
export function Switch({
  checked,
  onChange,
  disabled = false,
  label,
  className = '',
}: Props): JSX.Element {
  function toggle(): void {
    if (!disabled) onChange(!checked);
  }
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      title={label}
      disabled={disabled}
      onClick={toggle}
      onKeyDown={(e) => {
        if (e.key === ' ' || e.key === 'Enter') {
          e.preventDefault();
          toggle();
        }
      }}
      className={`relative inline-flex h-[22px] w-10 shrink-0 cursor-pointer items-center rounded-full transition-colors focus:outline-none focus:ring-2 focus:ring-[var(--accent-primary)]/30 disabled:cursor-not-allowed disabled:opacity-50 ${
        checked ? 'bg-[var(--accent-primary)]' : 'bg-[var(--border-default)]'
      } ${className}`}
    >
      <span
        className={`inline-block h-[18px] w-[18px] transform rounded-full bg-white shadow-sm transition-transform ${
          checked ? 'translate-x-[20px]' : 'translate-x-[2px]'
        }`}
      />
    </button>
  );
}
