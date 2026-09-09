import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { JSX, MouseEvent } from 'react';
import { useMemo, useState } from 'react';

import { connectorApi, type Connector } from '../api/connectors';
import { departmentsApi } from '../api/departments';
import { usersApi } from '../api/users';
import { useAuth } from '../auth/useAuth';
import { Switch } from '../components/Switch';
import { useToast } from '../components/toastStore';
import { t } from '../i18n';
import { AddCategoryModal } from './mcpManage/AddCategoryModal';
import { ConnectorCardGrid, type ConnectorTypeFilter } from './mcpManage/ConnectorCardGrid';
import { ConnectorCardMenu } from './mcpManage/ConnectorCardMenu';
import { ConnectorCategoryPanel } from './mcpManage/ConnectorCategoryPanel';
import { ConnectorDrawer } from './mcpManage/ConnectorDrawer';
import { DeleteConnectorModal } from './mcpManage/DeleteConnectorModal';
import { ReviewView } from './mcpManage/ReviewView';
import { fill } from './mcpManage/types';

type View = 'org' | 'review';
type DrawerState = { mode: 'create' } | { mode: 'edit'; id: string } | null;

/** Map a thrown API error to a user-facing message (mirrors the drawer). */
function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/**
 * The MCP admin console (two-tab shell per the prototype):
 *  - 企业连接器: category rail + connector card grid + create/edit drawer +
 *    card ⋯ menu + add-category / delete-connector modals;
 *  - 连接器审核: the member-submission review queue (approve / reject with a
 *    forced reason).
 * Plus the global "members can submit" setting card.
 */
