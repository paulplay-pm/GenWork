/**
 * Call-time authorization gate for enterprise catalog skills.
 *
 * The desktop keeps a copy of the marketplace list in the renderer and a
 * local install of every catalog skill the user has adopted. The server is the
 * source of truth for which of those skills the caller may still use: an
 * admin can disable a skill (or re-scope it below the caller) at any time.
 * This module computes the set of *installed* skills that are no longer
 * visible to the caller ("revoked"), so the config sync can force their
 * OpenClaw entries to `enabled=false` — keeping the files on disk (so
 * re-enabling later is instant) but blocking the gateway from invoking them.
 *
 * The list endpoint only returns rows that are both `enabled` and
 * scope-visible, so "installed but absent from the visible list" is a
 * faithful signal of revocation (spec §6.6, default-deny).
 */

/** A skill the caller has installed locally, keyed by its catalog id. */
export type InstalledSkill = { id: string; name: string };

/** A row from the (visible) marketplace list, keyed by catalog id. */
export type VisibleSkill = { id: string };

/**
 * Pure core of the gate. Returns the frontmatter `name`s of the installed
 * skills whose catalog `id` is **not** present in `visible`. These names are
 * the set to force `enabled=false` in the OpenClaw `skills.entries` override
 * (entries are keyed by frontmatter name, not id).
 */
export function computeRevokedSkillNames(
  installed: InstalledSkill[],
  visible: VisibleSkill[],
): string[] {
  const visibleIds = new Set(visible.map(v => v.id));
  const revoked: string[] = [];
  const seen = new Set<string>();
  for (const skill of installed) {
    if (visibleIds.has(skill.id)) {
      continue;
    }
    if (seen.has(skill.name)) {
      continue;
    }
    seen.add(skill.name);
    revoked.push(skill.name);
  }
  return revoked;
}

/**
 * Stateful wrapper around {@link computeRevokedSkillNames} that holds the
 * last known disabled set and only mutates on a *successful* recompute.
 *
 * A periodic re-fetch of the marketplace can fail transiently (network down,
 * server 5xx, JWT momentarily stale). On failure the gate must keep the last
 * known disabled set — clearing it on a fetch error would re-enable revoked
 * skills during an outage (Review-Focus #5). The caller signals "no fresh
 * data this tick" by passing `null`; the gate then reports `changed: false`
 * and leaves the set untouched.
 */
export class SkillAccessGate {
  private disabled = new Set<string>();

  /**
   * Recompute the disabled set from a fresh visible list.
   *
   * @param visible - the newly fetched visible skill ids, or `null` when this
   *   tick had no fresh data (fetch failure) — in which case the last known
   *   set is preserved and `changed` is `false`.
   * @returns whether the disabled set changed (so the caller knows whether to
   *   re-sync the OpenClaw config).
   */
  sync(installed: InstalledSkill[], visible: VisibleSkill[] | null): { changed: boolean } {
    if (visible === null) {
      return { changed: false };
    }
    const revoked = new Set(computeRevokedSkillNames(installed, visible));
    const changed =
      revoked.size !== this.disabled.size
      || [...revoked].some(name => !this.disabled.has(name));
    if (changed) {
      this.disabled = revoked;
    }
    return { changed };
  }

  /** Snapshot of the current disabled (frontmatter) names. */
  disabledNames(): Set<string> {
    return new Set(this.disabled);
  }
}
