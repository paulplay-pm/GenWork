import type { JSX } from 'react';
import { useEffect, useMemo, useState } from 'react';

import type { DeptNode } from '../../api/departments';
import type { SkillScope } from '../../api/skillMarketplace';
import type { UserRow } from '../../api/users';
import { t } from '../../i18n';
import { fill } from './types';

interface Props {
  value: SkillScope;
  onChange: (scope: SkillScope) => void;
  depts: DeptNode[];
  members: UserRow[];
  /** Report open/closed so the parent drawer can suppress its own Esc handler
   * while the picker is up (Esc closes the picker first, then the drawer). */
  onOpenChange?: (open: boolean) => void;
}

function memberName(m: UserRow): string {
  return m.display_name || m.username;
}

function Chip({
  label,
  tone,
  onRemove,
}: {
  label: string;
  tone: 'dept' | 'member';
  onRemove: () => void;
}): JSX.Element {
  const cls =
    tone === 'dept'
      ? 'bg-[var(--accent-light)] text-[var(--accent-primary)]'
      : 'bg-[#F5F3FF] text-[#7C3AED]';
  return (
    <span className={`inline-flex items-center gap-1 rounded-[5px] px-2 py-0.5 text-[12px] ${cls}`}>
      {tone === 'member' && (
        <span aria-hidden="true">
          👤
        </span>
      )}
      {label}
      <button
        type="button"
        aria-label={label}
        onClick={(e) => {
          e.stopPropagation();
          onRemove();
        }}
        className="cursor-pointer opacity-60 hover:opacity-100"
      >
        ×
      </button>
    </span>
  );
}

/**
 * 授权范围 picker. The trigger shows the current selection as chips; clicking
 * it opens a modal with a wide, independently-scrolling two-pane body:
 *  - left: a searchable department tree (checking the ROOT node = 全公司);
 *  - right: a searchable member list (the additive 成员例外 grant).
 * The modal replaces an earlier clipped popover that couldn't show a large
 * dept tree (dozens of departments) — the panes scroll within a fixed-height
 * dialog so the whole tree and every member are reachable.
 */
