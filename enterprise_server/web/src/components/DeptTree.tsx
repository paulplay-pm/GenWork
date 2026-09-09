import { ArrowDown, ArrowUp, ChevronDown, ChevronRight, Users } from 'lucide-react';
import type { JSX } from 'react';
import { useMemo, useState } from 'react';

import { type DeptNode } from '../api/departments';
import { t } from '../i18n';
import { Badge } from './Badge';

interface Props {
  nodes: DeptNode[];
  loading?: boolean;
  selectedId: string | null;
  onSelect: (id: string) => void;
  /** When the caller holds dept:edit, show sibling reorder controls. */
  canReorder?: boolean;
  onMove?: (id: string, dir: -1 | 1) => void;
}

/** Keep a node when it or any descendant matches the query (case-insensitive
 * match on name or code). A matching node keeps its full subtree. */
function filterTree(nodes: DeptNode[], q: string): DeptNode[] {
  if (!q) return nodes;
  const out: DeptNode[] = [];
  for (const n of nodes) {
    const kids = filterTree(n.children, q);
    const self =
      n.name.toLowerCase().includes(q) || (n.code ?? '').toLowerCase().includes(q);
    if (self || kids.length > 0) {
      out.push(self ? { ...n, children: n.children } : { ...n, children: kids });
    }
  }
  return out;
}

interface TreeCtx {
  selectedId: string | null;
  isExpanded: (node: DeptNode) => boolean;
  canReorder: boolean;
  onSelect: (id: string) => void;
  onToggle: (id: string) => void;
  onMove?: (id: string, dir: -1 | 1) => void;
}

interface RowProps extends TreeCtx {
  node: DeptNode;
  depth: number;
  siblingIndex: number;
  siblingCount: number;
}

function Row(p: RowProps): JSX.Element {
  const { node, depth } = p;
  const hasKids = node.children.length > 0;
  const selected = p.selectedId === node.id;
  const expanded = p.isExpanded(node);
  return (
    <div>
      <div
        className={`group flex cursor-pointer select-none items-center gap-1 rounded-[var(--radius-sm)] py-1.5 pr-1.5 ${
          selected
            ? 'bg-[var(--accent-light)] text-[var(--accent-primary)]'
            : 'text-[var(--text-primary)] hover:bg-[var(--bg-hover)]'
        }`}
        style={{ paddingLeft: depth * 14 + 6 }}
        onClick={() => p.onSelect(node.id)}
      >
        {hasKids ? (
          <button
            type="button"
            aria-label={expanded ? t('dept.tree.collapse') : t('dept.tree.expand')}
            className="shrink-0 rounded p-0.5 text-[var(--text-tertiary)] hover:bg-[var(--bg-tertiary)]"
            onClick={(e) => {
              e.stopPropagation();
              p.onToggle(node.id);
            }}
          >
            {expanded ? (
              <ChevronDown className="h-3.5 w-3.5" />
            ) : (
              <ChevronRight className="h-3.5 w-3.5" />
            )}
          </button>
        ) : (
          <span className="w-3.5 shrink-0" />
        )}
        <span className="flex-1 truncate text-sm font-medium">{node.name}</span>
        {node.code && (
          <span className="shrink-0 font-mono text-[10px] text-[var(--text-tertiary)]">
            {node.code}
          </span>
        )}
        <span className="shrink-0" title={t('dept.stat.subtree')}>
          <Badge tone={selected ? 'info' : 'neutral'}>
            <Users className="h-3 w-3" />
            {node.subtreeMembers}
          </Badge>
        </span>
        {p.canReorder && p.onMove && (
          <span className="hidden shrink-0 items-center gap-0.5 group-hover:flex">
            <button
              type="button"
              disabled={p.siblingIndex === 0}
              aria-label={t('dept.tree.moveUp')}
              className="rounded p-0.5 text-[var(--text-tertiary)] hover:bg-[var(--bg-tertiary)] disabled:opacity-30"
              onClick={(e) => {
                e.stopPropagation();
                p.onMove?.(node.id, -1);
              }}
            >
              <ArrowUp className="h-3 w-3" />
            </button>
            <button
              type="button"
              disabled={p.siblingIndex === p.siblingCount - 1}
              aria-label={t('dept.tree.moveDown')}
              className="rounded p-0.5 text-[var(--text-tertiary)] hover:bg-[var(--bg-tertiary)] disabled:opacity-30"
              onClick={(e) => {
                e.stopPropagation();
                p.onMove?.(node.id, 1);
              }}
            >
              <ArrowDown className="h-3 w-3" />
            </button>
          </span>
        )}
      </div>
      {hasKids && expanded && node.children.map((c, i) => (
        <Row
          key={c.id}
          node={c}
          depth={depth + 1}
          siblingIndex={i}
          siblingCount={node.children.length}
          selectedId={p.selectedId}
          isExpanded={p.isExpanded}
          canReorder={p.canReorder}
          onSelect={p.onSelect}
          onToggle={p.onToggle}
          onMove={p.onMove}
        />
      ))}
    </div>
  );
}

export function DeptTree({
  nodes,
  loading,
  selectedId,
  onSelect,
  canReorder = false,
  onMove,
}: Props): JSX.Element {
  const [query, setQuery] = useState('');
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const q = query.trim().toLowerCase();
  const visible = useMemo(() => filterTree(nodes, q), [nodes, q]);

  // Searching force-expands every branch; otherwise a node is expanded unless
  // the user explicitly collapsed it.
  const isExpanded = (n: DeptNode): boolean => (q ? true : !collapsed.has(n.id));
  const toggle = (id: string): void =>
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const ctx: TreeCtx = {
    selectedId,
    isExpanded,
    canReorder,
    onSelect,
    onToggle: toggle,
    onMove
  };

  return (
    <div
      className="rounded-[var(--radius-lg)] border border-[var(--border-subtle)] bg-white p-3"
      style={{ boxShadow: 'var(--shadow-sm)' }}
    >
      <input
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder={t('dept.search')}
        aria-label={t('dept.search')}
        className="mb-2 w-full rounded-lg border border-[var(--border-default)] px-3 py-1.5 text-sm text-[var(--text-primary)] placeholder:text-[var(--text-tertiary)] focus:border-[var(--accent-primary)] focus:outline-none focus:ring-2 focus:ring-[var(--accent-primary)]/30"
      />
      {loading ? (
        <div className="px-2 py-4 text-sm text-[var(--text-secondary)]">{t('common.loading')}</div>
      ) : visible.length === 0 ? (
        <div className="px-2 py-4 text-sm text-[var(--text-secondary)]">
          {q ? t('dept.noMatch') : t('dept.empty')}
        </div>
      ) : (
        <div className="max-h-[calc(100vh-280px)] overflow-y-auto">
          {visible.map((n, i) => (
            <Row
              key={n.id}
              node={n}
              depth={0}
              siblingIndex={i}
              siblingCount={visible.length}
              {...ctx}
            />
          ))}
        </div>
      )}
    </div>
  );
}
