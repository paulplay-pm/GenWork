import type { SkillSubmissionStatus } from '../../api/skillMarketplace';
import type { UserRow } from '../../api/users';

/** Status → i18n key + tag color, shared by the review queue row and the
 * detail drawer (both render the same four submission states). */
export const STATUS_TAG: Record<SkillSubmissionStatus, { key: string; cls: string }> = {
  pending: { key: 'skillmgmt.status.pending', cls: 'bg-[var(--warning-primary)]/10 text-[var(--warning-primary)]' },
  approved: { key: 'skillmgmt.status.approved', cls: 'bg-[var(--success-primary)]/15 text-[var(--success-primary)]' },
  rejected: { key: 'skillmgmt.status.rejected', cls: 'bg-[var(--danger-primary)]/10 text-[var(--danger-primary)]' },
  withdrawn: { key: 'skillmgmt.status.withdrawn', cls: 'bg-[var(--bg-tertiary)] text-[var(--text-secondary)]' },
};

/** Display name + dept for the author; falls back to the raw id when the
 * author is not in the member list (e.g. deleted). */
export function authorInfo(authorId: string, members: UserRow[]): { name: string; dept: string } {
  const u = members.find((m) => m.id === authorId);
  return { name: u?.display_name || u?.username || authorId, dept: u?.primary_dept_name ?? '' };
}