export function SkillScopeSelector(p: Props): JSX.Element {
  const [open, setOpen] = useState(false);
  const [deptQuery, setDeptQuery] = useState('');
  const [memberQuery, setMemberQuery] = useState('');

  // id → node map over the recursive `children` tree (for chip labels).
  const deptMap = useMemo(() => {
    const map = new Map<string, DeptNode>();
    const walk = (nodes: DeptNode[]): void => {
      for (const n of nodes) {
        map.set(n.id, n);
        walk(n.children);
      }
    };
    walk(p.depts);
    return map;
  }, [p.depts]);

  // Flattened tree (with depth) so a dept search can filter across all levels.
  const flatDepts = useMemo(() => {
    const out: { node: DeptNode; depth: number }[] = [];
    const walk = (nodes: DeptNode[], depth: number): void => {
      for (const n of nodes) {
        out.push({ node: n, depth });
        walk(n.children, depth + 1);
      }
    };
    walk(p.depts, 0);
    return out;
  }, [p.depts]);

  const rootName = p.depts.find((n) => n.parent_id === null)?.name ?? t('skillmgmt.scope.allCompany');

  const triggerText = p.value.allCompany
    ? fill(t('skillmgmt.scope.triggerAll'), { root: rootName })
    : p.value.deptIds.length + p.value.userIds.length > 0
      ? fill(t('skillmgmt.scope.triggerSome'), {
          d: p.value.deptIds.length,
          u: p.value.userIds.length,
        })
      : t('skillmgmt.scope.triggerEmpty');

  const setOpenState = (next: boolean): void => {
    setOpen(next);
    if (!next) {
      setDeptQuery('');
      setMemberQuery('');
    }
    p.onOpenChange?.(next);
  };

  // Esc closes the picker (the parent drawer's Esc handler is guarded on this
  // picker's open state, so Esc closes the picker first, then the drawer).
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setOpenState(false);
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  /** Root checkbox = allCompany grant: checking it clears depts + members;
   * unchecking it clears depts but keeps the member exceptions. */
  const checkRoot = (checked: boolean): void => {
    if (checked) p.onChange({ allCompany: true, deptIds: [], userIds: [] });
    else p.onChange({ allCompany: false, deptIds: [], userIds: p.value.userIds });
  };

  const checkDept = (id: string, checked: boolean): void => {
    const deptIds = checked ? [...p.value.deptIds, id] : p.value.deptIds.filter((d) => d !== id);
    p.onChange({ allCompany: false, deptIds, userIds: p.value.userIds });
  };

  /** Additive grant toggle: the member gains access beyond the selected
   * departments (narrowing allCompany off); clicking a selected member removes
   * it. It never excludes — selection is always a grant. */
  const toggleMember = (id: string): void => {
    const has = p.value.userIds.includes(id);
    p.onChange({
      allCompany: false,
      deptIds: p.value.deptIds,
      userIds: has ? p.value.userIds.filter((x) => x !== id) : [...p.value.userIds, id],
    });
  };

  const deptRow = (n: DeptNode, depth: number): JSX.Element => {
    const isRoot = n.parent_id === null;
    const checked = isRoot ? p.value.allCompany : p.value.deptIds.includes(n.id);
    const disabled = !isRoot && p.value.allCompany;
    return (
      <label
        className={`flex items-center gap-2 rounded-[5px] py-1 pr-2 text-[13px] ${
          disabled ? 'cursor-not-allowed opacity-40' : 'cursor-pointer hover:bg-[var(--bg-tertiary)]'
        }`}
        style={{ paddingLeft: depth * 16 + 4 }}
      >
        <input
          type="checkbox"
          className="h-3.5 w-3.5 shrink-0 accent-[var(--accent-primary)]"
          checked={checked}
          disabled={disabled}
          onChange={(e) => (isRoot ? checkRoot(e.target.checked) : checkDept(n.id, e.target.checked))}
        />
        <span className="truncate">{n.name}</span>
      </label>
    );
  };

  const renderNested = (nodes: DeptNode[], depth: number): JSX.Element[] =>
    nodes.map((n) => (
      <div key={n.id}>
        {deptRow(n, depth)}
        {n.children.length > 0 ? renderNested(n.children, depth + 1) : null}
      </div>
    ));

  const deptQueryNorm = deptQuery.trim().toLowerCase();
  const deptMatches = deptQueryNorm
    ? flatDepts.filter((d) => d.node.name.toLowerCase().includes(deptQueryNorm))
    : flatDepts;

  const memberQueryNorm = memberQuery.trim().toLowerCase();
  const memberFiltered = p.members.filter((m) => {
    if (!memberQueryNorm) return true;
    const hay = `${memberName(m)} ${m.primary_dept_name ?? ''}`.toLowerCase();
    return hay.includes(memberQueryNorm);
  });
  const memberRows = memberFiltered.slice(0, 20);

  const memberRow = (m: UserRow): JSX.Element => {
    const selected = p.value.userIds.includes(m.id);
    return (
      <button
        key={m.id}
        type="button"
        onClick={() => toggleMember(m.id)}
        className={`flex w-full items-center justify-between gap-2 rounded-[5px] px-2 py-1.5 text-left text-[13px] transition hover:bg-[var(--bg-tertiary)] ${
          selected ? 'bg-[var(--accent-light)] text-[var(--accent-primary)]' : 'text-[var(--text-secondary)]'
        }`}
      >
        <span className="truncate">
          {memberName(m)}
          {m.primary_dept_name ? (
            <span className="text-[var(--text-tertiary)]"> · {m.primary_dept_name}</span>
          ) : null}
        </span>
        {selected ? (
          <span aria-hidden="true" className="shrink-0 font-semibold">
            ✓
          </span>
        ) : null}
      </button>
    );
  };

  const chips: JSX.Element[] = [];
  if (p.value.allCompany) {
    chips.push(<Chip key="__root" label={rootName} tone="dept" onRemove={() => checkRoot(false)} />);
  } else {
    for (const id of p.value.deptIds) {
      const name = deptMap.get(id)?.name ?? id;
      chips.push(<Chip key={id} label={name} tone="dept" onRemove={() => checkDept(id, false)} />);
    }
  }
  for (const uid of p.value.userIds) {
    const m = p.members.find((x) => x.id === uid);
    chips.push(
      <Chip
        key={uid}
        label={m ? memberName(m) : uid}
        tone="member"
        onRemove={() =>
          p.onChange({
            allCompany: p.value.allCompany,
            deptIds: p.value.deptIds,
            userIds: p.value.userIds.filter((x) => x !== uid),
          })
        }
      />,
    );
  }

  return (
    <div>
      <button
        type="button"
        onClick={() => setOpenState(true)}
        className="flex w-full items-center justify-between rounded-[7px] border border-[var(--border-default)] bg-[var(--bg-secondary)] px-3 py-2 text-left"
        aria-label={t('skillmgmt.scope.section')}
      >
        <span className="text-[13px] text-[var(--text-tertiary)]">{triggerText}</span>
        <span className="text-[var(--text-tertiary)]">▾</span>
      </button>

      <div className="mt-2 flex flex-wrap gap-1.5">
        {chips.length === 0 ? (
          <span className="text-[12.5px] text-[var(--text-tertiary)]">{t('skillmgmt.scope.empty')}</span>
        ) : (
          chips
        )}
      </div>

      {open && (
        <div
          className="fixed inset-0 z-[102] flex items-center justify-center bg-black/40"
          onClick={() => setOpenState(false)}
        >
          <div
            className="flex max-h-[86vh] w-[640px] max-w-[94vw] flex-col overflow-hidden rounded-[10px] border border-[var(--border-default)] bg-[var(--bg-secondary)] shadow-lg"
            role="dialog"
            aria-modal="true"
            onClick={(e) => e.stopPropagation()}
          >
            <header className="flex items-center justify-between border-b border-[var(--border-default)] px-5 py-3.5">
              <h2 className="text-[15px] font-semibold text-[var(--text-primary)]">
                {t('skillmgmt.scope.modal.title')}
              </h2>
              <button
                type="button"
                onClick={() => setOpenState(false)}
                aria-label={t('common.close')}
                className="flex h-7 w-7 items-center justify-center rounded-[6px] text-[var(--text-secondary)] hover:bg-[var(--bg-tertiary)]"
              >
                ✕
              </button>
            </header>

            <div className="grid min-h-0 flex-1 grid-cols-2">
              {/* Left: searchable department tree (checking the root = 全公司). */}
              <div className="flex min-h-0 flex-col border-r border-[var(--border-default)]">
                <div className="border-b border-[var(--border-subtle)] p-2.5">
                  <input
                    value={deptQuery}
                    onChange={(e) => setDeptQuery(e.target.value)}
                    placeholder={t('skillmgmt.scope.modal.searchDept')}
                    aria-label={t('skillmgmt.scope.modal.searchDept')}
                    className="w-full rounded-[6px] border border-[var(--border-default)] bg-[var(--bg-tertiary)] px-2.5 py-1.5 text-[12.5px] text-[var(--text-primary)] outline-none focus:border-[var(--accent-primary)]"
                  />
                </div>
                <div className="min-h-0 flex-1 overflow-y-auto p-2">
                  <div className="px-1 pb-1.5 text-[11.5px] font-semibold text-[var(--text-tertiary)]">
                    {fill(t('skillmgmt.scope.deptLabel'), { root: rootName })}
                  </div>
                  {deptMatches.length === 0 ? (
                    <div className="px-1 py-4 text-center text-[12.5px] text-[var(--text-tertiary)]">
                      {t('skillmgmt.scope.modal.noResult')}
                    </div>
                  ) : deptQueryNorm ? (
                    deptMatches.map(({ node, depth }) => (
                      <div key={node.id}>{deptRow(node, depth)}</div>
                    ))
                  ) : (
                    renderNested(p.depts, 0)
                  )}
                </div>
              </div>

              {/* Right: searchable member list (additive 成员例外 grant). */}
              <div className="flex min-h-0 flex-col">
                <div className="border-b border-[var(--border-subtle)] p-2.5">
                  <input
                    value={memberQuery}
                    onChange={(e) => setMemberQuery(e.target.value)}
                    placeholder={t('skillmgmt.scope.modal.searchMember')}
                    aria-label={t('skillmgmt.scope.modal.searchMember')}
                    className="w-full rounded-[6px] border border-[var(--border-default)] bg-[var(--bg-tertiary)] px-2.5 py-1.5 text-[12.5px] text-[var(--text-primary)] outline-none focus:border-[var(--accent-primary)]"
                  />
                </div>
                <div className="min-h-0 flex-1 overflow-y-auto p-2">
                  <div className="px-1 pb-1.5 text-[11.5px] font-semibold text-[var(--text-tertiary)]">
                    {t('skillmgmt.scope.memberExceptions')}
                  </div>
                  {memberRows.length === 0 ? (
                    <div className="px-1 py-4 text-center text-[12.5px] text-[var(--text-tertiary)]">
                      {p.members.length === 0
                        ? t('skillmgmt.scope.modal.allAdded')
                        : t('skillmgmt.scope.modal.noResult')}
                    </div>
                  ) : (
                    memberRows.map(memberRow)
                  )}
                </div>
                {memberFiltered.length > 20 && (
                  <div className="px-1 py-1 text-[11.5px] text-[var(--text-tertiary)]">
                    {fill(t('skillmgmt.scope.memberTruncated'), { n: memberFiltered.length })}
                  </div>
                )}
              </div>
            </div>

            <footer className="flex items-center justify-between gap-3 border-t border-[var(--border-default)] px-5 py-3">
              <span className="min-w-0 truncate text-[12px] text-[var(--text-tertiary)]">{triggerText}</span>
              <button
                type="button"
                onClick={() => setOpenState(false)}
                className="shrink-0 rounded-[6px] bg-[var(--accent-primary)] px-4 py-2 text-[13px] text-white hover:bg-[var(--accent-primary-hover)]"
              >
                {t('skillmgmt.scope.modal.done')}
              </button>
            </footer>
          </div>
        </div>
      )}
    </div>
  );
}
