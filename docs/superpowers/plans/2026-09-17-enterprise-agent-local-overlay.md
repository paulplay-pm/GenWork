# Enterprise Agent Local Overlay Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Relax the desktop's fully-read-only enterprise agents into a server-baseline + local-overlay model: view full config, add/remove skills (only self-added removable), add/remove collaboration agents (only self-added removable), configure (fill credentials for) server-started IM channels without add/remove or enable/disable, block template overwrites of server agents, and keep the default-folder field.

**Architecture:** Add three baseline columns (`server_skill_ids`, `server_subagent_allow_agent_ids`, `server_im_channels`) to the `agents` table storing the server's raw values. A pure `deriveProvenance` function partitions each agent into baseline vs. added (in the local id space). The sync engine changes from wholesale-clobber to merge (refresh baseline, preserve the user overlay). A main-process update/delete guard enforces "baseline items are never deletable; server-owned scalar fields are immutable for enterprise rows." The UI moves from whole-panel read-only to per-section gating.

**Tech Stack:** Electron main (TypeScript), better-sqlite3, Redux Toolkit, React + Tailwind, Vitest. Server (enterprise_server) is out of scope.

**Spec:** `docs/superpowers/specs/2026-09-17-enterprise-agent-local-overlay-design.md`

## Global Constraints

- **Scope:** desktop only. Do not modify `enterprise_server/**`.
- **Affected agents only:** behavior changes apply when `agent.source === 'enterprise'`. `custom` and `preset` agents are unaffected and must keep current behavior.
- **Id spaces:** baseline columns store **server** ids (server skill ids, server agent ids). The existing `skill_ids` / `subagent_allow_agent_ids` store **local** ids. Mapping: skills via `skillManager.getCatalogLocalId(serverId)`; subagents via the local enterprise row whose `enterprise_agent_id === serverAgentId`.
- **Invariant:** a server-baseline item is never deletable and its scalar server-owned fields (name, description, identity, systemPrompt, model, thinkingLevel, icon) are immutable for enterprise rows. User-added items are addable and removable.
- **IM:** `server_im_channels` is a read-only set. The user may only fill credentials/instances for those already-started channels — no enable/disable, no add/remove.
- **i18n:** every new user-visible string needs BOTH `en` and `zh` in `src/renderer/services/i18n.ts`. Use `i18nService.t('key')`.
- **String constants:** new IPC channel names must go in `src/shared/agent/constants.ts` (`AgentIpcChannel`), not bare strings.
- **Lint gate (every touched file):** `npx eslint --ext ts,tsx --report-unused-disable-directives --max-warnings 0 <files>` — must be warning-free.
- **Type gate:** `npm run compile:electron` (runs `tsc --project electron-tsconfig.json`) must pass.
- **Test command:** `npx vitest run <files> --no-file-parallelism`.
- **Note on better-sqlite3 ABI:** `npm run compile:electron` rebuilds `better-sqlite3` against Electron's ABI. If a desktop test that constructs a real `better-sqlite3` DB then fails with a `NODE_MODULE_VERSION` mismatch, run `npm rebuild better-sqlite3` (restores the Node ABI) and re-run. This is an environment artifact, not a code bug.
- **Commits:** Conventional Commits, English, no `Co-Authored-By` trailer. Commit after each task's tests pass. Do not push.

## File Structure

- `src/main/sqliteStore.ts` — add 3 baseline columns to `agents` (migration + CREATE TABLE).
- `src/main/genworkStore.ts` — `Agent`/`CreateAgentRequest`/`UpdateAgentRequest` types + `serverSkillIds`/`serverSubagentAllowAgentIds`/`serverImChannels` fields; `mapAgentRow` parsing; `createAgent`/`updateAgent` write the baseline columns; **enterprise guard** in `updateAgent` + `deleteAgent`.
- `src/main/libs/agentProvenance.ts` (new) — pure `deriveProvenance`.
- `src/main/libs/agentEnterpriseSync.ts` — `ServerAgentView` gains `imChannels`; sync UPSERT merges baseline + overlay instead of clobbering.
- `src/main/auth/enterpriseClient.ts` — `listEnterpriseAgents` returns `imChannels`.
- `src/main/ipcHandlers/agents/handlers.ts` — `List` handler enriches each enterprise agent with baseline fields (skill id mapping); `deps` gains `getSkillManager`.
- `src/shared/agent/constants.ts` — add `serverSkillIds`/`serverSubagentAllowAgentIds`/`serverImChannels` to the agent list shape if a shared type exists; otherwise extend the preload/IPC return type.
- `src/main/preload.ts` — agents bridge `list()`/`update()` pass the new baseline fields through.
- `src/renderer/store/slices/agentSlice.ts` — `AgentSummary` gains the 3 baseline fields; rename `isReadOnly` → `isServerOwned`; update `setAgents`/`addAgent` + the slice test.
- `src/renderer/services/agent.ts` — `list`/`create`/`update` map the new baseline fields; rename usages of the flag if any.
- `src/renderer/components/agent/AgentSettingsPanel.tsx` — per-section gating, read-only server fields, source badges, save reappears (overlay-only), IM tab shown for enterprise agents with restricted content.
- `src/renderer/components/agent/AgentSkillSelector.tsx` — accept `lockedSkillIds` (baseline) to disable removal of those.
- `src/renderer/components/agentSidebar/AgentTreeNode.tsx` (+ `types.ts`, `useAgentSidebarState.ts`, `.test.ts`) — rename flag; Edit visible for enterprise agents, Delete stays hidden.
- `src/renderer/services/i18n.ts` — new keys (en + zh).

---

### Task 1: Baseline columns in SQLite

**Files:**
- Modify: `src/main/sqliteStore.ts:236-259` (CREATE TABLE `agents`) and `:645-695` (migration block).

**Interfaces:**
- Produces: columns `server_skill_ids TEXT NOT NULL DEFAULT '[]'`, `server_subagent_allow_agent_ids TEXT NOT NULL DEFAULT '[]'`, `server_im_channels TEXT NOT NULL DEFAULT '[]'` on `agents`.

- [ ] **Step 1: Add the columns to the CREATE TABLE statement**

In `src/main/sqliteStore.ts`, the `CREATE TABLE IF NOT EXISTS agents` block (lines 236-259), after the `subagent_allow_agent_ids` column (line 248) add:

```sql
  server_skill_ids TEXT NOT NULL DEFAULT '[]',
  server_subagent_allow_agent_ids TEXT NOT NULL DEFAULT '[]',
  server_im_channels TEXT NOT NULL DEFAULT '[]',
```

- [ ] **Step 2: Add migration for existing databases**

In the `Migration: Add model preference and layout columns to agents` block (the `try { const agentCols = this.db.pragma('table_info(agents)') ...` block ending at line 684), add three guarded ALTERs mirroring the `enterprise_agent_id` one:

```ts
      if (!agentColNames.includes('server_skill_ids')) {
        this.db.exec("ALTER TABLE agents ADD COLUMN server_skill_ids TEXT NOT NULL DEFAULT '[]';");
        this.didRunMigration = true;
      }
      if (!agentColNames.includes('server_subagent_allow_agent_ids')) {
        this.db.exec("ALTER TABLE agents ADD COLUMN server_subagent_allow_agent_ids TEXT NOT NULL DEFAULT '[]';");
        this.didRunMigration = true;
      }
      if (!agentColNames.includes('server_im_channels')) {
        this.db.exec("ALTER TABLE agents ADD COLUMN server_im_channels TEXT NOT NULL DEFAULT '[]';");
        this.didRunMigration = true;
      }
```

