import { Eye, EyeOff } from 'lucide-react';
import type { JSX } from 'react';
import { useEffect, useRef, useState } from 'react';

import type { ProviderKeyView } from '../../api/providers';
import { Switch } from '../../components/Switch';
import { PROVIDER_ENDPOINTS, providerDisplayName } from '../../data/providerCatalog';
import { t } from '../../i18n';

export interface SaveBody {
  label: string;
  baseUrl: string;
  protocol: 'openai' | 'anthropic';
  /** "Coding Plan" (beta) flag; on → the Base URL uses the coding endpoint. */
  codingPlan: boolean;
  /** The key exactly as typed: non-empty → set it; empty → keep the stored one
   * (the page omits it from the PATCH body when empty). */
  apiKey: string;
}

/** Canonical Base URL per protocol. Choosing a protocol auto-fills this into
 * the Base URL field (it always overwrites the current value). */
export const PROTOCOL_DEFAULT_BASE_URL: Record<'openai' | 'anthropic', string> = {
  openai: 'https://api.openai.com/v1',
  anthropic: 'https://api.anthropic.com',
};

/** The provider-specific Base URL for a protocol, falling back to the global
 * protocol default for custom / unknown slugs. */
function defaultBaseUrlFor(slug: string, protocol: 'openai' | 'anthropic'): string {
  const set = PROVIDER_ENDPOINTS[slug];
  return set?.[protocol] ?? PROTOCOL_DEFAULT_BASE_URL[protocol];
}

interface Props {
  provider: ProviderKeyView;
  canManage: boolean;
  /** Called with the current field values on mount and every change, so the
   * single header "保存" button (owned by the page) can submit the user's
   * in-progress edits. */
  onDraftChange: (body: SaveBody) => void;
}

/**
 * Form card for editing the provider's name, API protocol, Base URL, Coding
 * Plan, and API key. Renders the editable fields only — saving is consolidated
 * on the header "保存" button (the page reads this card's live values via
 * `onDraftChange`). The key input is write-only: it starts empty, and a blank
 * value on save keeps the stored key (the masked key is surfaced as a hint).
 */
