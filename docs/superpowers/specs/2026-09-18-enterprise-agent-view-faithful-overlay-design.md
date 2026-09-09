# Enterprise Agent: View-Faithful Overlay — Design

**Date:** 2026-09-18
**Status:** Approved (brainstorming)
**Related:** `2026-09-17-enterprise-agent-local-overlay-design.md` (baseline/overlay
model), `2026-09-16-enterprise-agent-management-design.md`

## Goal

Fix six fidelity gaps in the desktop's enterprise-agent settings panel
(`AgentSettingsPanel`) so a user viewing an enterprise server's agent sees what
the server actually configured, and can make the local edits that the overlay
model allows.

The baseline/overlay data model already exists (previous spec). What is missing
is: (a) the **关于你 / About You** content from the server is not fetched or
stored; (b) baseline skills and collaboration agents are mapped to *local* ids
at sync time and silently disappear when the local id does not resolve; (c) the
IM tab does not clearly restrict to server channels; (d) the default **model**
cannot be changed locally (no override storage); (e) the working-directory
control is a plain text input rather than the folder picker self-built agents
use.

## Scope

- **Desktop only.** No changes to `enterprise_server/**` — the server already
  exposes `aboutYou`, `skillIds`, `subagentAllowAgentIds`, `model`, and
  `imChannels` per agent.
- Applies only to agents with `source === 'enterprise'`. `custom` and `preset`
  agents keep their current behavior.
- Builds on the existing overlay infrastructure: `agents` baseline columns,
  `deriveProvenance`, the enterprise store guard, sync merge, handler
  enrichment, and `enterprise_agent_prefs`.

## Confirmed decisions (from brainstorming)

