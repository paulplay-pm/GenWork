import { Trash2 } from 'lucide-react';
import type { JSX } from 'react';
import { useMemo, useState } from 'react';

import type { ProviderKeyView } from '../../api/providers';
import { Switch } from '../../components/Switch';
import { brandColor, providerDisplayName } from '../../data/providerCatalog';
import { t } from '../../i18n';

interface Props {
  /** Single source of truth; the rail groups rows by `is_builtin`. */
  providers: ProviderKeyView[];
  /** Map of provider KEY id → model count, shown as a badge on the row. Keyed
   * by id (not slug) so two same-slug keys (built-in + custom) show distinct
   * counts. */
  modelCounts: Record<string, number>;
  selectedId: string | null;
  onSelect: (id: string) => void;
  canManage: boolean;
  /** Invoked when the "+ 添加服务商" button is clicked (creates a new custom draft). */
  onAddProvider?: () => void;
  /** Delete-confirm flow (custom rows only). */
  onDeleteProvider: (provider: ProviderKeyView) => void;
  /** Toggle a row's enabled state; optional so renders may omit it. */
  onToggleProvider?: (id: string, enabled: boolean) => void;
}

/**
 * Left rail listing every provider in one flat list, grouped into 内置服务商
 * (`is_builtin`) and 自定义服务商 sections. Each row shows the brand square,
 * display name, model-count badge, and an enable switch; custom rows add a
 * delete icon. The search box filters both sections.
 */
export function ProviderRail({
  providers,
  modelCounts,
  selectedId,
  onSelect,
  canManage,
  onAddProvider,
  onDeleteProvider,
  onToggleProvider,
}: Props): JSX.Element {
  const [search, setSearch] = useState('');

  const builtins = useMemo(() => providers.filter((p) => p.is_builtin), [providers]);
  const customs = useMemo(() => providers.filter((p) => !p.is_builtin), [providers]);

  const visibleBuiltins = useMemo(() => filterProviders(builtins, search), [builtins, search]);
  const visibleCustoms = useMemo(() => filterProviders(customs, search), [customs, search]);

  return (
    <div className="flex h-full w-full flex-col gap-3 border-r border-[var(--border-subtle)] bg-[var(--bg-secondary)] p-3">
      <input
        type="search"
        placeholder={t('providersModels.rail.search')}
        value={search}
        onChange={(e) => setSearch(e.target.value)}
        className="w-full rounded-[var(--radius-sm)] border border-[var(--border-default)] bg-[var(--bg-tertiary)] px-2 py-1.5 text-sm focus:outline-none focus:bg-[var(--bg-secondary)] focus:border-[var(--accent-primary)] focus:ring-2 focus:ring-[var(--accent-primary)]/10"
      />

      <Section title={`${t('providersModels.rail.builtin')} (${visibleBuiltins.length})`}>
        {visibleBuiltins.map((p) => (
          <Row
            key={p.id}
            provider={p}
            isCustom={false}
            count={modelCounts[p.id] ?? 0}
            selected={selectedId === p.id}
            canManage={canManage}
            onSelect={() => onSelect(p.id)}
            onToggle={(next) => onToggleProvider?.(p.id, next)}
            onDelete={() => {}}
          />
        ))}
      </Section>

      <Section title={`${t('providersModels.rail.custom')} (${visibleCustoms.length})`}>
        {visibleCustoms.map((p) => (
          <Row
            key={p.id}
            provider={p}
            isCustom
            count={modelCounts[p.id] ?? 0}
            selected={selectedId === p.id}
            canManage={canManage}
            onSelect={() => onSelect(p.id)}
            onToggle={(next) => onToggleProvider?.(p.id, next)}
            onDelete={() => onDeleteProvider(p)}
          />
        ))}
        {canManage && (
          <button
            type="button"
            onClick={onAddProvider}
            className="flex w-full items-center justify-center rounded-[var(--radius-sm)] border border-dashed border-[var(--border-default)] px-2 py-1.5 text-sm text-[var(--text-secondary)] hover:bg-[var(--bg-hover)]"
          >
            + {t('providersModels.rail.addProvider')}
          </button>
        )}
      </Section>
    </div>
  );
}

function filterProviders(list: ProviderKeyView[], search: string): ProviderKeyView[] {
  const s = search.trim().toLowerCase();
  if (!s) return list;
  return list.filter(
    (p) =>
      (p.label ?? providerDisplayName(p.provider)).toLowerCase().includes(s) ||
      p.provider.toLowerCase().includes(s)
  );
}

function Row({
  provider,
  isCustom,
  count,
  selected,
  canManage,
  onSelect,
  onToggle,
  onDelete,
}: {
  provider: ProviderKeyView;
  isCustom: boolean;
  count: number;
  selected: boolean;
  canManage: boolean;
  onSelect: () => void;
  onToggle: (next: boolean) => void;
  onDelete: () => void;
}): JSX.Element {
  // Display name: an explicit label wins; otherwise the provider's display
  // name (slug, except where the slug is an abbreviation, e.g. volc → Volcengine).
  const name = provider.label ?? providerDisplayName(provider.provider);
  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onSelect}
      onKeyDown={(e) => {
        // Only select when the key is pressed on the row itself — Enter/Space
        // on the inner Switch or delete button bubbles up and must not also
        // select the row (it should only toggle / delete).
        if (e.target !== e.currentTarget) return;
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onSelect();
        }
      }}
      className={`group flex w-full cursor-pointer items-center gap-2 rounded-[var(--radius-sm)] px-2 py-1.5 text-left text-sm transition-colors focus:outline-none focus:ring-2 focus:ring-[var(--accent-primary)]/30 ${
        selected
          ? 'bg-[var(--accent-light)] text-[var(--accent-primary)]'
          : 'hover:bg-[var(--bg-hover)]'
      }`}
    >
      <span
        aria-hidden
        className="flex h-5 w-5 shrink-0 items-center justify-center rounded-[4px] text-[10px] font-semibold uppercase text-white"
        style={{ backgroundColor: brandColor(provider.provider) }}
      >
        {name.charAt(0)}
      </span>
      <span className="min-w-0 truncate font-medium">{name}</span>
      <span className="ml-auto inline-flex shrink-0 items-center rounded-full bg-[var(--bg-tertiary)] px-2 text-[11px] text-[var(--text-secondary)]">
        {count}
      </span>
      <span className="shrink-0" onClick={(e) => e.stopPropagation()}>
        <Switch
          checked={provider.enabled}
          disabled={!canManage}
          onChange={onToggle}
          label={
            provider.enabled
              ? t('providersModels.header.enabled')
              : t('providersModels.header.disabled')
          }
        />
      </span>
      {isCustom && canManage && (
        <span
          className="shrink-0 opacity-0 transition-opacity focus-within:opacity-100 group-hover:opacity-100"
          onClick={(e) => e.stopPropagation()}
        >
          <button
            type="button"
            aria-label="delete-provider"
            title={t('providersModels.header.delete')}
            onClick={onDelete}
            className="flex h-6 w-6 items-center justify-center rounded-[var(--radius-sm)] border-0 bg-transparent text-[var(--text-tertiary)] transition-colors hover:bg-[var(--danger-light)] hover:text-[var(--danger-primary)]"
          >
            <Trash2 className="h-3.5 w-3.5" />
          </button>
        </span>
      )}
    </div>
  );
}

function Section({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}): JSX.Element {
  return (
    <div className="flex flex-col gap-1">
      <h3 className="px-2 text-xs font-medium uppercase text-[var(--text-tertiary)]">
        {title}
      </h3>
      {children}
    </div>
  );
}