export function ProviderInfoCard({
  provider,
  canManage,
  onDraftChange,
}: Props): JSX.Element {
  const slug = provider.provider;
  const codingPlanEndpoint = PROVIDER_ENDPOINTS[slug]?.codingPlan;

  // Name defaults to the provider's display name when no label is stored (a
  // label-less built-in falls back to its slug — except where the slug is an
  // abbreviation, e.g. volc → "Volcengine"), so the field is never blank.
  const [label, setLabel] = useState(provider.label ?? providerDisplayName(slug));
  const [baseUrl, setBaseUrl] = useState(provider.endpoint ?? '');
  const [apiKey, setApiKey] = useState('');
  const [protocol, setProtocol] = useState<'openai' | 'anthropic'>(provider.protocol);
  const [codingPlan, setCodingPlan] = useState<boolean>(provider.coding_plan);
  const [showKey, setShowKey] = useState(false);
  // Keep the latest callback without listing it as a dependency (an inline
  // parent callback changes identity every render, which would re-run this
  // effect and re-push the same draft — a pointless loop).
  const onDraftChangeRef = useRef(onDraftChange);
  onDraftChangeRef.current = onDraftChange;

  // Reset when the selected provider changes.
  useEffect(() => {
    setLabel(provider.label ?? providerDisplayName(slug));
    setBaseUrl(provider.endpoint ?? '');
    setApiKey('');
    setProtocol(provider.protocol);
    setCodingPlan(provider.coding_plan);
    setShowKey(false);
  }, [provider.id, provider.label, provider.provider, provider.endpoint, provider.protocol, provider.coding_plan]);

  // Push the current field values up to the page so the header save button can
  // submit them. Fires on mount (initial values) and after every change.
  useEffect(() => {
    onDraftChangeRef.current({ label, baseUrl, protocol, codingPlan, apiKey });
  }, [label, baseUrl, protocol, codingPlan, apiKey]);

  // Choosing a protocol auto-switches the Base URL to that protocol's
  // provider-specific default (falls back to the global default for custom).
  function changeProtocol(value: 'openai' | 'anthropic'): void {
    setProtocol(value);
    setBaseUrl(defaultBaseUrlFor(slug, value));
  }

  // Toggling Coding Plan on swaps the Base URL to the coding endpoint; off
  // reverts to the current protocol's default (the "auto-switch" behavior).
  function changeCodingPlan(next: boolean): void {
    setCodingPlan(next);
    setBaseUrl(next ? codingPlanEndpoint! : defaultBaseUrlFor(slug, protocol));
  }

  const maskedHint = provider.api_key_masked
    ? t('providersModels.info.current').replace('{masked}', provider.api_key_masked)
    : null;

  return (
    <div className="rounded-[var(--radius-md)] border border-[var(--border-subtle)] bg-[var(--bg-secondary)] p-4">
      <h3 className="mb-3 text-sm font-semibold text-[var(--text-primary)]">
        {t('providersModels.info.card')}
      </h3>

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <Field
          label={t('providersModels.info.name')}
          value={label}
          onChange={setLabel}
          disabled={!canManage}
        />
        <Field
          label={t('providersModels.info.baseUrl')}
          value={baseUrl}
          onChange={setBaseUrl}
          disabled={!canManage}
          placeholder={defaultBaseUrlFor(slug, protocol)}
        />
      </div>

      <fieldset className="mt-3">
        <legend className="mb-1 block text-xs font-medium text-[var(--text-secondary)]">
          {t('providersModels.protocol.label')}
        </legend>
        <div className="flex items-center gap-4">
          {(['openai', 'anthropic'] as const).map((value) => (
            <label
              key={value}
              className="flex cursor-pointer items-center gap-1.5 text-sm text-[var(--text-primary)]"
            >
              <input
                type="radio"
                name="provider-protocol"
                value={value}
                checked={protocol === value}
                disabled={!canManage}
                onChange={() => changeProtocol(value)}
                className="h-3.5 w-3.5 accent-[var(--accent-primary)]"
              />
              {value === 'openai'
                ? t('providersModels.protocol.openai')
                : t('providersModels.protocol.anthropic')}
            </label>
          ))}
        </div>
        <p className="mt-1 text-xs text-[var(--text-tertiary)]">
          {t('providersModels.protocol.hint')}
        </p>
      </fieldset>

      {codingPlanEndpoint && (
        <div className="mt-3 flex items-center justify-between gap-3 rounded-[var(--radius-sm)] border border-[var(--border-subtle)] bg-[var(--bg-tertiary)] px-3 py-2">
          <div className="min-w-0">
            <div className="flex items-center gap-1.5 text-sm font-medium text-[var(--text-primary)]">
              {t('providersModels.codingPlan.title')}
              <span className="rounded-[var(--radius-sm)] bg-[var(--accent-light)] px-1.5 py-0.5 text-[10px] font-medium text-[var(--accent-primary)]">
                {t('providersModels.codingPlan.badge')}
              </span>
            </div>
            <p className="mt-0.5 text-xs text-[var(--text-tertiary)]">
              {codingPlan
                ? t('providersModels.codingPlan.on').replace('{endpoint}', codingPlanEndpoint)
                : t('providersModels.codingPlan.off')}
            </p>
          </div>
          <Switch
            checked={codingPlan}
            disabled={!canManage}
            onChange={changeCodingPlan}
            label={t('providersModels.codingPlan.switch')}
          />
        </div>
      )}

      <div className="mt-3">
        <label
          htmlFor="provider-api-key"
          className="mb-1 block text-xs font-medium text-[var(--text-secondary)]"
        >
          {t('providersModels.info.apiKey')}
        </label>
        <div className="relative">
          <input
            id="provider-api-key"
            type={showKey ? 'text' : 'password'}
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
            disabled={!canManage}
            placeholder="sk-…"
            className="w-full rounded-[var(--radius-sm)] border border-[var(--border-default)] bg-[var(--bg-tertiary)] px-3 py-2 pr-16 text-sm focus:outline-none focus:bg-[var(--bg-secondary)] focus:border-[var(--accent-primary)] focus:ring-2 focus:ring-[var(--accent-primary)]/10 disabled:opacity-50 transition-colors"
          />
          {canManage && (
            <button
              type="button"
              onClick={() => setShowKey(!showKey)}
              aria-label={showKey ? t('providersModels.info.hideKey') : t('providersModels.info.showKey')}
              className="absolute right-2 top-1/2 -translate-y-1/2 rounded-[var(--radius-sm)] px-1.5 py-1 text-[var(--text-tertiary)] hover:bg-[var(--bg-hover)]"
            >
              {showKey ? (
                <EyeOff className="h-3.5 w-3.5" />
              ) : (
                <Eye className="h-3.5 w-3.5" />
              )}
            </button>
          )}
        </div>
        {maskedHint && (
          <p className="mt-1 text-xs text-[var(--text-tertiary)]">{maskedHint}</p>
        )}
        {maskedHint && (
          <p className="mt-0.5 text-xs text-[var(--text-tertiary)]">
            {t('providersModels.form.apiKeyHint')}
          </p>
        )}
      </div>
    </div>
  );
}

function Field({
  label,
  value,
  onChange,
  disabled,
  placeholder,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  disabled: boolean;
  placeholder?: string;
}): JSX.Element {
  return (
    <div>
      <label className="mb-1 block text-xs font-medium text-[var(--text-secondary)]">
        {label}
      </label>
      <input
        type="text"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        disabled={disabled}
        placeholder={placeholder}
        className="w-full rounded-[var(--radius-sm)] border border-[var(--border-default)] bg-[var(--bg-tertiary)] px-3 py-2 text-sm focus:outline-none focus:bg-[var(--bg-secondary)] focus:border-[var(--accent-primary)] focus:ring-2 focus:ring-[var(--accent-primary)]/10 disabled:opacity-50 transition-colors"
      />
    </div>
  );
}
