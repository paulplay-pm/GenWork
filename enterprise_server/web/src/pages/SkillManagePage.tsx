import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { JSX } from 'react';
import { useEffect, useMemo, useState } from 'react';

import { departmentsApi } from '../api/departments';
import { type SkillAdmin, skillMarketplaceApi } from '../api/skillMarketplace';
import { usersApi } from '../api/users';
import { useAuth } from '../auth/useAuth';
import { ConfirmDialog } from '../components/ConfirmDialog';
import { Switch } from '../components/Switch';
import { useToast } from '../components/toastStore';
import { t } from '../i18n';
import { AddCategoryModal } from './skillManage/AddCategoryModal';
import { CategorySidebar } from './skillManage/CategorySidebar';
import { DeleteSkillModal } from './skillManage/DeleteSkillModal';
import { SkillDrawer, type SkillDrawerSaveInput } from './skillManage/SkillDrawer';
import { SkillReviewView } from './skillManage/SkillReviewView';
import { SkillTable } from './skillManage/SkillTable';
import { fill, UNCATEGORIZED } from './skillManage/types';

type View = 'org' | 'review';

/**
 * The skill admin console (two-tab shell per the MCPManagePage shape):
 *  - 组织技能: category rail + 7-column skill table + the two-stage
 *    create/edit SkillDrawer (zip-first: parse → name/version from the
 *    bytes → metadata + org-scope → save);
 *  - 技能审核: the member-submission review queue (SkillReviewView:
 *    status chips, list, detail drawer, forced-reject modal).
 * Plus the global "members can submit" setting card.
 */
