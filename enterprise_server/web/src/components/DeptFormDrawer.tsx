import { X } from 'lucide-react';
import type { JSX } from 'react';
import { useEffect, useRef, useState } from 'react';

import { type DeptDetail } from '../api/departments';
import { t } from '../i18n';

export interface DeptFormValues {
  name: string;
  code: string;
  parentId: string | null;
  leaderId: string | null;
  sort: number | null;
  description: string | null;
}

interface Props {
  open: boolean;
  mode: 'create' | 'edit';
  /** The department being edited (edit mode only). */
  editing: DeptDetail | null;
  /** Parent options; the '' option is the root. Self + descendants excluded. */
  parentOptions: { value: string; label: string }[];
  /** Leader options; the '' option is "unassigned". */
  leaderOptions: { value: string; label: string }[];
  onSubmit: (v: DeptFormValues) => Promise<void>;
  /** Present in edit mode; asks the page to start the delete flow. */
  onRequestDelete?: () => void;
  onClose: () => void;
}

const inputCls =
  'w-full rounded-lg border border-[var(--border-default)] px-3 py-2 text-sm text-[var(--text-primary)] placeholder:text-[var(--text-tertiary)] focus:outline-none focus:ring-2 focus:ring-[var(--accent-primary)]/30 focus:border-[var(--accent-primary)] disabled:cursor-not-allowed disabled:bg-[var(--bg-tertiary)] disabled:text-[var(--text-tertiary)]';

/**
 * Create/edit drawer for departments. `code` is immutable after creation: in
 * edit mode the field is disabled (with a note) and the caller must not send
 * it in the PATCH body.
 */
