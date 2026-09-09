import { Check, ChevronDown } from 'lucide-react';
import type { JSX } from 'react';
import { useState } from 'react';

import type { ModelView } from '../../../api/models';
import type { ProviderKeyView } from '../../../api/providers';
import { modelLabel } from '../modelLabel';
import { t } from '../types';

interface ModelSelectProps {
  value: string;
  onChange: (v: string) => void;
  models: ModelView[];
  /** Org providers (from 模型配置). Used to (a) decide which models are
   * assignable — only models whose provider key is `enabled` — and (b) show
   * each provider's friendly label as a group header (matched by key id). */
  providers?: ProviderKeyView[];
  /** Render a free-text input instead of the catalog dropdown (e.g. the
   * org catalog query failed). */
  fallbackFree: boolean;
}

function modelValue(m: ModelView): string {
  return `${m.provider}/${m.model}`;
}

/**
 * Controlled model picker. When the org model catalog is available it renders
 * a dropdown of `provider/modelId` values (displaying `display_name ??
 * model`), grouped under each ENABLED provider (模型配置); when the catalog is
 * missing or `fallbackFree` it falls back to a free-text input.
 *
 * Only models from enabled providers are offered, and the list is grouped by
 * provider KEY (not slug) so a built-in and a custom provider of the same
 * vendor show their own distinct, non-duplicated model lists.
 */
export function ModelSelect({ value, onChange, models, providers, fallbackFree }: ModelSelectProps): JSX.Element {
  const [open, setOpen] = useState(false);
  const providerList = Array.isArray(providers) ? providers : [];
  // Only offer models the admin is allowed to assign: the model is enabled and
  // not disabled by policy (spec §4), AND — when we have the provider list —
  // its provider key is enabled (a disabled provider's models must not be
  // assignable). The enabled-provider check is gated on `hasProviders` so a
  // transient/errored providers query (no data) degrades to the model-level
  // filter rather than hiding the whole list. A model that becomes disabled,
  // or whose provider is disabled, after being selected falls out of the list;
  // its value is still held by the draft and the label degrades to the raw
  // `provider/model` string.
  const hasProviders = providerList.length > 0;
  const enabledProviderIds = new Set(providerList.filter(p => p.enabled).map(p => p.id));
  const list = (Array.isArray(models) ? models : [])
    .filter(m => m.enabled && !m.disabled_by_admin)
    .filter(m => {
      if (!hasProviders) return true;
      // A model is scoped to its provider KEY (provider_key_id), not its slug:
      // a built-in `deepseek` and a custom `deepseek` are independent keys.
      return m.provider_key_id
        ? enabledProviderIds.has(m.provider_key_id)
        // Legacy rows that predate the field: require an enabled key with the
        // model's slug.
        : providerList.some(p => p.provider === m.provider && p.enabled);
    });

  // Group the assignable models by provider KEY (provider_key_id) when the
  // provider list is available — so the dropdown mirrors the 模型配置 rail→list
  // layout and two same-slug keys (built-in + custom) stay distinct groups with
  // their own labels. With no provider data, group by slug as before so labels
  // degrade to the slug instead of a raw key id.
  const groupKeyOf = (m: ModelView): string =>
    (hasProviders && m.provider_key_id) ? m.provider_key_id : m.provider;
  const providerByKeyId = new Map(providerList.map(p => [p.id, p] as const));
  const labelOf = (key: string): string => {
    const p = providerByKeyId.get(key);
    return p ? (p.label ?? p.provider) : key;
  };
  const groups: Array<{ key: string; label: string; models: ModelView[] }> = [];
  const byKey = new Map<string, ModelView[]>();
  for (const m of list) {
    const key = groupKeyOf(m);
    const bucket = byKey.get(key) ?? [];
    bucket.push(m);
    byKey.set(key, bucket);
  }
  for (const [key, items] of byKey) groups.push({ key, label: labelOf(key), models: items });

  if (list.length === 0 || fallbackFree) {
    return (
      <input
        aria-label={t('agentmgmt.model')}
        className="h-9 w-full min-w-0 flex-1 rounded-lg border border-[var(--border-default)] bg-[var(--bg-primary)] px-3 text-sm text-[var(--text-primary)]"
        placeholder="providerId/modelId"
        value={value}
        onChange={e => onChange(e.target.value)}
      />
    );
  }

  const current = list.find(m => modelValue(m) === value);
  // Collapsed label: the vendor's friendly name (the 模型配置 label, falling
  // back to the slug) plus the model ID — e.g. "OpenAI · GPT-5". A value that
  // is not in the assignable list (a free-text entry) degrades to the raw
  // provider/model string.
  const label = current ? modelLabel(modelValue(current), providerList) : value;

  return (
    <div className="relative min-w-0 flex-1">
      <button
        type="button"
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => setOpen(o => !o)}
        className="flex h-9 w-full min-w-0 items-center justify-between gap-2 rounded-lg border border-[var(--border-default)] bg-[var(--bg-primary)] px-3 text-sm"
      >
        <span className={`truncate ${label ? 'text-[var(--text-primary)]' : 'text-[var(--text-secondary)]'}`}>
          {label || 'providerId/modelId'}
        </span>
        <ChevronDown size={14} className="shrink-0 text-[var(--text-secondary)]" />
      </button>
      {open ? (
        <ul
          role="listbox"
          className="absolute bottom-full left-0 right-0 z-10 mb-1 max-h-52 overflow-y-auto rounded-lg border border-[var(--border-default)] bg-[var(--bg-secondary)] py-1 shadow-lg"
        >
          {groups.map(g => (
            <li key={g.key}>
              <div className="px-3 pb-1 pt-2 text-xs font-medium uppercase tracking-wide text-[var(--text-tertiary)]">
                {g.label}
              </div>
              {g.models.map(m => {
                const v = modelValue(m);
                const active = v === value;
                return (
                  <button
                    key={m.id}
                    type="button"
                    role="option"
                    aria-selected={active}
                    onClick={() => { onChange(v); setOpen(false); }}
                    className={`flex w-full items-center justify-between gap-2 px-3 py-2 text-left text-sm hover:bg-[var(--bg-tertiary)] ${
                      active ? 'font-medium text-[var(--accent-primary)]' : 'text-[var(--text-primary)]'}`}>
                    <span className="truncate">{m.display_name ?? m.model}</span>
                    {active ? <Check size={14} className="shrink-0" /> : null}
                  </button>
                );
              })}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