export function MCPManagePage(): JSX.Element {
  const { claims } = useAuth();
  const orgId = claims?.orgId ?? 'default-org';
  const qc = useQueryClient();
  const toast = useToast();

  const [view, setView] = useState<View>('org');
  const [current, setCurrent] = useState('all');
  const [search, setSearch] = useState('');
  const [typeFilter, setTypeFilter] = useState<ConnectorTypeFilter>('all');
  const [drawer, setDrawer] = useState<DrawerState>(null);
  const [menu, setMenu] = useState<{ x: number; y: number; id: string } | null>(null);
  const [addingCategory, setAddingCategory] = useState(false);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [settingsBusy, setSettingsBusy] = useState(false);

  const connectorsQ = useQuery({
    queryKey: ['connector', 'list', orgId],
    queryFn: () => connectorApi.list(orgId),
  });
  const catsQ = useQuery({
    queryKey: ['connector', 'categories', orgId],
    queryFn: () => connectorApi.listCategories(orgId),
  });
  const subsQ = useQuery({
    queryKey: ['connector', 'submissions', orgId],
    queryFn: () => connectorApi.listSubmissions(orgId),
  });
  const deptsQ = useQuery({ queryKey: ['org', 'depts', orgId], queryFn: () => departmentsApi.list(orgId) });
  const membersQ = useQuery({ queryKey: ['org', 'members', orgId], queryFn: () => usersApi.list(orgId) });
  const settingsQ = useQuery({
    queryKey: ['connector', 'settings', orgId],
    queryFn: () => connectorApi.getSettings(orgId),
  });
  // Edit-mode detail fetch: the LIST row feeds the form; the detail feeds only
  // the version history (the list endpoint does not carry `versions`).
  const editId = drawer?.mode === 'edit' ? drawer.id : null;
  const detailQ = useQuery({
    queryKey: ['connector', 'detail', editId],
    queryFn: async () => (editId ? connectorApi.get(editId) : null),
    enabled: editId !== null,
  });

  const connectors = useMemo<Connector[]>(() => connectorsQ.data ?? [], [connectorsQ.data]);
  const categories = catsQ.data ?? [];
  const submissions = subsQ.data?.submissions ?? [];
  const depts = deptsQ.data ?? [];
  const members = membersQ.data ?? [];
  const membersCanSubmit = settingsQ.data?.membersCanSubmit ?? false;

  const pendingCount = useMemo(
    () => submissions.filter((s) => s.status === 'pending').length,
    [submissions],
  );

  const catConnectors = useMemo(
    () => connectors.filter((c) => current === 'all' || c.categoryId === current),
    [connectors, current],
  );
  // The grid header shows the TYPE-FILTERED count (must match the visible
  // grid — the grid itself applies the type filter).
  const typeFilteredCount = catConnectors.filter(
    (c) => typeFilter === 'all' || c.connectorType === typeFilter,
  ).length;

  const counts = useMemo(() => {
    const c: Record<string, number> = {};
    for (const x of connectors) if (x.categoryId) c[x.categoryId] = (c[x.categoryId] ?? 0) + 1;
    return c;
  }, [connectors]);

  const categoryName = current === 'all'
    ? t('mcp.all')
    : categories.find((c) => c.id === current)?.name ?? current;

  const invalidateConnectors = (): void => {
    void qc.invalidateQueries({ queryKey: ['connector', 'list'] });
    void qc.invalidateQueries({ queryKey: ['connector', 'categories'] });
    // The edit-mode detail (version history) is part of the connector data.
    void qc.invalidateQueries({ queryKey: ['connector', 'detail'] });
  };
  const invalidateSubmissions = (): void => {
    void qc.invalidateQueries({ queryKey: ['connector', 'submissions'] });
  };

  const displayName = (c: Connector | undefined): string =>
    c ? (c.nameZh ?? c.nameEn ?? c.serverKey) : '';

  const toggleConnector = (id: string, enabled: boolean): void => {
    const name = displayName(connectors.find((c) => c.id === id));
    connectorApi
      .patch(id, { enabled })
      .then(() => {
        invalidateConnectors();
        toast.success(fill(enabled ? t('mcp.toast.enabled') : t('mcp.toast.disabled'), { name }));
      })
      .catch((e: unknown) => toast.error(errorMessage(e)));
  };

  const openEdit = (id: string): void => {
    setMenu(null);
    setDrawer({ mode: 'edit', id });
  };

  const onMenuOpen = (e: MouseEvent, id: string): void => setMenu({ x: e.clientX, y: e.clientY, id });

  // Approve/reject resolve only on success: on API failure the error toast
  // is shown here and the error is rethrown so the review view keeps the
  // drawer/modal open for a retry.
  const approveSubmission = async (id: string): Promise<void> => {
    try {
      await connectorApi.approveSubmission(id);
    } catch (e) {
      toast.error(errorMessage(e));
      throw e;
    }
    const name = submissions.find((s) => s.id === id)?.name ?? '';
    toast.success(fill(t('mcp.review.approvedToast'), { name }));
    invalidateSubmissions();
    invalidateConnectors();
  };

  const rejectSubmission = async (id: string, reason: string): Promise<void> => {
    try {
      await connectorApi.rejectSubmission(id, reason);
    } catch (e) {
      toast.error(errorMessage(e));
      throw e;
    }
    const name = submissions.find((s) => s.id === id)?.name ?? '';
    toast.success(fill(t('mcp.review.rejectedToast'), { name }));
    invalidateSubmissions();
  };

  const onSettingsToggle = (next: boolean): void => {
    if (settingsBusy) return;
    setSettingsBusy(true);
    connectorApi
      .setSettings(orgId, { membersCanSubmit: next })
      .then(() => {
        toast.success(t('mcp.globalSetting.saved'));
        void qc.invalidateQueries({ queryKey: ['connector', 'settings'] });
      })
      .catch((e: unknown) => toast.error(errorMessage(e)))
      .finally(() => setSettingsBusy(false));
  };

  const addCategory = (name: string): Promise<void> =>
    connectorApi.createCategory(orgId, name).then(() => {
      setAddingCategory(false);
      invalidateConnectors();
    });

  const deleteTarget = deletingId ? (connectors.find((c) => c.id === deletingId) ?? null) : null;
  const confirmDelete = async (): Promise<void> => {
    if (!deletingId) return;
    const id = deletingId;
    const name = displayName(connectors.find((c) => c.id === id));
    setDeleting(true);
    try {
      await connectorApi.del(id);
      toast.success(fill(t('mcpDrawer.toast.deleted'), { name }));
      setDeletingId(null);
      invalidateConnectors();
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setDeleting(false);
    }
  };

  const editConnector =
    drawer?.mode === 'edit' ? (connectors.find((c) => c.id === drawer.id) ?? undefined) : undefined;
  const menuConnector = menu ? (connectors.find((c) => c.id === menu.id) ?? null) : null;

  const tabs: { id: View; label: string; count: number }[] = [
    { id: 'org', label: t('mcp.viewTab.org'), count: connectors.length },
    { id: 'review', label: t('mcp.viewTab.review'), count: pendingCount },
  ];

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* Top bar: page head, global setting card, view tabs. */}
      <header className="shrink-0 border-b border-[var(--border-default)] px-6 pt-5">
        <div className="flex items-start justify-between gap-4">
          <div>
            <h1 className="text-xl font-semibold tracking-tight text-[var(--text-primary)]">{t('mcp.tabs.org')}</h1>
            <p className="mt-1 text-sm text-[var(--text-secondary)]">{t('mcp.page.subtitle')}</p>
          </div>
          <button
            type="button"
            onClick={() => setDrawer({ mode: 'create' })}
            className="shrink-0 rounded-[6px] bg-[var(--accent-primary)] px-3.5 py-2 text-[13px] text-white hover:bg-[var(--accent-primary-hover)]"
          >
            {t('mcp.addConnector')}
          </button>
        </div>

        <div className="my-4 flex max-w-[560px] items-center justify-between gap-3 rounded-[8px] border border-[var(--border-default)] bg-[var(--bg-secondary)] p-4">
          <div>
            <div className="text-[14px] font-semibold text-[var(--text-primary)]">{t('mcp.globalSetting.title')}</div>
            <div className="mt-0.5 text-[12.5px] leading-snug text-[var(--text-tertiary)]">
              {t('mcp.globalSetting.desc')}
            </div>
          </div>
          <Switch
            checked={membersCanSubmit}
            onChange={onSettingsToggle}
            disabled={settingsBusy}
            label={t('mcp.globalSetting.title')}
          />
        </div>

        <nav className="flex gap-6" aria-label={t('mcp.tabs.org')}>
          {tabs.map((tab) => {
            const on = view === tab.id;
            return (
              <button
                key={tab.id}
                type="button"
                onClick={() => setView(tab.id)}
                className={`-mb-px flex items-center gap-1.5 border-b-2 px-0 pb-2.5 text-[14.5px] font-medium transition ${on
                  ? 'border-[var(--text-primary)] text-[var(--text-primary)]'
                  : 'border-transparent text-[var(--text-secondary)] hover:text-[var(--text-primary)]'}`}
              >
                {tab.label}
                <span
                  className={`rounded-full px-1.5 text-[11.5px] ${on
                    ? 'bg-[var(--text-primary)] text-white'
                    : 'bg-[var(--bg-tertiary)] text-[var(--text-tertiary)]'}`}
                >
                  {tab.count}
                </span>
              </button>
            );
          })}
        </nav>
      </header>

      {/* Content: org connectors (rail + grid) or the review queue. */}
      <div className="flex min-h-0 flex-1">
        {view === 'org' ? (
          <>
            <ConnectorCategoryPanel
              categories={categories}
              counts={counts}
              total={connectors.length}
              current={current}
              onSelect={setCurrent}
              onAdd={() => setAddingCategory(true)}
              search={search}
              onSearch={setSearch}
            />
            <ConnectorCardGrid
              connectors={catConnectors}
              typeFilter={typeFilter}
              onTypeFilter={setTypeFilter}
              categoryName={categoryName}
              count={typeFilteredCount}
              onOpen={openEdit}
              onToggle={toggleConnector}
              onMenuOpen={onMenuOpen}
            />
          </>
        ) : (
          <div className="min-w-0 flex-1 overflow-y-auto p-6">
            <ReviewView
              submissions={submissions}
              members={members}
              onApprove={approveSubmission}
              onReject={rejectSubmission}
            />
          </div>
        )}
      </div>

      {drawer && (
        <ConnectorDrawer
          mode={drawer.mode}
          orgId={orgId}
          connector={drawer.mode === 'edit' ? editConnector : undefined}
          depts={depts}
          members={members}
          categories={categories}
          versions={detailQ.data?.versions}
          draft={detailQ.data?.draft ?? null}
          onClose={() => setDrawer(null)}
          onSaved={() => {
            setDrawer(null);
            invalidateConnectors();
          }}
          onDeleted={() => {
            setDrawer(null);
            invalidateConnectors();
          }}
          onDraftSaved={invalidateConnectors}
          onRolledBack={invalidateConnectors}
          onTested={invalidateConnectors}
        />
      )}

      {menu && menuConnector && (
        <ConnectorCardMenu
          open
          x={menu.x}
          y={menu.y}
          connector={menuConnector}
          onClose={() => setMenu(null)}
          onEdit={openEdit}
          onToggle={toggleConnector}
          onDelete={(id) => setDeletingId(id)}
        />
      )}

      <DeleteConnectorModal
        open={deleteTarget !== null}
        connector={deleteTarget}
        busy={deleting}
        onConfirm={confirmDelete}
        onCancel={() => setDeletingId(null)}
      />

      <AddCategoryModal
        open={addingCategory}
        onSave={addCategory}
        onCancel={() => setAddingCategory(false)}
      />
    </div>
  );
}
