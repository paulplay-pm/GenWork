import type { ChangeEvent, JSX } from 'react';
import { useState } from 'react';

import type { DeptNode } from '../../api/departments';
import {
  type SkillAdmin,
  type SkillCategory,
  skillMarketplaceApi,
  type SkillScope,
} from '../../api/skillMarketplace';
import type { UserRow } from '../../api/users';
import { useToast } from '../../components/toastStore';
import { t } from '../../i18n';
import { SkillScopeSelector } from './SkillScopeSelector';
import { fill } from './types';

/** What the drawer hands to the page on 保存. Create mode carries `parsed`
 * (the tempToken backing the server-side tmp zip); edit mode carries `newZip`
 * (a replacement package to upload after the base patch). The skill name is
 * NEVER typed here — it comes from the parsed zip (D3). */
export interface SkillDrawerSaveInput {
  nameZh?: string;
  author?: string;
  category_id: string;
  desc?: string;
  icon?: string;
  scope: SkillScope;
  /** Edit mode: a new package picked in this session → sent via uploadZip. */
  newZip?: File;
  /** Create mode: the parse result (tempToken references the server tmp file). */
  parsed?: { tempToken: string };
}

interface ParsedZipMeta {
  name: string;
  version: string;
  size: number;
  sha256: string;
  tempToken: string;
}

/** Zip section state machine: idle → parsing → parsed; the × button resets to
 * idle (clears the tempToken). In create mode the save button stays disabled
 * until `parsed`; in edit mode the package is optional (a skill can be
 * re-saved without re-uploading). */
type ZipState =
  | { state: 'idle' }
  | { state: 'parsing' }
  | { state: 'parsed'; file: File; meta: ParsedZipMeta };

const EMPTY_SCOPE: SkillScope = { allCompany: false, deptIds: [], userIds: [] };

interface Props {
  mode: 'create' | 'edit';
  /** Edit mode: the skill being edited (pre-fills the form fields). */
  skill?: SkillAdmin;
  categories: SkillCategory[];
  depts: DeptNode[];
  members: UserRow[];
  /** Create mode: the category to preselect (the page's current rail choice). */
  defaultCategory?: string;
  onCancel: () => void;
  onSave: (input: SkillDrawerSaveInput) => void;
  /** Edit mode footer: the page's delete flow (confirm + deleteSkill). */
  onDelete?: () => void;
  /** The scope picker's open state is reported up so the page can suppress
   * its own Esc handler while the picker is open (Esc closes the picker
   * first, then the drawer). */
  onScopePickerOpenChange?: (open: boolean) => void;
}