export function DeptFormDrawer({
  open,
  mode,
  editing,
  parentOptions,
  leaderOptions,
  onSubmit,
  onRequestDelete,
  onClose,
}: Props): JSX.Element | null {
  const isEdit = mode === 'edit';
  const [name, setName] = useState('');
  const [code, setCode] = useState('');
  const [parentId, setParentId] = useState('');
  const [leaderId, setLeaderId] = useState('');
  const [sort, setSort] = useState('');
  const [description, setDescription] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // Reset the fields each time the drawer opens (create: blank, edit: seeded).
  const wasOpen = useRef(open);
  useEffect(() => {
    if (open && !wasOpen.current) {
      setName(editing?.name ?? '');
      setCode(editing?.code ?? '');
      setParentId(editing?.parent_id ?? '');
      setLeaderId(editing?.leader_id ?? '');
      setSort(editing ? String(editing.sort) : '');
      setDescription(editing?.description ?? '');
      setErr(null);
      setBusy(false);
    }
    wasOpen.current = open;
  }, [open, editing]);

  if (!open) return null;

  const submit = async (): Promise<void> => {
    const trimmedName = name.trim();
    if (!trimmedName) {
      setErr(t('dept.nameRequired'));
      return;
    }
    const trimmedCode = code.trim();
    if (!isEdit && !trimmedCode) {
      setErr(t('dept.codeRequired'));
      return;
    }
    const sortNum = sort.trim() === '' ? null : Number(sort.trim());
    setBusy(true);
    setErr(null);
    try {
      await onSubmit({
        name: trimmedName,
        code: trimmedCode,
        parentId: parentId === '' ? null : parentId,
        leaderId: leaderId === '' ? null : leaderId,
        sort: sortNum !== null && Number.isFinite(sortNum) ? sortNum : null,
        description: description.trim() === '' ? null : description.trim(),
      });
      onClose();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex justify-end bg-[var(--text-primary)]/40" onClick={onClose}>
      <div
        className="flex h-full w-full max-w-md flex-col bg-[var(--bg-secondary)] shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-[var(--border-subtle)] px-5 py-4">
          <h2 className="text-base font-semibold text-[var(--text-primary)]">
            {isEdit ? t('dept.editTitle') : t('dept.addTitle')}
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

        <div className="flex-1 overflow-y-auto px-5 py-4">
          <label className="mb-3 block" htmlFor="dept-name">
            <span className="mb-1 block text-sm font-medium text-[var(--text-secondary)]">
              {t('dept.field.name')} <span className="text-[var(--danger-primary)]">*</span>
            </span>
            <input id="dept-name" className={inputCls} value={name} onChange={(e) => setName(e.target.value)} />
          </label>

          <label className="mb-3 block" htmlFor="dept-code">
            <span className="mb-1 block text-sm font-medium text-[var(--text-secondary)]">
              {t('dept.field.code')}
              {!isEdit && <span className="text-[var(--danger-primary)] ml-1">*</span>}
            </span>
            <input
              id="dept-code"
              className={`${inputCls} font-mono`}
              value={code}
              onChange={(e) => setCode(e.target.value)}
              disabled={isEdit}
            />
            {isEdit && (
              <p className="mt-1 text-xs text-[var(--text-tertiary)]">{t('dept.codeLocked')}</p>
            )}
          </label>

          <label className="mb-3 block" htmlFor="dept-parent">
            <span className="mb-1 block text-sm font-medium text-[var(--text-secondary)]">
              {t('dept.field.parent')}
            </span>
            <select id="dept-parent" className={inputCls} value={parentId} onChange={(e) => setParentId(e.target.value)}>
              {parentOptions.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
          </label>

          <label className="mb-3 block" htmlFor="dept-leader">
            <span className="mb-1 block text-sm font-medium text-[var(--text-secondary)]">
              {t('dept.field.leader')}
            </span>
            <select id="dept-leader" className={inputCls} value={leaderId} onChange={(e) => setLeaderId(e.target.value)}>
              {leaderOptions.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
          </label>

          <label className="mb-3 block" htmlFor="dept-sort">
            <span className="mb-1 block text-sm font-medium text-[var(--text-secondary)]">
              {t('dept.field.sort')}
            </span>
            <input
              id="dept-sort"
              className={inputCls}
              type="number"
              value={sort}
              onChange={(e) => setSort(e.target.value)}
            />
          </label>

          <label className="block" htmlFor="dept-description">
            <span className="mb-1 block text-sm font-medium text-[var(--text-secondary)]">
              {t('dept.field.description')}
            </span>
            <textarea
              id="dept-description"
              className={inputCls}
              rows={3}
              value={description}
              onChange={(e) => setDescription(e.target.value)}
            />
          </label>
        </div>

        <div className="flex items-center gap-2 border-t border-[var(--border-subtle)] px-5 py-4">
          {isEdit && onRequestDelete && (
            <button
              type="button"
              onClick={onRequestDelete}
              disabled={busy}
              className="rounded-lg border border-[var(--danger-primary)]/40 px-3.5 py-2 text-sm font-medium text-[var(--danger-primary)] hover:bg-[var(--danger-primary)]/10 disabled:opacity-50"
            >
              {t('common.delete')}
            </button>
          )}
          {err && <p className="flex-1 text-sm text-[var(--danger-primary)]">{err}</p>}
          {!err && <span className="flex-1" />}
          <button
            type="button"
            onClick={onClose}
            disabled={busy}
            className="rounded-lg border border-[var(--border-default)] px-3.5 py-2 text-sm font-medium text-[var(--text-secondary)] transition-colors hover:bg-[var(--bg-hover)] disabled:opacity-50"
          >
            {t('common.cancel')}
          </button>
          <button
            type="button"
            onClick={submit}
            disabled={busy || name.trim() === '' || (!isEdit && code.trim() === '')}
            className="rounded-lg bg-[var(--accent-primary)] px-3.5 py-2 text-sm font-medium text-white shadow-sm transition-colors hover:bg-[var(--accent-primary-hover)] disabled:opacity-50"
          >
            {t('common.save')}
          </button>
        </div>
      </div>
    </div>
  );
}
