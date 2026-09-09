import type { SubmissionStatus } from '../../api/connectors';
import type { UserRow } from '../../api/users';

/** Status → i18n key + tag color, shared by the review queue row and the
 * detail drawer (both render the same four submission states). */
export const STATUS_TAG: Record<SubmissionStatus, { key: string; cls: string }> = {
  pending: { key: 'mcp.status.pending', cls: 'bg-[var(--warning-primary)]/10 text-[var(--warning-primary)]' },
  approved: { key: 'mcp.status.approved', cls: 'bg-[var(--success-primary)]/15 text-[var(--success-primary)]' },
  rejected: { key: 'mcp.status.rejected', cls: 'bg-[var(--danger-primary)]/10 text-[var(--danger-primary)]' },
  withdrawn: { key: 'mcp.status.withdrawn', cls: 'bg-[var(--bg-tertiary)] text-[var(--text-secondary)]' },
};

/** Display name + dept for the author; falls back to the raw id when the
 * author is not in the member list (e.g. deleted). */
export function authorInfo(authorId: string, members: UserRow[]): { name: string; dept: string } {
  const u = members.find((m) => m.id === authorId);
  return { name: u?.display_name || u?.username || authorId, dept: u?.primary_dept_name ?? '' };
}