1. **Model override (#5):** a user's model change on an enterprise agent is
   **persisted locally** as a per-agent override, keyed by `enterpriseAgentId`,
   mirroring the existing `enterprise_agent_prefs` working-directory pattern.
   The server cannot read it back; a re-login/resync does not clear it.
2. **Uninstalled enterprise skills (#2):** shown **as locked/checked entries**
   (by name) — not auto-installed, and not hidden. Built-in and self-created
   skills remain available for the user to check/uncheck.
3. **Unresolvable baseline names:** when a baseline item's name cannot be
   resolved (skill not in the catalog; subagent has no local row), the raw
   server id is shown. This is acceptable.

---

## 1. 关于你 / About You — fetch and display `aboutYou` (issue 1)

**Root cause:** the server's `AgentMarketplaceView` carries `aboutYou`, but
`enterpriseClient.listEnterpriseAgents` and the sync do not fetch or store it;
the 关于你 tab (`AgentDetailTab.User`) reads the local `USER.md` bootstrap file,
which enterprise agents never write, so it renders empty.

### Changes

- **`agents` table:** add `about_you TEXT NOT NULL DEFAULT ''` (SQLite +
  migration + CREATE TABLE), mirroring the `server_im_channels` pattern.
- **`genworkStore`:** add `aboutYou: string` to `Agent`, `CreateAgentRequest`,
  `UpdateAgentRequest`; parse in `mapAgentRow`; write in `createAgent`/
  `updateAgent`. The enterprise scalar guard must **not** block
  `about_you` on the authoritative sync write (the sync uses
  `bypassEnterpriseGuard`); for user-initiated updates it is treated as a
  server-owned scalar (immutable), same as `systemPrompt`.
- **`enterpriseClient.listEnterpriseAgents`:** add `aboutYou: String(a.aboutYou
  ?? '')` to the mapped row.
- **`ServerAgentView` (agentEnterpriseSync):** add `aboutYou: string`; the sync
  UPSERT payload carries `aboutYou: sv.aboutYou`.
- **Preload/IPC:** `agents:get` and `agents:list` return `aboutYou` (it flows
  with the agent object; add to the preload agent type if one is declared).
- **`agentSlice` `AgentSummary`:** add `aboutYou: string`.
- **`services/agent.ts`:** map `aboutYou` in list/create/update payloads and
  the local `Agent` mapping object (the panel reads `aboutYou` off the
  summary; `src/renderer/types/agent.ts` gains `aboutYou: string` if it is the
  typed source for that mapping).
- **`AgentSettingsPanel`:** for `isServerOwned`, the 关于你 tab renders
  `agentSummary.aboutYou` (read-only text with the existing read-only badge),
  **not** `readBootstrapFile('USER.md')`. The `identity` and `systemPrompt`
  tabs already render the row values read-only and stay as-is.

### Precedence / display

- 关于你 is a **server-owned, read-only** field for enterprise agents. It is
  display-only; the user cannot edit it from the desktop.

---

## 2. Skills — show the full baseline by name (issue 2)

**Root cause:** sync maps `serverSkillIds` → local ids via
`skillManager.getCatalogLocalId(sid) ?? sid`. An enterprise skill that is not
installed locally keeps its raw server id, which matches no entry in
`state.skill.skills`, so it vanishes from the picker. Installed-but-disabled
skills are also filtered out (the picker lists only `enabled` skills).

### Fix the id-space invariant first

The subagent baseline mapping already drops unresolvable ids
(`.filter((id): id is string => id !== null)`), keeping
`subagent_allow_agent_ids` purely local. The skill mapping instead falls back
to the raw server id (`?? sid`), which leaks server ids into the local
`skill_ids` column — a latent inconsistency (a stray server id in `skill_ids`
would be handed to OpenClaw as if it were a local skill). Align skills with
subagents: **`skill_ids` holds local ids only**. Change the sync's
`baselineSkillLocal` to filter out unresolvable ids (drop the `?? sid`
fallback). Uninstalled baseline skills are then represented **only** by
`server_skill_ids` and rendered from there (below). This is a small, scoped
change consistent with the existing invariant; existing sync tests resolve every
id, so they are unaffected.

### Data already available to the panel

`AgentSummary` already carries (from the handler enrichment):
- `serverSkillIds: string[]` — raw server skill ids (the full baseline).
- `serverSkillLocalIds: string[]` — the subset whose server id resolved to an
  installed local id.

The renderer can resolve a baseline skill **name** from the marketplace cache
without any new IPC: `skillService.getLocalizedSkillName(serverSkillId,
serverSkillId)` (the marketplace cache is keyed by catalog skill id; the
server skill id is the catalog id). Unresolved → fall back to the raw id.

### Rendering (Skills tab, `isServerOwned`)

The tab renders two groups:

1. **Baseline (locked):** one row per id in `serverSkillIds`.
   - Name: `skillService.getLocalizedSkillName(sid, sid)` (catalog name →
     prettified → raw id fallback).
   - Locked/checked, not removable; badge `agentBaselineBadge` ("服务端").
   - Whether or not the skill is installed locally it is shown and locked
     (per decision 2 — no auto-install).
2. **Available (toggleable):** the installed + enabled skills
   (`state.skill.skills` filtered `enabled`), as today. A skill already in the
   baseline is **not** repeated here; otherwise the user can check/uncheck
   built-in and self-created skills. Removed items must not include baseline
   ids (the `lockedSkillIds` prop already enforces this in
   `AgentSkillSelector`).

### Save

The effective `skillIds` (local ids) = installed-baseline local ids ∪
user-selected local ids. The handler merge guard already re-adds dropped
baseline items. Uninstalled baseline ids are **not** stored in `skillIds` (they
have no local id); they live only in `serverSkillIds` and are rendered from
there. This keeps the existing id-space invariant intact.

---

## 3. Collaboration — show baseline agents checked/locked (issue 3)

**Root cause:** `renderCollaborationSettings` iterates `availableSubagentAgents`
= `agents.filter(a => a.enabled && a.id !== agentId)`. A baseline subagent only
appears if a local agent row exists **and** is `enabled`. A disabled baseline
agent (or one with no local row) is absent, so it is never shown checked.

### Rendering (Collaboration tab, `isServerOwned`)

Render every baseline collaborator from `serverSubagentAllowAgentIds`, plus the
existing toggleable candidate list:

1. **Baseline (locked, always checked):** one row per server agent id in
   `serverSubagentAllowAgentIds`.
   - Resolve to a local agent (via `serverSubagentLocalIds` / the local
     enterprise row whose `enterpriseAgentId` matches).
   - Name: the local agent's display name if it exists; otherwise the raw
     server id (per decision 3).
   - Locked/checked, checkbox disabled, badge `agentBaselineBadge`, lock icon.
     Rendered **regardless of the local agent's `enabled` state** — this fixes
     the "not checked" bug.
   - Deduplicated against the toggleable list (a baseline agent is not also a
     toggleable candidate).
2. **Available (toggleable):** `availableSubagentAgents` (self + other
   `enabled` agents), as today. The user may check/uncheck self-created agents.
   Baseline items excluded from this list to avoid duplication.

### Save

Effective `subagentAllowAgentIds` = local baseline ids ∪ user-selected local
ids. The handler merge guard re-adds dropped baseline items. A baseline
collaborator with **no local row** has no local id; it is rendered from
`serverSubagentAllowAgentIds` (by id) and is **not** written to
`subagentAllowAgentIds` (no local id to store) — the same treatment as
uninstalled baseline skills.

---

## 4. IM channels — restrict to server channels (issue 4)

**Current state (mostly correct):** for `isServerOwned` the IM tab already
renders **only** `visibleServerChannels` (the `serverImChannels` filtered to
known, locale-visible platforms) and shows `agentImNoChannels` when empty.

### Changes (clarification + correctness)

- **Do not render non-server channels** for `isServerOwned` — the panel
  currently does not (only `visibleServerChannels`), so keep that; this item
  is to *verify* the restriction holds after the other changes and that the
  non-enterprise path (all platforms) is untouched.
- The bind control remains per-instance/per-channel (the user binds a specific
  instance of a server-started channel to this agent). The read-only hint
  (`agentImReadOnlyHint`) explains that only the admin-started channels appear.
- No new add/remove/enable-disable capability; server channels are the only
  ones shown and the user configures bindings for them.

### Save

IM binding persistence is unchanged (`persistIMBindingsIfNeeded`), constrained
to `visibleServerChannels` keys for `isServerOwned` (already the case because
`boundKeys` can only be set from the rendered server-channel rows).

---

## 5. Default model — local, persisted override (issue 5)

**Root cause:** `model` is a server-owned scalar; the store guard and handler
strip any local `model` write, and there is no place to persist a user override.

### Storage

Extend `enterprise_agent_prefs` with a `model_ref TEXT NOT NULL DEFAULT ''`
column (SQLite + migration). Add to `EnterpriseAgentPrefsStore`:
- `getModel(enterpriseAgentId): string`
- `setModel(enterpriseAgentId, modelRef: string): void`
- `remove` already deletes the whole row (clears both prefs) — unchanged.

New IPC (mirror the working-directory channels):
- `AgentIpcChannel.GetEnterpriseAgentModel: 'agents:getEnterpriseAgentModel'`
- `AgentIpcChannel.SetEnterpriseAgentModel: 'agents:setEnterpriseAgentModel'`
- Preload `getEnterpriseAgentModel(agentId)` /
  `setEnterpriseAgentModel(agentId, modelRef)`; handlers read/write the prefs
  store keyed by `enterpriseAgentId`.

### Resolution precedence (display, desktop)

When the panel opens an enterprise agent, the model selector shows:

1. **Local override** (`prefs.getModel(enterpriseAgentId)`) if set and
   parseable (`parsePrimaryModelRef` non-null).
2. **Server default** — the `model` column (`a.model`) — if non-empty.
3. **Global default** — `defaultSelectedModel` — as the existing fallback.

The user's pick is written via `setEnterpriseAgentModel` (keyed by
`enterpriseAgentId`); it is **not** written to the `model` column (which stays
the server value and is immutable for user updates).

### Runtime effect (the override changes the model the agent runs with)

The override must actually be the model the agent runs with, not just a saved
preference. The runtime currently reads the agent's model from the **`model`
column** at exactly two main-process consumption points:
- session-start model resolution — `main.ts` `resolveCoworkRunModelRef`;
- OpenClaw config sync — `openclawConfigSync.ts` `syncManagedSessionStore`
  (per-agent `agentModel`).

Introduce a pure helper `effectiveAgentModelRef(agent, getOverrideModel)`:
for an enterprise agent, return the local override (`getOverrideModel(
agent.enterpriseAgentId)`) when it is non-empty and parseable, else
`agent.model`; for non-enterprise agents, always `agent.model`. Consult it at
both consumption points, wiring `getOverrideModel` to
`enterpriseAgentPrefsStore.getModel`. This is additive: non-enterprise agents
and other call sites that do not pass the override are unaffected. The resolved
ref feeds `resolveOpenClawModelRef` exactly as today.

### Save flow

`handleSave` (enterprise branch) additionally persists the model override when
it differs from the server default and from the current override:
- `setEnterpriseAgentModel(enterpriseAgentId, toOpenClawModelRef(selectedModel))`.
- If the user clears the model, write `''` (falls back to server default).

The model selector uses the standard `ModelSelector` (same as self-built), so
the UI is identical; only the persistence target differs.

---

## 6. Default working directory — folder picker (issue 6)

**Current state:** enterprise uses `EnterpriseWorkingDirectoryField` (plain
text input + save). Self-built agents use `AgentWorkingDirectoryField` (a
folder-picker popover, `FolderSelectorPopover`).

### Changes

- Rebuild `EnterpriseWorkingDirectoryField` to use the same
  `FolderSelectorPopover`-based picker control as
  `AgentWorkingDirectoryField` (compact variant), keeping the existing
  load-from-prefs / save-to-prefs behavior (keyed by `enterpriseAgentId`).
- The stored value and IPC are unchanged (`get/setEnterpriseAgentWorkingDirectory`
  already exist); only the input control changes from a text box to the
  folder-picker popover, matching the self-built agent UX.

---

## 7. Save-flow summary (`handleSave`, enterprise branch)

For `isServerOwned`, `handleSave` commits only the local overlay and prefs:

1. `agentService.updateAgent(agentId, { skillIds, subagentAllowAgentIds })` —
   the overlay (local ids only). Server scalars (name/description/
   systemPrompt/identity/icon/model) are **not** resent.
2. Persist **model override** via `setEnterpriseAgentModel` when changed.
3. Persist **working directory** via the existing
   `setEnterpriseAgentWorkingDirectory` (already done by the field's own save;
   keep it independent of the main save, matching current behavior, or fold
   into `handleSave` — decision: keep the field's own save button, unchanged).
4. `persistIMBindingsIfNeeded()` for the server-channel instance bindings.

Server-owned scalars and `aboutYou` are read-only display; `identity`/
`systemPrompt`/`aboutYou` are **not** written for enterprise agents.

---

## Error handling

- **Missing/uninstalled baseline skill or subagent:** render by resolved name
  or raw id (decision 3); never block the panel.
- **Unparseable model override:** fall through the precedence chain (treat as
  unset).
- **Prefs read/write failure:** log via `console.error` with the module tag and
  fall back to the next precedence tier; surface a toast on save failure per
  existing patterns.
- **Enterprise catalog not yet fetched** (skill names unresolved): the name
  falls back to the raw id; the marketplace fetch (triggered by the panel's
  existing effect) populates names on a later render.

## Testing strategy

- **Main process (Vitest):**
  - Store: `about_you` read/write; enterprise scalar guard still rejects
    user-initiated `aboutYou`/`systemPrompt`/`model` writes but the
    `bypassEnterpriseGuard` sync write persists them.
  - Prefs store: `getModel`/`setModel` round-trip; `remove` clears both prefs.
  - Sync: persists `aboutYou` from `ServerAgentView`; existing overlay-merge
    behavior unchanged.
  - Model override precedence helper (pure): override → server → global.
  - Model override **runtime effect**: `effectiveAgentModelRef` returns the
    override for an enterprise agent (parseable), the row model for a
    non-enterprise agent or an unparseable override.
  - Handler: `agents:list`/`get` return `aboutYou` and the enriched baseline
    sets; model get/set IPC round-trips.
- **Renderer (Vitest + RTL):**
  - 关于你 tab renders the server `aboutYou` (read-only) for an enterprise
    agent, and the `USER.md` path is **not** used for enterprise.
  - Skills tab: an uninstalled baseline skill (server id with no local row)
    renders locked + badged by name/id; a self skill toggles.
  - Collaboration tab: a **disabled** baseline agent renders checked + locked;
    a self agent toggles.
  - Working directory: the folder-picker popover control is present for
    enterprise and saves to prefs.
  - Model: the resolved model (override when set) shows in the selector and a
    pick persists via the model-override IPC.
- **Gates:** `npx vitest run <touched>` then the full `npx vitest run
  --no-file-parallelism`; `npm run compile:electron`; `npm run build`.
- **Manual:** `npm run electron:dev` — open an enterprise agent and verify all
  six items.

## What this does NOT change

- No auto-install of enterprise skills (decision 2).
- No server-side changes (`aboutYou` is already exposed).
- No change to `custom`/`preset` agent behavior.
- No change to the IM add/remove/enable-disable rules (enterprise is
  configure-only, already enforced).
