import dayjs from 'dayjs';
import type { JSX } from 'react';

import { type KitAdmin } from '../../api/kitCatalog';
import { Switch } from '../../components/Switch';
import { t } from '../../i18n';
import { autoIcon } from '../../lib/autoIcon';
import { fill } from './types';

interface Props {
  kits: KitAdmin[];
  categoryName: string;
  current: string;
  onAdd: () => void;
  onEdit: (k: KitAdmin) => void;
  onToggle: (id: string, enabled: boolean) => void;
  /** Page-level delete flow (confirm + deleteKit + invalidate + toasts);
   * shared with the edit drawer's footer delete. */
  onDelete: (k: KitAdmin) => void;
}

function formatBytes(n: number | null): string {
  if (n === null) return '—';
  if (n < 1024) return `${n} B`;
  if (n < 1048576) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1048576).toFixed(1)} MB`;
}

/** Kit card-grid mirrors the skill card grid (icon / name / version / scope /
 * enable switch / actions). Kits add: tryAsking snippets badge, skill count
 * (= skillList.length), and an `官方`-style tag for built-in kits. */
export function KitTable({ kits, categoryName, current, onAdd, onEdit, onToggle, onDelete }: Props): JSX.Element {
  return (
    <div className="flex-1 overflow-y-auto p-6">
      <div className="mb-4">
        <div className="min-w-0">
          <div className="text-[12px] text-[var(--text-secondary)]">
            {t('kitmgmt.breadcrumb')} <span className="opacity-50">/</span> <span className="text-[var(--text-primary)]">{categoryName}</span>
          </div>
          <h2 className="truncate text-[20px] font-semibold">{categoryName}</h2>
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <span className="text-[12.5px] text-[var(--text-tertiary)]">
              {t('kitmgmt.table.visibility')} <span className="opacity-50">·</span> {fill(t('kitmgmt.table.count'), { n: kits.length })}
            </span>
          </div>
        </div>
      </div>

      {kits.length === 0 ? (
        <div className="py-10 text-center">
          <div className="text-[13.5px] text-[var(--text-tertiary)]">{t('kitmgmt.table.empty')}</div>
          <button
            type="button"
            onClick={onAdd}
            className="mt-3 rounded-[6px] bg-[var(--accent-primary)] px-3.5 py-2 text-[13px] text-white hover:bg-[var(--accent-primary-hover)]"
          >
            {t('kitmgmt.addKit')}
          </button>
        </div>
      ) : (
        <div className="overflow-x-auto rounded-[8px] border border-[var(--border-default)]">
          <table className="w-full min-w-[880px] text-left text-[13px]">
            <thead>
              <tr className="border-b border-[var(--border-default)] bg-[var(--bg-tertiary)] text-[12px] text-[var(--text-secondary)]">
                <th className="px-3 py-2.5 font-medium">{t('kitmgmt.table.name')}</th>
                <th className="px-3 py-2.5 font-medium">{t('kitmgmt.table.desc')}</th>
                <th className="px-3 py-2.5 font-medium">{t('kitmgmt.table.zip')}</th>
                <th className="px-3 py-2.5 font-medium">{t('kitmgmt.table.scope')}</th>
                <th className="px-3 py-2.5 font-medium">{t('kitmgmt.table.status')}</th>
                <th className="px-3 py-2.5 font-medium">{t('kitmgmt.table.updatedAt')}</th>
                <th className="px-3 py-2.5 font-medium">{t('kitmgmt.table.actions')}</th>
              </tr>
            </thead>
            <tbody>
              {kits.map((k) => {
                const displayName = k.name_zh || k.name_en || k.id;
                return (
                  <tr key={k.id} className={`border-b border-[var(--border-default)] last:border-b-0 ${k.enabled ? '' : 'opacity-60'}`}>
                    <td className="px-3 py-2.5">
                      <div className="flex items-center gap-2">
                        {k.icon
                          ? <img src={k.icon} alt="" aria-hidden className="h-7 w-7 shrink-0 rounded-[6px] object-cover" />
                          : <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-[6px] bg-[var(--accent-primary)]/10 text-[14px]" aria-hidden>{autoIcon(displayName)}</span>}
                        <div className="min-w-0">
                          <div className="flex items-center gap-1.5">
                            <span className="truncate font-medium text-[var(--text-primary)]">{displayName}</span>
                            {k.isBuiltin ? (
                              <span className="shrink-0 rounded-[4px] bg-[var(--accent-primary)]/10 px-1.5 py-0.5 text-[10.5px] text-[var(--accent-primary)]">
                                {t('kitmgmt.official')}
                              </span>
                            ) : null}
                          </div>
                          <div className="truncate font-mono text-[11px] text-[var(--text-tertiary)]">{k.id}</div>
                        </div>
                      </div>
                    </td>
                    <td className="max-w-[240px] px-3 py-2.5 align-top">
                      <div className="flex items-start gap-2">
                        <span className="line-clamp-2 text-[12.5px] leading-snug text-[var(--text-secondary)]">
                          {k.description_zh || k.description_en || ''}
                        </span>
                        <span
                          className="mt-px shrink-0 rounded-[4px] bg-[var(--accent-primary)]/10 px-1.5 py-0.5 text-[11px] text-[var(--accent-primary)]"
                          title={t('kitmgmt.table.skillCount')}
                        >
                          🧩 {k.skillList.length}
                        </span>
                      </div>
                    </td>
                    <td className="px-3 py-2.5 align-top">
                      {k.zip.fileName ? (
                        <div className="flex items-center gap-2">
                          <div className="min-w-0">
                            <div className="max-w-[140px] truncate text-[12.5px]">{k.zip.fileName}</div>
                            <div className="text-[11px] text-[var(--text-tertiary)]">{formatBytes(k.zip.fileSize)}</div>
                          </div>
                        </div>
                      ) : (
                        <span className="text-[12.5px] text-[var(--text-tertiary)]">—</span>
                      )}
                    </td>
                    <td className="px-3 py-2.5 align-top">
                      <span className="rounded-[4px] bg-[var(--bg-tertiary)] px-1.5 py-0.5 text-[11px] text-[var(--text-secondary)]">{k.scopeSummary}</span>
                    </td>
                    <td className="px-3 py-2.5 align-middle">
                      <Switch
                        checked={k.enabled}
                        onChange={(next) => onToggle(k.id, next)}
                        label={displayName}
                      />
                    </td>
                    <td className="whitespace-nowrap px-3 py-2.5 align-middle">
                      <div className="text-[12.5px] text-[var(--text-secondary)]">{dayjs(k.updatedAt).format('YYYY-MM-DD HH:mm')}</div>
                      {k.version && <div className="text-[11px] text-[var(--text-tertiary)]">v{k.version}</div>}
                    </td>
                    <td className="whitespace-nowrap px-3 py-2.5 align-middle">
                      <div className="flex items-center gap-3">
                        <button type="button" onClick={() => onEdit(k)} className="text-[12.5px] text-[var(--accent-primary)] hover:underline">
                          {t('kitmgmt.table.edit')}
                        </button>
                        <button type="button" onClick={() => onDelete(k)} className="text-[12.5px] text-[var(--danger-primary)] hover:underline">
                          {t('common.delete')}
                        </button>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
