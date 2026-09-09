# Enterprise Agent: View-Faithful Overlay — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the desktop's enterprise-agent settings panel faithful to the
server config (关于你, 技能, 协作, IM), and allow the local overlay edits the
model permits — including a persisted, runtime-effective model override and a
folder-picker working directory.

**Architecture:** Extend the existing overlay data pipeline to carry the
server `aboutYou` (SQLite → sync → store → IPC → renderer), fix the skill
baseline id-space invariant, and add a per-enterprise-agent model override in
`enterprise_agent_prefs` that is consulted at the two main-process model
consumption points (session-start model ref, OpenClaw config sync). The panel
renders the full baseline by name and exposes the model selector + folder
picker.

**Tech Stack:** Electron main (TypeScript), better-sqlite3, Redux Toolkit,
React + Tailwind, Vitest. Server (`enterprise_server/`) is out of scope — it
already exposes `aboutYou` per agent.

**Spec:** `docs/superpowers/specs/2026-09-18-enterprise-agent-view-faithful-overlay-design.md`

## Global Constraints

- **Scope:** desktop only. Do not modify `enterprise_server/**`.
- **Affected agents only:** behavior changes apply when `agent.source === 'enterprise'`. `custom` and `preset` agents keep current behavior.
- **Server-owned scalars stay immutable for user edits** (name, description, identity, systemPrompt, model, thinkingLevel, icon). The model override is a **separate local preference**, not a write to the `model` column.
- **Id-space invariant:** `skill_ids` / `subagent_allow_agent_ids` hold **local** ids only. Baseline ids that don't resolve to a local item live only in `server_skill_ids` / `server_subagent_allow_agent_ids` and are rendered from there.
- **Id spaces:** baseline server skill ids map to local ids via `skillManager.getCatalogLocalId(serverId)`; server agent ids map to local agent ids via the local enterprise row whose `enterprise_agent_id === serverAgentId`.
- **i18n:** every new user-visible string needs BOTH `en` and `zh` in `src/renderer/services/i18n.ts` via `i18nService.t('key')`. (This change reuses existing keys: `coworkBootstrapUserTitle`, `agentBaselineBadge`, `agentDefaultModel`, `agentDefaultWorkingDirectory`, `agentReadOnlyBadge` — verify none new are needed.)
- **String constants:** new IPC channel names go in `src/shared/agent/constants.ts` (`AgentIpcChannel`), not bare strings.
- **Lint gate (every touched file):** `npx eslint --ext ts,tsx --report-unused-disable-directives --max-warnings 0 <files>` — warning-free.
- **Type gate:** `npm run compile:electron` (`tsc --project electron-tsconfig.json`) must pass.
- **Test command:** `npx vitest run <files> --no-file-parallelism`.
- **better-sqlite3 ABI note:** `npm run compile:electron` rebuilds `better-sqlite3` against Electron's ABI. If a Node-side vitest that builds a real DB then fails with `NODE_MODULE_VERSION`, run `npm rebuild better-sqlite3` and re-run. This is an environment artifact, not a code bug.
- **Commits:** Conventional Commits, English, no `Co-Authored-By` trailer. Commit after each task's tests pass. Do not push.

## File Structure

- `src/main/sqliteStore.ts` — `agents.about_you` column (CREATE TABLE + migration); `enterprise_agent_prefs.model_ref` column (CREATE TABLE + migration).
- `src/main/genworkStore.ts` — `Agent.aboutYou`, `CreateAgentRequest`/`UpdateAgentRequest` optional `aboutYou`, `mapAgentRow` parse, `createAgent`/`updateAgent` write (guarded for enterprise like `systemPrompt`).
- `src/main/auth/enterpriseClient.ts` — `listEnterpriseAgents` maps `aboutYou`.
- `src/main/libs/agentEnterpriseSync.ts` — `ServerAgentView.aboutYou`; UPSERT payload carries it; **skill baseline mapping drops the `?? sid` fallback** (fix id-space invariant).
- `src/main/libs/enterpriseAgentPrefsStore.ts` — add `model_ref` to `get`/`upsert`; add `getModel`/`setModel`.
- `src/main/libs/agentModelOverride.ts` (new) — pure `effectiveAgentModelRef(agent, getOverrideModel)`.
- `src/main/ipcHandlers/agents/handlers.enterprise.ts` — `GetEnterpriseAgentModel` / `SetEnterpriseAgentModel` handlers.
- `src/shared/agent/constants.ts` — add the two model-override IPC channels.
- `src/main/main.ts` — wire `resolveCoworkRunModelRef` to the override; pass `getAgentModelOverride` into `OpenClawConfigSync`.
- `src/main/libs/openclawConfigSync.ts` — accept `getAgentModelOverride` dep; use `effectiveAgentModelRef` for the per-agent model at the qualification + target sites.
- `src/main/preload.ts` — `getEnterpriseAgentModel` / `setEnterpriseAgentModel` bridge.
- `src/renderer/store/slices/agentSlice.ts` — `AgentSummary.aboutYou`.
- `src/renderer/types/agent.ts` — `Agent.aboutYou`.
- `src/renderer/services/agent.ts` — map `aboutYou` in the agent mapping objects.
- `src/renderer/components/agent/AgentSettingsPanel.tsx` — 关于你 tab shows `aboutYou`; enterprise footer shows model selector; enterprise load resolves model precedence; enterprise `handleSave` persists the model override; skills + collaboration tabs render baseline by name / checked.
- `src/renderer/components/agent/EnterpriseWorkingDirectoryField.tsx` — swap text input for the `FolderSelectorPopover` picker.
- `src/renderer/components/agent/AgentSkillSelector.tsx` — accept an optional `baselineSkills` list (server-id → name) to render locked baseline rows for uninstalled skills.
- Tests: `src/main/gworkStore.test.ts`, `src/main/libs/agentEnterpriseSync.test.ts`, `src/main/libs/enterpriseAgentPrefsStore.test.ts`, `src/main/ipcHandlers/agents/handlers.enterprise.test.ts` (create), `src/main/libs/agentModelOverride.test.ts` (new), `src/renderer/components/agent/AgentSettingsPanel.test.ts`.

---

### Task 1: `about_you` column + store read/write

**Files:**
- Modify: `src/main/sqliteStore.ts:237-261` (CREATE TABLE) and `:684-699` (migration block); `src/main/genworkStore.ts` (`Agent` 402-431, `CreateAgentRequest` 433-451, `UpdateAgentRequest` 453-470, `mapAgentRow` 3465-3519, `createAgent` 3271-3299, `updateAgent` 3335-3406); `src/main/gworkStore.test.ts` (harness `agents` table ~116-141, new test).

