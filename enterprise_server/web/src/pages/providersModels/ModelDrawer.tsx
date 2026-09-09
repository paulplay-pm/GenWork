import { X } from 'lucide-react';
import type { JSX } from 'react';
import { useEffect, useState } from 'react';

import {
  MODEL_TYPE_VALUES,
  type ModelTypeValue,
  type ModelView,
} from '../../api/models';
import { t } from '../../i18n';
import {
  CONTEXT_STOPS,
  contextLabel,
  nearestStopIndex,
  typeValueLabel,
} from './modelType';

/** Payload for the single model editor (add + edit). `id` absent → new model. */
export interface ModelSavePayload {
  id?: string;
  name: string;
  model: string;
  types: ModelTypeValue[];
  /** Nullable so an edit of an originally-null field, saved untouched, round-trips
   * as `null` instead of being silently materialized to the UI default. The add
   * path always sends a number (state initializes to the defaults below). */
  contextWindow: number | null;
  temperature: number | null;
  topP: number | null;
}

interface Props {
  open: boolean;
  /** Model being edited; `null` = adding a new model. */
  model: ModelView | null;
  providerId: string;
  provider: string;
  busy: boolean;
  onSave: (payload: ModelSavePayload) => void;
  onClose: () => void;
}

/** One-line capability description per type (i18n keys, en + zh). */
const TYPE_VALUE_DESC: Record<ModelTypeValue, string> = {
  'chat': 'providersModels.drawer.desc.chat',
  'vision': 'providersModels.drawer.desc.vision',
  'reasoning': 'providersModels.drawer.desc.reasoning',
  'image-gen': 'providersModels.drawer.desc.image-gen',
  'embedding': 'providersModels.drawer.desc.embedding',
  'rerank': 'providersModels.drawer.desc.rerank',
  'asr': 'providersModels.drawer.desc.asr',
  'tts': 'providersModels.drawer.desc.tts',
};

/**
 * Unified slide-in drawer for adding and editing a model: basic info
 * (name + model ID), the 8-capability type grid, the 5-stop context-window
 * picker, and sampling params (temperature / top P). The page maps the
 * payload to `modelsApi.add` (no `id`) or `modelsApi.patch` (edit);
 * `providerId`/`provider` identify the owning provider row for that add.
 */