export function SkillManagePage(): JSX.Element {
  const qc = useQueryClient();
  const toast = useToast();
  const { claims } = useAuth();
  const orgId = claims?.orgId ?? 'default-org';

  const [view, setView] = useState<View>('org');
  const [current, setCurrent] = useState('all');
  const [search, setSearch] = useState('');
  const [openCreate, setOpenCreate] = useState(false);
  const [openId, setOpenId] = useState<string | null>(null);
  // The scope picker (inside the drawer) closes on its own Esc first; while
  // it is open the page's Esc handler must not also close the drawer.
  const [scopePickerOpen, setScopePickerOpen] = useState(false);
  const [addingCategory, setAddingCategory] = useState(false);
  const [deletingCategory, setDeletingCategory] = useState<{ id: string; name: string } | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<SkillAdmin | null>(null);
  const [deleteBusy, setDeleteBusy] = useState(false);
  const [settingsBusy, setSettingsBusy] = useState(false);

  const skillsQ = useQuery({ queryKey: ['skillmgmt', 'skills'], queryFn: skillMarketplaceApi.listSkills });
  const catsQ = useQuery({ queryKey: ['skillmgmt', 'categories'], queryFn: skillMarketplaceApi.listCategories });
  const deptsQ = useQuery({ queryKey: ['org', 'depts', orgId], queryFn: () => departmentsApi.list(orgId) });
  const membersQ = useQuery({ queryKey: ['org', 'members', orgId], queryFn: () => usersApi.list(orgId) });
  const settingsQ = useQuery({ queryKey: ['skillmgmt', 'settings'], queryFn: skillMarketplaceApi.getSettings });
  const subsQ = useQuery({ queryKey: ['skillmgmt', 'submissions'], queryFn: () => skillMarketplaceApi.listSubmissions() });

  const skills = useMemo<SkillAdmin[]>(() => skillsQ.data ?? [], [skillsQ.data]);
  const categories = catsQ.data ?? [];
  const submissions = useMemo(() => subsQ.data?.submissions ?? [], [subsQ.data]);
  const membersCanSubmit = settingsQ.data?.membersCanSubmit ?? false;

  const pendingCount = useMemo(
    () => submissions.filter((s) => s.status === 'pending').length,
    [submissions],
  );

  const q = search.trim().toLowerCase();
  const matchesSearch = (name: string) => !q || name.toLowerCase().includes(q);
  const filtered = skills.filter((s) => (current === 'all' || s.category === current) && matchesSearch(s.name));
  const counts = useMemo(() => {
    const c: Record<string, number> = {};
    for (const s of skills) if (!q || s.name.toLowerCase().includes(q)) c[s.category] = (c[s.category] ?? 0) + 1;
    return c;
  }, [skills, q]);

  const invalidate = (): void => {
    void qc.invalidateQueries({ queryKey: ['skillmgmt', 'skills'] });
    void qc.invalidateQueries({ queryKey: ['skillmgmt', 'categories'] });
  };

  const openSkill = skills.find((s) => s.id === openId) ?? null;

  useEffect(() => {
    function onKey(e: KeyboardEvent): void {
      if (e.key !== 'Escape') return;
      if (deleteTarget) return; // the delete modal handles its own Esc first
      if (scopePickerOpen) return; // the scope picker handles its own Esc first
      if (openId) setOpenId(null);
      else if (openCreate) setOpenCreate(false);
    }
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [openId, openCreate, scopePickerOpen, deleteTarget]);

  const errorMessage = (e: unknown): string => (e instanceof Error ? e.message : String(e));

  const closeCreate = (): void => {
    setOpenCreate(false);
    setScopePickerOpen(false);
  };

  const closeEdit = (): void => {
    setOpenId(null);
    setScopePickerOpen(false);
  };

  /** Drawer save (create): the parsed tempToken references the server-side
   * tmp zip from parseZip; name/version are read from it server-side. */
  const onSaveCreate = (input: SkillDrawerSaveInput): void => {
    if (!input.parsed) return;
    skillMarketplaceApi
      .createSkill({
        tempToken: input.parsed.tempToken,
        nameZh: input.nameZh,
        author: input.author,
        category_id: input.category_id,
        desc: input.desc,
        icon: input.icon,
        scope: input.scope,
      })
      .then(() => {
        toast.success(t('skillmgmt.toast.created'));
        closeCreate();
        invalidate();
      })
      .catch((e: unknown) => toast.error(errorMessage(e)));
  };

  /** Drawer save (edit): base PATCH first; a replacement zip (if one was
   * picked) is uploaded only after the patch lands. */
  const onSaveEdit = (input: SkillDrawerSaveInput): void => {
    if (!openSkill) return;
    const id = openSkill.id;
    skillMarketplaceApi
      .updateSkill(id, {
        nameZh: input.nameZh,
        author: input.author,
        desc: input.desc,
        icon: input.icon,
        category_id: input.category_id,
        scope: input.scope,
      })
      .then(() => (input.newZip ? skillMarketplaceApi.uploadZip(id, input.newZip) : undefined))
      .then(() => {
        toast.success(t('skillmgmt.toast.updated'));
        if (input.category_id && input.category_id !== current) setCurrent(input.category_id);
        closeEdit();
        invalidate();
      })
      .catch((e: unknown) => toast.error(errorMessage(e)));
  };

  /** Shared delete entry (table rows + drawer footer): open the impact-list
   * modal; the actual delete runs from the modal's confirm. */
  const requestDelete = (s: SkillAdmin): void => {
    setDeleteTarget(s);
  };

  /** Modal confirm: delete, invalidate, and close the drawer if it was the
   * deleted skill's. */
  const confirmDeleteSkill = (): void => {
    if (!deleteTarget) return;
    const id = deleteTarget.id;
    setDeleteBusy(true);
    skillMarketplaceApi
      .deleteSkill(id)
      .then(() => {
        invalidate();
        toast.success(t('skillmgmt.table.deleted'));
        if (openId === id) setOpenId(null);
        setDeleteTarget(null);
      })
      .catch((e: unknown) => toast.error(errorMessage(e)))
      .finally(() => setDeleteBusy(false));
  };

  const onSettingsToggle = (next: boolean): void => {
    if (settingsBusy) return;
    setSettingsBusy(true);
    skillMarketplaceApi
      .setSettings({ membersCanSubmit: next })
      .then(() => {
        toast.success(t('skillmgmt.settings.saved'));
        void qc.invalidateQueries({ queryKey: ['skillmgmt', 'settings'] });
      })
      .catch((e: unknown) => toast.error(e instanceof Error ? e.message : String(e)))
      .finally(() => setSettingsBusy(false));
  };

  const onToggleSkill = (id: string, enabled: boolean): void => {
    skillMarketplaceApi.updateSkill(id, { enabled }).then(invalidate).catch(() => undefined);
  };

  // Approve/reject resolve only on success: on API failure the error toast
  // is shown here and the error is rethrown so the review view keeps the
  // drawer/modal open for a retry.
  const approveSubmission = async (id: string): Promise<void> => {
    try {
      await skillMarketplaceApi.approveSubmission(id);
    } catch (e) {
      toast.error(errorMessage(e));
      throw e;
    }
    const name = submissions.find((s) => s.id === id)?.name ?? '';
    toast.success(fill(t('skillmgmt.review.approvedToast'), { name }));
    invalidate();
    void qc.invalidateQueries({ queryKey: ['skillmgmt', 'submissions'] });
  };

  const rejectSubmission = async (id: string, reason: string): Promise<void> => {
    try {
      await skillMarketplaceApi.rejectSubmission(id, reason);
    } catch (e) {
      toast.error(errorMessage(e));
      throw e;
    }
    const name = submissions.find((s) => s.id === id)?.name ?? '';
    toast.success(fill(t('skillmgmt.review.rejectedToast'), { name }));
    invalidate();
    void qc.invalidateQueries({ queryKey: ['skillmgmt', 'submissions'] });
  };

  const deleteCategory = (id: string, name: string): void => {
    setDeletingCategory({ id, name });
  };

  const confirmDeleteCategory = (): void => {
    if (!deletingCategory) return;
    const { id } = deletingCategory;
    setDeletingCategory(null);
    skillMarketplaceApi.deleteCategory(id).then(invalidate).catch(() => undefined);
    if (current === id) setCurrent('all');
  };

  const addCategory = (name: string): void => {
    const slug = name.toLowerCase().replace(/\s+/g, '-');
    setAddingCategory(false);
    // TODO(T11): server now generates the slug; `slug` local + setCurrent(slug) are transitional (T9)
    skillMarketplaceApi.createCategory({ name_zh: name, name_en: name })
      .then(() => { invalidate(); setCurrent(slug); })
      .catch(() => undefined);
  };

  const categoryName = current === 'all'
    ? t('skillmgmt.all')
    : categories.find((c) => c.id === current)?.name_zh ?? current;
  const deletingCategoryNameCount = deletingCategory ? skills.filter((s) => s.category === deletingCategory.id).length : 0;

  const tabs: { id: View; label: string; count: number }[] = [
    { id: 'org', label: t('skillmgmt.viewTab.org'), count: skills.length },
    { id: 'review', label: t('skillmgmt.viewTab.review'), count: pendingCount },
  ];

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* Top bar: page head, global setting card, view tabs. */}
      <header className="shrink-0 border-b border-[var(--border-default)] px-6 pt-5">
        <div className="flex items-start justify-between gap-4">
          <div>
            <h1 className="text-xl font-semibold tracking-tight text-[var(--text-primary)]">{t('skillmgmt.tabs.org')}</h1>
            <p className="mt-1 text-sm text-[var(--text-secondary)]">{t('skillmgmt.settings.pageSubtitle')}</p>
          </div>
          <button
            type="button"
            onClick={() => setOpenCreate(true)}
            className="shrink-0 rounded-[6px] bg-[var(--accent-primary)] px-3.5 py-2 text-[13px] text-white hover:bg-[var(--accent-primary-hover)]"
          >
            {t('skillmgmt.addSkill')}
          </button>
        </div>

        <div className="my-4 flex max-w-[560px] items-center justify-between gap-3 rounded-[8px] border border-[var(--border-default)] bg-[var(--bg-secondary)] p-4">
          <div>
            <div className="text-[14px] font-semibold text-[var(--text-primary)]">{t('skillmgmt.settings.title')}</div>
            <div className="mt-0.5 text-[12.5px] leading-snug text-[var(--text-tertiary)]">{t('skillmgmt.settings.desc')}</div>
          </div>
          <Switch
            checked={membersCanSubmit}
            onChange={onSettingsToggle}
            disabled={settingsBusy}
            label={t('skillmgmt.settings.title')}
          />
        </div>

        <nav className="flex gap-6" aria-label={t('skillmgmt.tabs.org')}>
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

      {/* Content: org skills (rail + table) or the review queue. */}
      <div className="flex min-h-0 flex-1">
        {view === 'org' ? (
          <>
            <CategorySidebar
              categories={categories}
              counts={counts}
              total={skills.filter((s) => matchesSearch(s.name)).length}
              current={current}
              onSelect={setCurrent}
              onAdd={() => setAddingCategory(true)}
              onDelete={deleteCategory}
              search={search}
              onSearch={setSearch}
            />
            <SkillTable
              skills={filtered}
              categoryName={categoryName}
              current={current}
              onAdd={() => setOpenCreate(true)}
              onEdit={(s) => setOpenId(s.id)}
              onToggle={onToggleSkill}
              onDelete={requestDelete}
            />
          </>
        ) : (
          <div className="min-w-0 flex-1 overflow-y-auto p-6">
            <SkillReviewView
              submissions={submissions}
              members={membersQ.data ?? []}
              onApprove={approveSubmission}
              onReject={rejectSubmission}
            />
          </div>
        )}
      </div>

      {/* Two-stage create/edit drawer (zip-first; name/version come from the
          parsed package, never hand-typed). */}
      {openCreate && (
        <>
          <div className="fixed inset-0 z-[100] bg-[rgba(15,23,42,0.35)]" onClick={closeCreate} />
          <SkillDrawer
            mode="create"
            categories={categories}
            depts={deptsQ.data ?? []}
            members={membersQ.data ?? []}
            defaultCategory={current === 'all' ? (categories[0]?.id ?? UNCATEGORIZED) : current}
            onCancel={closeCreate}
            onSave={onSaveCreate}
            onScopePickerOpenChange={setScopePickerOpen}
          />
        </>
      )}

      {openSkill && (
        <>
          <div className="fixed inset-0 z-[100] bg-[rgba(15,23,42,0.35)]" onClick={closeEdit} />
          <SkillDrawer
            mode="edit"
            skill={openSkill}
            categories={categories}
            depts={deptsQ.data ?? []}
            members={membersQ.data ?? []}
            onCancel={closeEdit}
            onSave={onSaveEdit}
            onDelete={() => requestDelete(openSkill)}
            onScopePickerOpenChange={setScopePickerOpen}
          />
        </>
      )}

      <AddCategoryModal
        open={addingCategory}
        onSave={addCategory}
        onCancel={() => setAddingCategory(false)}
      />
      <ConfirmDialog
        open={deletingCategory !== null}
        title={t('skillmgmt.categoryDelete.title')}
        message={deletingCategory
          ? (deletingCategoryNameCount > 0
            ? fill(t('skillmgmt.categoryDelete.confirm'), { name: deletingCategory.name, n: deletingCategoryNameCount })
            : fill(t('skillmgmt.categoryDelete.confirmEmpty'), { name: deletingCategory.name }))
          : ''}
        confirmLabel={t('common.delete')}
        cancelLabel={t('common.cancel')}
        destructive
        onConfirm={confirmDeleteCategory}
        onCancel={() => setDeletingCategory(null)}
      />
      <DeleteSkillModal
        open={deleteTarget !== null}
        name={deleteTarget ? (deleteTarget.name_zh || deleteTarget.name) : ''}
        scopeSummary={deleteTarget?.scopeSummary ?? ''}
        useCount30d={deleteTarget?.useCount30d ?? 0}
        busy={deleteBusy}
        onConfirm={confirmDeleteSkill}
        onCancel={() => setDeleteTarget(null)}
      />
    </div>
  );
}
