import { Check } from 'lucide-react';
import type { JSX } from 'react';

import type { AgentMarketplaceItem } from '../../../api/agentMarketplace';
import { tileClass } from '../agentTile';
import { t } from '../types';

interface Props { agents: AgentMarketplaceItem[]; currentId: string | null; selected: string[]; onToggle: (id: string) => void; }

export function SubagentPicker({ agents, currentId, selected, onToggle }: Props): JSX.Element {
  const opts = agents.filter(a => a.agentId !== currentId);
  return (
    <div>
      <div className="mb-0.5 text-sm font-semibold">{t('agentmgmt.subs.title')}</div>
      <div className="mb-3 text-xs text-[var(--text-secondary)]">{t('agentmgmt.subs.hint')}</div>
      {opts.map(a => {
        const on = selected.includes(a.agentId);
        const cycle = !!currentId && a.subagentAllowAgentIds.includes(currentId);
        return (
          <button key={a.agentId} type="button" disabled={cycle} onClick={() => onToggle(a.agentId)}
                  className={`mb-2 flex w-full items-center gap-3 rounded-xl border px-3 py-2.5 text-left ${on ? 'border-[var(--accent-primary)] bg-[var(--accent-primary)]/5' : 'border-[var(--border-subtle)]'} ${cycle ? 'opacity-50 cursor-not-allowed' : 'hover:bg-[var(--bg-tertiary)]'}`}>
            <span className={`flex h-9 w-9 items-center justify-center rounded-lg text-sm font-bold ${tileClass(a.iconColor)}`}>{a.name.charAt(0)}</span>
            <span className="flex-1 min-w-0">
              <span className="block text-[13.5px] font-medium">{a.name}</span>
              <span className="block text-[11px] text-[var(--text-tertiary)]">{a.agentId}</span>
            </span>
            {cycle ? <span className="text-[11px] text-[var(--warning-primary)]">{t('agentmgmt.subs.cycle')}</span> : null}
            <span className={`flex h-[19px] w-[19px] items-center justify-center rounded-md ${on ? 'bg-[var(--accent-primary)] text-white' : 'border border-[var(--border-default)]'}`}>{on ? <Check size={12} /> : null}</span>
          </button>
        );
      })}
    </div>
  );
}