export function SkillDrawer(p: Props): JSX.Element {
  const toast = useToast();
  const isEdit = p.mode === 'edit';
  const [zip, setZip] = useState<ZipState>({ state: 'idle' });
  const [nameZh, setNameZh] = useState(isEdit ? (p.skill?.name_zh ?? '') : '');
  const [author, setAuthor] = useState('');
  const [desc, setDesc] = useState(isEdit ? (p.skill?.description ?? '') : '');
  const [icon, setIcon] = useState(isEdit ? (p.skill?.icon ?? '') : '');
  const [category, setCategory] = useState(isEdit ? (p.skill?.category ?? '') : (p.defaultCategory ?? ''));
  const [scope, setScope] = useState<SkillScope>(isEdit ? (p.skill?.scope ?? EMPTY_SCOPE) : EMPTY_SCOPE);

  // Read-only, from the parse; in edit mode pre-filled from the skill and
  // refreshed when a replacement package is parsed.
  const version = zip.state === 'parsed' ? zip.meta.version : (p.skill?.version ?? '');

  function onFile(e: ChangeEvent<HTMLInputElement>): void {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    setZip({ state: 'parsing' });
    skillMarketplaceApi
      .parseZip(file)
      .then((meta) => setZip({ state: 'parsed', file, meta }))
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
      nameZh: nameZh.trim() || undefined,
      author: author.trim() || undefined,
      category_id: category,
      desc: desc.trim() || undefined,
      icon: icon.trim() || undefined,
      scope,
      newZip: isEdit && zip.state === 'parsed' ? zip.file : undefined,
      parsed: !isEdit && zip.state === 'parsed' ? { tempToken: zip.meta.tempToken } : undefined,
    });
  }

  // Create: disabled until the zip is parsed. Edit: enabled, but never while a
  // parse is in flight (so a half-parsed replace can't race the save).
  const canSave = isEdit ? zip.state !== 'parsing' : zip.state === 'parsed';

  const inputCls = 'w-full rounded-[6px] border border-[var(--border-default)] px-2.5 py-1.5 text-[13px] outline-none focus:border-[var(--accent-primary)]';
  const sectionTitleCls = 'mb-2.5 text-[13px] font-semibold uppercase tracking-wide text-[var(--text-secondary)]';
  const labelCls = 'flex flex-col gap-1 text-[12px] font-medium text-[var(--text-secondary)]';

  return (
    <aside className="fixed inset-y-0 right-0 z-[101] flex w-[460px] max-w-[92vw] flex-col border-l border-[var(--border-default)] bg-[var(--bg-secondary)] shadow-[-8px_0_24px_rgba(15,23,42,0.08)]">
      <header className="flex items-start justify-between gap-3 border-b border-[var(--border-default)] p-5">
        <div>
          <h3 className="text-[18px] font-semibold">{isEdit ? t('skillmgmt.edit.title') : t('skillmgmt.create.title')}</h3>
          {isEdit && p.skill ? (
            <div className="mt-0.5 text-[13px] text-[var(--text-secondary)]">
              {p.skill.name_zh || p.skill.name}
              <code className="ml-2 font-mono text-[12px] text-[var(--text-tertiary)]">{p.skill.name}</code>
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
        {/* 1. 技能包 — zip-first: the name/version come from the bytes. */}
        <section className="rounded-[8px] border border-[var(--border-default)] bg-[var(--bg-tertiary)] p-4">
          <h4 className={sectionTitleCls}>{isEdit ? t('skillmgmt.package.replace') : t('skillmgmt.package.title')}</h4>
          {zip.state === 'parsed' ? (
            <div className="flex items-center justify-between gap-2">
              <span className="min-w-0 truncate text-[13px] font-medium text-[var(--text-primary)]">
                {fill(t('skillmgmt.package.parsed'), { name: zip.meta.name, version: zip.meta.version })}
              </span>
              <button
                type="button"
                onClick={removeZip}
                aria-label={t('skillmgmt.package.remove')}
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
                aria-label={isEdit ? t('skillmgmt.replacePackage') : t('skillmgmt.uploadPackage')}
                disabled={zip.state === 'parsing'}
                onChange={onFile}
                className="text-[12px] text-[var(--text-secondary)] file:mr-2.5 file:rounded-[6px] file:border-0 file:bg-[var(--accent-primary)]/10 file:px-3 file:py-1.5 file:text-[12px] file:text-[var(--accent-primary)]"
              />
              {zip.state === 'parsing' ? (
                <p className="mt-1.5 text-[12px] text-[var(--text-secondary)]">{t('skillmgmt.package.parsing')}</p>
              ) : null}
              {isEdit && p.skill?.zip.fileName ? (
                <p className="mt-1.5 truncate text-[12px] text-[var(--text-tertiary)]">{p.skill.zip.fileName}</p>
              ) : null}
            </>
          )}
        </section>

        {/* 2. 基本信息 */}
        <section className="mt-4">
          <h4 className={sectionTitleCls}>{t('skillmgmt.basicInfo.title')}</h4>
          <div className="grid grid-cols-2 gap-3.5">
            <label className={labelCls}>
              {t('skillmgmt.nameZh')}
              <input className={inputCls} aria-label={t('skillmgmt.nameZh')} value={nameZh} onChange={(e) => setNameZh(e.target.value)} />
            </label>
            <label className={labelCls}>
              {t('skillmgmt.author')}
              <input className={inputCls} aria-label={t('skillmgmt.author')} value={author} onChange={(e) => setAuthor(e.target.value)} />
            </label>
            <label className={labelCls}>
              {t('skillmgmt.version')}
              <input className={inputCls} aria-label={t('skillmgmt.version')} value={version} readOnly />
            </label>
            <label className={labelCls}>
              {t('skillmgmt.category')}
              <select className={inputCls} aria-label={t('skillmgmt.category')} value={category} onChange={(e) => setCategory(e.target.value)}>
                {p.categories.map((c) => <option key={c.id} value={c.id}>{c.name_zh || c.name_en}</option>)}
              </select>
            </label>
            <label className={`col-span-2 ${labelCls}`}>
              {t('skillmgmt.desc')}
              <input className={inputCls} aria-label={t('skillmgmt.desc')} value={desc} onChange={(e) => setDesc(e.target.value)} />
            </label>
            <label className={`col-span-2 ${labelCls}`}>
              {t('skillmgmt.icon')}
              <input className={inputCls} aria-label={t('skillmgmt.icon')} value={icon} onChange={(e) => setIcon(e.target.value)} />
            </label>
          </div>
        </section>

        {/* 3. 授权范围 */}
        <section className="mt-4 border-t border-dashed border-[var(--border-default)] pt-4">
          <h4 className={sectionTitleCls}>{t('skillmgmt.scope.section')}</h4>
          <SkillScopeSelector
            value={scope}
            onChange={setScope}
            depts={p.depts}
            members={p.members}
            onOpenChange={p.onScopePickerOpenChange}
          />
        </section>
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
