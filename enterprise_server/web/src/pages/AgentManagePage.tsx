import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Search, X } from 'lucide-react';
import type { JSX } from 'react';
import { useEffect, useState } from 'react';

import { type AgentInput, agentMarketplaceApi, type AgentMarketplaceItem } from '../api/agentMarketplace';
import { modelsApi } from '../api/models';
import { providersApi } from '../api/providers';
import { useAuth } from '../auth/useAuth';
import { ConfirmDialog } from '../components/ConfirmDialog';
import { useToast } from '../components/toastStore';
import { AgentCardGrid } from './agentManage/AgentCardGrid';
import { AgentDrawer } from './agentManage/drawer/AgentDrawer';
import { fill, t } from './agentManage/types';

const ADMIN_LIST_KEY = ['agent-marketplace', 'admin'] as const;
const SEARCH_DEBOUNCE_MS = 300;
const SKELETON_CARD_COUNT = 6;

export function AgentManagePage(): JSX.Element {
  const qc = useQueryClient();
  const toast = useToast();
  const { claims } = useAuth();
  const orgId = claims?.orgId ?? 'default-org';
  const [openMode, setOpenMode] = useState<'create' | 'edit' | null>(null);
  const [open, setOpen] = useState<AgentMarketplaceItem | null>(null);
  const [discard, setDiscard] = useState(false);
  const [search, setSearch] = useState('');
  const [committedSearch, setCommittedSearch] = useState('');
  const [confirmDelete, setConfirmDelete] = useState<null | { ids: string[]; names: string[]; agent: AgentMarketplaceItem }>(null);
  // agentId whose disable-confirm popover is open (null = none).
  const [disableOn, setDisableOn] = useState<string | null>(null);
  // agentId to flash (ring) after a create; cleared after ~2.2 s.
  const [flashId, setFlashId] = useState<string | null>(null);
  // agentId animating out after a confirmed delete.
  const [removingId, setRemovingId] = useState<string | null>(null);

  const agentsQuery = useQuery({ queryKey: ADMIN_LIST_KEY, queryFn: () => agentMarketplaceApi.list() });
  const skillsQuery = useQuery({ queryKey: ['agent-marketplace', 'skills-picker'],
    queryFn: () => agentMarketplaceApi.listSkillsForPicker() });
  const rolesQuery = useQuery({ queryKey: ['agent-marketplace', 'role-options'],
    queryFn: () => agentMarketplaceApi.listRoleOptions() });
  const modelsQuery = useQuery({ queryKey: ['models', orgId], queryFn: () => modelsApi.list(orgId) });
  // Org providers feed the model picker's vendor group headers (same key the
  // 模型配置 page uses, so the query is shared/cached across both pages).
  const providersQuery = useQuery({ queryKey: ['providers', orgId], queryFn: () => providersApi.list(orgId) });

  // Commit the raw input to the filter value after a 300 ms pause so typing
  // does not thrash the grid (and the no-result state only appears once the
  // user has stopped typing).
  useEffect(() => {
    const id = setTimeout(() => setCommittedSearch(search), SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(id);
  }, [search]);

  // The create flash is transient: clear the ring after ~2.2 s (the cleanup
  // also clears a pending timer if the page unmounts sooner).
  useEffect(() => {
    if (!flashId) return;
    const id = window.setTimeout(() => setFlashId(null), 2200);
    return () => window.clearTimeout(id);
  }, [flashId]);

  const clearSearch = (): void => {
    setSearch('');
    setCommittedSearch('');
  };

  const agents = agentsQuery.data ?? [];
  const filtered = agents.filter(a =>
    !committedSearch || a.name.toLowerCase().includes(committedSearch.toLowerCase())
    || a.description.toLowerCase().includes(committedSearch.toLowerCase()));

  const listError = agentsQuery.error as { status?: number } | null;
  const isNoAccess = agentsQuery.isError && listError?.status === 403;

  const refreshAll = (): void => {
    void qc.invalidateQueries({ queryKey: ['agent-marketplace'] });
  };

  const closeDrawer = (): void => {
    setOpenMode(null);
    setOpen(null);
  };

  // Create: close the drawer, flash the new card, and toast. (Reopening the
  // new agent in the drawer would hide the flash behind the 680 px overlay.)
  const createAgent = async (input: AgentInput): Promise<void> => {
    const out = await agentMarketplaceApi.createAgent(input);
    refreshAll();
    closeDrawer();
    setFlashId(out.agent_id);
    toast.success(t('agentmgmt.create.toast'));
  };

  // Save the current drawer draft: create a new agent or update the open one.
  // Errors are toasted here so the drawer stays open for the user to retry.
  const handleSave = async (input: AgentInput): Promise<void> => {
    try {
      if (openMode === 'create') {
        await createAgent(input);
      } else if (open) {
        await agentMarketplaceApi.update(open.agentId, input);
        refreshAll();
        closeDrawer();
        toast.success(t('agentmgmt.save.toast'));
      }
    } catch (e) {
      toast.error((e as Error).message || t('common.error'));
    }
  };

  // Optimistic enable/disable update with rollback; reports success so
  // callers can toast.
  const applyEnabled = async (agent: AgentMarketplaceItem, enabled: boolean): Promise<boolean> => {
    const prev = qc.getQueryData<AgentMarketplaceItem[]>(ADMIN_LIST_KEY);
    if (prev) qc.setQueryData(ADMIN_LIST_KEY, prev.map(a => a.agentId === agent.agentId ? { ...a, enabled } : a));
    try {
      await agentMarketplaceApi.update(agent.agentId, { enabled });
      refreshAll();
      return true;
    } catch (e) {
      if (prev) qc.setQueryData(ADMIN_LIST_KEY, prev);
      toast.error((e as Error).message || t('agentmgmt.toggleError'));
      return false;
    }
  };

  // Turning ON is a direct optimistic PUT; turning OFF asks for confirmation
  // first via a light popover anchored to the card (disableOn).
  const toggleEnabled = (agent: AgentMarketplaceItem, enabled: boolean): void => {
    if (enabled) {
      void applyEnabled(agent, true);
      return;
    }
    setDisableOn(agent.agentId);
  };

  const confirmDisable = (): void => {
    const id = disableOn;
    setDisableOn(null);
    if (!id) return;
    const agent = agents.find(a => a.agentId === id);
    if (!agent) return;
    void applyEnabled(agent, false).then(ok => {
      if (ok) toast.success(t('agentmgmt.save.toast'));
    });
  };

  const cancelDisable = (): void => {
    setDisableOn(null);
  };

  // Delete: pre-check cross-references, then confirm, then remove.
  const beginDelete = async (agent: AgentMarketplaceItem): Promise<void> => {
    try {
      const refs = await agentMarketplaceApi.getReferences(agent.agentId);
      setConfirmDelete({ ids: refs.ids, names: refs.names, agent });
    } catch (e) {
      toast.error((e as Error).message);
    }
  };

  const doDelete = async (): Promise<void> => {
    if (!confirmDelete) return;
    const id = confirmDelete.agent.agentId;
    try {
      await agentMarketplaceApi.remove(id);
      setConfirmDelete(null);
      // Animate the card out, then refresh (the list no longer contains it).
      // Timing-fragile in jsdom — covered by the DELETE-call test, not its own.
      setRemovingId(id);
      window.setTimeout(() => {
        setRemovingId(null);
        refreshAll();
      }, 160);
    } catch (e) {
      toast.error((e as Error).message);
    }
  };

  return (
    <div className="p-8 flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-baseline gap-2">
          <h1 className="text-lg font-semibold">{t('agentmgmt.title')}</h1>
          <span className="text-sm text-muted">{fill(t('agentmgmt.count'), { n: filtered.length })}</span>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <div className="relative min-w-0">
            <Search size={14} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-muted" />
            <input
              role="searchbox"
              aria-label={t('agentmgmt.search')}
              className="h-9 w-64 min-w-0 max-w-full rounded-lg border border-border bg-surface pl-8 pr-8 text-sm"
              placeholder={t('agentmgmt.searchPlaceholder')}
              value={search}
              onChange={e => setSearch(e.target.value)}
            />
            {search ? (
              <button type="button" onClick={clearSearch}
                      aria-label={t('agentmgmt.noResult.clear')}
                      className="absolute right-2 top-1/2 -translate-y-1/2 rounded p-0.5 text-muted hover:opacity-70">
                <X size={14} />
              </button>
            ) : null}
          </div>
          <button type="button" onClick={() => { setOpen(null); setOpenMode('create'); }}
                  className="h-9 shrink-0 px-4 text-sm rounded-lg bg-primary text-white">
            {t('agentmgmt.addAgent')}
          </button>
        </div>
      </div>
      {agentsQuery.isPending ? (
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3.5">
          {Array.from({ length: SKELETON_CARD_COUNT }, (_, i) => (
            <div key={i} className="h-40 animate-pulse rounded-lg border border-border bg-surface opacity-60" />
          ))}
        </div>
      ) : isNoAccess ? (
        <div className="rounded-lg border border-dashed border-[var(--border-default)] p-10 text-center">
          <div className="text-sm font-medium">{t('agentmgmt.noAccess.title')}</div>
          <p className="mt-2 text-sm text-muted">{t('agentmgmt.noAccess.body')}</p>
        </div>
      ) : agentsQuery.isError ? (
        <div className="rounded-lg border border-dashed border-[var(--border-default)] p-10 text-center">
          <div className="text-sm font-medium">{t('agentmgmt.loadError.title')}</div>
          <p className="mt-2 text-sm text-muted">{t('agentmgmt.loadError.body')}</p>
          <button type="button" onClick={() => agentsQuery.refetch()}
                  className="mt-4 h-9 px-4 text-sm rounded-lg border border-border bg-surface">
            {t('agentmgmt.retry')}
          </button>
        </div>
      ) : filtered.length === 0 && search ? (
        <div className="rounded-lg border border-dashed border-[var(--border-default)] p-10 text-center">
          <div className="text-sm font-medium">{fill(t('agentmgmt.noResult.title'), { q: search })}</div>
          <button type="button" onClick={clearSearch}
                  className="mt-4 h-9 px-4 text-sm rounded-lg border border-border bg-surface">
            {t('agentmgmt.noResult.clear')}
          </button>
        </div>
      ) : agents.length === 0 ? (
        <div className="rounded-lg border border-dashed border-[var(--border-default)] p-10 text-center text-sm text-[var(--text-secondary)]">
          <div className="font-medium">{t('agentmgmt.empty')}</div>
          <p className="mt-2 text-muted">{t('agentmgmt.empty.hint')}</p>
          <ol className="mx-auto mt-4 max-w-md list-decimal space-y-1 pl-5 text-left text-muted">
            <li>{t('agentmgmt.empty.step1')}</li>
            <li>{t('agentmgmt.empty.step2')}</li>
            <li>{t('agentmgmt.empty.step3')}</li>
          </ol>
          <p className="mt-4 text-xs text-muted">{t('agentmgmt.empty.note')}</p>
        </div>
      ) : (
        <AgentCardGrid
          agents={filtered}
          providers={providersQuery.data ?? []}
          onToggle={toggleEnabled}
          onOpen={(a) => { setOpen(a); setOpenMode('edit'); }}
          onDelete={beginDelete}
          disableOn={disableOn}
          onConfirmDisable={confirmDisable}
          onCancelDisable={cancelDisable}
          flashId={flashId}
          removingId={removingId}
        />
      )}
      {openMode !== null ? (
        <AgentDrawer
          key={openMode === 'edit' && open ? open.agentId : 'create'}
          mode={openMode}
          agent={open ?? undefined}
          roleOptions={rolesQuery.data?.roles ?? []}
          skills={(skillsQuery.data ?? []).filter(s => s.enabled !== false)}
          agents={agents}
          models={modelsQuery.data ?? []}
          providers={providersQuery.data ?? []}
          modelsError={modelsQuery.isError}
          onSave={handleSave}
          onClose={closeDrawer}
          onDiscardRequest={() => setDiscard(true)}
        />
      ) : null}
      {discard ? (
        <ConfirmDialog
          open
          title={t('agentmgmt.discard.title')}
          message={t('agentmgmt.discard.body')}
          cancelLabel={t('agentmgmt.discard.stay')}
          confirmLabel={t('agentmgmt.discard.discard')}
          onCancel={() => setDiscard(false)}
          onConfirm={() => { setDiscard(false); closeDrawer(); }}
        />
      ) : null}
      {confirmDelete ? (
        <ConfirmDialog
          open
          destructive
          title={fill(t('agentmgmt.delete.title'), { name: confirmDelete.agent.name })}
          message={
            (confirmDelete.ids.length > 0
              ? fill(t('agentmgmt.delete.refNames'), { n: confirmDelete.ids.length, names: confirmDelete.names.join('、') }) + ' '
              : '') + t('agentmgmt.delete.unrecoverable')
          }
          cancelLabel={t('common.cancel')}
          confirmLabel={t('common.delete')}
          onCancel={() => setConfirmDelete(null)}
          onConfirm={doDelete}
        />
      ) : null}
    </div>
  );
}
