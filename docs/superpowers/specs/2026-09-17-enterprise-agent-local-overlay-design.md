# Enterprise Agent Local Overlay — Design

**Date:** 2026-09-17
**Status:** Approved (brainstorming)
**Related:** `2026-09-16-enterprise-agent-management-design.md`, `2026-09-16-enterprise-agent-mgmt-spa-design.md`

## Goal

Let the GenWork desktop present enterprise-server-provisioned agents as
**read-only for server-owned content** while allowing a local overlay of
user-added items. A user who can *see* an enterprise agent (via role
authorization) should be able to:

- **View** the agent's full configuration.
- **Add** skills and **remove only self-added** skills (never server-added).
- **Add** collaboration (subagent) agents and **remove only self-added**
  ones (never server-linked).
- **Configure** (fill in IM credentials/instances) the IM channels the
  server already started — but **not add or remove channels, and not
  enable/disable** them.
- **Not** update a server-created agent's core info from a template.
- **Set a default folder** (per-agent working directory).

The desktop's enterprise agent today is fully read-only and is **clobbered
on every sync**; this design replaces that with a server-baseline +
local-overlay model.

## Scope

- Desktop only. Server-side provisioning (role filter, `im_channels` column,
  marketplace catalog) already exists and is out of scope.
- Applies only to agents with `source === 'enterprise'`. Local
  (`custom`) and `preset` agents are unaffected.

## Terminology

- **Baseline** — the set of skills / subagent links / IM channels the
  enterprise server currently sends for an agent. Immutable from the desktop.
- **Overlay / added** — items the local user added on top of the baseline.
  Removable.
- **Effective** — baseline ∪ overlay, what actually runs.

## Decisions (from brainstorming)

- **Provenance model: Approach A** — parallel baseline columns; the existing
  arrays stay the merged "effective" set in the local id space.
- **IM scope:** the server's `im_channels` are channels the admin already
  started. On the desktop the user may only **fill in credentials/instances**
  for those already-started channels — no enable/disable, no add/remove.
- **Collaboration candidates:** other server agents **plus** local
  custom/preset agents. The user may add any and remove only self-added.

---

## 1. Data model

Add three baseline columns to `agents` (default `'[]'`, applied to all rows;
non-enterprise rows keep empty baselines).

| Column | Content | Id space |
|---|---|---|
| `server_skill_ids` | server skill id array (JSON) | **server** skill ids |
| `server_subagent_allow_agent_ids` | server agent id array (JSON) | **server** agent ids |
| `server_im_channels` | channel id array (JSON, e.g. `["feishu"]`) | server platform ids |

Existing columns are **unchanged** and remain the merged *effective* set in
the **local** id space:

- `skill_ids` = `mapLocal(server_skill_ids) ∪ addedSkillIds` (local ids)
- `subagent_allow_agent_ids` = `mapLocal(server_subagent_allow_agent_ids) ∪
  addedSubagentIds` (local agent ids)

Id mapping:

- **Skills:** `server_skill_ids` → local id via the existing
  `skillManager.getCatalogLocalId` (already used in sync).
- **Subagents:** a server agent id resolves to the local agent id of the
  local enterprise row whose `enterprise_agent_id` equals that server id.
  If the referenced agent is not visible to this user (not synced), it
  cannot resolve → **excluded from the effective subagent set** (the user
  does not have that agent locally anyway).

### Provenance pure function

New module `src/main/libs/agentProvenance.ts` exports a single pure function
(used by both main-process guard and renderer so the two never diverge):

```ts
interface AgentProvenance {
  baselineSkillIds: string[];     // local ids
  addedSkillIds: string[];        // local ids
  baselineSubagentIds: string[];  // local agent ids
  addedSubagentIds: string[];     // local agent ids
  imChannels: string[];           // = server_im_channels (read-only set)
}

deriveProvenance(
  agent: {
    skillIds: string[];
    subagentAllowAgentIds: string[];
    serverSkillIds: string[];
    serverSubagentAllowAgentIds: string[];
    serverImChannels: string[];
  },
  resolveSkill: (serverSkillId: string) => string | null,
  resolveSubagent: (serverAgentId: string) => string | null,
): AgentProvenance
```

Semantics:
- `baselineSkillIds = serverSkillIds.map(resolveSkill).filter(Boolean)`
- `addedSkillIds = skillIds.filter(id => !baselineSkillIds.includes(id))`
- same pattern for subagents.
- `imChannels = serverImChannels` (verbatim).

## 2. Sync merge & update invariant

**Invariant:** server-baseline items are never deletable; overlay items can be
added and removed.

### Sync (`agentEnterpriseSync.syncFromServer`, enterprise UPSERT)

Change from wholesale-clobber to merge:

1. Write the three baseline columns from the server payload.
2. Compute the surviving overlay:
   `added = (old effective set) \ (old baseline, mapped to local)`.
3. Recompute effective sets:
   - `skill_ids = mapLocal(new serverSkillIds) ∪ addedSkill`
   - `subagent_allow_agent_ids = mapLocal(new serverSubagentIds) ∪ addedSub`
4. Server-owned scalar fields (name, description, identity, systemPrompt,
   model, thinkingLevel, icon) are refreshed wholesale — the user cannot
   change them (Section 3). `workingDirectory` stays `''` on the row (the real
   value lives in `enterprise_agent_prefs`).

