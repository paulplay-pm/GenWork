import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { JSX } from 'react';
import { useEffect, useMemo, useState } from 'react';

import { modelsApi, type ModelView } from '../api/models';
import { type ProviderKeyView, providersApi } from '../api/providers';
import { useAuth } from '../auth/useAuth';
import { ConfirmDialog } from '../components/ConfirmDialog';
import { useToast } from '../components/toastStore';
import { providerDisplayName } from '../data/providerCatalog';
import { t } from '../i18n';
import { ModelDrawer, type ModelSavePayload } from './providersModels/ModelDrawer';
import { ModelList } from './providersModels/ModelList';
import { ProviderHeaderBar } from './providersModels/ProviderHeaderBar';
import {
  ProviderInfoCard,
  type SaveBody as ProviderSaveBody,
} from './providersModels/ProviderInfoCard';
import { ProviderRail } from './providersModels/ProviderRail';

type SelectionMode = 'patch' | 'create';

/**
 * One provider detail view for either selection state — a persisted row
 * (built-ins and custom, all real DB rows) or a freshly-added custom draft
 * that is not persisted until 保存. Built-in providers are seeded
 * server-side, so the rail is just the `providers` list and there is no
 * catalog-seed concept anymore.
 */
interface SelectedProvider {
  view: ProviderKeyView;
  mode: SelectionMode;
}