export function ModelDrawer({
  open,
  model,
  providerId,
  provider,
  busy,
  onSave,
  onClose,
}: Props): JSX.Element | null {
  const [name, setName] = useState('');
  const [modelId, setModelId] = useState('');
  const [types, setTypes] = useState<ModelTypeValue[]>(['chat']);
  const [contextWindow, setContextWindow] = useState<number | null>(200000);
  const [temperature, setTemperature] = useState<number | null>(0.7);
  const [topP, setTopP] = useState<number | null>(0.9);
  const [err, setErr] = useState<string | null>(null);

  // (Re)initialize local state each time the drawer opens for a model.
  useEffect(() => {
    if (!open) return;
    setName(model?.display_name ?? '');
    setModelId(model?.model ?? '');
    setTypes(model && model.types.length > 0 ? model.types : ['chat']);
    // Edit: keep the model's actual values (an untouched null must stay null,
    // not be materialized to a default on save). Add: fall back to the defaults.
    setContextWindow(model ? model.context_window : 200000);
    setTemperature(model ? model.temperature : 0.7);
    setTopP(model ? model.top_p : 0.9);
    setErr(null);
  }, [open, model]);

  if (!open) return null;

  const stopIndex = nearestStopIndex(contextWindow);

  function toggleType(value: ModelTypeValue, on: boolean): void {
    setTypes((prev) => (on ? [...prev, value] : prev.filter((v) => v !== value)));
  }

  function submit(): void {
    if (!name.trim() || !modelId.trim()) {
      setErr(t('providersModels.drawer.required'));
      return;
    }
    setErr(null);
    onSave({
      id: model?.id,
      name: name.trim(),
      model: modelId.trim(),
      types,
      contextWindow,
      temperature,
      topP,
    });
  }

  return (
    <div
      className="fixed inset-0 z-50 flex justify-end bg-[var(--text-primary)]/40"
      onClick={onClose}
    >
      <div
        className="h-full w-full max-w-[460px] overflow-y-auto bg-[var(--bg-secondary)] shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-[var(--border-subtle)] px-5 py-4">
          <h2 className="text-base font-semibold text-[var(--text-primary)]">
            {model
              ? t('providersModels.drawer.titleEdit')
              : t('providersModels.model.add')}
          </h2>
          <button
            type="button"
            onClick={onClose}
            aria-label={t('common.close')}
            className="rounded-md p-1 text-[var(--text-secondary)] transition-colors hover:text-[var(--text-primary)]"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="px-5 py-4">
          <p className="mb-3 text-xs text-[var(--text-tertiary)]">
            {provider}
            {model ? (
              <>
                {' · '}
                <span className="font-mono">{model.model}</span>
                {model.display_name ? ` · ${model.display_name}` : ''}
              </>
            ) : null}
          </p>

          <Section title={t('providersModels.drawer.basic')}>
            <div>
              <label
                htmlFor="model-drawer-name"
                className="mb-1 block text-xs font-medium text-[var(--text-secondary)]"
              >
                {t('providersModels.drawer.name')} *
              </label>
              <input
                id="model-drawer-name"
                type="text"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder={t('providersModels.drawer.namePlaceholder')}
                className="w-full rounded-[var(--radius-sm)] border border-[var(--border-default)] bg-[var(--bg-tertiary)] px-3 py-2 text-sm focus:border-[var(--accent-primary)] focus:bg-[var(--bg-secondary)] focus:outline-none focus:ring-2 focus:ring-[var(--accent-primary)]/10"
              />
              <p className="mt-0.5 text-xs text-[var(--text-tertiary)]">
                {t('providersModels.drawer.nameHint')}
              </p>
            </div>
            <div>
              <label
                htmlFor="model-drawer-id"
                className="mb-1 block text-xs font-medium text-[var(--text-secondary)]"
              >
                {t('providersModels.drawer.id')} *
              </label>
              <input
                id="model-drawer-id"
                type="text"
                value={modelId}
                onChange={(e) => setModelId(e.target.value)}
                placeholder={t('providersModels.drawer.idPlaceholder')}
                className="w-full rounded-[var(--radius-sm)] border border-[var(--border-default)] bg-[var(--bg-tertiary)] px-3 py-2 font-mono text-sm focus:border-[var(--accent-primary)] focus:bg-[var(--bg-secondary)] focus:outline-none focus:ring-2 focus:ring-[var(--accent-primary)]/10"
              />
              <p className="mt-0.5 text-xs text-[var(--text-tertiary)]">
                {t('providersModels.drawer.idHint')}
              </p>
            </div>
          </Section>

          <Section
            title={t('providersModels.drawer.types')}
            hint={t('providersModels.drawer.typesHint')}
          >
            <div className="grid grid-cols-2 gap-2">
              {MODEL_TYPE_VALUES.map((value) => {
                const checked = types.includes(value);
                return (
                  <label
                    key={value}
                    className={`flex cursor-pointer items-start gap-2 rounded-[var(--radius-sm)] border px-2.5 py-2 transition-colors ${
                      checked
                        ? 'border-[var(--accent-primary)] bg-[var(--accent-light)]'
                        : 'border-[var(--border-default)] hover:bg-[var(--bg-hover)]'
                    }`}
                  >
                    <input
                      type="checkbox"
                      checked={checked}
                      onChange={(e) => toggleType(value, e.target.checked)}
                      className="mt-0.5 h-3.5 w-3.5 accent-[var(--accent-primary)]"
                    />
                    <span className="min-w-0">
                      <span className="block text-sm font-medium text-[var(--text-primary)]">
                        {typeValueLabel(value)}
                      </span>
                      <span className="block text-xs leading-snug text-[var(--text-tertiary)]">
                        {t(TYPE_VALUE_DESC[value])}
                      </span>
                    </span>
                  </label>
                );
              })}
            </div>
          </Section>

          <Section
            title={t('providersModels.drawer.context')}
            hint={t('providersModels.drawer.contextHint')}
          >
            <div className="mb-2 flex items-center justify-between">
              <span className="text-xs text-[var(--text-tertiary)]">
                {contextLabel(contextWindow)}
              </span>
            </div>
            <div className="flex overflow-hidden rounded-[var(--radius-sm)] border border-[var(--border-default)]">
              {CONTEXT_STOPS.map((stop, i) => (
                <button
                  key={stop.tokens}
                  type="button"
                  onClick={() => setContextWindow(stop.tokens)}
                  aria-pressed={i === stopIndex}
                  className={`flex-1 px-2 py-1.5 text-xs font-medium transition-colors ${
                    i === stopIndex
                      ? 'bg-[var(--accent-primary)] text-white'
                      : 'bg-[var(--bg-tertiary)] text-[var(--text-secondary)] hover:bg-[var(--bg-hover)]'
                  }`}
                >
                  {stop.label}
                </button>
              ))}
            </div>
          </Section>

          <div className="my-4 border-t border-[var(--border-subtle)]" />

          <Section title={t('providersModels.drawer.sampling')}>
            <div>
              <div className="mb-1 flex items-center justify-between">
                <label
                  htmlFor="model-drawer-temperature"
                  className="text-xs font-medium text-[var(--text-secondary)]"
                >
                  {t('providersModels.drawer.temperature')}
                </label>
                <span className="rounded-full bg-[var(--bg-tertiary)] px-2 text-xs font-mono text-[var(--text-secondary)]">
                  {temperature ?? '—'}
                </span>
              </div>
              <input
                id="model-drawer-temperature"
                type="range"
                min={0}
                max={2}
                step={0.1}
                value={temperature ?? 0.7}
                onChange={(e) => setTemperature(Number(e.target.value))}
                className="w-full accent-[var(--accent-primary)]"
              />
              <p className="mt-0.5 text-xs text-[var(--text-tertiary)]">
                {t('providersModels.drawer.temperatureHint')}
              </p>
            </div>
            <div>
              <div className="mb-1 flex items-center justify-between">
                <label
                  htmlFor="model-drawer-top-p"
                  className="text-xs font-medium text-[var(--text-secondary)]"
                >
                  {t('providersModels.drawer.topP')}
                </label>
                <span className="rounded-full bg-[var(--bg-tertiary)] px-2 text-xs font-mono text-[var(--text-secondary)]">
                  {topP ?? '—'}
                </span>
              </div>
              <input
                id="model-drawer-top-p"
                type="range"
                min={0}
                max={1}
                step={0.05}
                value={topP ?? 0.9}
                onChange={(e) => setTopP(Number(e.target.value))}
                className="w-full accent-[var(--accent-primary)]"
              />
              <p className="mt-0.5 text-xs text-[var(--text-tertiary)]">
                {t('providersModels.drawer.topPHint')}
              </p>
            </div>
          </Section>

          {err && <p className="mb-2 text-sm text-[var(--danger-primary)]">{err}</p>}

          <div className="mt-4 flex justify-end gap-2">
            <button
              type="button"
              onClick={onClose}
              disabled={busy}
              className="rounded-[var(--radius-md)] border border-[var(--border-default)] bg-[var(--bg-secondary)] px-3.5 py-2 text-sm font-medium text-[var(--text-secondary)] transition-colors hover:bg-[var(--bg-hover)] disabled:opacity-50"
            >
              {t('common.cancel')}
            </button>
            <button
              type="button"
              onClick={submit}
              disabled={busy}
              className="rounded-[var(--radius-md)] bg-[var(--accent-primary)] px-3.5 py-2 text-sm font-medium text-white shadow-sm transition-colors hover:bg-[var(--accent-primary-hover)] disabled:opacity-50"
            >
              {t('common.save')}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

function Section({
  title,
  hint,
  children,
}: {
  title: string;
  hint?: string;
  children: React.ReactNode;
}): JSX.Element {
  return (
    <div className="mb-4">
      <div className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-[var(--text-tertiary)]">
        {title}
      </div>
      {hint && <p className="-mt-1.5 mb-2 text-xs text-[var(--text-tertiary)]">{hint}</p>}
      <div className="space-y-2">{children}</div>
    </div>
  );
}