Effects:
- Server edits a skill list → baseline refreshes; user-added skills survive.
- Server removes a skill the user did not add → it disappears.
- Server adds a skill → baseline grows; user items preserved.

### Main-process update guard (`GenWorkStore.updateAgent`, enterprise rows)

The renderer sends the full set *it wants*. Main enforces the invariant so
the renderer alone can't break it:

- `effectiveFull = (submittedFull ∪ mapped(currentBaseline))` for
  `skillIds` and `subagentAllowAgentIds` — dropped baseline items are re-added;
  deleting a baseline item is a no-op.
- Server-owned scalar fields (`name`, `description`, `identity`,
  `systemPrompt`, `model`, `thinkingLevel`, `icon`) are **rejected** for
  enterprise rows (those fields are ignored on update).
- `deleteAgent` for an enterprise row is rejected (main-side, not just UI).

### IM

Per-agent channel enable is **not** stored on `agents`. `im_channels` remain a
global, platform-keyed config (`im_config.platformAgentBindings`). The
`server_im_channels` column exists only so the UI knows *which* channels this
agent is allowed to configure. Credentials/instances for those channels are
written to the existing global IM config.

## 3. Behavior per area (local, non-admin user, on a server agent)

- **View:** open the settings panel. Server-owned fields render **read-only**
  (inputs disabled); no save action for those fields.
- **Skills:** baseline skills show a "server-provided" badge + lock and cannot
  be removed; the user can add any not-yet-selected locally-enabled skill;
  only `addedSkillIds` are removable.
- **Collaboration:** candidates = other enabled server agents + local
  custom/preset agents. Baseline links are locked; user adds candidates and
  removes only self-added. Unresolvable baseline references are excluded.
- **IM channels:** `server_im_channels` is a read-only set (no add/remove, no
  enable/disable). The user fills in credentials/instances for those
  already-started channels. An agent with no `im_channels` shows an empty
  state: "no server-configured channels".
- **Template:** a template cannot update a server-created agent. Main guard
  rejects any template/preset overwrite targeting `source === 'enterprise'`.
  (Today templates only create new local agents in the create modal; this adds
  the main-side guard and documents that sync only writes server fields.)
- **Default folder:** unchanged — the existing `enterprise_agent_prefs` +
  `EnterpriseWorkingDirectoryField` remains the one user-owned field.

## 4. UI gating (`AgentSettingsPanel`, sidebar)

Today the enterprise agent panel is locked whole by `isReadOnly`
(= `source === 'enterprise'`): save/delete hidden, IM tab hidden, only the
default folder editable. Move from **whole-panel read-only** to **per-section
gating**:

- Repurpose the slice flag `isReadOnly` as `isServerOwned`
  (= `source === 'enterprise'`); update the renderer usages. The slice still
  derives it from `source` — only the meaning/usage broadens.
- **Header fields:** inputs disabled (read-only view); the default-folder
  field stays editable.
- **Save action:** a save button **reappears** for enterprise agents and
  commits only the editable overlay — `skillIds`, `subagentAllowAgentIds`, and
  IM credential/instance changes. Server-owned scalar fields are disabled, so
  their values are unchanged; the main guard (Section 2) enforces this
  server-side regardless.
- **Skills / Collaboration tabs:** interactive per Section 3. Each item shows a
  source badge — "server-provided" (locked, lock icon) vs "added locally"
  (removable). New i18n keys (en + zh).
- **IM tab:** no longer hidden for enterprise agents; content restricted per
  Section 3.
- **Delete button:** still hidden for enterprise agents (the agent itself
  cannot be deleted).
- **Sidebar `AgentTreeNode`:** the **Edit** action becomes visible for
  enterprise agents (currently hidden); Delete stays hidden. The refresh
  button logic is unchanged.

## 5. Testing

- **`agentProvenance.test.ts` (new, pure):** baseline/added partition; skill id
  mapping; subagent id mapping + unresolvable-item exclusion;
  `added = effective \ baseline`.
- **`agentEnterpriseSync.test.ts` (extend):** a user-added skill survives sync;
  a server-removed skill (not user-added) disappears; a server-added skill
  grows the baseline while user items persist; collaboration list reflects a
  server change.
- **`genworkStore` enterprise-row guard:** an update that omits a baseline
  skill re-adds it (deleting a baseline is ineffective); server-owned field
  changes are rejected; `deleteAgent` on an enterprise row is rejected.
- **IM:** an enterprise agent with `im_channels` allows credential entry but
  no enable/disable; without `im_channels` it shows the empty state.
- **UI (`agentSlice` / `AgentSettingsPanel`):** baseline items locked, added
  items removable, no template entry point for an enterprise agent, sidebar
  Edit visible / Delete hidden.

## Error handling & edge cases

- **Missing model:** unchanged — an unavailable server model falls back to the
  default ref and the agent is still synced (visibility is not model-gated).
- **Unresolvable server subagent reference:** excluded from the effective set
  (user does not have that agent locally).
- **User edits a local skill that the server later lists as baseline:** the
  item becomes baseline on next sync and is no longer removable — expected.
- **Sync with an overlay present:** merge (Section 2) preserves the overlay.

## Out of scope

- Changing how the server authorizes which agents a role can see (existing).
- Multi-device consistency of the overlay (the overlay is local per install).
- Enabling/disabling server-started IM channels from the desktop.