export function ProvidersModelsPage(): JSX.Element {
  const { claims, hasCapability } = useAuth();
  const canManage = hasCapability('model_admin');
  const orgId = claims?.orgId ?? 'default-org';
  const qc = useQueryClient();
  const toast = useToast();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [drawerModel, setDrawerModel] = useState<ModelView | null>(null);
  // The model awaiting delete confirmation (the styled ConfirmDialog). Set by
  // the row's trash icon; null means no dialog is open.
  const [pendingModelDelete, setPendingModelDelete] = useState<ModelView | null>(null);
  // Live values from the info-card form (label / baseUrl / protocol / codingPlan
  // / apiKey), pushed up by `ProviderInfoCard.onDraftChange` on mount + every
  // change. The single header "保存" button submits this — so a save always
  // carries the user's in-progress edits, not just the row defaults.
  const [draft, setDraft] = useState<ProviderSaveBody>({
    label: '',
    baseUrl: '',
    protocol: 'openai',
    codingPlan: false,
    apiKey: '',
  });

  const providersQ = useQuery({
    queryKey: ['providers', orgId],
    queryFn: () => providersApi.list(orgId),
  });
  const modelsQ = useQuery({
    queryKey: ['models', orgId],
    queryFn: () => modelsApi.list(orgId),
  });

  const invalidate = (): void => {
    void qc.invalidateQueries({ queryKey: ['providers', orgId] });
    void qc.invalidateQueries({ queryKey: ['models', orgId] });
  };

  const testMut = useMutation({
    mutationFn: (id: string) => providersApi.test(id),
    onSuccess: (r, id) => {
      invalidate();
      const row = (providersQ.data ?? []).find((p) => p.id === id);
      // The /test route returns 200 with status 'connected'|'failed' (only a
      // missing endpoint 400s, handled in onError). A failed probe is a
      // resolved 200, not a thrown error — so branch on the body's status.
      if (r.status === 'connected') {
        toast.success(
          t('providersModels.test.success').replace('{ms}', String(r.latencyMs ?? row?.latency_ms ?? 0)),
        );
      } else {
        toast.error(t('providersModels.test.failed'));
      }
    },
    onError: (e: Error) => {
      // A 400 here means the provider has no Base URL configured.
      const detail =
        (e as { body?: { error?: string } }).body?.error === 'no_endpoint'
          ? t('providersModels.test.noEndpoint')
          : e.message;
      toast.error(detail);
    },
  });

  const saveProviderMut = useMutation({
    mutationFn: ({
      id,
      body,
    }: {
      id: string;
      body: ProviderSaveBody;
    }) =>
      providersApi.patch(id, {
        label: body.label,
        baseUrl: body.baseUrl,
        protocol: body.protocol,
        codingPlan: body.codingPlan,
        // Omit the key entirely when the user typed nothing (keep stored).
        ...(body.apiKey ? { apiKey: body.apiKey } : {}),
      }),
    onSuccess: () => {
      invalidate();
      toast.success(t('providersModels.toast.saved'));
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const addProviderMut = useMutation({
    mutationFn: ({
      provider,
      body,
    }: {
      provider: string;
      body: ProviderSaveBody;
    }) =>
      providersApi.add({
        orgId,
        provider,
        // Keyless custom providers are allowed; omit the key when empty.
        ...(body.apiKey ? { apiKey: body.apiKey } : {}),
        label: body.label || undefined,
        endpoint: body.baseUrl || undefined,
        protocol: body.protocol,
        codingPlan: body.codingPlan,
      }),
    onSuccess: async (r) => {
      invalidate();
      toast.success(t('providersModels.catalog.success'));
      setSelectedId(r.id);
      // Auto-fetch models so the desktop sees them without a manual refresh.
      const rr = await doRefresh(r.id);
      void rr;
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const deleteProviderMut = useMutation({
    mutationFn: (id: string) => providersApi.remove(id),
    onSuccess: (r) => {
      invalidate();
      toast.success(t('providersModels.toast.deleted').replace('{n}', String(r.deletedModels)));
      setSelectedId(null);
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const setEnabledMut = useMutation({
    mutationFn: ({ id, enabled }: { id: string; enabled: boolean }) =>
      providersApi.setEnabled(id, enabled),
    onSuccess: (_r, { enabled }) => {
      invalidate();
      toast.success(
        t(enabled ? 'providersModels.enable.titleOn' : 'providersModels.enable.titleOff'),
      );
    },
    onError: (e: Error) => toast.error(e.message),
  });

  // Toggling a provider ON requires a configured API Key (a keyless provider
  // can't authenticate). Toggling OFF always goes through.
  function handleToggleProvider(id: string, enabled: boolean): void {
    if (enabled) {
      const row = (providersQ.data ?? []).find((p) => p.id === id);
      if (row && row.api_key_masked == null) {
        toast.error(t('providersModels.enable.keyRequired'));
        return;
      }
    }
    setEnabledMut.mutate({ id, enabled });
  }

  // 获取模型 — uses the shared doRefresh (real key + protocol) so the button
  // and the post-create auto-refresh surface the same, specific toasts.
  const refreshMut = useMutation({
    mutationFn: (id: string) => doRefresh(id),
  });

  // The single model editor mutation: add (no id) or patch (edit).
  const saveModelDrawer = useMutation({
    mutationFn: (p: ModelSavePayload): Promise<unknown> =>
      p.id
        ? modelsApi.patch(
            p.id,
            {
              displayName: p.name,
              types: p.types,
              capabilities: {
                contextWindow: p.contextWindow,
                temperature: p.temperature,
                topP: p.topP,
              },
            },
            orgId,
          )
        : modelsApi.add({
            orgId,
            providerKeyId: view?.id ?? '',
            provider: view?.provider ?? '',
            model: p.model,
            displayName: p.name,
            types: p.types,
            capabilities: {
              contextWindow: p.contextWindow,
              temperature: p.temperature,
              topP: p.topP,
            },
          }),
    onSuccess: () => {
      invalidate();
      setDrawerOpen(false);
      toast.success(t('providersModels.toast.saved'));
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const deleteModelMut = useMutation({
    mutationFn: ({ id, orgId: oid }: { id: string; orgId: string }) =>
      modelsApi.remove(id, oid),
    onSuccess: invalidate,
    onError: (e: Error) => toast.error(e.message),
  });

  const toggleModelMut = useMutation({
    mutationFn: ({
      id,
      enabled,
      orgId: oid,
    }: {
      id: string;
      enabled: boolean;
      orgId: string;
    }) =>
      enabled
        ? modelsApi.patch(id, { enabled: true }, oid)
        : modelsApi.patch(id, { enabled: false }, oid),
    onSuccess: invalidate,
    onError: (e: Error) => toast.error(e.message),
  });

  // Shared model-refresh with a user-facing toast (also used by the auto
  // refresh that follows a provider create). The backend uses the stored API
  // Key + the row's protocol to fetch the real model list; errors are mapped
  // to a specific, actionable message.
  async function doRefresh(id: string): Promise<void> {
    try {
      const r = await providersApi.refreshModels(id);
      invalidate();
      if (r.error === 'invalid_api_key') {
        toast.error(t('providersModels.catalog.refreshInvalidKey'));
      } else if (r.error === 'upstream_timeout') {
        toast.error(t('providersModels.catalog.refreshTimeout'));
      } else if (r.error === 'upstream_error') {
        toast.error(
          t('providersModels.catalog.refreshUpstream').replace('{detail}', r.detail ?? 'upstream error'),
        );
      } else if (r.error === 'empty_endpoint') {
        toast.error(t('providersModels.test.noEndpoint'));
      } else if (r.skipped === 'unsupported_provider') {
        toast.info(t('providersModels.catalog.refreshSkipped'));
      } else if (r.added > 0) {
        toast.success(t('providersModels.catalog.refreshed').replace('{n}', String(r.added)));
      } else {
        toast.success(t('providersModels.catalog.refreshed').replace('{n}', '0'));
      }
    } catch (e) {
      // Non-2xx: a 409 means the provider is disabled (keyless / not yet
      // enabled); everything else is a generic failure.
      const err = e as { body?: { error?: string } };
      if (err.body?.error === 'provider_disabled') {
        toast.error(t('providersModels.catalog.refreshDisabled'));
      } else {
        toast.info(t('providersModels.catalog.refreshFailed'));
      }
      console.warn('[ProvidersModelsPage] model refresh failed:', e);
    }
  }

  const providers = useMemo<ProviderKeyView[]>(
    () => providersQ.data ?? [],
    [providersQ.data],
  );
  const models = useMemo<ModelView[]>(() => modelsQ.data ?? [], [modelsQ.data]);

  // Resolve the current selection: a persisted row, or a fresh custom draft
  // (`custom-<ts>` id, synthesized until it is saved).
  const selected: SelectedProvider | null = useMemo(() => {
    if (!selectedId) return null;
    const row = providers.find((p) => p.id === selectedId);
    if (row) return { view: row, mode: 'patch' };
    if (selectedId.startsWith('custom-')) {
      return {
        view: {
          id: selectedId,
          provider: selectedId,
          endpoint: null,
          label: t('providersModels.create.newName'),
          enabled: false,
          region: null,
          default_base_url: null,
          website: null,
          description: null,
          api_key_masked: null,
          status: 'unknown',
          latency_ms: null,
          last_test_at: null,
          created_at: new Date(0).toISOString(),
          is_builtin: false,
          protocol: 'openai',
          coding_plan: false,
        },
        mode: 'create',
      };
    }
    return null;
  }, [selectedId, providers]);

  const view = selected?.view ?? null;
  const mode: SelectionMode = selected?.mode ?? 'patch';
  // Actions that need a persisted row (test / fetch / add-model / toggle) are
  // unavailable in 'create' mode.
  const rowExists = mode === 'patch';

  // Rail count badge: model count per provider KEY. Two keys can share a
  // `provider` slug (built-in `deepseek` + custom `deepseek`), so count by
  // `provider_key_id` (falling back to the slug when absent) — otherwise both
  // same-slug keys would show the merged total.
  const modelCounts = useMemo(() => {
    const counts: Record<string, number> = {};
    for (const m of models) {
      const key = m.provider_key_id ?? m.provider;
      if (key) counts[key] = (counts[key] ?? 0) + 1;
    }
    return counts;
  }, [models]);

  // The selected provider's models, scoped to ITS provider key. Before same-
  // slug coexistence there was one key per slug, so filtering by slug was safe;
  // now a built-in and a custom provider of the same vendor each have their own
  // key and must show only their own rows. Key by `provider_key_id` (falling
  // back to the slug for rows that predate the field).
  const providerModels = useMemo(
    () => (view ? models.filter((m) => (m.provider_key_id ?? m.provider) === view.id) : []),
    [models, view],
  );

  function onAddProvider(): void {
    // A unique, collision-free slug for a fresh custom draft.
    setSelectedId(`custom-${Date.now()}`);
  }

  function handleSaveProvider(id: string, body: ProviderSaveBody): void {
    if (!selected) return;
    if (mode === 'patch') {
      saveProviderMut.mutate({ id, body });
      return;
    }
    addProviderMut.mutate({ provider: selected.view.provider, body });
  }

  // Default to the first provider on entry so the detail pane isn't empty.
  // Pick the top rail row (built-ins first, then custom — the same order the
  // rail renders) and select it once, but only when nothing is selected yet.
  // Gated on the providers query having loaded so `providers[0]` is real, not
  // the empty pre-load array; `selectedId === null` makes it a one-shot.
  const providerListReady = !providersQ.isLoading && !providersQ.isPending;
  useEffect(() => {
    if (selectedId !== null || !providerListReady || providers.length === 0) return;
    const first = providers.find((p) => p.is_builtin) ?? providers[0];
    if (first) setSelectedId(first.id);
  }, [selectedId, providerListReady, providers]);

  if (providersQ.isLoading || modelsQ.isLoading) {
    return (
      <div className="p-8 text-[var(--text-secondary)]">{t('providersModels.loading')}</div>
    );
  }

  // Header context — breadcrumb + h1 + subtitle.
  const headerContext: {
    breadcrumbName: string | null;
    h1: string;
    subtitle: string | null;
  } = view
    ? {
        breadcrumbName: view.label ?? providerDisplayName(view.provider),
        h1: view.label ?? providerDisplayName(view.provider),
        subtitle:
          view.description ||
          (mode === 'create' ? t('providersModels.create.hint') : null),
      }
    : {
        breadcrumbName: null,
        h1: t('providersModels.title'),
        subtitle: t('providersModels.subtitle'),
      };

  const headerBusy =
    testMut.isPending ||
    saveProviderMut.isPending ||
    addProviderMut.isPending ||
    deleteProviderMut.isPending ||
    setEnabledMut.isPending;

  return (
    <div className="flex h-full flex-col bg-[var(--bg-primary)]">
      <div className="border-b border-[var(--border-subtle)] bg-[var(--bg-secondary)] px-6 py-3">
        <div className="text-[12.5px] text-[var(--text-tertiary)]">
          {t('providersModels.breadcrumb.root')}
          <span className="mx-1.5">/</span>
          {t('providersModels.breadcrumb.section')}
          {headerContext.breadcrumbName && (
            <>
              <span className="mx-1.5">/</span>
              <span className="text-[var(--text-primary)]">{headerContext.breadcrumbName}</span>
            </>
          )}
        </div>
        <h1 className="mt-1 text-base font-semibold text-[var(--text-primary)]">
          {headerContext.h1}
        </h1>
        {headerContext.subtitle && (
          <p className="mt-0.5 text-xs text-[var(--text-secondary)]">
            {headerContext.subtitle}
          </p>
        )}
      </div>

      <div className="flex flex-1 overflow-hidden">
        <div className="w-72 shrink-0">
          <ProviderRail
            providers={providers}
            modelCounts={modelCounts}
            selectedId={selectedId}
            onSelect={(id) => {
              setSelectedId(id);
              setDrawerOpen(false);
            }}
            canManage={canManage}
            onAddProvider={onAddProvider}
            onDeleteProvider={(p) => {
              if (
                window.confirm(
                  t('providersModels.confirm.deleteProvider')
                    .replace('{name}', p.label ?? p.provider)
                    .replace('{n}', String(modelCounts[p.id] ?? 0)),
                )
              ) {
                deleteProviderMut.mutate(p.id);
              }
            }}
            onToggleProvider={(id, enabled) => handleToggleProvider(id, enabled)}
          />
        </div>

        <div className="flex-1 overflow-y-auto p-6">
          {view ? (
            <div className="space-y-4">
              <ProviderHeaderBar
                provider={view}
                canManage={canManage}
                busy={headerBusy}
                onTest={(id) => testMut.mutate(id)}
                onSave={(id) => handleSaveProvider(id, draft)}
              />

              <ProviderInfoCard
                key={view.id}
                provider={view}
                canManage={canManage}
                onDraftChange={setDraft}
              />

              <ModelList
                models={providerModels}
                canManage={canManage && rowExists}
                busy={
                  saveModelDrawer.isPending ||
                  deleteModelMut.isPending ||
                  refreshMut.isPending ||
                  toggleModelMut.isPending
                }
                onRefresh={() => refreshMut.mutate(view.id)}
                onAdd={() => {
                  setDrawerModel(null);
                  setDrawerOpen(true);
                }}
                onEdit={(m) => {
                  setDrawerModel(m);
                  setDrawerOpen(true);
                }}
                onDelete={(id) => {
                  const target = providerModels.find((m) => m.id === id) ?? null;
                  setPendingModelDelete(target);
                }}
                onToggleEnabled={(id, enabled) => toggleModelMut.mutate({ id, enabled, orgId })}
              />
            </div>
          ) : (
            <div className="flex h-full items-center justify-center text-[var(--text-secondary)]">
              {t('providersModels.empty.selectProvider')}
            </div>
          )}
        </div>
      </div>

      {view && (
        <ModelDrawer
          open={drawerOpen}
          model={drawerModel}
          providerId={view.id}
          provider={view.provider}
          busy={saveModelDrawer.isPending}
          onSave={(p) => saveModelDrawer.mutate(p)}
          onClose={() => setDrawerOpen(false)}
        />
      )}

      <ConfirmDialog
        open={pendingModelDelete !== null}
        destructive
        title={t('providersModels.confirm.deleteModelTitle')}
        message={t('providersModels.confirm.deleteModel').replace(
          '{name}',
          pendingModelDelete ? pendingModelDelete.display_name ?? pendingModelDelete.model : '',
        )}
        cancelLabel={t('common.cancel')}
        confirmLabel={t('common.delete')}
        onConfirm={() => {
          if (pendingModelDelete) deleteModelMut.mutate({ id: pendingModelDelete.id, orgId });
          setPendingModelDelete(null);
        }}
        onCancel={() => setPendingModelDelete(null)}
      />
    </div>
  );
}
