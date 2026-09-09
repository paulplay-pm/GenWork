import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { JSX } from 'react';
import { useEffect, useMemo, useState } from 'react';

import { departmentsApi } from '../api/departments';
import { type KitAdmin, kitCatalogApi } from '../api/kitCatalog';
import { usersApi } from '../api/users';
import { useAuth } from '../auth/useAuth';
import { ConfirmDialog } from '../components/ConfirmDialog';
import { useToast } from '../components/toastStore';
import { t } from '../i18n';
import { PermissionPoint } from '../shared/permissions';
import { AddCategoryModal } from './kitManage/AddCategoryModal';
import { CategorySidebar } from './kitManage/CategorySidebar';
import { DeleteKitModal } from './kitManage/DeleteKitModal';
import { KitDrawer, type KitDrawerSaveInput } from './kitManage/KitDrawer';
import { KitTable } from './kitManage/KitTable';
import { fill, UNCATEGORIZED } from './kitManage/types';

/**
 * 套件管理 page (mirrors SkillManagePage with the review-queue + settings-card
 * pieces dropped). One-tab shell: category rail + kit card-grid +
 * two-stage create/edit KitDrawer. Kits have no member-submission flow, so
 * there's no review queue or `membersCanSubmit` setting.
 */
export function KitManagePage(): JSX.Element {
  const qc = useQueryClient();
  const toast = useToast();
  const { claims, hasCapability } = useAuth();
  const orgId = claims?.orgId ?? 'default-org';

  const canView = hasCapability(PermissionPoint.KitView);
  const canCreate = hasCapability(PermissionPoint.KitCreate);
  const canEdit = hasCapability(PermissionPoint.KitEdit);
  const canToggle = hasCapability(PermissionPoint.KitToggle);
  const canDelete = hasCapability(PermissionPoint.KitDelete);

  const [current, setCurrent] = useState('all');
  const [search, setSearch] = useState('');
  const [openCreate, setOpenCreate] = useState(false);
  const [openId, setOpenId] = useState<string | null>(null);
  const [scopePickerOpen, setScopePickerOpen] = useState(false);
  const [addingCategory, setAddingCategory] = useState(false);
  const [deletingCategory, setDeletingCategory] = useState<{ id: string; name: string } | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<KitAdmin | null>(null);
  const [deleteBusy, setDeleteBusy] = useState(false);

  const kitsQ = useQuery({
    queryKey: ['kitmgmt', 'kits'],
    queryFn: kitCatalogApi.listKits,
    enabled: canView,
  });
  const catsQ = useQuery({
    queryKey: ['kitmgmt', 'categories'],
    queryFn: kitCatalogApi.listCategories,
    enabled: canView,
  });
  const deptsQ = useQuery({ queryKey: ['org', 'depts', orgId], queryFn: () => departmentsApi.list(orgId) });
  const membersQ = useQuery({ queryKey: ['org', 'members', orgId], queryFn: () => usersApi.list(orgId) });

  const kits = useMemo<KitAdmin[]>(() => kitsQ.data ?? [], [kitsQ.data]);
  const categories = catsQ.data ?? [];

  const q = search.trim().toLowerCase();
  const displayName = (k: KitAdmin): string => (k.name_zh || k.name_en || k.id).toLowerCase();
  const matchesSearch = (k: KitAdmin): boolean => !q || displayName(k).includes(q);
  const filtered = kits.filter((k) => (current === 'all' || k.category === current) && matchesSearch(k));
  const counts = useMemo(() => {
    const c: Record<string, number> = {};
    for (const k of kits) if (matchesSearch(k)) c[k.category ?? ''] = (c[k.category ?? ''] ?? 0) + 1;
    return c;
  }, [kits, q]);

  const invalidate = (): void => {
    void qc.invalidateQueries({ queryKey: ['kitmgmt', 'kits'] });
    void qc.invalidateQueries({ queryKey: ['kitmgmt', 'categories'] });
  };

  const openKit = kits.find((s) => s.id === openId) ?? null;

  useEffect(() => {
    function onKey(e: KeyboardEvent): void {
      if (e.key !== 'Escape') return;
      if (deleteTarget) return;
      if (scopePickerOpen) return;
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

  const onSaveCreate = (input: KitDrawerSaveInput): void => {
    if (!input.parsed) return;
    kitCatalogApi
      .createKit({
        tempToken: input.parsed.tempToken,
        slug: input.slug,
        nameEn: input.nameEn,
        nameZh: input.nameZh,
        descriptionEn: input.descriptionEn,
        descriptionZh: input.descriptionZh,
        icon: input.icon,
        author: input.author,
        version: input.version,
        category_id: input.category_id,
        scope: input.scope,
      })
      .then(() => {
        toast.success(t('kitmgmt.toast.created'));
        closeCreate();
        invalidate();
      })
      .catch((e: unknown) => toast.error(errorMessage(e)));
  };

  const onSaveEdit = (input: KitDrawerSaveInput): void => {
    if (!openKit) return;
    const id = openKit.id;
    kitCatalogApi
      .updateKit(id, {
        nameEn: input.nameEn,
        nameZh: input.nameZh,
        descriptionEn: input.descriptionEn,
        descriptionZh: input.descriptionZh,
        icon: input.icon,
        author: input.author,
        version: input.version,
        category_id: input.category_id,
        scope: input.scope,
      })
      .then(() => (input.newZip ? kitCatalogApi.uploadZip(id, input.newZip) : undefined))
      .then(() => {
        toast.success(t('kitmgmt.toast.updated'));
        if (input.category_id && input.category_id !== current) setCurrent(input.category_id);
        closeEdit();
        invalidate();
      })
      .catch((e: unknown) => toast.error(errorMessage(e)));
  };

  const requestDelete = (k: KitAdmin): void => setDeleteTarget(k);

  const confirmDeleteKit = (): void => {
    if (!deleteTarget) return;
    const id = deleteTarget.id;
    setDeleteBusy(true);
    kitCatalogApi
      .deleteKit(id)
      .then(() => {
        invalidate();
        toast.success(t('kitmgmt.toast.deleted'));
        if (openId === id) setOpenId(null);
        setDeleteTarget(null);
      })
      .catch((e: unknown) => toast.error(errorMessage(e)))
      .finally(() => setDeleteBusy(false));
  };

  const onToggleKit = (id: string, enabled: boolean): void => {
    kitCatalogApi.updateKit(id, { enabled }).then(invalidate).catch(() => undefined);
  };

  const deleteCategory = (id: string, name: string): void => setDeletingCategory({ id, name });

  const confirmDeleteCategory = (): void => {
    if (!deletingCategory) return;
    const { id } = deletingCategory;
    setDeletingCategory(null);
    kitCatalogApi.deleteCategory(id).then(invalidate).catch(() => undefined);
    if (current === id) setCurrent('all');
  };

  const addCategory = (name: string): void => {
    setAddingCategory(false);
    kitCatalogApi
      .createCategory({ name_zh: name, name_en: name })
      .then(() => invalidate())
      .catch(() => undefined);
  };

  const categoryName = current === 'all'
    ? t('kitmgmt.all')
    : categories.find((c) => c.id === current)?.name_zh ?? current;
  const deletingCategoryNameCount = deletingCategory
    ? kits.filter((k) => k.category === deletingCategory.id).length
    : 0;

  if (!canView) {
    return (
      <div className="flex h-full items-center justify-center p-8">
        <div className="text-[13.5px] text-[var(--text-tertiary)]">{t('kitmgmt.noAccess')}</div>
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="shrink-0 border-b border-[var(--border-default)] px-6 pt-5">
        <div className="flex items-start justify-between gap-4">
          <div>
            <h1 className="text-xl font-semibold tracking-tight text-[var(--text-primary)]">{t('kitmgmt.title')}</h1>
            <p className="mt-1 text-sm text-[var(--text-secondary)]">{t('kitmgmt.pageSubtitle')}</p>
          </div>
          {canCreate && (
            <button
              type="button"
              onClick={() => setOpenCreate(true)}
              className="shrink-0 rounded-[6px] bg-[var(--accent-primary)] px-3.5 py-2 text-[13px] text-white hover:bg-[var(--accent-primary-hover)]"
            >
              {t('kitmgmt.addKit')}
            </button>
          )}
        </div>
      </header>

      <div className="flex min-h-0 flex-1">
        <CategorySidebar
          categories={categories}
          counts={counts}
          total={kits.filter((k) => matchesSearch(k)).length}
          current={current}
          onSelect={setCurrent}
          onAdd={() => setAddingCategory(true)}
          onDelete={deleteCategory}
          search={search}
          onSearch={setSearch}
        />
        <KitTable
          kits={filtered}
          categoryName={categoryName}
          current={current}
          onAdd={() => setOpenCreate(true)}
          onEdit={(k) => (canEdit ? setOpenId(k.id) : undefined)}
          onToggle={(id, next) => (canToggle ? onToggleKit(id, next) : undefined)}
          onDelete={requestDelete}
        />
      </div>

      {openCreate && (
        <>
          <div className="fixed inset-0 z-[100] bg-[rgba(15,23,42,0.35)]" onClick={closeCreate} />
          <KitDrawer
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

      {openKit && (
        <>
          <div className="fixed inset-0 z-[100] bg-[rgba(15,23,42,0.35)]" onClick={closeEdit} />
          <KitDrawer
            mode="edit"
            kit={openKit}
            categories={categories}
            depts={deptsQ.data ?? []}
            members={membersQ.data ?? []}
            onCancel={closeEdit}
            onSave={onSaveEdit}
            onDelete={canDelete ? () => requestDelete(openKit) : undefined}
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
        title={t('kitmgmt.categoryDelete.title')}
        message={deletingCategory
          ? (deletingCategoryNameCount > 0
            ? fill(t('kitmgmt.categoryDelete.confirm'), { name: deletingCategory.name, n: deletingCategoryNameCount })
            : fill(t('kitmgmt.categoryDelete.confirmEmpty'), { name: deletingCategory.name }))
          : ''}
        confirmLabel={t('common.delete')}
        cancelLabel={t('common.cancel')}
        destructive
        onConfirm={confirmDeleteCategory}
        onCancel={() => setDeletingCategory(null)}
      />
      <DeleteKitModal
        open={deleteTarget !== null}
        name={deleteTarget ? (deleteTarget.name_zh || deleteTarget.name_en || deleteTarget.id) : ''}
        scopeSummary={deleteTarget?.scopeSummary ?? ''}
        busy={deleteBusy}
        onConfirm={confirmDeleteKit}
        onCancel={() => setDeleteTarget(null)}
      />
    </div>
  );
}
