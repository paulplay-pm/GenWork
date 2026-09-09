import { Check, Search } from 'lucide-react';
import { useState } from 'react';

import { t } from '../types';

interface Props {
  skills: Array<{ id: string; name: string; name_zh: string | null }>;
  selected: string[];
  onToggle: (id: string) => void;
}

export function SkillPicker({ skills, selected, onToggle }: Props) {
  const [q, setQ] = useState('');
  const list = skills.filter(s => !q || (s.name + (s.name_zh ?? '')).toLowerCase().includes(q.toLowerCase()));
  return (
    <div>
      <div className="mb-2 rounded-lg bg-[var(--accent-primary)]/5 px-3 py-2 text-xs text-[var(--text-secondary)]">{t('agentmgmt.skills.hint')}</div>
      <div className="relative mb-2">
        <Search size={14} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-[var(--text-tertiary)]" />
        <input
          aria-label={t('agentmgmt.skills.search')}
          className="h-9 w-full rounded-lg border border-[var(--border-default)] pl-8 pr-3 text-sm"
          placeholder={t('agentmgmt.skills.search')}
          value={q}
          onChange={e => setQ(e.target.value)}
        />
      </div>
      {list.length === 0 ? (
        <div className="py-4 text-center text-sm text-[var(--text-tertiary)]">{t('agentmgmt.skills.empty')}</div>
      ) : (
        list.map(s => {
          const on = selected.includes(s.id);
          return (
            <button
              key={s.id}
              type="button"
              onClick={() => onToggle(s.id)}
              className={`mb-2 flex w-full items-center gap-3 rounded-xl border px-3 py-2.5 text-left ${
                on ? 'border-[var(--accent-primary)] bg-[var(--accent-primary)]/5' : 'border-[var(--border-subtle)] hover:bg-[var(--bg-tertiary)]'
              }`}
            >
              <span className="min-w-0 flex-1">
                <span className="block text-[13.5px] font-medium">{s.name_zh ?? s.name}</span>
                {s.name_zh && s.name_zh !== s.name ? (
                  <span className="block text-[11.5px] text-[var(--text-tertiary)]">{s.name}</span>
                ) : null}
              </span>
              <span className={`flex h-[19px] w-[19px] items-center justify-center rounded-md ${
                on ? 'bg-[var(--accent-primary)] text-white' : 'border border-[var(--border-default)]'
              }`}>
                {on ? <Check size={12} /> : null}
              </span>
            </button>
          );
        })
      )}
    </div>
  );
}
