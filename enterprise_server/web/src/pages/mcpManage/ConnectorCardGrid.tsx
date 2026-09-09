import type { JSX, MouseEvent } from 'react';

import type { Connector } from '../../api/connectors';
import { t } from '../../i18n';
import { fill } from './types';
import { ConnectorCard } from './ConnectorCard';

export type ConnectorTypeFilter = 'all' | 'mcp' | 'app';

interface Props {
  connectors: Connector[];
  typeFilter: ConnectorTypeFilter;
  onTypeFilter: (f: ConnectorTypeFilter) => void;
  categoryName: string;
  count: number;
  onOpen: (id: string) => void;
  onToggle: (id: string, enabled: boolean) => void;
  onMenuOpen: (e: MouseEvent, id: string) => void;
}

const FILTERS: { value: ConnectorTypeFilter; key: string }[] = [
  { value: 'all', key: 'mcp.typeFilter.all' },
  { value: 'mcp', key: 'mcp.typeFilter.mcp' },
  { value: 'app', key: 'mcp.typeFilter.app' },
];

/**
 * Right pane of the org-connectors view: type-filter chips (filtered
 * client-side), the 2-col card grid, and the empty state. No usage metrics
 * anywhere — the locked design dropped 30-day calls / error rate.
 */
export function ConnectorCardGrid(p: Props): JSX.Element {
  const visible = p.connectors.filter((c) => p.typeFilter === 'all' || c.connectorType === p.typeFilter);

  return (
    <div className="flex-1 overflow-y-auto p-6">
      <div className="mb-4">
        <div className="min-w-0">
          <div className="text-[12px] text-[var(--text-secondary)]">
            {t('mcp.breadcrumb')} <span className="opacity-50">/</span> <span className="text-[var(--text-primary)]">{p.categoryName}</span>
          </div>
          <h2 className="truncate text-[20px] font-semibold">{p.categoryName}</h2>
          <div className="mt-2 flex flex-wrap items-center gap-3">
            <span className="text-[12.5px] text-[var(--text-tertiary)]">{fill(t('mcp.connectorCount'), { n: p.count })}</span>
            <div className="flex items-center gap-1.5">
              {FILTERS.map((f) => {
                const on = p.typeFilter === f.value;
                return (
                  <button
                    key={f.value}
                    type="button"
                    onClick={() => p.onTypeFilter(f.value)}
                    className={`rounded-full border px-2.5 py-1 text-[12px] transition ${on
                      ? 'border-[var(--text-primary)] bg-[var(--text-primary)] font-medium text-white'
                      : 'border-[var(--border-default)] bg-[var(--bg-secondary)] text-[var(--text-secondary)] hover:border-[var(--text-secondary)]'}`}
                  >
                    {t(f.key)}
                  </button>
                );
              })}
            </div>
          </div>
        </div>
      </div>

      {visible.length === 0 ? (
        <div className="py-10 text-center text-[13.5px] text-[var(--text-tertiary)]">{t('mcp.connEmpty')}</div>
      ) : (
        <div className="grid grid-cols-1 gap-4 min-[1201px]:grid-cols-2">
          {visible.map((c) => (
            <ConnectorCard key={c.id} c={c} onOpen={p.onOpen} onToggle={p.onToggle} onMenu={p.onMenuOpen} />
          ))}
        </div>
      )}
    </div>
  );
}
