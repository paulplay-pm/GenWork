import type { ChangeEvent, JSX } from 'react';
import { useState } from 'react';

import type { DeptNode } from '../../api/departments';
import {
  type KitAdmin,
  type KitCategory,
  type KitScope,
  kitCatalogApi,
} from '../../api/kitCatalog';
import type { UserRow } from '../../api/users';
import { useToast } from '../../components/toastStore';
import { t } from '../../i18n';
import { KitScopeSelector } from './KitScopeSelector';
import { fill } from './types';

/** Drawer save input. Create mode carries `parsed` (tempToken from parseZip)
 * + the kit-specific `slug` (flat zips carry no slug to infer). Edit mode
 * carries `newZip` (a replacement package to upload after the base patch). */
export interface KitDrawerSaveInput {
  slug: string;
  nameEn?: string; nameZh?: string;
  descriptionEn?: string; descriptionZh?: string;
  icon?: string; author?: string; version?: string;
  category_id: string;
  scope: KitScope;
  newZip?: File;
  parsed?: { tempToken: string };
}

interface ZipState {
  state: 'idle' | 'parsing' | 'parsed';
  file?: File;
  size?: number;
  sha256?: string;
  tempToken?: string;
}

const EMPTY_SCOPE: KitScope = { allCompany: false, deptIds: [], userIds: [] };
const SLUG_RE = /^[a-z0-9][a-z0-9-_]*$/;

interface Props {
  mode: 'create' | 'edit';
  kit?: KitAdmin;
  categories: KitCategory[];
  depts: DeptNode[];
  members: UserRow[];
  defaultCategory?: string;
  onCancel: () => void;
  onSave: (input: KitDrawerSaveInput) => void;
  onDelete?: () => void;
  onScopePickerOpenChange?: (open: boolean) => void;
}

