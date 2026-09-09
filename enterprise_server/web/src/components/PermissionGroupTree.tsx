import type { JSX } from 'react';
import { useMemo } from 'react';

import { t } from '../i18n';
import {
  moduleLabelKey,
  PERMISSION_MODULES,
  PERMISSION_POINTS,
  type PermissionPoint,
  pointLabelKey,
} from '../shared/permissions';

interface Props {
  /** The selected points — the source of truth. The tree holds no state. */
  value: PermissionPoint[];
  onChange: (v: PermissionPoint[]) => void;
}

/**
 * Grouped fine-grained permission picker. Renders one section per
 * `PERMISSION_MODULES` entry (fixed order) with a per-module header checkbox
 * (checked when ALL of the module's points are selected, indeterminate when
 * SOME are) and one checkbox per action point, plus top-level
 * select-all / clear controls. Fully controlled: the selection is derived
 * from `value` on every render.
 */
export function PermissionGroupTree({ value, onChange }: Props): JSX.Element {
  const selected = useMemo(() => new Set<PermissionPoint>(value), [value]);

  const togglePoint = (p: PermissionPoint): void => {
    if (selected.has(p)) onChange(value.filter((x) => x !== p));
    else onChange([...value, p]);
  };

  const toggleModule = (points: PermissionPoint[]): void => {
    if (points.every((p) => selected.has(p))) {
      onChange(value.filter((p) => !points.includes(p)));
    } else {
      const next = new Set<PermissionPoint>(value);
      for (const p of points) next.add(p);
      onChange([...next]);
    }
  };

  return (
    <div>
      <div className="flex items-center justify-between mb-3">
        <span className="text-sm text-[var(--text-secondary)]">{t('roles.page.pointsHint')}</span>
        <div className="flex items-center gap-3">
          <button
            type="button"
            onClick={() => onChange([...PERMISSION_POINTS])}
            className="text-xs text-[var(--accent-primary)] hover:underline"
          >
            {t('roles.page.selectAll')}
          </button>
          <button
            type="button"
            onClick={() => onChange([])}
            className="text-xs text-[var(--text-secondary)] hover:underline"
          >
            {t('roles.page.clearAll')}
          </button>
        </div>
      </div>
      <div className="space-y-3">
        {PERMISSION_MODULES.map((m) => {
          const selCount = m.points.filter((p) => selected.has(p)).length;
          const all = m.points.length > 0 && selCount === m.points.length;
          const some = selCount > 0 && !all;
          return (
            <section key={m.key} className="rounded-lg border border-[var(--border-subtle)] overflow-hidden">
              <header className="flex items-center gap-2.5 px-3 py-2 bg-[var(--bg-tertiary)]/60">
                <input
                  type="checkbox"
                  aria-label={t(moduleLabelKey(m.key))}
                  checked={all}
                  onChange={() => toggleModule(m.points)}
                  ref={(el) => {
                    if (el) el.indeterminate = some;
                  }}
                  className="h-4 w-4 rounded border-[var(--border-default)] text-[var(--accent-primary)]"
                />
                <span className="text-sm font-semibold text-[var(--text-primary)]">
                  {t(moduleLabelKey(m.key))}
                </span>
                <span className="ml-auto text-xs text-[var(--text-secondary)]">
                  {selCount}/{m.points.length}
                </span>
              </header>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-4 gap-y-1.5 px-3 py-2">
                {m.points.map((p) => (
                  <label
                    key={p}
                    className="flex items-center gap-2 text-sm text-[var(--text-primary)] cursor-pointer select-none"
                  >
                    <input
                      type="checkbox"
                      checked={selected.has(p)}
                      onChange={() => togglePoint(p)}
                      className="h-4 w-4 rounded border-[var(--border-default)] text-[var(--accent-primary)]"
                    />
                    {t(pointLabelKey(p))}
                  </label>
                ))}
              </div>
            </section>
          );
        })}
      </div>
    </div>
  );
}
