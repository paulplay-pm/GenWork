import type { JSX } from 'react';
import { useState } from 'react';

import type { KitCategory } from '../../api/kitCatalog';
import { t } from '../../i18n';
import { autoIcon } from '../../lib/autoIcon';
import { UNCATEGORIZED } from './types';

interface Props {
  categories: KitCategory[];
  counts: Record<string, number>;
  total: number;
  current: string;
  onSelect: (id: string) => void;
  onAdd: () => void;
  onDelete: (id: string, name: string) => void;
  search: string;
  onSearch: (q: string) => void;
}

export function CategorySidebar(p: Props): JSX.Element {
  const [hovered, setHovered] = useState<string | null>(null);
  const rows = [
    { id: 'all', name: t('kitmgmt.all'), icon: '▦', count: p.total },
    ...p.categories.map((c) => ({ id: c.id, name: c.name_zh || c.name_en, icon: autoIcon(c.name_zh || c.name_en), count: p.counts[c.id] ?? 0 })),
  ];
  return (
    <aside className="w-[280px] shrink-0 border-r border-[var(--border-default)] p-3">
      <h2 className="mb-3 text-[15px] font-semibold">{t('kitmgmt.title')}</h2>
      <input
        value={p.search}
        onChange={(e) => p.onSearch(e.target.value)}
        placeholder={t('kitmgmt.search')}
        className="mb-3 w-full rounded-[6px] border border-[var(--border-default)] bg-[var(--bg-tertiary)] px-3 py-2 text-[12px] outline-none focus:border-[var(--accent-primary)]"
      />
      <div className="mb-1 px-2 text-[11px] font-medium text-[var(--text-secondary)]">{t('kitmgmt.categories')}</div>
      <div className="flex flex-col gap-[2px]">
        {rows.map((row) => {
          const active = p.current === row.id;
          const showDel = row.id !== UNCATEGORIZED && hovered === row.id;
          return (
            <button
              key={row.id}
              type="button"
              onMouseEnter={() => setHovered(row.id)}
              onMouseLeave={() => setHovered((h) => (h === row.id ? null : h))}
              onClick={() => p.onSelect(row.id)}
              className={`flex items-center gap-2 rounded-[6px] px-2 py-1.5 text-left text-[13px] ${active
                ? 'bg-[var(--accent-primary)]/10 font-medium text-[var(--accent-primary)]'
                : 'text-[var(--text-secondary)] hover:bg-[var(--bg-tertiary)]'}`}
            >
              <span aria-hidden>{row.icon}</span>
              <span className="flex-1 truncate">{row.name}</span>
              <span className="rounded-[8px] bg-[var(--bg-tertiary)] px-1.5 text-[10px] text-[var(--text-secondary)]">{row.count}</span>
              {showDel && (
                <span
                  role="button"
                  aria-label={t('common.delete')}
                  onClick={(e) => { e.stopPropagation(); p.onDelete(row.id, row.name); }}
                  className="text-[var(--text-secondary)] hover:text-[var(--danger-primary)]"
                >
                  ✕
                </span>
              )}
            </button>
          );
        })}
      </div>
      <button type="button" onClick={p.onAdd}
        className="mt-3 w-full rounded-[6px] border border-dashed border-[var(--border-default)] px-2 py-1.5 text-[12px] text-[var(--text-secondary)] hover:border-[var(--accent-primary)] hover:text-[var(--accent-primary)]">
        {t('kitmgmt.addCategory')}
      </button>
    </aside>
  );
}
