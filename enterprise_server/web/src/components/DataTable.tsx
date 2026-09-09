import type { JSX, ReactNode } from 'react';

export interface Column<T> {
  key: keyof T | string;
  /** Header cell content — a string or a custom node (e.g. a select-all
   * checkbox for a selection column). */
  header: ReactNode;
  render?: (row: T) => ReactNode;
  width?: string;
}

interface Props<T> {
  columns: Column<T>[];
  rows: T[];
  loading?: boolean;
  emptyMessage?: string;
  onRowClick?: (row: T) => void;
  rowKey?: (row: T) => string;
}

export function DataTable<T extends { id: string }>({
  columns,
  rows,
  loading,
  emptyMessage = 'No data',
  onRowClick,
  rowKey,
}: Props<T>): JSX.Element {
  if (loading)
    return <div className="p-4 text-sm text-[var(--text-secondary)]">Loading…</div>;
  if (rows.length === 0)
    return (
      <div className="rounded-xl border border-dashed border-[var(--border-default)] bg-[var(--bg-secondary)] px-6 py-10 text-center text-sm text-[var(--text-secondary)]">
        {emptyMessage}
      </div>
    );
  return (
    <table className="w-full text-sm">
      <thead className="bg-[var(--bg-tertiary)] text-xs font-medium uppercase tracking-wide text-[var(--text-secondary)]">
        <tr>
          {columns.map((c) => (
            <th
              key={String(c.key)}
              className="px-4 py-2.5 text-left"
              style={{ width: c.width }}
            >
              {c.header}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {rows.map((row) => (
          <tr
            key={rowKey ? rowKey(row) : row.id}
            className={`border-t border-[var(--border-subtle)] transition-colors ${
              onRowClick
                ? 'cursor-pointer hover:bg-[var(--bg-hover)] focus-within:bg-[var(--accent-light)]/60'
                : ''
            }`}
            onClick={() => onRowClick?.(row)}
          >
            {columns.map((c) => (
              <td key={String(c.key)} className="px-4 py-3 text-[var(--text-secondary)]">
                {c.render ? c.render(row) : String(row[c.key as keyof T] ?? '')}
              </td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  );
}
