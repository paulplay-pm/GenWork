/**
 * Sentinel marker that separates the user-editable portion of an AGENTS.md
 * file from the section GenWork owns (system instructions, environment notes,
 * scheduled-task hints, etc.).
 *
 * Pre-rebrand workspaces may carry a `<!-- GenWork managed -->` marker from
 * a prior install; those workspaces retain the legacy marker as user content
 * and are NOT migrated (one-time user-data loss per Phase 2 of the GenWork
 * rebrand).
 */

export const GENWORK_AGENTS_MARKER =
  '<!-- GenWork managed: do not edit below this line -->';

/**
 * Returns the index of the first managed marker, or -1.
 * Mirrors `String.prototype.indexOf` semantics.
 */
export function findAgentsManagedMarker(content: string): number {
  return content.indexOf(GENWORK_AGENTS_MARKER);
}

/**
 * The marker name that appears at `indexOf(found)`. Returns `undefined` if
 * the marker is not present.
 */
export function whichAgentsMarker(content: string): string | undefined {
  return content.includes(GENWORK_AGENTS_MARKER) ? GENWORK_AGENTS_MARKER : undefined;
}

/**
 * Strip every managed-section marker from a string. Use when embedding
 * user-supplied prompts into the managed section so they don't escape the
 * section on the next sync.
 */
export function stripAgentsManagedMarkers(content: string): string {
  return content.split(GENWORK_AGENTS_MARKER).join('');
}