**Interfaces:**
- Produces: `Agent.aboutYou: string`; `CreateAgentRequest.aboutYou?`, `UpdateAgentRequest.aboutAbout?`→`aboutYou?`; `mapAgentRow` returns `aboutYou` (default `''`); `updateAgent` treats `aboutYou` as a guarded server-owned scalar for enterprise rows (like `systemPrompt`), but the `bypassEnterpriseGuard` sync write persists it.

- [ ] **Step 1: Add the column to CREATE TABLE + migration**

In `src/main/sqliteStore.ts`, in the `CREATE TABLE IF NOT EXISTS agents` block (line 237), after the `identity TEXT NOT NULL DEFAULT '',` line (line 242) add:

```sql
        about_you TEXT NOT NULL DEFAULT '',
```

In the migration `try` block (after the `server_im_channels` guard at line 696-699), add:

```ts
      if (!agentColNames.includes('about_you')) {
        this.db.exec("ALTER TABLE agents ADD COLUMN about_you TEXT NOT NULL DEFAULT '';");
        this.didRunMigration = true;
      }
```

- [ ] **Step 2: Add `aboutYou` to the types**

In `src/main/genworkStore.ts`, add to `Agent` (after line 406 `systemPrompt: string;`):

```ts
  aboutYou: string;
```

Add to `CreateAgentRequest` (after `identity?`):

```ts
  aboutYou?: string;
```

Add to `UpdateAgentRequest` (after `identity?`):

```ts
  aboutYou?: string;
```

- [ ] **Step 3: Write in createAgent and updateAgent**

In `createAgent`, add `about_you` to the `INSERT` column list (after `identity`) and a `?` placeholder, and add `request.aboutYou || ''` to the `.run(...)` args (after `request.identity || ''`).

In `updateAgent`, after the `identity` block (lines 3347-3350) add:

```ts
    if (!guarded && updates.aboutYou !== undefined) {
      setClauses.push('about_you = ?');
      values.push(updates.aboutYou);
    }
```

- [ ] **Step 4: Parse in mapAgentRow**

In `mapAgentRow`, add `about_you?: string | null;` to the row param type (near the `identity` field) and add to the returned object (after `identity: row.identity,`):

```ts
      aboutYou: row.about_you ?? '',
```

- [ ] **Step 5: Update the store test harness + write the failing test**

In `src/main/gworkStore.test.ts`, in the harness `CREATE TABLE agents` (line 116), add `about_you TEXT NOT NULL DEFAULT '',` after the `identity` line. Then add a test (near the existing enterprise tests ~1406):

```ts
  test('aboutYou round-trips and is guarded for enterprise rows but applies on sync write', () => {
    const ent = store.createAgent({ name: 'Ent', source: 'enterprise', enterpriseAgentId: 'srv-1', aboutYou: 'orig' });
    expect(ent.aboutYou).toBe('orig');
    // User-initiated update is rejected (server-owned scalar).
    const after = store.updateAgent(ent.id, { aboutYou: 'hacked' });
    expect(after?.aboutYou).toBe('orig');
    // Sync write (bypass) applies.
    const synced = store.updateAgent(ent.id, { aboutYou: 'server-v2' }, { bypassEnterpriseGuard: true });
    expect(synced?.aboutYou).toBe('server-v2');
  });
```

- [ ] **Step 6: Run to verify**

Run: `npx vitest run src/main/gworkStore.test.ts --no-file-parallelism`
Expected: PASS (new test + existing). If better-sqlite3 throws `NODE_MODULE_VERSION`, run `npm rebuild better-sqlite3` first.

- [ ] **Step 7: Lint + type check + commit**

Run: `npx eslint --ext ts,tsx --report-unused-disable-directives --max-warnings 0 src/main/sqliteStore.ts src/main/genworkStore.ts src/main/gworkStore.test.ts`
Run: `npm run compile:electron`

```bash
git add src/main/sqliteStore.ts src/main/genworkStore.ts src/main/gworkStore.test.ts
git commit -m "feat(desktop): add about_you to agent row with enterprise guard"
```

---

### Task 2: Fetch + sync `aboutYou` from the server

**Files:**
- Modify: `src/main/auth/enterpriseClient.ts` (`listEnterpriseAgents` 391-433), `src/main/libs/agentEnterpriseSync.ts` (`ServerAgentView` 7-21, UPSERT payload 108-124), `src/main/libs/agentEnterpriseSync.test.ts`.

**Interfaces:**
- Consumes: Task 1 store fields.
- Produces: `ServerAgentView.aboutYou: string`; client returns `aboutYou`; sync UPSERT writes `aboutYou: sv.aboutYou`.

- [ ] **Step 1: Write the failing test**

In `src/main/libs/agentEnterpriseSync.test.ts`, add (extend the existing `serverView` fixture helper if one is shared, else inline):

```ts
  test('sync persists aboutYou from the server view', async () => {
    const store = fakeStore([]);
    await agentEnterpriseSync.syncFromServer({
      serverView: [{ agentId: 'a', name: 'A', description: '', identity: '', systemPrompt: '', model: '', thinkingLevel: 'medium', icon: '', skillIds: [], subagentAllowAgentIds: [], allowedRoles: ['org_admin'], enabled: true, imChannels: [], aboutYou: 'hello there' }],
      genworkStore: store as never,
      prefsStore: { remove: vi.fn() } as never,
      skillManager: { getCatalogLocalId: () => null } as never,
      defaultModelRef: '',
    });
    const a = store.listAgents().find(x => x.id === 'a')!;
    expect(a.aboutYou).toBe('hello there');
  });
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run src/main/libs/agentEnterpriseSync.test.ts --no-file-parallelism`
Expected: FAIL — `aboutYou` is `''`.

- [ ] **Step 3: Add `aboutYou` to ServerAgentView + sync payload**

In `agentEnterpriseSync.ts`, add `aboutYou: string;` to `ServerAgentView` (after `systemPrompt`). In the `payload` object (line ~108), add `aboutYou: sv.aboutYou,` after `systemPrompt: sv.systemPrompt,`.

- [ ] **Step 4: Surface `aboutYou` in the client**

In `enterpriseClient.ts` `listEnterpriseAgents`, add `aboutYou: string;` to the inline return type (after `systemPrompt`) and `aboutYou: String(a.aboutYou ?? '')` to the mapped object (after `systemPrompt: String(a.systemPrompt ?? '')`).

- [ ] **Step 5: Run to verify it passes**

Run: `npx vitest run src/main/libs/agentEnterpriseSync.test.ts --no-file-parallelism`
Expected: PASS.

- [ ] **Step 6: Lint + type check + commit**

Run: `npx eslint --ext ts,tsx --report-unused-disable-directives --max-warnings 0 src/main/auth/enterpriseClient.ts src/main/libs/agentEnterpriseSync.ts src/main/libs/agentEnterpriseSync.test.ts`
Run: `npm run compile:electron`

