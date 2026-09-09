import { X } from 'lucide-react';
import type { JSX } from 'react';

import { t } from '../types';

interface RolesPickerProps {
  options: string[];
  selected: string[];
  onChange: (v: string[]) => void;
  error?: string;
}

export function RolesPicker({ options, selected, onChange, error }: RolesPickerProps): JSX.Element {
  const addable = options.filter(o => !selected.includes(o));
  return (
    <div>
      <div className="mb-0.5 text-sm font-semibold">{t('agentmgmt.tab.roles')}</div>
      <div className="mb-3 text-xs text-[var(--text-secondary)]">{t('agentmgmt.roles.hint')}</div>
      <div className="flex flex-wrap items-center gap-1.5">
        {selected.map((r, i) => (
          <button
            key={r}
            type="button"
            onClick={() => onChange(selected.filter((_, j) => j !== i))}
            aria-label={r}
            className="flex items-center gap-1 rounded-full bg-[var(--accent-primary)]/10 px-2.5 py-1 text-xs text-[var(--accent-primary)]"
          >
            {r}<X size={11} />
          </button>
        ))}
        {selected.length === 0 && <span className="text-xs text-[var(--text-tertiary)]">{t('agentmgmt.roles.add')}</span>}
      </div>
      {addable.length > 0 && (
        <div className="mt-2 flex flex-wrap gap-1.5">
          {addable.map(r => (
            <button
              key={r}
              type="button"
              onClick={() => onChange([...selected, r])}
              className="rounded-lg border border-[var(--border-default)] px-2.5 py-1 text-xs hover:border-[var(--accent-primary)] hover:text-[var(--accent-primary)]"
            >
              + {r}
            </button>
          ))}
        </div>
      )}
      {error && <div className="mt-2 text-[11.5px] text-[var(--danger-primary)]">{error}</div>}
    </div>
  );
}
