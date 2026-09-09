import type { JSX } from 'react';

import { t } from '../../i18n';
import { autoIcon } from '../../lib/autoIcon';

export interface ConnectorCategory {
  id: string;
  name: string;
}

interface Props {
  categories: ConnectorCategory[];
  counts: Record<string, number>;
  total: number;
  current: string; // 'all' or a category id
  onSelect: (id: string) => void;
  onAdd: () => void;
  search: string;
  onSearch: (q: string) => void;
}

/**
 * Left rail of the org-connectors view (mirrors `CategorySidebar`'s layout,
 * minus the per-row delete affordance). The search box filters the category
 * list locally by name only; the `全部` row is always shown with the total.
 */
export function ConnectorCategoryPanel(p: Props): JSX.Element {
  const q = p.search.trim().toLowerCase();
  const visible = p.categories.filter((c) => !q || c.name.toLowerCase().includes(q));
  const rows = [
    { id: 'all', name: t('mcp.all'), icon: '▦', count: p.total },
    ...visible.map((c) => ({ id: c.id, name: c.name, icon: autoIcon(c.name), count: p.counts[c.id] ?? 0 })),
  ];

  return (
    <aside className="w-[280px] shrink-0 border-r border-[var(--border-default)] p-3">
      <h2 className="mb-3 text-[15px] font-semibold">{t('mcp.tabs.org')}</h2>
      <input
        value={p.search}
        onChange={(e) => p.onSearch(e.target.value)}
        placeholder={t('mcp.categorySearch')}
        aria-label={t('mcp.categorySearch')}
        className="mb-3 w-full rounded-[6px] border border-[var(--border-default)] bg-[var(--bg-tertiary)] px-3 py-2 text-[12px] outline-none focus:border-[var(--accent-primary)]"
      />
      <div className="mb-1 px-2 text-[11px] font-medium text-[var(--text-secondary)]">{t('mcp.categories')}</div>
      <div className="flex flex-col gap-[2px]">
        {rows.map((row) => {
          const active = p.current === row.id;
          return (
            <button
              key={row.id}
              type="button"
              onClick={() => p.onSelect(row.id)}
              className={`flex items-center gap-2 rounded-[6px] px-2 py-1.5 text-left text-[13px] ${active
                ? 'bg-[var(--accent-primary)]/10 font-medium text-[var(--accent-primary)]'
                : 'text-[var(--text-secondary)] hover:bg-[var(--bg-tertiary)]'}`}
            >
              <span aria-hidden>{row.icon}</span>
              <span className="flex-1 truncate">{row.name}</span>
              <span className="rounded-[8px] bg-[var(--bg-tertiary)] px-1.5 text-[10px] text-[var(--text-secondary)]">{row.count}</span>
            </button>
          );
        })}
      </div>
      <button type="button" onClick={p.onAdd}
        className="mt-3 w-full rounded-[6px] border border-dashed border-[var(--border-default)] px-2 py-1.5 text-[12px] text-[var(--text-secondary)] hover:border-[var(--accent-primary)] hover:text-[var(--accent-primary)]">
        {t('mcp.addCategory')}
      </button>
    </aside>
  );
}