```bash
git add src/main/auth/enterpriseClient.ts src/main/libs/agentEnterpriseSync.ts src/main/libs/agentEnterpriseSync.test.ts
git commit -m "feat(desktop): sync enterprise agent aboutYou from the server"
```

---

### Task 3: Fix the skill baseline id-space invariant

**Files:**
- Modify: `src/main/libs/agentEnterpriseSync.ts` (`baselineSkillLocal` 76-77, and the `oldBaselineSkill` mapping 97-98), `src/main/libs/agentEnterpriseSync.test.ts`.

**Interfaces:**
- Produces: `skill_ids` holds local ids only. Unresolvable server skill ids are dropped from the local set (they remain in `server_skill_ids`) instead of leaking the raw server id in. Matches the existing subagent behavior (`.filter((id): id is string => id !== null)`).

- [ ] **Step 1: Write the failing test**

In `src/main/libs/agentEnterpriseSync.test.ts`, add:

```ts
  test('unresolvable server skill ids are dropped from local skill_ids (kept in server_skill_ids)', async () => {
    const store = fakeStore([]);
    await agentEnterpriseSync.syncFromServer({
      serverView: [{ agentId: 'a', name: 'A', description: '', identity: '', systemPrompt: '', model: '', thinkingLevel: 'medium', icon: '', skillIds: ['installed-1', 'not-installed-x'], subagentAllowAgentIds: [], allowedRoles: ['org_admin'], enabled: true, imChannels: [], aboutYou: '' }],
      genworkStore: store as never,
      prefsStore: { remove: vi.fn() } as never,
      // Only 'installed-1' resolves to a local id. Note: getCatalogLocalId's REAL
      // return type is `string | undefined` (skillManager.getCatalogLocalId), so
      // the unresolvable case returns `undefined`, matching production.
      skillManager: { getCatalogLocalId: (id: string) => (id === 'installed-1' ? 'local_installed-1' : undefined) } as never,
      defaultModelRef: '',
    });
    const a = store.listAgents().find(x => x.id === 'a')!;
    expect(a.skillIds).toEqual(['local_installed-1']); // no raw 'not-installed-x', no undefined
    expect(a.serverSkillIds).toEqual(['installed-1', 'not-installed-x']);
  });
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run src/main/libs/agentEnterpriseSync.test.ts --no-file-parallelism`
Expected: FAIL — `skillIds` currently includes `'not-installed-x'` (the `?? sid` fallback).

- [ ] **Step 3: Drop the `?? sid` fallback and normalize to null before filtering**

`getCatalogLocalId` returns `string | undefined`. To mirror the subagent
filter (which maps `?? null` first, then `.filter((id): id is string => id !== null)`),
normalize `undefined` → `null` in the map so the `!== null` filter actually drops
unresolvable ids. A bare `.filter((id): id is string => id !== null)` would NOT
drop `undefined`, so the `?? null` step is required.

In `agentEnterpriseSync.ts`, change `baselineSkillLocal` (line 77-78):

```ts
      const baselineSkillLocal = sv.skillIds
        .map((sid) => opts.skillManager.getCatalogLocalId(sid) ?? null)
        .filter((id): id is string => id !== null);
```

And change `oldBaselineSkill` (line 98-99) identically:

```ts
        const oldBaselineSkill = existing.serverSkillIds
          .map((sid) => opts.skillManager.getCatalogLocalId(sid) ?? null)
          .filter((id): id is string => id !== null);
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run src/main/libs/agentEnterpriseSync.test.ts --no-file-parallelism`
Expected: PASS (new + existing).

- [ ] **Step 5: Lint + type check + commit**

Run: `npx eslint --ext ts,tsx --report-unused-disable-directives --max-warnings 0 src/main/libs/agentEnterpriseSync.ts src/main/libs/agentEnterpriseSync.test.ts`
Run: `npm run compile:electron`

```bash
git add src/main/libs/agentEnterpriseSync.ts src/main/libs/agentEnterpriseSync.test.ts
git commit -m "fix(desktop): keep enterprise skill baseline local ids out of skill_ids"
```

---

### Task 4: Model override — prefs column, methods, IPC

**Files:**
- Modify: `src/main/sqliteStore.ts` (`enterprise_agent_prefs` CREATE TABLE 704-710 + migration), `src/main/libs/enterpriseAgentPrefsStore.ts`, `src/shared/agent/constants.ts`, `src/main/ipcHandlers/agents/handlers.enterprise.ts`, `src/main/preload.ts`, `src/renderer/types/electron.d.ts`.
- Test: `src/main/libs/enterpriseAgentPrefsStore.test.ts`, create `src/main/ipcHandlers/agents/handlers.enterprise.test.ts`.

**Interfaces:**
- Produces: `EnterpriseAgentPrefsStore.getModel(id): string` and `setModel(id, modelRef: string): void`; IPC channels `AgentIpcChannel.GetEnterpriseAgentModel` / `SetEnterpriseAgentModel`; preload `getEnterpriseAgentModel(agentId)` / `setEnterpriseAgentModel(agentId, modelRef)`.

- [ ] **Step 1: Add the `model_ref` column**

In `src/main/sqliteStore.ts`, add `model_ref TEXT NOT NULL DEFAULT '',` to the `enterprise_agent_prefs` CREATE TABLE (line 704-710). Then add a migration guard right after the `CREATE TABLE IF NOT EXISTS enterprise_agent_prefs` block:

```ts
    try {
      const prefsCols = this.db.pragma('table_info(enterprise_agent_prefs)') as Array<{ name: string }>;
      if (!prefsCols.some(c => c.name === 'model_ref')) {
        this.db.exec("ALTER TABLE enterprise_agent_prefs ADD COLUMN model_ref TEXT NOT NULL DEFAULT '';");
        this.didRunMigration = true;
      }
    } catch {
      // Column already exists or migration not needed.
    }
```

- [ ] **Step 2: Add `getModel` / `setModel` to the prefs store**

In `src/main/libs/enterpriseAgentPrefsStore.ts`, extend `get` to also return model (keep the existing `get` for working dir and add two new methods). Add:

```ts
  getModel(enterpriseAgentId: string): string {
    const row = this.db
      .prepare('SELECT model_ref AS mr FROM enterprise_agent_prefs WHERE enterprise_agent_id = ?')
      .get(enterpriseAgentId) as { mr?: string } | undefined;
    return row?.mr ?? '';
  }

  setModel(enterpriseAgentId: string, modelRef: string): void {
    const existing = this.db
      .prepare('SELECT 1 FROM enterprise_agent_prefs WHERE enterprise_agent_id = ?')
      .get(enterpriseAgentId);
    if (existing) {
      this.db.prepare(
        'UPDATE enterprise_agent_prefs SET model_ref = ?, updated_at = ? WHERE enterprise_agent_id = ?',
      ).run(modelRef, Date.now(), enterpriseAgentId);
    } else {
      this.db.prepare(
        `INSERT INTO enterprise_agent_prefs (enterprise_agent_id, working_directory, model_ref, updated_at)
         VALUES (?, '', ?, ?)`,
      ).run(enterpriseAgentId, modelRef, Date.now());
    }
  }
```