(These live inside the existing `try { ... }` that already computes `agentColNames`; add them just before the block's closing brace, after the `enterprise_agent_id` check.)

- [ ] **Step 3: Verify migration runs and columns exist**

Run: `npx vitest run src/main/sqliteStore.test.ts --no-file-parallelism`
Expected: PASS (existing tests still pass; the migration is additive and idempotent). If better-sqlite3 throws a `NODE_MODULE_VERSION` error, run `npm rebuild better-sqlite3` first, then re-run.

- [ ] **Step 4: Commit**

```bash
git add src/main/sqliteStore.ts
git commit -m "feat(desktop): add agent server baseline columns (skills/subagents/im_channels)"
```

---

### Task 2: Store types + read/write of baseline fields

**Files:**
- Modify: `src/main/genworkStore.ts` (`Agent` 402-424, `CreateAgentRequest` 426-441, `UpdateAgentRequest` 443-457, `createAgent` 3237-3291, `updateAgent` 3304-3376, `mapAgentRow` 3425-3473).
- Test: `src/main/gworkStore.test.ts`.

**Interfaces:**
- Consumes: Task 1 columns; existing `normalizeStringIdList` (genworkStore.ts:156) and `parseStringIdList` (genworkStore.ts:180).
- Produces: `Agent.serverSkillIds: string[]`, `Agent.serverSubagentAllowAgentIds: string[]`, `Agent.serverImChannels: string[]`. `CreateAgentRequest`/`UpdateAgentRequest` accept the same three optional fields. `mapAgentRow` parses them (default `[]`).

- [ ] **Step 1: Write the failing test**

In `src/main/gworkStore.test.ts`, add (near the existing agent tests). Note the test harness `setupDb()` (line 42) builds a minimal `agents` table — extend its `CREATE TABLE agents` (around lines 120-136) to include the three new columns so the INSERT/SELECT succeed:

```ts
  test('updateAgent stores and reads back the three server baseline fields', () => {
    const agent = store.createAgent({ name: 'Ent Agent', source: 'enterprise', enterpriseAgentId: 'srv-1' });
    const updated = store.updateAgent(agent.id, {
      serverSkillIds: ['srv-skill-a', 'srv-skill-b'],
      serverSubagentAllowAgentIds: ['srv-agent-x'],
      serverImChannels: ['feishu', 'dingtalk'],
    });
    expect(updated?.serverSkillIds).toEqual(['srv-skill-a', 'srv-skill-b']);
    expect(updated?.serverSubagentAllowAgentIds).toEqual(['srv-agent-x']);
    expect(updated?.serverImChannels).toEqual(['feishu', 'dingtalk']);
    const reloaded = store.getAgent(agent.id);
    expect(reloaded?.serverSkillIds).toEqual(['srv-skill-a', 'srv-skill-b']);
  });
```

(If `gworkStore.test.ts`'s `setupDb()` currently lacks an `agents` table, add one mirroring `sqliteStore.ts` including the three new columns. Check the file first.)

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run src/main/gworkStore.test.ts --no-file-parallelism`
Expected: FAIL — `updated?.serverSkillIds` is `undefined`.

- [ ] **Step 3: Add the fields to the types**

In `genworkStore.ts`, add to `Agent` (after line 413 `subagentAllowAgentIds: string[];`):

```ts
  serverSkillIds: string[];
  serverSubagentAllowAgentIds: string[];
  serverImChannels: string[];
```

Add to `CreateAgentRequest` (after `subagentAllowAgentIds?`):

```ts
  serverSkillIds?: string[];
  serverSubagentAllowAgentIds?: string[];
  serverImChannels?: string[];
```

Add to `UpdateAgentRequest` (after `subagentAllowAgentIds?`):

```ts
  serverSkillIds?: string[];
  serverSubagentAllowAgentIds?: string[];
  serverImChannels?: string[];
```

- [ ] **Step 4: Write the baseline columns in createAgent and updateAgent**

In `createAgent` (3237), add the three columns to the `INSERT INTO agents (...)` column list and `VALUES` placeholders, and pass `JSON.stringify(normalizeStringIdList(request.serverSkillIds))`, `JSON.stringify(normalizeStringIdList(request.serverSubagentAllowAgentIds))`, `JSON.stringify(normalizeStringIdList(request.serverImChannels))`.

In `updateAgent` (3304), after the `subagentAllowAgentIds` block (line 3351) add:

```ts
    if (updates.serverSkillIds !== undefined) {
      setClauses.push('server_skill_ids = ?');
      values.push(JSON.stringify(normalizeStringIdList(updates.serverSkillIds)));
    }
    if (updates.serverSubagentAllowAgentIds !== undefined) {
      setClauses.push('server_subagent_allow_agent_ids = ?');
      values.push(JSON.stringify(normalizeStringIdList(updates.serverSubagentAllowAgentIds)));
    }
    if (updates.serverImChannels !== undefined) {
      setClauses.push('server_im_channels = ?');
      values.push(JSON.stringify(normalizeStringIdList(updates.serverImChannels)));
    }
```

- [ ] **Step 5: Parse the fields in mapAgentRow**

In `mapAgentRow` (3425), add to the row param type `server_skill_ids?: string | null;`, `server_subagent_allow_agent_ids?: string | null;`, `server_im_channels?: string | null;`, and to the returned object (after `subagentAllowAgentIds,`):

```ts
      serverSkillIds: parseStringIdList(row.server_skill_ids),
      serverSubagentAllowAgentIds: parseStringIdList(row.server_subagent_allow_agent_ids),
      serverImChannels: parseStringIdList(row.server_im_channels),
```

- [ ] **Step 6: Run to verify it passes**

Run: `npx vitest run src/main/gworkStore.test.ts --no-file-parallelism`
Expected: PASS.

- [ ] **Step 7: Lint + type check**

Run: `npx eslint --ext ts,tsx --report-unused-disable-directives --max-warnings 0 src/main/genworkStore.ts src/main/gworkStore.test.ts`
Run: `npm run compile:electron`
Expected: both clean.

- [ ] **Step 8: Commit**

```bash
git add src/main/genworkStore.ts src/main/gworkStore.test.ts
git commit -m "feat(desktop): read/write agent server baseline fields in the store"
```

---

### Task 3: Provenance pure function

**Files:**
- Create: `src/main/libs/agentProvenance.ts`
- Test: `src/main/libs/agentProvenance.test.ts`

**Interfaces:**
- Produces:
```ts
export interface AgentProvenanceInput {
  skillIds: string[];
  subagentAllowAgentIds: string[];
  serverSkillIds: string[];
  serverSubagentAllowAgentIds: string[];
  serverImChannels: string[];
}
export interface AgentProvenance {
  baselineSkillIds: string[];
  addedSkillIds: string[];
  baselineSubagentIds: string[];
  addedSubagentIds: string[];
  imChannels: string[];
}
export function deriveProvenance(
  input: AgentProvenanceInput,
  resolveSkill: (serverSkillId: string) => string | null,
  resolveSubagent: (serverAgentId: string) => string | null,
): AgentProvenance
```
- `baselineSkillIds = input.serverSkillIds.map(resolveSkill).filter((x): x is string => x !== null)`.
- `addedSkillIds = input.skillIds.filter(id => !baselineSkillIds.includes(id))`.
- Subagent variant is identical over the subagent fields with `resolveSubagent`.
- `imChannels = input.serverImChannels` (verbatim).

- [ ] **Step 1: Write the failing tests**

Create `src/main/libs/agentProvenance.test.ts`:

```ts
import { describe, expect, test } from 'vitest';
import { deriveProvenance } from './agentProvenance';

const resolveSkill = (id: string) => (id === 'missing' ? null : 'local_' + id);
const resolveSub = (id: string) => (id === 'ghost' ? null : 'localagent_' + id);

describe('deriveProvenance', () => {
  test('partitions skills into baseline and added', () => {
    const p = deriveProvenance(
      { skillIds: ['local_s1', 'local_s2', 'local_extra'], subagentAllowAgentIds: [], serverSkillIds: ['s1', 's2'], serverSubagentAllowAgentIds: [], serverImChannels: [] },
      resolveSkill, resolveSub,
    );
    expect(p.baselineSkillIds).toEqual(['local_s1', 'local_s2']);
    expect(p.addedSkillIds).toEqual(['local_extra']);
  });

  test('unresolvable server skill ids are excluded from baseline', () => {
    const p = deriveProvenance(
      { skillIds: ['local_missing'], subagentAllowAgentIds: [], serverSkillIds: ['missing', 's1'], serverSubagentAllowAgentIds: [], serverImChannels: [] },
      resolveSkill, resolveSub,
    );
    expect(p.baselineSkillIds).toEqual([]);
    expect(p.addedSkillIds).toEqual(['local_missing']);
  });

  test('partitions subagents and drops unresolvable server refs', () => {
    const p = deriveProvenance(
      { skillIds: [], subagentAllowAgentIds: ['localagent_x', 'localagent_mine'], serverSkillIds: [], serverSubagentAllowAgentIds: ['x', 'ghost'], serverImChannels: [] },
      resolveSkill, resolveSub,
    );
    expect(p.baselineSubagentIds).toEqual(['localagent_x']);
    expect(p.addedSubagentIds).toEqual(['localagent_mine']);
  });

  test('imChannels is the verbatim server set', () => {
    const p = deriveProvenance(
      { skillIds: [], subagentAllowAgentIds: [], serverSkillIds: [], serverSubagentAllowAgentIds: [], serverImChannels: ['feishu', 'dingtalk'] },
      resolveSkill, resolveSub,
    );
    expect(p.imChannels).toEqual(['feishu', 'dingtalk']);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run src/main/libs/agentProvenance.test.ts --no-file-parallelism`
Expected: FAIL — `Cannot find module './agentProvenance'`.

- [ ] **Step 3: Implement**

Create `src/main/libs/agentProvenance.ts`:

```ts
export interface AgentProvenanceInput {
  skillIds: string[];
  subagentAllowAgentIds: string[];
  serverSkillIds: string[];
  serverSubagentAllowAgentIds: string[];
  serverImChannels: string[];
}

export interface AgentProvenance {
  baselineSkillIds: string[];
  addedSkillIds: string[];
  baselineSubagentIds: string[];
  addedSubagentIds: string[];
  imChannels: string[];
}

export function deriveProvenance(
  input: AgentProvenanceInput,
  resolveSkill: (serverSkillId: string) => string | null,
  resolveSubagent: (serverAgentId: string) => string | null,
): AgentProvenance {
  const baselineSkillIds = input.serverSkillIds
    .map((id) => resolveSkill(id))
    .filter((id): id is string => id !== null);
  const addedSkillIds = input.skillIds.filter((id) => !baselineSkillIds.includes(id));

  const baselineSubagentIds = input.serverSubagentAllowAgentIds
    .map((id) => resolveSubagent(id))
    .filter((id): id is string => id !== null);
  const addedSubagentIds = input.subagentAllowAgentIds.filter((id) => !baselineSubagentIds.includes(id));

  return {
    baselineSkillIds,
    addedSkillIds,
    baselineSubagentIds,
    addedSubagentIds,
    imChannels: input.serverImChannels,
  };
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run src/main/libs/agentProvenance.test.ts --no-file-parallelism`
Expected: PASS.

- [ ] **Step 5: Lint + commit**

Run: `npx eslint --ext ts,tsx --report-unused-disable-directives --max-warnings 0 src/main/libs/agentProvenance.ts src/main/libs/agentProvenance.test.ts`

```bash
git add src/main/libs/agentProvenance.ts src/main/libs/agentProvenance.test.ts
git commit -m "feat(desktop): add agent provenance (baseline vs added) pure function"
```

---

### Task 4: Main-process guard on enterprise update/delete

**Files:**
- Modify: `src/main/genworkStore.ts` (`updateAgent` 3304-3376, `deleteAgent` 3405-3423).
- Test: `src/main/gworkStore.test.ts`.

**Interfaces:**
- Consumes: Task 2 (`Agent.serverSkillIds`/`serverSubagentAllowAgentIds`/`serverImChannels`), Task 3 `deriveProvenance`.
- Produces: for `source === 'enterprise'` rows, `updateAgent` ignores server-owned scalar fields (name/description/identity/systemPrompt/model/thinkingLevel/icon); `deleteAgent` returns `false` for enterprise rows. (The "re-add dropped baseline skill" merge is Task 6, in the handler.)

- [ ] **Step 1: Write the failing tests**

The store can enforce exactly **two** invariants without the skill catalog: (a) server-owned scalar fields are immutable for enterprise rows, and (b) enterprise rows cannot be deleted. The "re-add a dropped baseline skill" merge is enforced in the **handler** (Task 6) — the only layer that has `skillManager` to resolve server→local ids. Do not test the merge here.

In `src/main/gworkStore.test.ts`:

```ts
  test('enterprise row: server-owned scalar field change is rejected', () => {
    const agent = store.createAgent({ name: 'Ent', source: 'enterprise', enterpriseAgentId: 'srv-1', systemPrompt: 'orig' });
    const after = store.updateAgent(agent.id, { systemPrompt: 'hacked', name: 'Renamed' });
    expect(after?.systemPrompt).toBe('orig');
    expect(after?.name).toBe('Ent');
  });

  test('enterprise row: deleteAgent returns false', () => {
    const agent = store.createAgent({ name: 'Ent', source: 'enterprise', enterpriseAgentId: 'srv-1' });
    expect(store.deleteAgent(agent.id)).toBe(false);
    expect(store.getAgent(agent.id)).not.toBeNull();
  });
```

- [ ] **Step 2: Implement the store guard**

In `updateAgent` (3304), right after `const existing = this.getAgent(id); if (!existing) return null;` (lines 3305-3306), add:

```ts
    const isEnterprise = existing.source === 'enterprise';
```

Then guard each server-owned scalar field. Change each of these blocks so the `if (updates.X !== undefined)` only applies when `!isEnterprise`. The cleanest edit: wrap the seven scalar blocks. For `name`, `description`, `systemPrompt`, `identity`, `model`, `thinkingLevel`, `icon`, prefix their condition with `!isEnterprise &&`. Example for `name`:

```ts
    if (!isEnterprise && updates.name !== undefined) {
      setClauses.push('name = ?');
      values.push(updates.name);
    }
```

Do the same for `description`, `systemPrompt`, `identity`, `model`, `thinkingLevel`, and `icon`. Leave `workingDirectory`, `skillIds`, `subagentAllowAgentIds`, the baseline fields, `enabled`, `pinned`, `sortOrder` unchanged (workingDirectory on the row stays `''` for enterprise anyway; the real value is in prefs).

In `deleteAgent` (3405), right after `if (id === AgentId.Main) return false;` (line 3406) add:

```ts
    const row = this.getAgent(id);
    if (row && row.source === 'enterprise') return false;
```

- [ ] **Step 3: Run the scalar/delete tests**

Run: `npx vitest run src/main/gworkStore.test.ts --no-file-parallelism -t enterprise`
Expected: the two enterprise scalar/delete tests PASS. (Move the "baseline re-add" test into Task 6 against the handler — do not assert it here.)

- [ ] **Step 4: Lint + type check + commit**

Run: `npx eslint --ext ts,tsx --report-unused-disable-directives --max-warnings 0 src/main/genworkStore.ts src/main/gworkStore.test.ts`
Run: `npm run compile:electron`

```bash
git add src/main/genworkStore.ts src/main/gworkStore.test.ts
git commit -m "feat(desktop): enforce read-only invariants for enterprise agents in the store"
```

---

### Task 5: Sync merges baseline + overlay (no clobber) + surface imChannels

**Files:**
- Modify: `src/main/libs/agentEnterpriseSync.ts` (`ServerAgentView` 7-20, UPSERT 63-97), `src/main/auth/enterpriseClient.ts` (`listEnterpriseAgents` ~391-429), `src/main/libs/agentEnterpriseSync.test.ts`.

**Interfaces:**
- Consumes: Task 2 store baseline fields; Task 1 columns.
- Produces: `ServerAgentView` gains `imChannels: string[]`. Sync UPSERT writes `serverSkillIds`/`serverSubagentAllowAgentIds`/`serverImChannels` and sets `skillIds`/`subagentAllowAgentIds` to `mappedBaseline ∪ preservedOverlay` instead of the raw server list.

- [ ] **Step 1: Write the failing tests**

In `src/main/libs/agentEnterpriseSync.test.ts`, update the `row()` factory to include `serverSkillIds: []`, `serverSubagentAllowAgentIds: []`, `serverImChannels: []` defaults. Add tests:

```ts
  test('a user-added skill survives a server resync', async () => {
    // Pre-existing local enterprise agent has a user-added skill 'local_mine'
    // on top of baseline local 'local_s1' (server id 's1').
    const store = fakeStore([
      row({
        id: 'local_a', name: 'A', source: 'enterprise', enterpriseAgentId: 'a',
        skillIds: ['local_s1', 'local_mine'],
        serverSkillIds: ['s1'],
      }),
    ]);
    const prefs = { remove: vi.fn() };
    const skillManager = { getCatalogLocalId: (id: string) => 'local_' + id };
    await agentEnterpriseSync.syncFromServer({
      serverView: [{ agentId: 'a', name: 'A', description: '', identity: '', systemPrompt: '', model: '', thinkingLevel: 'medium', icon: '', skillIds: ['s1'], subagentAllowAgentIds: [], allowedRoles: ['org_admin'], enabled: true, imChannels: ['feishu'] }],
      genworkStore: store as never,
      prefsStore: prefs as never,
      skillManager: skillManager as never,
      defaultModelRef: '',
    });
    const updated = store.listAgents().find((a) => a.id === 'local_a')!;
    // baseline 'local_s1' preserved + user overlay 'local_mine' preserved.
    expect(updated.skillIds).toEqual(expect.arrayContaining(['local_s1', 'local_mine']));
    expect(updated.serverSkillIds).toEqual(['s1']);
    expect(updated.serverImChannels).toEqual(['feishu']);
  });

  test('a server-removed skill the user did not add disappears', async () => {
    const store = fakeStore([
      row({
        id: 'local_a', name: 'A', source: 'enterprise', enterpriseAgentId: 'a',
        skillIds: ['local_s1', 'local_s2'],
        serverSkillIds: ['s1', 's2'],
      }),
    ]);
    const skillManager = { getCatalogLocalId: (id: string) => 'local_' + id };
    await agentEnterpriseSync.syncFromServer({
      serverView: [{ agentId: 'a', name: 'A', description: '', identity: '', systemPrompt: '', model: '', thinkingLevel: 'medium', icon: '', skillIds: ['s1'], subagentAllowAgentIds: [], allowedRoles: ['org_admin'], enabled: true, imChannels: [] }],
      genworkStore: store as never,
      prefsStore: { remove: vi.fn() } as never,
      skillManager: skillManager as never,
      defaultModelRef: '',
    });
    const updated = store.listAgents().find((a) => a.id === 'local_a')!;
    expect(updated.skillIds).toEqual(['local_s1']); // local_s2 dropped
  });
```

(If the existing test's `serverView` objects are constructed by a shared helper, extend that helper to carry `imChannels` and the new baseline fields; keep existing tests passing.)

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run src/main/libs/agentEnterpriseSync.test.ts --no-file-parallelism`
Expected: FAIL — the overlay is clobbered (`skillIds` becomes `['local_s1']` and drops `local_mine`); `serverSkillIds`/`serverImChannels` not written.

- [ ] **Step 3: Add `imChannels` to ServerAgentView and surface it in the client**

In `agentEnterpriseSync.ts`, add `imChannels: string[];` to `ServerAgentView` (line 20 area).

In `src/main/auth/enterpriseClient.ts`, in `listEnterpriseAgents` (map the response rows), add `imChannels: (row.im_channels as string[]) ?? []` to each returned object (the server `AgentMarketplaceView` exposes `imChannels`). Check the existing row mapping and add the field; the `ServerAgentView` consumer (`enterpriseAgentSyncRunner` / the sync caller) must pass `imChannels` into `serverView`. If the caller builds `serverView` from the client response, add `imChannels: a.imChannels`.

- [ ] **Step 4: Implement the merge in sync UPSERT**

Replace the UPSERT payload construction (lines 64-97). For the **existing** enterprise row, compute the overlay and preserve it:

```ts
      const existing = existingLocal.find(a => a.enterpriseAgentId === sv.agentId);

      // Map server skill ids → local ids.
      const baselineSkillLocal = sv.skillIds
        .map((sid) => opts.skillManager.getCatalogLocalId(sid) ?? sid);

      // Map server subagent ids → local agent ids (via enterprise_agent_id).
      const allLocal = opts.genworkStore.listAgents();
      const serverAgentIdToLocal = new Map(
        allLocal.filter(a => a.source === 'enterprise' && a.enterpriseAgentId).map(a => [a.enterpriseAgentId!, a.id] as const),
      );
      const baselineSubagentLocal = sv.subagentAllowAgentIds
        .map((aid) => serverAgentIdToLocal.get(aid) ?? null)
        .filter((id): id is string => id !== null);

      let nextSkillIds = baselineSkillLocal;
      let nextSubagentIds = baselineSubagentLocal;

      if (existing) {
        // Preserve the user overlay = previously effective set minus the previous baseline.
        const oldBaselineSkill = existing.serverSkillIds
          .map((sid) => opts.skillManager.getCatalogLocalId(sid) ?? sid);
        const oldBaselineSub = (existing.serverSubagentAllowAgentIds ?? [])
          .map((aid) => serverAgentIdToLocal.get(aid) ?? null)
          .filter((id): id is string => id !== null);
        const overlaySkills = existing.skillIds.filter((id) => !oldBaselineSkill.includes(id));
        const overlaySubs = existing.subagentAllowAgentIds.filter((id) => !oldBaselineSub.includes(id));
        nextSkillIds = Array.from(new Set([...baselineSkillLocal, ...overlaySkills]));
        nextSubagentIds = Array.from(new Set([...baselineSubagentLocal, ...overlaySubs]));
      }

      const payload = {
        name: sv.name,
        description: sv.description,
        identity: sv.identity,
        systemPrompt: sv.systemPrompt,
        model: effectiveModel,
        thinkingLevel: (sv.thinkingLevel ?? '') as '' | 'low' | 'medium' | 'high',
        workingDirectory: '',
        icon: sv.icon,
        skillIds: nextSkillIds,
        subagentAllowAgentIds: nextSubagentIds,
        serverSkillIds: sv.skillIds,
        serverSubagentAllowAgentIds: sv.subagentAllowAgentIds,
        serverImChannels: sv.imChannels ?? [],
        source: 'enterprise' as const,
        enterpriseAgentId: sv.agentId,
      };

      if (existing) {
        opts.genworkStore.updateAgent(existing.id, payload);
      } else {
        const req: CreateAgentRequest = { ...payload };
        opts.genworkStore.createAgent(req);
      }
      report.upserted++;
```

(The `createAgent`/`create` path gets the baseline fields too because `CreateAgentRequest` now carries them from Task 2.)

- [ ] **Step 5: Run to verify it passes**

Run: `npx vitest run src/main/libs/agentEnterpriseSync.test.ts --no-file-parallelism`
Expected: PASS (new tests + all existing tests).

- [ ] **Step 6: Lint + type check + commit**

Run: `npx eslint --ext ts,tsx --report-unused-disable-directives --max-warnings 0 src/main/libs/agentEnterpriseSync.ts src/main/auth/enterpriseClient.ts src/main/libs/agentEnterpriseSync.test.ts`
Run: `npm run compile:electron`

```bash
git add src/main/libs/agentEnterpriseSync.ts src/main/auth/enterpriseClient.ts src/main/libs/agentEnterpriseSync.test.ts
git commit -m "feat(desktop): sync merges server baseline with local agent overlay"
```

---

### Task 6: Handler merge guard (re-add dropped baseline) + baseline enrichment on list

**Files:**
- Modify: `src/main/ipcHandlers/agents/handlers.ts` (`AgentHandlerDeps`, `List` handler ~84-99, `Update` handler ~125-159), and the call site in `src/main/main.ts` (add `getSkillManager` to the `registerAgentHandlers` deps).
- Test: extend `src/main/ipcHandlers/agents/handlers.test.ts` if it exists; otherwise add `src/main/ipcHandlers/agents/agentHandlers.enterprise.test.ts`.

**Interfaces:**
- Consumes: `deriveProvenance` (Task 3), `skillManager.getCatalogLocalId`, `genworkStore`/`agentManager.listAgents`.
- Produces: the `agents:update` handler, for enterprise rows, computes the effective `skillIds`/`subagentAllowAgentIds` as `submitted ∪ baselineLocal` (so a dropped baseline item is re-added) before calling the store. The `agents:list` handler enriches each enterprise agent's response with `serverSkillIds`/`serverSubagentAllowAgentIds`/`serverImChannels` **plus** the pre-resolved local sets `serverSkillLocalIds`/`serverSubagentLocalIds` (so the renderer can show lock badges without a new IPC).

- [ ] **Step 1: Add `getSkillManager` to the deps**

In `handlers.ts` `registerAgentHandlers` (line 72), destructure `getSkillManager` from `deps` (add it to the `AgentHandlerDeps` interface). In `src/main/main.ts`, add `getSkillManager` to the object passed to `registerAgentHandlers` (it is available there — see `main.ts:3131` and the other `registerAgentHandlers` call sites around line 6834).

- [ ] **Step 2: Write the failing test**

Create `src/main/ipcHandlers/agents/agentHandlers.enterprise.test.ts` (or extend the existing handler test if one exists). Mock `electron` (`app.getAppPath`), build an in-memory DB like `gworkStore.test.ts` with an `agents` table including the baseline columns, create a `GenWorkStore`, and an `AgentManager`-like `listAgents`/`updateAgent` delegate to the store. Register the handlers with a fake `getSkillManager` whose `getCatalogLocalId(id)` returns `'local_' + id`. Insert an enterprise agent:

```ts
// Setup (mirrors gworkStore.test.ts harness + registerAgentHandlers with fakes)
const ent = store.createAgent({ name: 'Ent', source: 'enterprise', enterpriseAgentId: 'srv-1', skillIds: ['local_s1', 'local_mine'], subagentAllowAgentIds: ['localagent_x'] });
store.updateAgent(ent.id, { serverSkillIds: ['s1'], serverSubagentAllowAgentIds: ['x'] });

test('dropping a baseline skill on update is re-added (merge guard)', async () => {
  const res = await ipcInvoke(AgentIpcChannel.Update, { agentId: ent.id, updates: { skillIds: ['local_mine'] } });
  // 'local_s1' (baseline) must be present alongside the user's 'local_mine'.
  expect(res.success).toBe(true);
  const after = store.getAgent(ent.id)!;
  expect(after.skillIds).toEqual(expect.arrayContaining(['local_s1', 'local_mine']));
});
```

(Use the existing pattern for invoking a registered `ipcMain.handle` — if a helper for invoking handlers exists in `handlers.test.ts`, reuse it. If not, capture the handler via `ipcMain.handle` spy: `vi.spyOn(ipcMain, 'handle')` and call the last registered handler for `AgentIpcChannel.Update`.)

- [ ] **Step 3: Run to verify it fails**

Run: `npx vitest run src/main/ipcHandlers/agents/agentHandlers.enterprise.test.ts --no-file-parallelism`
Expected: FAIL — the update writes `skillIds: ['local_mine']` without re-adding the baseline.

- [ ] **Step 4: Implement the merge guard in the Update handler**

In the `agents:update` handler (in `handlers.ts`, ~125-159), before calling the store `updateAgent`, if the target agent is enterprise, merge the baseline back in:

```ts
      const target = getGenWorkStore().getAgent(agentId);
      let effectiveUpdates = updates;
      if (target && target.source === 'enterprise') {
        const skillMgr = getSkillManager();
        const localByServerAgent = new Map(
          getGenWorkStore().listAgents()
            .filter((a) => a.source === 'enterprise' && a.enterpriseAgentId)
            .map((a) => [a.enterpriseAgentId!, a.id] as const),
        );
        const prov = deriveProvenance(
          {
            skillIds: updates.skillIds ?? target.skillIds,
            subagentAllowAgentIds: updates.subagentAllowAgentIds ?? target.subagentAllowAgentIds,
            serverSkillIds: target.serverSkillIds,
            serverSubagentAllowAgentIds: target.serverSubagentAllowAgentIds,
            serverImChannels: target.serverImChannels,
          },
          (sid) => skillMgr.getCatalogLocalId(sid) ?? null,
          (aid) => localByServerAgent.get(aid) ?? null,
        );
        effectiveUpdates = {
          ...updates,
          skillIds: updates.skillIds
            ? Array.from(new Set([...updates.skillIds, ...prov.baselineSkillIds]))
            : undefined,
          subagentAllowAgentIds: updates.subagentAllowAgentIds
            ? Array.from(new Set([...updates.subagentAllowAgentIds, ...prov.baselineSubagentIds]))
            : undefined,
        };
        // Strip server-owned scalar fields so the store guard is belt-and-suspenders.
        const { name, description, systemPrompt, identity, model, thinkingLevel, icon, ...rest } = effectiveUpdates;
        effectiveUpdates = rest;
      }
```

Then pass `effectiveUpdates` to the store `updateAgent` (replace the current `updates` argument). For the scalar-strip destructure, omit the named fields so `rest` simply excludes them; if the linter still flags the destructured vars as unused, prefix them (e.g. `name: _name`) or add a single narrow `// eslint-disable-next-line @typescript-eslint/no-unused-vars` above the line — do not use a broad disable.

Import `deriveProvenance` at the top of `handlers.ts`.

- [ ] **Step 5: Enrich the List handler with server + local baseline sets**

In the `agents:list` handler (~84-99), after `const agents = getAgentManager().listAgents();`, map the result so each enterprise agent also carries the **resolved local** baseline sets the renderer needs for its lock badges (the handler has `getSkillManager`, so this needs no new IPC):

```ts
      const skillMgr = getSkillManager();
      const all = getGenWorkStore().listAgents();
      const serverAgentIdToLocal = new Map(
        all.filter((a) => a.source === 'enterprise' && a.enterpriseAgentId)
          .map((a) => [a.enterpriseAgentId!, a.id] as const),
      );
      const agents = rawAgents.map((a) => {
        if (a.source !== 'enterprise') return a;
        return {
          ...a,
          serverSkillLocalIds: a.serverSkillIds
            .map((sid) => skillMgr.getCatalogLocalId(sid) ?? null)
            .filter((id): id is string => id !== null),
          serverSubagentLocalIds: a.serverSubagentAllowAgentIds
            .map((aid) => serverAgentIdToLocal.get(aid) ?? null)
            .filter((id): id is string => id !== null),
        };
      });
```

(Rename the original `const agents = getAgentManager().listAgents();` to `const rawAgents = ...` and use `agents` as the mapped result. Extend the return payload / preload agent type in Task 7 to include `serverSkillLocalIds?: string[]` and `serverSubagentLocalIds?: string[]`.)

- [ ] **Step 6: Run to verify it passes**

Run: `npx vitest run src/main/ipcHandlers/agents/agentHandlers.enterprise.test.ts --no-file-parallelism`
Expected: PASS.

- [ ] **Step 7: Lint + type check + commit**

Run: `npx eslint --ext ts,tsx --report-unused-disable-directives --max-warnings 0 src/main/ipcHandlers/agents/handlers.ts src/main/ipcHandlers/agents/agentHandlers.enterprise.test.ts src/main/main.ts`
Run: `npm run compile:electron`

```bash
git add src/main/ipcHandlers/agents/handlers.ts src/main/ipcHandlers/agents/agentHandlers.enterprise.test.ts src/main/main.ts
git commit -m "feat(desktop): merge server baseline back into enterprise agent updates in the handler"
```

---

### Task 7: Plumb baseline fields through preload + renderer types + slice

**Files:**
- Modify: `src/main/preload.ts` (agents bridge, ~line 376), `src/renderer/store/slices/agentSlice.ts` (4-22, 48-62) + its test, `src/renderer/services/agent.ts` (40-135), `src/shared/agent/constants.ts` (if a shared agent-view type exists).

**Interfaces:**
- Produces: `AgentSummary.serverSkillIds: string[]`, `serverSubagentAllowAgentIds: string[]`, `serverImChannels: string[]`, plus the pre-resolved `serverSkillLocalIds: string[]` and `serverSubagentLocalIds: string[]` (from Task 6's list enrichment); flag renamed `isReadOnly` → `isServerOwned`. The renderer `AgentSummary` carries the baseline fields so `AgentSettingsPanel` can show lock badges directly from the local sets.

- [ ] **Step 1: Add fields + rename the flag in the slice**

In `agentSlice.ts`, change `AgentSummary` (line 21): replace `isReadOnly?: boolean;` with `isServerOwned?: boolean;`, and after `subagentAllowAgentIds: string[];` add:

```ts
  serverSkillIds: string[];
  serverSubagentAllowAgentIds: string[];
  serverImChannels: string[];
  serverSkillLocalIds?: string[];
  serverSubagentLocalIds?: string[];
```

Update `setAgents` (line 49) and `addAgent` (line 61): `isReadOnly` → `isServerOwned`.

- [ ] **Step 2: Update the slice test**

In `src/renderer/store/slices/agentSlice.test.ts`, rename `isReadOnly` → `isServerOwned` in the three tests (the file's describe uses `agentSlice.isReadOnly` assertions; change to `isServerOwned`). Add default `serverSkillIds: []` etc. to any fixture if the type requires it.

- [ ] **Step 3: Map the baseline fields in the agent service**

In `src/renderer/services/agent.ts`:
- In the `list` mapping (line ~49), add `serverSkillIds: a.serverSkillIds ?? []`, `serverSubagentAllowAgentIds: a.serverSubagentAllowAgentIds ?? []`, `serverImChannels: a.serverImChannels ?? []`, `serverSkillLocalIds: a.serverSkillLocalIds ?? []`, `serverSubagentLocalIds: a.serverSubagentLocalIds ?? []` to `mappedAgents`.
- In `create` and `update` dispatch payloads (lines ~94, ~129), add the same fields (from the returned agent; the local sets default to `[]`).
- Update the local `Agent` type in this file (its interface) to include all of these fields.

- [ ] **Step 4: Plumb through the preload bridge**

In `src/main/preload.ts` agents bridge (~line 376), `list()` returns `agents` from the handler — the fields flow through automatically if the IPC payload is passed through. Verify the preload does not strip unknown fields (it typically returns the raw result). If the preload declares a typed agent shape, add the three fields. Rename any `isReadOnly` in the bridge to `isServerOwned` (the flag is derived in the slice from `source`, so the bridge likely doesn't carry it — confirm).

- [ ] **Step 5: Update remaining `isReadOnly` consumers**

Rename `isReadOnly` → `isServerOwned` in:
- `src/renderer/components/agent/AgentSettingsPanel.tsx` (lines 106, 521, 779, 862, 873, 883 — and `isMainAgent && !isReadOnly`).
- `src/renderer/components/agentSidebar/AgentTreeNode.tsx` (line 92, 95, 115) + its test.
- `src/renderer/components/agentSidebar/types.ts` (line with `isReadOnly?: boolean;`).
- `src/renderer/components/agentSidebar/useAgentSidebarState.ts` (the mapping).
- `src/renderer/services/agent.test.ts` (assertions).

(Run `rg -n "isReadOnly" src/renderer` and fix every hit in these files; the `CoworkPromptInput.tsx` hits are a different local var `isReadOnlyContextCompact` — do NOT touch those.)

- [ ] **Step 6: Run the affected tests**

Run: `npx vitest run src/renderer/store/slices/agentSlice.test.ts src/renderer/services/agent.test.ts src/renderer/components/agentSidebar/AgentTreeNode.test.ts --no-file-parallelism`
Expected: PASS.

- [ ] **Step 7: Lint + type check + commit**

Run: `npx eslint --ext ts,tsx --report-unused-disable-directives --max-warnings 0 src/main/preload.ts src/renderer/store/slices/agentSlice.ts src/renderer/services/agent.ts src/renderer/components/agentSidebar/AgentTreeNode.tsx src/renderer/components/agentSidebar/types.ts src/renderer/components/agentSidebar/useAgentSidebarState.ts`
Run: `npm run compile:electron`

```bash
git add -A src/main/preload.ts src/renderer/store/slices/agentSlice.ts src/renderer/services/agent.ts src/renderer/components/agentSidebar/
git commit -m "feat(desktop): plumb agent baseline fields to the renderer and rename isReadOnly"
```

---

### Task 8: UI — per-section gating, badges, save, IM tab, sidebar Edit

**Files:**
- Modify: `src/renderer/components/agent/AgentSettingsPanel.tsx`, `src/renderer/components/agent/AgentSkillSelector.tsx`, `src/renderer/components/agentSidebar/AgentTreeNode.tsx`, `src/renderer/services/i18n.ts`.
- Test: `src/renderer/components/agent/AgentSettingsPanel.test.tsx` (create if absent), `src/renderer/components/agentSidebar/AgentTreeNode.test.ts`.

**Interfaces:**
- Consumes: `AgentSummary` with baseline fields (Task 7), `deriveProvenance`-equivalent logic (recomputed in the panel from the summary's fields + resolvers). For the panel, the resolvers are: skill id → local via a new lightweight IPC or the already-local `serverSkillIds` (the panel receives local baseline via a new field) — **decision:** the panel computes provenance from `serverSkillIds` mapped through a `skillManager`-free path by receiving the **already-local** baseline. See Step 4 note.
- Produces: an enterprise agent's settings panel shows read-only server fields, a source badge on skills/subagents, a save button that commits only the overlay, and a restricted IM tab; the sidebar shows Edit (not Delete) for enterprise agents.

**i18n keys (add to `src/renderer/services/i18n.ts`, en + zh):**
- `agentBaselineBadge`: en "Server", zh "服务端" (badge on baseline items, locked).
- `agentAddedBadge`: en "Local", zh "本地" (removable items).
- `agentImNoChannels`: en "No server-configured IM channels", zh "无服务端可配置渠道".
- `agentImReadOnlyHint`: en "Fill in credentials for the channels your administrator started.", zh "请为管理员已启动的渠道填写凭据。"

- [ ] **Step 1: Write the failing UI tests**

Create `src/renderer/components/agent/agentProvenancePanel.test.tsx` (a focused unit test) — or, if `AgentSettingsPanel` is already tested, extend that. Given the panel's size, test the **derived** helpers instead of the full 900-line component. Extract a pure helper (Step 2) and test it:

```ts
import { describe, expect, test } from 'vitest';
import { partitionSkills } from './agentProvenancePanel';

describe('partitionSkills', () => {
  test('marks baseline skills locked and added skills removable', () => {
    const p = partitionSkills({
      effectiveSkillIds: ['local_s1', 'local_mine'],
      baselineSkillIds: ['local_s1'],
    });
    expect(p.lockedSkillIds).toEqual(['local_s1']);
    expect(p.removableSkillIds).toEqual(['local_mine']);
  });
});
```

In `AgentTreeNode.test.ts`, add a test that for `isServerOwned: true` the **Edit** menu item is present and **Delete** is absent (currently Edit is hidden — this flips it):

```ts
  test('shows edit but hides delete for server-owned agents', () => {
    const html = renderKebabMenu(makeAgent({ isServerOwned: true }));
    expect(html).toContain('Edit');
    expect(html).not.toContain('Delete');
  });
```

(Use the existing `renderKebabMenu`/`makeAgent` helpers in that test file; rename `isReadOnly`→`isServerOwned` in the fixture.)

- [ ] **Step 2: Add the panel helper**

Create `src/renderer/components/agent/agentProvenancePanel.ts`:

```ts
export interface SkillPartition {
  lockedSkillIds: string[];
  removableSkillIds: string[];
}
export function partitionSkills(input: { effectiveSkillIds: string[]; baselineSkillIds: string[] }): SkillPartition {
  const lockedSkillIds = input.effectiveSkillIds.filter((id) => input.baselineSkillIds.includes(id));
  const removableSkillIds = input.effectiveSkillIds.filter((id) => !input.baselineSkillIds.includes(id));
  return { lockedSkillIds, removableSkillIds };
}
export function partitionSubagents(input: { effectiveSubagentIds: string[]; baselineSubagentIds: string[] }): SkillPartition {
  const locked = input.effectiveSubagentIds.filter((id) => input.baselineSubagentIds.includes(id));
  const removable = input.effectiveSubagentIds.filter((id) => !input.baselineSubagentIds.includes(id));
  return { lockedSkillIds: locked, removableSkillIds: removable };
}
```

**Panel baseline source:** `AgentSettingsPanel` reads the already-resolved local baseline sets straight from the summary — `agentSummary.serverSkillLocalIds` (skills) and `agentSummary.serverSubagentLocalIds` (subagents) — which Task 6's `agents:list` enrichment populates. No new IPC or per-panel resolution needed: `baselineSkillIds = agentSummary.serverSkillLocalIds ?? []`, `baselineSubagentIds = agentSummary.serverSubagentLocalIds ?? []`, `imChannels = agentSummary.serverImChannels ?? []`.

- [ ] **Step 3: Run the panel-helper + sidebar tests (RED)**

Run: `npx vitest run src/renderer/components/agent/agentProvenancePanel.test.tsx src/renderer/components/agentSidebar/AgentTreeNode.test.ts --no-file-parallelism`
Expected: FAIL (helper module missing; sidebar Edit still hidden).

- [ ] **Step 4: Implement the sidebar Edit-visibility change**

In `AgentTreeNode.tsx`, the kebab menu currently hides both Edit and Delete when `isServerOwned` (line 95 Edit, line 115 Delete). Change the **Edit** block (line 95) so it is always shown (remove the `!isServerOwned &&` guard), keeping the **Delete** block (line 115) guarded by `!isServerOwned &&`. (The main guard already blocks delete; the UI hides it too.)

- [ ] **Step 5: Implement the panel gating**

In `AgentSettingsPanel.tsx`:
1. Keep `const isServerOwned = agentSummary?.isServerOwned === true;` (line 106, already renamed in Task 7).
2. Compute the partition from the local baseline sets: `const baselineSkillIds = agentSummary.serverSkillLocalIds ?? []; const addedSkillIds = skillIds.filter((id) => !baselineSkillIds.includes(id)); const baselineSubagentIds = agentSummary.serverSubagentLocalIds ?? []; const addedSubagentIds = subagentAllowAgentIds.filter((id) => !baselineSubagentIds.includes(id)); const imChannels = agentSummary.serverImChannels ?? [];` (use `partitionSkills`/`partitionSubagents` helpers from Step 2 for the skill/subagent splits).
3. **Read-only server fields:** for `isServerOwned`, disable the name/description inputs (add `disabled`) and the `renderTextEditor` textareas for Prompt/Identity/User (add `disabled` to the `textarea` via a prop or a wrapper). The model/thinking toolbar (`AgentDetailToolbar`) is already replaced by `EnterpriseWorkingDirectoryField` for read-only (line 862) — keep that.
4. **Skills tab (line 839):** pass `lockedSkillIds={baselineSkillIds}` to `AgentSkillSelector` (new prop). In `AgentSkillSelector`, when a selected skill id is in `lockedSkillIds`, disable its toggle (render a lock icon + `disabled`), and show the `agentBaselineBadge` badge; for non-locked selected ids show `agentAddedBadge`.
5. **Collaboration tab (`renderCollaborationSettings`, 546):** for each candidate, if `baselineSubagentIds.includes(candidate.id)` render a lock + `agentBaselineBadge` and make the checkbox disabled (no toggle); if it is in `addedSubagentIds`, toggleable with `agentAddedBadge`. Candidates not in the effective set remain addable checkboxes.
6. **IM tab (line 521 filter):** change the filter so the IM tab is **shown** for `isServerOwned` too (remove `!isServerOwned || tab.key !== AgentDetailTab.Im` → just render all tabs). In the IM tab body (line 844), when `isServerOwned`: show `agentImReadOnlyHint`; render only the channels in `imChannels`; disable the enable/disable switches (they are already the per-instance enable toggles — for server-owned, render the channel rows with **only** the credential/instance config controls, no top-level enable toggle). If no `imChannels`, render `agentImNoChannels`.
7. **Save button (line 883):** change the condition from `!isServerOwned` to `true` (always render), but for `isServerOwned` the button label can stay `save`. In `handleSave` (338), when `isServerOwned`, call `agentService.updateAgent(agentId, { skillIds, subagentAllowAgentIds })` **only** (omit server-owned fields), and skip the `writeBootstrapFile` block (lines 373-394) for non-`isMainAgent` enterprise agents (they are never main). Keep the IM bindings persist (lines 401+) only for `imChannels`-listed platforms.
8. **Delete button (line 873):** keep hidden for `isServerOwned` (unchanged).
9. Keep the `agentReadOnlyBadge` span (line 779) for `isServerOwned`.

- [ ] **Step 6: Run the UI tests (GREEN)**

Run: `npx vitest run src/renderer/components/agent/agentProvenancePanel.test.tsx src/renderer/components/agentSidebar/AgentTreeNode.test.ts --no-file-parallelism`
Expected: PASS.

- [ ] **Step 7: Manual validation**

Run `npm run electron:dev`, open an enterprise agent's settings: verify server fields read-only, baseline skills/subagents locked with "Server" badge, added ones removable, IM tab shows only server channels with credential entry (no enable toggle), save persists the overlay, sidebar Edit visible / Delete hidden.

- [ ] **Step 8: Lint + type check + commit**

Run: `npx eslint --ext ts,tsx --report-unused-disable-directives --max-warnings 0 src/renderer/components/agent/AgentSettingsPanel.tsx src/renderer/components/agent/AgentSkillSelector.tsx src/renderer/components/agent/agentProvenancePanel.ts src/renderer/components/agent/agentProvenancePanel.test.tsx src/renderer/components/agentSidebar/AgentTreeNode.tsx src/renderer/services/i18n.ts`
Run: `npm run compile:electron`

```bash
git add src/renderer/components/agent/AgentSettingsPanel.tsx src/renderer/components/agent/AgentSkillSelector.tsx src/renderer/components/agent/agentProvenancePanel.ts src/renderer/components/agent/agentProvenancePanel.test.tsx src/renderer/components/agentSidebar/AgentTreeNode.tsx src/renderer/services/i18n.ts
git commit -m "feat(desktop): per-section gating and provenance badges for enterprise agents"
```

---

### Task 9: Block template overwrite of enterprise agents

**Files:**
- Modify: the preset/template apply path in `src/main/agentManager.ts` (or the `agents:applyTemplate` / `AddPreset` handler in `src/main/ipcHandlers/agents/handlers.ts:244-281`) — whichever writes preset/template fields onto an existing agent.
- Test: extend the handler test from Task 6 (`agentHandlers.enterprise.test.ts`).

**Interfaces:**
- Consumes: `agent.source === 'enterprise'`.
- Produces: applying a preset/template to an existing agent whose `source === 'enterprise'` is rejected (returns an error result / no-op); applying to `custom`/`preset` agents is unchanged.

- [ ] **Step 1: Write the failing test**

In `agentHandlers.enterprise.test.ts`:

```ts
  test('applying a template to an enterprise agent is rejected', async () => {
    const ent = store.createAgent({ name: 'Ent', source: 'enterprise', enterpriseAgentId: 'srv-1', systemPrompt: 'orig' });
    const res = await invokeApplyTemplate(ent.id, { systemPrompt: 'templated' });
    expect(res.success).toBe(false);
    expect(store.getAgent(ent.id)!.systemPrompt).toBe('orig');
  });
```

(Implement `invokeApplyTemplate` against the actual template-apply IPC channel. Inspect `handlers.ts:244-281` for the exact channel name and payload shape; if no "apply template to existing agent" channel exists — the spec noted templates only create today — then this task reduces to a **store-level guard already covered by Task 4** plus a **create-only** check: the template picker in `AgentCreateModal` must not offer enterprise agents as a target. In that case, write the test asserting `store.updateAgent(ent.id, {systemPrompt})` is rejected (already in Task 4) and add a UI assertion that the create modal's template picker targets only new agents. State which case applies in the commit body.)

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run src/main/ipcHandlers/agents/agentHandlers.enterprise.test.ts --no-file-parallelism`
Expected: FAIL if an apply-template path exists (it would overwrite); PASS-with-noop if only the store guard applies (document which).

- [ ] **Step 3: Implement the guard**

If an apply-template/update-from-template path targets an existing agent, add at its top: `const target = store.getAgent(agentId); if (target?.source === 'enterprise') return { success: false, error: 'enterprise_agent_read_only' };`. If it does not exist, the Task 4 store guard already blocks scalar overwrites — note this in the commit and add the `AgentCreateModal` UI note that templates only create.

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run src/main/ipcHandlers/agents/agentHandlers.enterprise.test.ts --no-file-parallelism`
Expected: PASS.

- [ ] **Step 5: Lint + type check + commit**

Run: `npx eslint --ext ts,tsx --report-unused-disable-directives --max-warnings 0 <touched files>`
Run: `npm run compile:electron`

```bash
git add <touched files>
git commit -m "feat(desktop): prevent template overwrites of enterprise-created agents"
```

---

## Verification (run the full desktop gate at the end)

- `npx vitest run --no-file-parallelism` (whole suite) — if better-sqlite3 ABI mismatch surfaces, `npm rebuild better-sqlite3` first.
- `npm run compile:electron`.
- `npm run build` (renderer bundle) to catch any type errors the electron tsconfig doesn't cover.
- Manual: `npm run electron:dev` — enterprise agent: view config, add/remove skills (baseline locked), add/remove collaboration (baseline locked), configure server IM channels (credentials only, no enable toggle), no template entry point, set default folder.

## Self-Review Notes (author)

- Spec coverage: view (Task 8), skills add/remove (Tasks 3,4,6,8), collaboration add/remove (Tasks 3,4,6,8), IM configure-only (Tasks 5,8), template block (Task 9), default folder (existing, unchanged), merge invariant (Tasks 4,5,6).
- **How the panel gets local baseline ids:** resolved — the `agents:list` handler (Task 6) emits pre-resolved `serverSkillLocalIds`/`serverSubagentLocalIds`; the slice and service (Task 7) carry them; the panel (Task 8) reads them directly. No new IPC.
- **Store guard scope:** Task 4 narrows the store guard to scalar-rejection + delete-refusal; the "re-add dropped baseline" merge is enforced in the handler (Task 6) because that is where `skillManager` and the resolver live. This keeps the store testable without the catalog.
- **Task 9 is conditional:** if no apply-template-to-existing-agent IPC exists (templates only create today, per the spec), Task 9 reduces to documenting that Task 4's scalar guard already blocks overwrites and adding a UI assertion that the template picker targets only new agents. The implementer must inspect `handlers.ts:244-281` and state which case applies.
