import dayjs from 'dayjs';
import type { JSX } from 'react';

import { type SkillAdmin } from '../../api/skillMarketplace';
import { useAuthStore } from '../../auth/store';
import { Switch } from '../../components/Switch';
import { useToast } from '../../components/toastStore';
import { t } from '../../i18n';
import { autoIcon } from '../../lib/autoIcon';
import { fill } from './types';

interface Props {
  skills: SkillAdmin[];
  categoryName: string;
  current: string;
  onAdd: () => void;
  onEdit: (s: SkillAdmin) => void;
  onToggle: (id: string, enabled: boolean) => void;
  /** Page-level delete flow (confirm + deleteSkill + invalidate + toasts);
   * shared with the edit drawer's footer delete. */
  onDelete: (s: SkillAdmin) => void;
}

/** Human-readable size for the Zip column: `—` / `B` / `KB` / `MB`. */
function formatBytes(n: number | null): string {
  if (n === null) return '—';
  if (n < 1024) return `${n} B`;
  if (n < 1048576) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1048576).toFixed(1)} MB`;
}

/**
 * Org-skills table (replaces the removed SkillCardGrid): tool row
 * (breadcrumb + visibility/count line) and the 7 columns 技能名称 /
 * 描述 / Zip / 授权范围 / 状态 / 更新时间 / 操作. The 👥 badge under
 * 描述 is the 30-day USAGE count (useCount30d), not a role count. `current`
 * is reserved by the interface. The Zip column's ↓ triggers an AUTHENTICATED
 * download: the SPA is header-only (no cookies), so a bare `<a href>` would
 * 401 and save the JSON error body as the file — instead we fetch the blob
 * with the bearer token and trigger the download from a `URL.createObjectURL`.
 */
export function SkillTable({ skills, categoryName, onAdd, onEdit, onToggle, onDelete }: Props): JSX.Element {
  const toast = useToast();

  const downloadZip = (s: SkillAdmin): void => {
    const token = useAuthStore.getState().token;
    fetch(`${window.location.origin}/api/skill-marketplace/download/${s.id}`, {
      headers: token ? { authorization: `Bearer ${token}` } : {},
    })
      .then((res) => {
        if (!res.ok) throw new Error(`http ${res.status}`);
        return res.blob();
      })
      .then((blob) => {
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `${s.id}.zip`;
        document.body.appendChild(a);
        a.click();
        a.remove();
        URL.revokeObjectURL(url);
      })
      .catch(() => {
        toast.error(t('skillmgmt.toast.downloadFailed'));
      });
  };

  return (
    <div className="flex-1 overflow-y-auto p-6">
      <div className="mb-4">
        <div className="min-w-0">
          <div className="text-[12px] text-[var(--text-secondary)]">
            {t('skillmgmt.breadcrumb')} <span className="opacity-50">/</span> <span className="text-[var(--text-primary)]">{categoryName}</span>
          </div>
          <h2 className="truncate text-[20px] font-semibold">{categoryName}</h2>
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <span className="text-[12.5px] text-[var(--text-tertiary)]">
              {t('skillmgmt.table.visibility')} <span className="opacity-50">·</span> {fill(t('skillmgmt.table.count'), { n: skills.length })}
            </span>
          </div>
        </div>
      </div>

      {skills.length === 0 ? (
        <div className="py-10 text-center">
          <div className="text-[13.5px] text-[var(--text-tertiary)]">{t('skillmgmt.table.empty')}</div>
          <button
            type="button"
            onClick={onAdd}
            className="mt-3 rounded-[6px] bg-[var(--accent-primary)] px-3.5 py-2 text-[13px] text-white hover:bg-[var(--accent-primary-hover)]"
          >
            {t('skillmgmt.addSkill')}
          </button>
        </div>
      ) : (
        <div className="overflow-x-auto rounded-[8px] border border-[var(--border-default)]">
          <table className="w-full min-w-[880px] text-left text-[13px]">
            <thead>
              <tr className="border-b border-[var(--border-default)] bg-[var(--bg-tertiary)] text-[12px] text-[var(--text-secondary)]">
                <th className="px-3 py-2.5 font-medium">{t('skillmgmt.table.name')}</th>
                <th className="px-3 py-2.5 font-medium">{t('skillmgmt.table.desc')}</th>
                <th className="px-3 py-2.5 font-medium">{t('skillmgmt.table.zip')}</th>
                <th className="px-3 py-2.5 font-medium">{t('skillmgmt.table.scope')}</th>
                <th className="px-3 py-2.5 font-medium">{t('skillmgmt.table.status')}</th>
                <th className="px-3 py-2.5 font-medium">{t('skillmgmt.table.updatedAt')}</th>
                <th className="px-3 py-2.5 font-medium">{t('skillmgmt.table.actions')}</th>
              </tr>
            </thead>
            <tbody>
              {skills.map((s) => (
                <tr key={s.id} className={`border-b border-[var(--border-default)] last:border-b-0 ${s.enabled ? '' : 'opacity-60'}`}>
                  <td className="px-3 py-2.5">
                    <div className="flex items-center gap-2">
                      {s.icon
                        ? <img src={s.icon} alt="" aria-hidden className="h-7 w-7 shrink-0 rounded-[6px] object-cover" />
                        : <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-[6px] bg-[var(--accent-primary)]/10 text-[14px]" aria-hidden>{autoIcon(s.name_zh || s.name)}</span>}
                      <div className="min-w-0">
                        <div className="truncate font-medium text-[var(--text-primary)]">{s.name_zh || s.name}</div>
                        <div className="truncate font-mono text-[11px] text-[var(--text-tertiary)]">{s.name}</div>
                      </div>
                    </div>
                  </td>
                  <td className="max-w-[240px] px-3 py-2.5 align-top">
                    <div className="flex items-start gap-2">
                      <span className="line-clamp-2 text-[12.5px] leading-snug text-[var(--text-secondary)]">{s.description}</span>
                      <span className="mt-px shrink-0 rounded-[4px] bg-[var(--accent-primary)]/10 px-1.5 py-0.5 text-[11px] text-[var(--accent-primary)]" title={t('skillmgmt.table.usage')}>
                        👥 {s.useCount30d}
                      </span>
                    </div>
                  </td>
                  <td className="px-3 py-2.5 align-top">
                    {s.zip.fileName ? (
                      <div className="flex items-center gap-2">
                        <div className="min-w-0">
                          <div className="max-w-[140px] truncate text-[12.5px]">{s.zip.fileName}</div>
                          <div className="text-[11px] text-[var(--text-tertiary)]">{formatBytes(s.zip.fileSize)}</div>
                        </div>
                        <button
                          type="button"
                          onClick={() => downloadZip(s)}
                          title={t('skillmgmt.table.download')}
                          className="shrink-0 rounded-[4px] border border-[var(--border-default)] px-1.5 py-0.5 text-[11px] text-[var(--accent-primary)] hover:bg-[var(--bg-tertiary)]"
                        >
                          ↓
                        </button>
                      </div>
                    ) : (
                      <span className="text-[12.5px] text-[var(--text-tertiary)]">—</span>
                    )}
                  </td>
                  <td className="px-3 py-2.5 align-top">
                    <span className="rounded-[4px] bg-[var(--bg-tertiary)] px-1.5 py-0.5 text-[11px] text-[var(--text-secondary)]">{s.scopeSummary}</span>
                  </td>
                  <td className="px-3 py-2.5 align-middle">
                    <Switch
                      checked={s.enabled}
                      onChange={(next) => onToggle(s.id, next)}
                      label={s.name_zh || s.name}
                    />
                  </td>
                  <td className="whitespace-nowrap px-3 py-2.5 align-middle">
                    <div className="text-[12.5px] text-[var(--text-secondary)]">{dayjs(s.updatedAt).format('YYYY-MM-DD HH:mm')}</div>
                    {s.version && <div className="text-[11px] text-[var(--text-tertiary)]">v{s.version}</div>}
                  </td>
                  <td className="whitespace-nowrap px-3 py-2.5 align-middle">
                    <div className="flex items-center gap-3">
                      <button type="button" onClick={() => onEdit(s)} className="text-[12.5px] text-[var(--accent-primary)] hover:underline">
                        {t('skillmgmt.table.edit')}
                      </button>
                      <button type="button" onClick={() => onDelete(s)} className="text-[12.5px] text-[var(--danger-primary)] hover:underline">
                        {t('common.delete')}
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
