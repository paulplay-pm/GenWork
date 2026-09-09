import { compareVersions } from '../../services/skill';

/**
 * The four install states a marketplace card can show. `disabled` is the
 * 4th state added by the call-time authorization gate (T18/T19): the skill is
 * installed locally but the server no longer grants the caller access to it
 * (an admin disabled it or re-scoped it below the caller). The local directory
 * is kept (data is not deleted, only blocked), so the card shows 已失效/已停用
 * instead of an Install/Upgrade action.
 */
export type SkillInstallStatus = 'not_installed' | 'disabled' | 'update_available' | 'installed';

/**
 * Pure install-status resolver for a marketplace card. Extracted from
 * `SkillsManager.getSkillInstallStatus` so the revocation precedence can be
 * tested independently of the React component.
 *
 * Precedence: `revoked` wins unconditionally (a revoked skill shows
 * `disabled` regardless of version or local enabled state); otherwise the
 * existing tri-state logic (not_installed / update_available / installed) is
 * applied by comparing the remote version against the installed one.
 *
 * @param marketplace - the marketplace row (or a retained copy of it); `null`
 *   when there is no row at all.
 * @param installed - the locally installed record matched to `marketplace`,
 *   or `null` when not installed.
 * @param revoked - whether the gate has marked this skill no longer usable.
 */
export function resolveInstallStatus(
  marketplace: { id: string; version?: string } | null,
  installed: { id: string; version?: string; enabled?: boolean } | null,
  revoked: boolean,
): SkillInstallStatus {
  if (revoked) {
    return 'disabled';
  }
  if (!installed) {
    return 'not_installed';
  }
  if (!marketplace?.version) {
    return 'installed';
  }
  const localVersion = installed.version || '0.0.0';
  if (compareVersions(marketplace.version, localVersion) > 0) {
    return 'update_available';
  }
  return 'installed';
}