- [ ] **Step 3: Write the failing prefs test**

In `src/main/libs/enterpriseAgentPrefsStore.test.ts`, add (mirror the existing harness that builds a temp DB with the `enterprise_agent_prefs` table — extend that harness's CREATE TABLE to include `model_ref`):

```ts
  test('getModel/setModel round-trip and coexist with working_directory', () => {
    store.setModel('ent-1', 'genwork/opus-4');
    expect(store.getModel('ent-1')).toBe('genwork/opus-4');
    store.upsert('ent-1', '/some/dir');
    expect(store.get('ent-1')).toBe('/some/dir');
    expect(store.getModel('ent-1')).toBe('genwork/opus-4'); // preserved across upsert
  });
```

- [ ] **Step 4: Run to verify it fails, then confirm the store change makes it pass**

Run: `npx vitest run src/main/libs/enterpriseAgentPrefsStore.test.ts --no-file-parallelism`
Expected: FAIL before the Step 2 methods exist / PASS after.

- [ ] **Step 5: Add IPC channels**

In `src/shared/agent/constants.ts`, add to `AgentIpcChannel`:

```ts
  GetEnterpriseAgentModel: 'agents:getEnterpriseAgentModel',
  SetEnterpriseAgentModel: 'agents:setEnterpriseAgentModel',
```

- [ ] **Step 6: Add the handlers**

In `src/main/ipcHandlers/agents/handlers.enterprise.ts`, after the `SetEnterpriseAgentWorkingDirectory` handler (line 65) add:

```ts
  ipcMain.handle(AgentIpcChannel.GetEnterpriseAgentModel, async (_e, agentId: string) => {
    loginGate.requireEnterprise();
    const local = deps.getGenWorkStore().listAgents().find(a => a.source === 'enterprise' && a.enterpriseAgentId === agentId);
    if (!local) return { success: false, error: 'unknown_agent' };
    return { success: true, modelRef: deps.getEnterpriseAgentPrefsStore().getModel(agentId) };
  });

  ipcMain.handle(AgentIpcChannel.SetEnterpriseAgentModel, async (_e, args: { agentId: string; modelRef: string }) => {
    loginGate.requireEnterprise();
    deps.getEnterpriseAgentPrefsStore().setModel(args.agentId, args.modelRef);
    return { success: true };
  });
```

- [ ] **Step 7: Add the preload bridge + renderer type**

In `src/main/preload.ts`, after `setEnterpriseAgentWorkingDirectory` (line 462) add:

```ts
    getEnterpriseAgentModel: async (agentId: string) => {
      const result = await ipcRenderer.invoke(AgentIpcChannel.GetEnterpriseAgentModel, agentId);
      return result as { success: boolean; modelRef?: string; error?: string };
    },
    setEnterpriseAgentModel: async (agentId: string, modelRef: string) => {
      const result = await ipcRenderer.invoke(AgentIpcChannel.SetEnterpriseAgentModel, { agentId, modelRef });
      return result as { success: boolean; error?: string };
    },
```

In `src/renderer/types/electron.d.ts`, extend the `agents` bridge (after `setEnterpriseAgentWorkingDirectory`) so the renderer calls type-check:

```ts
    getEnterpriseAgentModel: (agentId: string) => Promise<{ success: boolean; modelRef?: string; error?: string }>;
    setEnterpriseAgentModel: (agentId: string, modelRef: string) => Promise<{ success: boolean; error?: string }>;
```

- [ ] **Step 8: Write the handler test**

Create `src/main/ipcHandlers/agents/handlers.enterprise.test.ts`. Follow the pattern in `gworkStore.test.ts` for an in-memory DB + a fake prefs store, and capture the registered handlers via `vi.spyOn(ipcMain, 'handle')`. Assert `SetEnterpriseAgentModel` writes to the prefs store and `GetEnterpriseAgentModel` reads it back for a known enterprise agent:

```ts
import { describe, expect, test, vi } from 'vitest';
import { ipcMain } from 'electron';
import { AgentIpcChannel } from '../../../shared/agent/constants';
import { registerAgentEnterpriseHandlers } from './handlers.enterprise';

// Build a minimal env: fake genworkStore (one enterprise agent 'agent_a1'),
// a real EnterpriseAgentPrefsStore on a temp DB (or a fake), fake skillManager,
// getAvailableModelsRef -> ''. Mock loginGate.requireEnterprise to return a
// session. Register handlers, capture ipcMain.handle registrations into a map,
// then invoke the model get/set channels.
```

(Implement `loginGate` via `vi.mock('../../auth/loginGate')` returning `{ requireEnterprise: () => ({ userId: 'u', orgId: 'o' }) }`, and `ipcMain` via `vi.mock('electron')` capturing `handle`.)

- [ ] **Step 9: Run to verify**

Run: `npx vitest run src/main/libs/enterpriseAgentPrefsStore.test.ts src/main/ipcHandlers/agents/handlers.enterprise.test.ts --no-file-parallelism`
Expected: PASS.

- [ ] **Step 10: Lint + type check + commit**

Run: `npx eslint --ext ts,tsx --report-unused-disable-directives --max-warnings 0 src/main/sqliteStore.ts src/main/libs/enterpriseAgentPrefsStore.ts src/shared/agent/constants.ts src/main/ipcHandlers/agents/handlers.enterprise.ts src/main/preload.ts src/renderer/types/electron.d.ts src/main/libs/enterpriseAgentPrefsStore.test.ts src/main/ipcHandlers/agents/handlers.enterprise.test.ts`
Run: `npm run compile:electron`

```bash
git add src/main/sqliteStore.ts src/main/libs/enterpriseAgentPrefsStore.ts src/shared/agent/constants.ts src/main/ipcHandlers/agents/handlers.enterprise.ts src/main/preload.ts src/renderer/types/electron.d.ts src/main/libs/enterpriseAgentPrefsStore.test.ts src/main/ipcHandlers/agents/handlers.enterprise.test.ts
git commit -m "feat(desktop): persist per-agent enterprise model override with IPC"
```

---

### Task 5: Model override takes effect at runtime

**Files:**
- Create: `src/main/libs/agentModelOverride.ts`, `src/main/libs/agentModelOverride.test.ts`.
- Modify: `src/main/main.ts` (`resolveCoworkRunModelRef` 4906-4920, config-sync construction ~2159), `src/main/libs/openclawConfigSync.ts` (`OpenClawConfigSyncDeps` 1252-1276, class field/ctor 1277-1324, `syncManagedSessionStore` 2918-2987).

**Interfaces:**
- Produces: `effectiveAgentModelRef(agent: Agent, getOverrideModel: (enterpriseAgentId: string) => string): string` — returns the parseable local override for enterprise agents, else `agent.model`.

- [ ] **Step 1: Write the failing test**

Create `src/main/libs/agentModelOverride.test.ts`:

```ts
import { describe, expect, test } from 'vitest';
import type { Agent } from '../genworkStore';
import { effectiveAgentModelRef } from './agentModelOverride';

const base: Agent = {
  id: 'a1', name: 'A', description: '', systemPrompt: '', identity: '', aboutYou: '',
  model: 'genwork/server-model', thinkingLevel: 'medium', workingDirectory: '', icon: '',
  skillIds: [], subagentAllowAgentIds: [], serverSkillIds: [], serverSubagentAllowAgentIds: [],
  serverImChannels: [], enabled: true, pinned: false, pinOrder: null, sortOrder: null,
  isDefault: false, source: 'enterprise', presetId: '', enterpriseAgentId: 'srv-1',
  createdAt: 0, updatedAt: 0,
};

describe('effectiveAgentModelRef', () => {
  test('enterprise: parseable override wins', () => {
    expect(effectiveAgentModelRef(base, () => 'genwork/other')).toBe('genwork/other');
  });
  test('enterprise: unparseable/empty override falls back to the row model', () => {
    expect(effectiveAgentModelRef(base, () => 'not-a-ref')).toBe('genwork/server-model');
    expect(effectiveAgentModelRef(base, () => '')).toBe('genwork/server-model');
  });
  test('non-enterprise: always the row model', () => {
    expect(effectiveAgentModelRef({ ...base, source: 'custom', enterpriseAgentId: undefined }, () => 'genwork/other')).toBe('genwork/server-model');
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run src/main/libs/agentModelOverride.test.ts --no-file-parallelism`
Expected: FAIL — module missing.

- [ ] **Step 3: Implement the pure helper**

Create `src/main/libs/agentModelOverride.ts`:

```ts
import type { Agent } from '../genworkStore';
import { parsePrimaryModelRef } from './openclawAgentModels';

/** The model ref an agent actually runs with: a parseable local override for
 *  enterprise agents (from `enterprise_agent_prefs`), else the agent row's
 *  server-provided model. Non-enterprise agents always use their row model. */
export function effectiveAgentModelRef(
  agent: Agent,
  getOverrideModel: (enterpriseAgentId: string) => string,
): string {
  if (agent.source === 'enterprise' && agent.enterpriseAgentId) {
    const override = getOverrideModel(agent.enterpriseAgentId).trim();
    if (override && parsePrimaryModelRef(override)) return override;
  }
  return agent.model;
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run src/main/libs/agentModelOverride.test.ts --no-file-parallelism`
Expected: PASS.

- [ ] **Step 5: Use it in session-start model resolution (main.ts)**

In `src/main/main.ts` `resolveCoworkRunModelRef` (line 4915-4918), replace the `getAgentManager().getAgent(agentId)?.model?.trim()` term with the override-aware value:

```ts
    const agentRow = getAgentManager().getAgent(agentId);
    const agentModelRef = agentRow
      ? effectiveAgentModelRef(agentRow, (enterpriseAgentId) => getEnterpriseAgentPrefsStore().getModel(enterpriseAgentId))
      : '';
    const rawModelRef = options.modelOverride?.trim()
      || session?.modelOverride?.trim()
      || agentModelRef.trim()
      || resolveDefaultAgentModelRef();
    return rawModelRef?.trim() || '';
```

Import `effectiveAgentModelRef` at the top (`import { effectiveAgentModelRef } from './libs/agentModelOverride';`).

- [ ] **Step 6: Wire the override into OpenClaw config sync**

In `src/main/libs/openclawConfigSync.ts`, add to `OpenClawConfigSyncDeps`:

```ts
  getAgentModelOverride?: (enterpriseAgentId: string) => string;
```

Add a private field `private readonly getAgentModelOverride?: (enterpriseAgentId: string) => string;` and set it in the constructor: `this.getAgentModelOverride = deps.getAgentModelOverride;`.

In `syncManagedSessionStore` (line 2918), at the top of the per-agent loop compute:

```ts
      const agentModel = this.getAgentModelOverride
        ? effectiveAgentModelRef(agent, this.getAgentModelOverride)
        : agent.model;
```

and replace the two `agent.model` usages (line 2920 `agentModel: agent.model,` and line 2983 `qualification.status === 'qualified' ? qualification.primaryModel : agent.model,`) with `agentModel`.

Import `effectiveAgentModelRef` at the top of `openclawConfigSync.ts`.

- [ ] **Step 7: Pass the dep from main.ts**

In `src/main/main.ts`, in the `new OpenClawConfigSync({...})` deps (near line 2159 `getAgents: ...`), add:

```ts
      getAgentModelOverride: (enterpriseAgentId) => getEnterpriseAgentPrefsStore().getModel(enterpriseAgentId),
```

- [ ] **Step 8: Lint + type check**

Run: `npx eslint --ext ts,tsx --report-unused-disable-directives --max-warnings 0 src/main/libs/agentModelOverride.ts src/main/libs/agentModelOverride.test.ts src/main/main.ts src/main/libs/openclawConfigSync.ts`
Run: `npm run compile:electron`

- [ ] **Step 9: Commit**

```bash
git add src/main/libs/agentModelOverride.ts src/main/libs/agentModelOverride.test.ts src/main/main.ts src/main/libs/openclawConfigSync.ts
git commit -m "feat(desktop): apply enterprise model override at runtime model resolution"
```

---

### Task 6: Plumb `aboutYou` to the renderer

**Files:**
- Modify: `src/renderer/store/slices/agentSlice.ts` (`AgentSummary`), `src/renderer/types/agent.ts` (`Agent`), `src/renderer/services/agent.ts` (mapping objects).

**Interfaces:**
- Produces: `AgentSummary.aboutYou: string`; the renderer `Agent` type carries `aboutYou`; `services/agent.ts` maps `aboutYou` in `loadAgents`/`createAgent`/`updateAgent`/`reorderAgents`/`addPreset`.

- [ ] **Step 1: Add the field to the slice + type**

In `src/renderer/store/slices/agentSlice.ts` `AgentSummary`, add `aboutYou: string;` (after `description`). In `src/renderer/types/agent.ts` `Agent`, add `aboutYou: string;` (after `description`).

- [ ] **Step 2: Map `aboutYou` in services/agent.ts**

In each of the five mapping objects in `src/renderer/services/agent.ts` (`loadAgents` ~43, `createAgent` ~90, `updateAgent` ~140, `reorderAgents` ~194, `addPreset` ~288), add `aboutYou: a.aboutYou ?? '',` (use the correct source variable per object: `a` in list/reorder, `agent` in create/addPreset/update).

- [ ] **Step 3: Type check**

Run: `npm run compile:electron`
Expected: clean (the slice/agent test fixtures gain `aboutYou` via `?? ''` defaults; if a test fixture type-checks strictly, add `aboutYou: ''` to the fixture).

- [ ] **Step 4: Lint + commit**

Run: `npx eslint --ext ts,tsx --report-unused-disable-directives --max-warnings 0 src/renderer/store/slices/agentSlice.ts src/renderer/types/agent.ts src/renderer/services/agent.ts`

```bash
git add src/renderer/store/slices/agentSlice.ts src/renderer/types/agent.ts src/renderer/services/agent.ts
git commit -m "feat(desktop): plumb aboutYou to the renderer agent state"
```

---

### Task 7: Panel — 关于你 tab, model selector, working-dir picker

**Files:**
- Modify: `src/renderer/components/agent/AgentSettingsPanel.tsx`, `src/renderer/components/agent/EnterpriseWorkingDirectoryField.tsx`.
- Test: `src/renderer/components/agent/AgentSettingsPanel.test.ts`.

**Interfaces:**
- Consumes: `AgentSummary.aboutYou` (Task 6); preload `getEnterpriseAgentModel`/`setEnterpriseAgentModel` (Task 4); `ModelSelector` (existing); `FolderSelectorPopover` (existing, used by `AgentWorkingDirectoryField`).
- Produces: 关于你 tab renders server `aboutYou` read-only; enterprise footer shows a model selector (resolved override→server→global) alongside the working-dir field; enterprise `handleSave` persists the model override; the enterprise working-dir field is a folder picker.

- [ ] **Step 1: Write the failing UI tests**

In `src/renderer/components/agent/AgentSettingsPanel.test.ts`, extend the enterprise fixture (line ~54) with `aboutYou: 'Server says hi'` and mock the model-override IPC. Add tests:

```ts
  test('关于你 tab renders the server aboutYou (read-only) for an enterprise agent', async () => {
    // render the enterprise agent, click the 关于你 tab, assert the server text
    // shows and the field is not an editable textarea (no USER.md value).
  });

  test('enterprise footer shows the model selector and persists the override on save', async () => {
    // mock window.electron.agents.getEnterpriseAgentModel -> { success: true, modelRef: '' };
    // assert the ModelSelector is present for the enterprise agent (previously only
    // the working-dir field was), and that saving with a changed model calls
    // setEnterpriseAgentModel.
  });
```

(Match the file's existing `configureStore`/`render` harness; mock `window.electron.agents.get` and `getEnterpriseAgentModel` with `vi.fn`.)

- [ ] **Step 2: 关于你 tab renders server `aboutYou`**

In `AgentSettingsPanel.tsx`, in the `activeTab === AgentDetailTab.User` render (line 917-924), branch on `isServerOwned`:

```tsx
          {activeTab === AgentDetailTab.User && (
            isServerOwned ? (
              <div className="flex h-full min-h-0 flex-col gap-2">
                <p className="shrink-0 text-xs leading-5 text-secondary">
                  {i18nService.t('coworkBootstrapUserHint')}
                </p>
                <div className="min-h-0 flex-1 w-full overflow-y-auto whitespace-pre-wrap rounded-lg bg-surface-raised/40 px-3 py-2 text-sm leading-6 text-foreground">
                  {agentSummary?.aboutYou || i18nService.t('agentNoContent')}
                </div>
              </div>
            ) : renderTextEditor(
              userInfo,
              setUserInfo,
              i18nService.t('coworkBootstrapPlaceholder'),
              i18nService.t('coworkBootstrapUserTitle'),
              i18nService.t('coworkBootstrapUserHint'),
            )
          )}
```

(If `agentNoContent` doesn't exist in i18n, reuse an existing empty-state key or render `''`. Verify a suitable key exists; do not hardcode.)

- [ ] **Step 3: Resolve the model on load for enterprise (precedence)**

In the load `useEffect` (lines 251-275), after `setAgent(a)`, capture the
server default and the current override in a ref (used by Step 5's save) and
resolve the model with precedence. Replace the single model-resolution block
(lines 258-271) with:

```ts
      // Model precedence (enterprise): local override → server default → global.
      // Non-enterprise: server row model → global.
      let effectiveRef = a.model || '';
      if (a.source === 'enterprise' && a.enterpriseAgentId) {
        serverModelRef.current = a.model || '';
        const overrideRef = await window.electron?.agents?.getEnterpriseAgentModel(a.enterpriseAgentId)
          ?.then(r => (r.success ? (r.modelRef ?? '') : '')) ?? '';
        modelOverrideRef.current = overrideRef;
        if (overrideRef && parsePrimaryModelRefLocal(overrideRef)) {
          effectiveRef = overrideRef;
        }
      }
      const resolvedModel = resolveOpenClawModelRef(effectiveRef, availableModels) ?? defaultSelectedModel ?? null;
      const resolvedModelRef = resolvedModel ? toOpenClawModelRef(resolvedModel) : '';
      setModel(resolvedModel);
      setWorkingDirectory(a.workingDirectory ?? '');
      initialValuesRef.current.model = resolvedModelRef;
```

Declare the two refs near `initialValuesRef` (line 138):

```tsx
  const serverModelRef = useRef('');
  const modelOverrideRef = useRef('');
```

For the parse check use a small local helper (do **not** import the
main-process `openclawAgentModels` into the renderer):

```ts
  const parsePrimaryModelRefLocal = (ref: string) => {
    const i = ref.indexOf('/');
    return i > 0 && i < ref.length - 1;
  };
```

Keep the existing `setSkillIds`/`setSubagentAllowAgentIds`/remaining
initial-values assignments (lines 261-271) untouched; only the model resolution
changes.

- [ ] **Step 4: Enterprise footer shows the model selector**

In the footer (line 975-984), replace the enterprise branch so it renders a model selector plus the working-dir field:

```tsx
          {isServerOwned ? (
            <div className="flex min-w-0 flex-1 items-center gap-2 overflow-hidden">
              <div className="flex h-8 min-w-0 items-center gap-1 rounded-lg bg-surface-raised/70 pl-2 text-foreground" title={i18nService.t('agentDefaultModel')}>
                <CubeIcon className="h-4 w-4 flex-shrink-0 text-secondary" />
                <ModelSelector dropdownDirection="up" value={model} onChange={setModel} portal />
              </div>
              <EnterpriseWorkingDirectoryField agentId={agentId} enterpriseAgentId={enterpriseAgentId} />
            </div>
          ) : (
            <AgentDetailToolbar model={model} onModelChange={setModel} workingDirectory={workingDirectory} onWorkingDirectoryChange={setWorkingDirectory} />
          )}
```

Import `ModelSelector` (from `../ModelSelector`) and `CubeIcon` (from `@heroicons/react/24/outline`).

- [ ] **Step 5: Persist the model override on save (enterprise branch)**

In `handleSave` (line 401-430), in the `isServerOwned` branch, after the
overlay `updateAgent` succeeds, persist the model override only when the
selected model differs from the current stored override (avoid a redundant
write each save). Use the refs captured in Step 3:

```ts
        if (enterpriseAgentId) {
          const nextModelRef = model ? toOpenClawModelRef(model) : '';
          if (nextModelRef !== modelOverrideRef.current) {
            await window.electron?.agents?.setEnterpriseAgentModel(enterpriseAgentId, nextModelRef);
            modelOverrideRef.current = nextModelRef;
          }
        }
```

This writes the override for any selected model (including one equal to the
server default, which is fine — it is a local preference that shadows the
server value) and skips the IPC when unchanged. If the user clears the model,
`nextModelRef` is `''`, clearing the override and falling back to the server
default at runtime.

- [ ] **Step 6: Working-dir field becomes a folder picker**

In `EnterpriseWorkingDirectoryField.tsx`, replace the text `<input>` (line 70-81) with a `FolderSelectorPopover`-backed button mirroring `AgentWorkingDirectoryField`'s compact variant (button shows `truncatePath(wd)` + folder icon; clicking opens the popover; `onSelectFolder` sets `wd`). Keep the existing load-from-prefs / `handleSave` (persist to `setEnterpriseAgentWorkingDirectory`) and the save button. Import `FolderSelectorPopover`, `FolderIcon`, `XMarkIcon`, `getCompactFolderName` as in `AgentWorkingDirectoryField`. Add a clear (×) button that sets `wd` to `''`.

- [ ] **Step 7: Run the UI tests (GREEN)**

Run: `npx vitest run src/renderer/components/agent/AgentSettingsPanel.test.ts --no-file-parallelism`
Expected: PASS.

- [ ] **Step 8: Lint + type check + commit**

Run: `npx eslint --ext ts,tsx --report-unused-disable-directives --max-warnings 0 src/renderer/components/agent/AgentSettingsPanel.tsx src/renderer/components/agent/EnterpriseWorkingDirectoryField.tsx src/renderer/components/agent/AgentSettingsPanel.test.ts`
Run: `npm run compile:electron`

```bash
git add src/renderer/components/agent/AgentSettingsPanel.tsx src/renderer/components/agent/EnterpriseWorkingDirectoryField.tsx src/renderer/components/agent/AgentSettingsPanel.test.ts
git commit -m "feat(desktop): show aboutYou, model selector and folder picker for enterprise agents"
```

---

### Task 8: Panel — skills + collaboration baseline by name

**Files:**
- Modify: `src/renderer/components/agent/AgentSettingsPanel.tsx`, `src/renderer/components/agent/AgentSkillSelector.tsx`.
- Test: `src/renderer/components/agent/AgentSettingsPanel.test.ts`.

**Interfaces:**
- Consumes: `agentSummary.serverSkillIds` / `serverSubagentAllowAgentIds` / `serverSubagentLocalIds` (already on the summary); `skillService.getLocalizedSkillName(serverId, serverId)` (renderer, resolves catalog name); `agents` (for subagent names).
- Produces: Skills tab renders the full baseline (by name) as locked rows, including uninstalled skills; Collaboration tab renders baseline collaborators checked+locked regardless of `enabled`, deduped from the toggleable list.

- [ ] **Step 1: Write the failing UI tests**

In `src/renderer/components/agent/AgentSettingsPanel.test.ts`, add:

```ts
  test('skills tab shows an uninstalled baseline skill, locked', async () => {
    // enterprise agent with serverSkillIds ['srv-skill-not-installed'] (no matching
    // local skill in state.skill.skills). Render the Skills tab; assert the skill
    // id/name is present, badged 服务端, and not toggled off.
  });

  test('collaboration tab shows a disabled baseline agent checked + locked', async () => {
    // a local enterprise agent 'agent_sub' with enabled: false that is in the
    // agent's serverSubagentAllowAgentIds / serverSubagentLocalIds. Render the
    // Collaboration tab; assert it appears checked and locked (not toggleable).
  });
```

- [ ] **Step 2: Derive which baseline skills are installed (main → renderer)**

The renderer cannot map a server skill id to an installed local id (that map
lives in `skillManager`), so the handler tells it. In
`src/main/ipcHandlers/agents/handlers.ts`, in `enrichAgentBaselines` (lines
99-112), add to the returned object:

```ts
      serverSkillInstalledIds: agent.serverSkillIds.filter((sid) =>
        skillMgr.getCatalogLocalId(sid) != null,
      ),
```

Thread `serverSkillInstalledIds?: string[]` (default `[]`) through the same
three places `aboutYou` went in Task 6: `AgentSummary` (agentSlice), the
enriched summary type in `src/renderer/types/agent.ts`, and the
`services/agent.ts` mapping objects.

- [ ] **Step 3: Render the uninstalled baseline in the skills selector**

In `AgentSkillSelector.tsx`, add two optional props to `AgentSkillSelectorProps`:

```ts
  /** Server-baseline skill ids to render as locked rows even when the skill is
   *  not installed locally (no local skill row exists). Names resolve via
   *  skillService.getLocalizedSkillName. Enterprise only. */
  baselineServerSkillIds?: string[];
  /** The subset of `baselineServerSkillIds` that ARE installed locally. These
   *  already appear (checked + locked) in the normal grid, so they are excluded
   *  from the 服务端 section to avoid a duplicate row. */
  installedBaselineServerIds?: string[];
```

In the `activeTab === Skills` render, inside the content scroll region, after
the existing `filteredSkills` grid, add the 服务端 section (enterprise only,
i.e. when `showProvenanceBadges`):

```tsx
              {showProvenanceBadges &&
                (baselineServerSkillIds ?? []).filter(
                  (sid) => !(installedBaselineServerIds ?? []).includes(sid),
                ).length > 0 ? (
                <div>
                  <p className="text-xs text-secondary">
                    {i18nService.t('agentBaselineBadge')}
                  </p>
                  <div className="mt-2 grid grid-cols-1 gap-2 sm:grid-cols-2">
                    {(baselineServerSkillIds ?? []).filter(
                      (sid) => !(installedBaselineServerIds ?? []).includes(sid),
                    ).map((sid) => (
                      <div
                        key={sid}
                        className="flex items-center justify-between rounded-lg border border-line/60 bg-surface-raised px-3 py-2"
                      >
                        <p className="flex min-w-0 items-center gap-1.5 text-xs text-foreground">
                          <span className="truncate">
                            {skillService.getLocalizedSkillName(sid, sid)}
                          </span>
                          <span className={`shrink-0 rounded-full border px-1.5 py-0.5 text-[10px] ${skillService.getSkillIcon(sid) === 'default' ? 'border-line text-secondary' : 'border-accent/30 bg-accent/10 text-accent'}`}>
                            {i18nService.t('agentBaselineBadge')}
                          </span>
                        </p>
                      </div>
                    ))}
                  </div>
                </div>
              ) : null}
```

Import `i18nService` (from `../../services/i18n`) and `skillService` (from
`../../services/skill`) into `AgentSkillSelector.tsx`. Installed baseline
skills keep appearing in the existing `filteredSkills` grid (checked + 服务端
badge via the existing `showProvenanceBadges` logic); this section adds only
the uninstalled ones.

In `AgentSettingsPanel.tsx`, read the value and pass both props to the
selector (call site at line 898-901). Near the other summary reads (lines
102-115) add:

```tsx
    const serverSkillIds = agentSummary?.serverSkillIds ?? [];
    const installedBaselineServerIds = agentSummary?.serverSkillInstalledIds ?? [];
```

and extend the selector call:

```tsx
              <AgentSkillSelector
                value={skillIds}
                onChange={setSkillIds}
                onOpenSkillMarketplace={onOpenSkillMarketplace}
                showProvenanceBadges={isServerOwned}
                addedSkillIds={isServerOwned ? addedSkillIds : undefined}
                lockedSkillIds={isServerOwned ? baselineSkillIds : undefined}
                baselineServerSkillIds={isServerOwned ? serverSkillIds : undefined}
                installedBaselineServerIds={isServerOwned ? installedBaselineServerIds : undefined}
              />
```

- [ ] **Step 4: Collaboration tab — baseline checked regardless of enabled**

In `AgentSettingsPanel.tsx` `renderCollaborationSettings` (line 607-680), before the toggleable `availableSubagentAgents` map, render the baseline collaborators. Compute the set of baseline local ids (`baselineSubagentIds` = `agentSummary.serverSubagentLocalIds ?? []`) and, for each, resolve the local agent from `agents` (to get the display name) — render a locked+checked row (reuse the existing row markup with `isBaselineCandidate` styling) even when `candidate.enabled` is false. Then in the toggleable list, exclude candidates whose id is in `baselineSubagentIds` (so a baseline agent isn't rendered twice). Keep the existing per-candidate `isBaselineCandidate`/`isAddedCandidate` logic for the toggleable list (a baseline that *is* enabled and in the list is already handled; the new baseline section handles the disabled/absent-from-list case).

Concretely: build `baselineRows = baselineSubagentIds.map(localId => agents.find(a => a.id === localId))` (filter null → render by raw id). Render those rows (locked, checked, `agentBaselineBadge`, lock icon). Then render the existing `availableSubagentAgents.filter(c => !baselineSubagentIds.includes(c.id))`.

- [ ] **Step 5: Run the UI tests (GREEN)**

Run: `npx vitest run src/renderer/components/agent/AgentSettingsPanel.test.ts --no-file-parallelism`
Expected: PASS.

- [ ] **Step 6: Lint + type check + commit**

Run: `npx eslint --ext ts,tsx --report-unused-disable-directives --max-warnings 0 src/renderer/components/agent/AgentSettingsPanel.tsx src/renderer/components/agent/AgentSkillSelector.tsx src/main/ipcHandlers/agents/handlers.ts src/renderer/store/slices/agentSlice.ts src/renderer/types/agent.ts src/renderer/services/agent.ts src/renderer/components/agent/AgentSettingsPanel.test.ts`
Run: `npm run compile:electron`

```bash
git add src/renderer/components/agent/AgentSettingsPanel.tsx src/renderer/components/agent/AgentSkillSelector.tsx src/main/ipcHandlers/agents/handlers.ts src/renderer/store/slices/agentSlice.ts src/renderer/types/agent.ts src/renderer/services/agent.ts src/renderer/components/agent/AgentSettingsPanel.test.ts
git commit -m "feat(desktop): render full enterprise skills/collaboration baseline by name"
```

---

### Task 9: Full verification + manual

**Files:** none (verification only).

- [ ] **Step 1: Rebuild + full desktop test suite**

```bash
npm rebuild better-sqlite3
npx vitest run --no-file-parallelism
```
Expected: all pass.

- [ ] **Step 2: Type + build gates**

```bash
npm run compile:electron
npm run build
```
Expected: clean.

- [ ] **Step 3: Manual validation**

Run `npm run electron:dev`. Open an enterprise agent's settings and verify:
1. 关于你 tab shows the server-configured text (read-only).
2. 技能 tab shows the enterprise-configured skills (locked, 服务端 badge) including any not installed locally, plus built-in/self skills the user can check/uncheck.
3. 协作 tab shows enterprise-configured collaborators checked + locked (even disabled ones); self agents toggle.
4. IM 渠道 tab shows only the server-started channels.
5. 默认模型 shows the server default; changing it persists and the agent runs with the new model.
6. 默认工作目录 uses the folder-picker popover, same as self-built agents.

- [ ] **Step 4: Final lint sweep over all touched files**

Run the CI-equivalent lint over every touched TS/TSX file; confirm warning-free.

---

## Self-Review Notes (author)

- **Spec coverage:** 关于你 (Tasks 1,2,6,7), skills-by-name (Tasks 3,8), collaboration-by-name (Task 8), IM (verified unchanged — already restricted to `serverImChannels`; the panel renders `visibleServerChannels` only, no new code beyond what Task 7 keeps intact), model override (Tasks 4,5,7), working-dir picker (Task 7).
- **Renderer cannot map server skill id → installed local id** (that map lives in `skillManager`). Resolution: a new handler-derived `serverSkillInstalledIds: string[]` (Task 8 Step 3) tells the panel which baseline skills are installed, so the "服务端" uninstalled section renders only the uninstalled ones without duplicating installed ones.
- **Model override runtime effect** requires main-process changes (session-start + config sync) — handled in Task 5 with a pure helper + two wirings; the config-sync dep is optional so non-enterprise/other call sites are unaffected.
- **No new i18n keys expected** (reuses `coworkBootstrapUserTitle`, `coworkBootstrapUserHint`, `agentBaselineBadge`, `agentDefaultModel`, `agentDefaultWorkingDirectory`, `agentReadOnlyBadge`). Verify during Task 7; if an empty-关于你 placeholder key is missing, add en+zh then.
- **IM tab** is already correct (renders only `visibleServerChannels`); the plan does not add IM code beyond keeping it working through the footer change. If manual testing shows a gap, it is a small follow-up, not a new capability.