export function KitDrawer(p: Props): JSX.Element {
  const toast = useToast();
  const isEdit = p.mode === 'edit';
  const [zip, setZip] = useState<ZipState>({ state: 'idle' });
  const [slug, setSlug] = useState(isEdit ? (p.kit?.id ?? '') : '');
  const [nameEn, setNameEn] = useState(isEdit ? (p.kit?.name_en ?? '') : '');
  const [nameZh, setNameZh] = useState(isEdit ? (p.kit?.name_zh ?? '') : '');
  const [author, setAuthor] = useState(isEdit ? (p.kit?.author ?? '') : '');
  const [descEn, setDescEn] = useState(isEdit ? (p.kit?.description_en ?? '') : '');
  const [descZh, setDescZh] = useState(isEdit ? (p.kit?.description_zh ?? '') : '');
  const [icon, setIcon] = useState(isEdit ? (p.kit?.icon ?? '') : '');
  const [category, setCategory] = useState(isEdit ? (p.kit?.category ?? '') : (p.defaultCategory ?? ''));
  const [scope, setScope] = useState<KitScope>(isEdit ? (p.kit?.scope ?? EMPTY_SCOPE) : EMPTY_SCOPE);

  function onFile(e: ChangeEvent<HTMLInputElement>): void {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    setZip({ state: 'parsing' });
    kitCatalogApi
      .parseZip(file)
      .then((meta) => setZip({ state: 'parsed', file, size: meta.size, sha256: meta.sha256, tempToken: meta.tempToken }))
      .catch((err: unknown) => {
        setZip({ state: 'idle' });
        toast.error(err instanceof Error ? err.message : String(err));
      });
  }

  function removeZip(): void {
    setZip({ state: 'idle' });
  }

  function save(): void {
    p.onSave({
      slug: slug.trim(),
      nameEn: nameEn.trim() || undefined,
      nameZh: nameZh.trim() || undefined,
      descriptionEn: descEn.trim() || undefined,
      descriptionZh: descZh.trim() || undefined,
      icon: icon.trim() || undefined,
      author: author.trim() || undefined,
      version: p.kit?.version ?? undefined,
      category_id: category,
      scope,
      newZip: isEdit && zip.state === 'parsed' ? zip.file : undefined,
      parsed: !isEdit && zip.state === 'parsed' && zip.tempToken ? { tempToken: zip.tempToken } : undefined,
    });
  }

  const slugValid = isEdit || SLUG_RE.test(slug.trim());
  const canSave = isEdit
    ? zip.state !== 'parsing'
    : zip.state === 'parsed' && slugValid;

  const inputCls = 'w-full rounded-[6px] border border-[var(--border-default)] px-2.5 py-1.5 text-[13px] outline-none focus:border-[var(--accent-primary)]';
  const sectionTitleCls = 'mb-2.5 text-[13px] font-semibold uppercase tracking-wide text-[var(--text-secondary)]';
  const labelCls = 'flex flex-col gap-1 text-[12px] font-medium text-[var(--text-secondary)]';

  return (
    <aside className="fixed inset-y-0 right-0 z-[101] flex w-[480px] max-w-[92vw] flex-col border-l border-[var(--border-default)] bg-[var(--bg-secondary)] shadow-[-8px_0_24px_rgba(15,23,42,0.08)]">
      <header className="flex items-start justify-between gap-3 border-b border-[var(--border-default)] p-5">
        <div>
          <h3 className="text-[18px] font-semibold">{isEdit ? t('kitmgmt.edit.title') : t('kitmgmt.create.title')}</h3>
          {isEdit && p.kit ? (
            <div className="mt-0.5 text-[13px] text-[var(--text-secondary)]">
              {(p.kit.name_zh || p.kit.name_en || p.kit.id)}
              <code className="ml-2 font-mono text-[12px] text-[var(--text-tertiary)]">{p.kit.id}</code>
            </div>
          ) : null}
        </div>
        <button
          type="button"
          onClick={p.onCancel}
          aria-label={t('common.close')}
          className="flex h-8 w-8 shrink-0 items-center justify-center rounded-[6px] text-[var(--text-secondary)] hover:bg-[var(--bg-tertiary)]"
        >
          ✕
        </button>
      </header>

      <div className="flex-1 overflow-y-auto p-5">
        {/* 1. 套件包 — zip-first (parse → tempToken). Flat zips carry no
            inferred slug, so the slug is a required form field. */}
        <section className="rounded-[8px] border border-[var(--border-default)] bg-[var(--bg-tertiary)] p-4">
          <h4 className={sectionTitleCls}>{isEdit ? t('kitmgmt.package.replace') : t('kitmgmt.package.title')}</h4>
          {zip.state === 'parsed' ? (
            <div className="flex items-center justify-between gap-2">
              <span className="min-w-0 truncate text-[13px] font-medium text-[var(--text-primary)]">
                {zip.file ? zip.file.name : t('kitmgmt.package.parsed')}
              </span>
              <button
                type="button"
                onClick={removeZip}
                aria-label={t('kitmgmt.package.remove')}
                className="flex h-7 w-7 shrink-0 items-center justify-center rounded-[6px] text-[var(--text-secondary)] hover:bg-[var(--bg-tertiary)]"
              >
                ✕
              </button>
            </div>
          ) : (
            <>
              <input
                type="file"
                accept=".zip"
                aria-label={isEdit ? t('kitmgmt.replacePackage') : t('kitmgmt.uploadPackage')}
                disabled={zip.state === 'parsing'}
                onChange={onFile}
                className="text-[12px] text-[var(--text-secondary)] file:mr-2.5 file:rounded-[6px] file:border-0 file:bg-[var(--accent-primary)]/10 file:px-3 file:py-1.5 file:text-[12px] file:text-[var(--accent-primary)]"
              />
              {zip.state === 'parsing' ? (
                <p className="mt-1.5 text-[12px] text-[var(--text-secondary)]">{t('kitmgmt.package.parsing')}</p>
              ) : null}
              {isEdit && p.kit?.zip.fileName ? (
                <p className="mt-1.5 truncate text-[12px] text-[var(--text-tertiary)]">{p.kit.zip.fileName}</p>
              ) : null}
            </>
          )}
        </section>

        {/* 2. 基本信息 */}
        <section className="mt-4">
          <h4 className={sectionTitleCls}>{t('kitmgmt.basicInfo.title')}</h4>
          <div className="grid grid-cols-2 gap-3.5">
            {!isEdit && (
              <label className={`col-span-2 ${labelCls}`}>
                {t('kitmgmt.slug')}
                <input
                  className={inputCls}
                  aria-label={t('kitmgmt.slug')}
                  value={slug}
                  onChange={(e) => setSlug(e.target.value)}
                  placeholder="my-kit-slug"
                />
                {!slugValid && slug.length > 0 ? (
                  <span className="text-[11px] text-[var(--danger-primary)]">{t('kitmgmt.slug.invalid')}</span>
                ) : null}
              </label>
            )}
            <label className={labelCls}>
              {t('kitmgmt.nameZh')}
              <input className={inputCls} aria-label={t('kitmgmt.nameZh')} value={nameZh} onChange={(e) => setNameZh(e.target.value)} />
            </label>
            <label className={labelCls}>
              {t('kitmgmt.nameEn')}
              <input className={inputCls} aria-label={t('kitmgmt.nameEn')} value={nameEn} onChange={(e) => setNameEn(e.target.value)} />
            </label>
            <label className={labelCls}>
              {t('kitmgmt.author')}
              <input className={inputCls} aria-label={t('kitmgmt.author')} value={author} onChange={(e) => setAuthor(e.target.value)} />
            </label>
            <label className={labelCls}>
              {t('kitmgmt.version')}
              <input className={inputCls} aria-label={t('kitmgmt.version')} value={p.kit?.version ?? ''} readOnly />
            </label>
            <label className={`col-span-2 ${labelCls}`}>
              {t('kitmgmt.category')}
              <select className={inputCls} aria-label={t('kitmgmt.category')} value={category} onChange={(e) => setCategory(e.target.value)}>
                {p.categories.map((c) => <option key={c.id} value={c.id}>{c.name_zh || c.name_en}</option>)}
              </select>
            </label>
            <label className={`col-span-2 ${labelCls}`}>
              {t('kitmgmt.descZh')}
              <input className={inputCls} aria-label={t('kitmgmt.descZh')} value={descZh} onChange={(e) => setDescZh(e.target.value)} />
            </label>
            <label className={`col-span-2 ${labelCls}`}>
              {t('kitmgmt.descEn')}
              <input className={inputCls} aria-label={t('kitmgmt.descEn')} value={descEn} onChange={(e) => setDescEn(e.target.value)} />
            </label>
            <label className={`col-span-2 ${labelCls}`}>
              {t('kitmgmt.icon')}
              <input className={inputCls} aria-label={t('kitmgmt.icon')} value={icon} onChange={(e) => setIcon(e.target.value)} />
            </label>
          </div>
        </section>

        {/* 3. 授权范围 */}
        <section className="mt-4 border-t border-dashed border-[var(--border-default)] pt-4">
          <h4 className={sectionTitleCls}>{t('kitmgmt.scope.section')}</h4>
          <KitScopeSelector
            value={scope}
            onChange={setScope}
            depts={p.depts}
            members={p.members}
            onOpenChange={p.onScopePickerOpenChange}
            labels={{
              allCompany: t('kitmgmt.scope.allCompany'),
              triggerAll: t('kitmgmt.scope.triggerAll'),
              triggerSome: t('kitmgmt.scope.triggerSome'),
              triggerEmpty: t('kitmgmt.scope.triggerEmpty'),
              empty: t('kitmgmt.scope.empty'),
              modalTitle: t('kitmgmt.scope.modal.title'),
              searchDept: t('kitmgmt.scope.modal.searchDept'),
              searchMember: t('kitmgmt.scope.modal.searchMember'),
              deptLabel: t('kitmgmt.scope.deptLabel'),
              memberExceptions: t('kitmgmt.scope.memberExceptions'),
              memberTruncated: t('kitmgmt.scope.memberTruncated'),
              noResult: t('kitmgmt.scope.modal.noResult'),
              allAdded: t('kitmgmt.scope.modal.allAdded'),
              done: t('kitmgmt.scope.modal.done'),
            }}
          />
        </section>

        {/* 4. tryAsking — read-only display if any. Kits expose this field
            in the admin view as a preview (the same shape goes into the
            skill-flow snippet picker downstream). */}
        {isEdit && p.kit && p.kit.tryAsking.length > 0 ? (
          <section className="mt-4 border-t border-dashed border-[var(--border-default)] pt-4">
            <h4 className={sectionTitleCls}>{t('kitmgmt.tryAsking.title')}</h4>
            <ul className="flex flex-col gap-1.5">
              {p.kit.tryAsking.map((q, idx) => (
                <li key={idx} className="rounded-[5px] bg-[var(--bg-tertiary)] px-2.5 py-1.5 text-[12.5px]">
                  {fill(t('kitmgmt.tryAsking.row'), { zh: q.zh || '—', en: q.en || '—' })}
                </li>
              ))}
            </ul>
          </section>
        ) : null}
      </div>

      <footer className="flex items-center gap-2 border-t border-[var(--border-default)] bg-[var(--bg-tertiary)] p-3">
        {isEdit && p.onDelete ? (
          <button type="button" onClick={p.onDelete} className="rounded-[6px] border border-[var(--danger-primary)]/40 px-3 py-1.5 text-[13px] text-[var(--danger-primary)] hover:bg-[var(--danger-primary)]/10">
            {t('common.delete')}
          </button>
        ) : null}
        <span className="flex-1" />
        <button type="button" onClick={p.onCancel} className="rounded-[6px] border border-[var(--border-default)] px-3 py-1.5 text-[13px] hover:bg-[var(--bg-tertiary)]">
          {t('common.cancel')}
        </button>
        <button
          type="button"
          onClick={save}
          disabled={!canSave}
          className="rounded-[6px] bg-[var(--accent-primary)] px-3 py-1.5 text-[13px] text-white hover:bg-[var(--accent-primary-hover)] disabled:cursor-not-allowed disabled:opacity-50"
        >
          {t('common.save')}
        </button>
      </footer>
    </aside>
  );
}
