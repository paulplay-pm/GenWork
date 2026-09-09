# Enterprise Agent Management — Design Spec

**Date:** 2026-09-16
**Status:** Proposed
**Author:** Brainstorming session with paul
**Scope:** Add an enterprise_server-side "智能体管理" (agent management) feature; allow admins to author agents on enterprise_server, restrict their visible scope via `allowed_roles` JSONB, and let desktop clients mirror those agents into the local `agents` table strictly by role filter. Desktop users can use enterprise agents read-only; enterprise agents are visually mixed into the existing "我的 Agent" sidebar list.

## Problem

Today, enterprise_server has catalogs for skills (`skill_marketplace_skills`, `023_skill_marketplace.sql`) and MCP servers (`mcp_marketplace_servers`, `018_mcp_marketplace_v2.sql`), but no concept of a centrally-authored **agent** that desktops can consume. Desktop `agents` only support `source: 'custom' | 'preset'` (`src/main/genworkStore.ts:400`), and the only existing "enterprise agents" path (`syncEnterpriseConfig` in `src/main/libs/enterpriseConfigSync.ts:795`) reads a local file pack, never touches enterprise_server HTTP, and ignores user roles. The company needs a real channel where:

- an `agent_admin` user on enterprise_server authors a complete agent (identity / system prompt / model / thinking level / icon / skill bundle / subagent allow-list / role-scoped availability);
- after publication, every desktop user in a role listed in `allowed_roles` sees the agent appear in their local "我的 Agent" list automatically;
- the desktop version is **read-only** (no edit / no delete UI), the server version is the single source of truth;
- per-agent working-directory is a **desktop-local preference** that does NOT propagate from the server.

This matches the symmetry already established by skill and MCP marketplaces, with two simplifications driven by product requirements: (1) **no categories** on the server — the catalog is a flat card list; (2) **no installation step** on the desktop — the enterprise agent is mirrored directly into the local `agents` table, not downloaded as an artifact.

## Goals

1. Authoring surface on enterprise_server (admin web SPA) for `agent_admin` users to CRUD agent templates.
2. Role-scoped visibility: each agent carries an `allowed_roles` JSONB list; desktop users only see agents whose `allowed_roles` intersect their JWT roles.
3. Strict server-to-desktop mirror: when a desktop user opens / refreshes their "我的 Agent" list, the local `source='enterprise'` rows are diff-upserted against the server-filtered view; server-side invisible rows are removed.
4. Read-only desktop UX: enterprise agents can be used and pinned, but cannot be edited or deleted from the desktop.
5. Desktop-local `working_directory` per enterprise agent, persisted in a separate table, with default fallback to the Cowork global default cwd.

## Non-Goals

- No agent categories on the server (explicit product decision; mirrors the "flat card list" requirement).
- No IM-channel bindings for enterprise agents (server has no knowledge of desktop IM instances).
- No manual "install / download" step on the desktop (the agent row is mirrored, not a packaged artifact).
- No bidirectional sync or local-edits-push-back; the desktop is a read-only mirror.
- No legacy `syncEnterpriseConfig` file-pack path changes — that path is unrelated and out of scope.
- No `desktop-side` authoring of enterprise agents.

## User-visible changes

### Server side (enterprise_server admin web SPA)

- New sidebar entry "智能体管理" / "Agent Management" under `/config/agents`, gated on role `agent_admin`.
- Flat card list (no category sidebar), each card shows name / description / icon / model / allowed role count / enabled toggle / edit + delete actions.
- `CreateAgentForm` and `DetailDrawer` are full CRUD for an agent row: name, description, identity (markdown), system_prompt (markdown), model, thinking_level, icon, skill_ids (multi-select from enterprise skill catalog), subagent_allow_agent_ids (multi-select from enterprise agent catalog), allowed_roles (RoleChips, min 1), enabled.
- Audit log entries: `agent_create`, `agent_update`, `agent_delete` (and an `agent_update` entry for the referenced-agent cleanup that precedes a delete).

### Desktop side

- After login (or on demand) the desktop fetches the enterprise-server-filtered agent list and mirrors it into the local `agents` table.
- The local "我的 Agent" sidebar list is unchanged in shape: it continues to show `main` + all custom + preset + enterprise agents, ordered by `pinned` then `sort_order`.
- For each enterprise agent row, the kebab menu (Image #3) renders **only "置顶"**; "编辑" and "删除" are hidden in the DOM (not just disabled).
- The `AgentSettingsPanel` opens an enterprise agent in **read-only mode**: no field is editable, no IM 渠道 tab is rendered, no save button is rendered. The `working_directory` field is rendered with its own read/save control and is the only mutable surface.
- A "刷新 enterprise 智能体" toolbar button on the "我的 Agent" list triggers a manual sync.

## Design

### Architecture overview

```
enterprise_server (Hono + Postgres)
  └─ /api/agent-marketplace                       [public, role-filtered]
  └─ /api/admin/agent-marketplace/agents          [CRUD, agents.manage]
  └─ /api/admin/agent-marketplace/agents/:id/refs [references detail]
  └─ /api/agent-marketplace/role-options          [public, role vocabulary for picker]

Desktop (Electron + React + Redux Toolkit)
  main process
    ├─ enterpriseClient.listEnterpriseAgents()       [HTTP GET]
    ├─ agentEnterpriseSync.syncFromServer()          [mirror engine, strict D1]
    ├─ enterpriseAgentPrefsStore                     [kv of (id → workingDirectory)]
    └─ IPC handler: agents:fetchEnterpriseAgents
  renderer
    ├─ agentService.fetchEnterpriseAgents()
    ├─ agentSlice.isReadOnly = (source === 'enterprise') derived
    ├─ MyAgentSidebarTree: kebab conditioned on !isReadOnly
    └─ AgentSettingsPanel: readOnly prop, workingDirectory editable only

Local SQLite (desktop)
  agents.enterprise_agent_id  (TEXT, nullable)
  enterprise_agent_prefs      (enterprise_agent_id TEXT PK, working_directory TEXT, updated_at INTEGER)
```

### Data model

#### Server — migration `025_agent_marketplace.sql`

```sql
CREATE TABLE IF NOT EXISTS agent_marketplace_agents (
  agent_id                 TEXT PRIMARY KEY,
  name                     TEXT NOT NULL,
  description              TEXT NOT NULL DEFAULT '',
  identity                 TEXT NOT NULL DEFAULT '',
  system_prompt            TEXT NOT NULL DEFAULT '',
  model                    TEXT NOT NULL DEFAULT '',
  thinking_level           TEXT NOT NULL DEFAULT '',
  icon                     TEXT NOT NULL DEFAULT '',
  skill_ids                JSONB NOT NULL DEFAULT '[]'::jsonb,
  subagent_allow_agent_ids JSONB NOT NULL DEFAULT '[]'::jsonb,
  allowed_roles            JSONB NOT NULL DEFAULT '["org_admin"]'::jsonb,
  enabled                  BOOLEAN NOT NULL DEFAULT TRUE,
  created_at               TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at               TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS agent_marketplace_agents_enabled_idx
  ON agent_marketplace_agents(enabled);

INSERT INTO roles (name, description, permissions)
  VALUES ('agent_admin', 'Manages enterprise agent templates', '["agents.manage"]'::jsonb)
  ON CONFLICT (name) DO NOTHING;
```

#### Desktop schema migration (idempotent)

```sql
ALTER TABLE agents ADD COLUMN enterprise_agent_id TEXT;

CREATE TABLE IF NOT EXISTS enterprise_agent_prefs (
  enterprise_agent_id TEXT PRIMARY KEY,
  working_directory    TEXT NOT NULL DEFAULT '',
  updated_at INTEGER NOT NULL
);
```

### Components

#### Server

- `PermissionCode.AgentsManage = 'agents.manage'` added to `src/shared/enterpriseServerConstants.ts` and mirrored in `web/src/shared/permissions.ts`. New i18n keys for `roles.perm.agents.manage` and `roles.permDesc.agents.manage` in both en and zh.
- `AuditAction.AgentCreate / AgentUpdate / AgentDelete` constants.
- `src/models/agentMarketplaceView.ts`: `AGENT_COLUMNS` (the SELECT list), `mapAgent(row)` (snake→camel wire mapping with `allowedRoles` JSONB→string[]).
- `src/routes/agentMarketplace.ts`: public `GET /api/agent-marketplace`, gated `requireAuth`, server-side filter `isSuperAdmin || row.allowed_roles.some(r => userRoleSet.has(r))` over `enabled=true` rows.
- `src/routes/agentMarketplaceAdmin.ts`: `requireAuth` + `requirePermission(PermissionCode.AgentsManage)` on `/api/admin/agent-marketplace/*`:
  - `POST /api/admin/agent-marketplace/agents` — Zod `agentCreateSchema` validates `allowedRoles.length >= 1`, every `skillIds` entry exists and is enabled in `skill_marketplace_skills`, every `subagentAllowAgentIds` entry exists in `agent_marketplace_agents`; `agent_id = 'agent_' + Date.now()`.
  - `PUT /api/admin/agent-marketplace/agents/:agentId` — partial update; same Zod validation.
  - `DELETE /api/admin/agent-marketplace/agents/:agentId` — first `UPDATE agent_marketplace_agents SET subagent_allow_agent_ids = subagent_allow_agent_ids - :agentId WHERE subagent_allow_agent_ids ? :agentId` (Postgres JSONB `-` operator), then `DELETE FROM agent_marketplace_agents WHERE agent_id = :agentId`.
  - `GET /api/admin/agent-marketplace/agents` — unfiltered list (includes `enabled=false`).
  - `GET /api/admin/agent-marketplace/agents/:agentId/references` — returns the names + ids of all other agents whose `subagent_allow_agent_ids` contain this id.
- `src/routes/agentMarketplace.ts` (same file): `GET /api/agent-marketplace/role-options`, gated `requireAuth`, returns `CORE_ROLES = ['super_admin','org_admin','agent_admin']` ∪ user's own `claims.roles` deduplicated. This is the **picker source** for `agent_admin`-only admins who lack `roles.manage`.
- `buildApp()` in `src/server.ts:39-50`: register `agentMarketplaceRoutes` and `agentMarketplaceAdminRoutes`.

#### Desktop main process

- Type extensions:
  - `AgentSource = 'custom' | 'preset' | 'enterprise'`
  - `Agent.enterpriseAgentId?: string`
  - `AgentSummary.enterpriseAgentId?: string`, `AgentSummary.isReadOnly?: boolean` (derived in reducer)
- `src/main/sqliteStore.ts`: `ensureAgentSchema` adds `ALTER TABLE agents ADD COLUMN enterprise_agent_id TEXT` when missing; new `ensureEnterpriseAgentPrefsSchema` creates `enterprise_agent_prefs` when missing.
- `src/main/auth/enterpriseClient.ts`: `listEnterpriseAgents(): Promise<EnterpriseAgentView[]>`.
- `src/main/ipcHandlers/agents/handlers.enterprise.ts` (new file): `registerAgentEnterpriseHandlers({ loginGate, enterpriseClient, genworkStore })` registers `AgentIpcChannel.FetchEnterpriseAgents` (constant `agents:fetchEnterpriseAgents`); calls `loginGate.requireEnterprise()`; on HTTP failure returns `{ success: false }` **without touching local state**; on success calls `agentEnterpriseSync.syncFromServer` and returns `{ success: true, report }`.
- `src/main/libs/agentEnterpriseSync.ts` (new): pure function `syncFromServer(opts) → { view, report }` — strict D1 mirror; details below.
- `src/main/libs/enterpriseAgentPrefsStore.ts` (new): thin store wrapping the new table; `upsert / remove / get`.
- `src/main/libs/agentEnterpriseSyncThrottle.ts` (new): module-level `Map<key, { result, ts }>` keyed by user account id; same-key within 3000ms returns cached result, otherwise executes and records.

#### Desktop renderer

- `src/main/preload.ts:376`: `window.electron.agents.fetchEnterpriseAgents = () => ipcRenderer.invoke(AgentIpcChannel.FetchEnterpriseAgents)`.
- `src/renderer/services/agent.ts`: `fetchEnterpriseAgents()` wrapper.
- `agentSlice.ts`:
  - new action `setEnterpriseSyncReport(report)` (used by toast).
  - in `addAgent` / `updateAgent` / `setAgents` reducer: `isReadOnly = a.source === 'enterprise'`.
- `src/renderer/components/agentSidebar/MyAgentSidebarTree.tsx`: kebab menu conditional — `{ !agent.isReadOnly && <MenuItem onEdit /> }`, `{ !agent.isReadOnly && <MenuItem onDelete /> }`, `<MenuItem onPin />` always (except for `agent.id === 'main'`).
- `src/renderer/components/agent/AgentSettingsPanel.tsx`: new `readOnly` prop; when true, all field inputs render as read-only text/markdown, IM 渠道 tab is omitted, save button is omitted; a dedicated `workingDirectoryField` uses `enterpriseAgentPrefsStore.get(id)` to render and `enterpriseAgentPrefsStore.upsert(id, value)` to save.
- `src/renderer/components/agentSidebar/MyAgentSidebarTree.tsx`: toolbar button "刷新 enterprise 智能体" calls `agentService.fetchEnterpriseAgents()` and shows a toast from `setEnterpriseSyncReport`.
- i18n keys added in both en and zh blocks.

### Data flow — strict mirror D1

`syncFromServer(opts)` algorithm:

```
serverView = await enterpriseClient.listEnterpriseAgents()
serverIds  = new Set(serverView.map(a => a.agent_id))

existingLocal = genworkStore.listAgents()
                 .filter(a => a.source === 'enterprise')

// REMOVE phase — server-invisible rows are deleted (only on successful HTTP)
for (a of existingLocal) {
  if (!serverIds.has(a.enterpriseAgentId)) {
    genworkStore.deleteAgent(a.id)
    enterpriseAgentPrefsStore.remove(a.enterpriseAgentId)
    report.removed++
  }
}

// UPSERT phase
for (sv of serverView) {
  effectiveModel = isModelAvailable(sv.model) ? sv.model : defaultModel ?? ''
  effectiveSkillIds = sv.skill_ids.map(sid =>
    skillManager.getCatalogLocalId(sid) ?? sid)
  effectiveSubagent = sv.subagent_allow_agent_ids // server-validated already

  payload = {
    name, description, identity, system_prompt: sv.system_prompt,
    model: effectiveModel,
    thinkingLevel: sv.thinking_level,
    icon: sv.icon,
    skillIds: effectiveSkillIds,
    subagentAllowAgentIds: effectiveSubagent,
    enterpriseAgentId: sv.agent_id,
    source: 'enterprise',
  }

  local = existingLocal.find(a => a.enterpriseAgentId === sv.agent_id)
  if (local) {
    genworkStore.updateAgent(local.id, payload)
    report.upserted++
  } else {
    genworkStore.createAgent(payload)
    report.upserted++
  }

  if (effectiveModel !== sv.model) report.skipped++   // model fallback
}
```

Failure semantics: if `enterpriseClient.listEnterpriseAgents()` throws, the handler returns `{ success: false }` **without invoking the algorithm** — local `source='enterprise'` rows are preserved verbatim. This is the "网络抖动不杀人" patch on top of D1 strict mirror.

### Triggers

| Trigger | Code location | Behavior |
|---|---|---|
| **(b)** App startup | `src/main/main.ts` after `bootstrapEnterpriseMt` | async `fetchEnterpriseAgents()`; failure logged, not surfaced |
| **(c)** Open "我的 Agent" list | `MyAgentSidebarTree` mount `useEffect` | one sync on mount; throttled 3s |
| **(d)** After enterprise login | `enterpriseMt` login handler | one sync after token persisted |
| **(e)** Manual refresh button | toolbar in `MyAgentSidebarTree` | `agentService.fetchEnterpriseAgents()`; throttled 3s; toast on completion

The throttle is per-account-id (not global) so switching accounts doesn't share the 3s window.

### Behavior — desktop UI

| Source | Pin | Sort | Edit | Delete | Use as cwd | IM 渠道 tab |
|---|:-:|:-:|:-:|:-:|:-:|:-:|
| `main` | ✗ (hidden kebab) | ✓ | n/a | ✗ (hidden) | ✓ | ✓ |
| `custom` | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| `preset` | ✓ | ✓ | ✓ | ✓ (UI confirmation) | ✓ | ✓ |
| `enterprise` | ✓ | ✓ | **hidden** | **hidden** | ✓ (own prefs table) | **hidden** |

`isReadOnly` is the single source of truth at the UI layer; reducer derives it from `source`.

### Role / permission topology

- New point: `PermissionCode.AgentsManage = 'agents.manage'`.
- New seeded role: `agent_admin` (`permissions: ['agents.manage']` only).
- `super_admin` short-circuits every check (existing `requirePermission` middleware).
- `org_admin` does **not** gain `agents.manage`; an org admin who wants to author agents must be additionally granted `agent_admin` via `PATCH /admin/users/:id { extraRoles: ['agent_admin'] }`.
- Sidebar entry gated on `requires: 'agent_admin'` (role-name gate in SPA, server enforces point).
- Allowed-roles field for an enterprise agent is selected from `['super_admin','org_admin','agent_admin']` ∪ user's own roles, returned by `GET /api/agent-marketplace/role-options`.

### References cleanup on delete

Before `DELETE FROM agent_marketplace_agents WHERE agent_id = :id`:

```sql
UPDATE agent_marketplace_agents
   SET subagent_allow_agent_ids =
         subagent_allow_agent_ids - :id,
       updated_at = NOW()
 WHERE subagent_allow_agent_ids ? :id;
```

The `references` endpoint shows admin the count + names of impacted agents in `DetailDrawer` before the user confirms deletion.

## Error handling

| Scenario | Behavior | Local enterprise rows affected | Toast / log |
|---|---|---|---|
| enterprise_server unreachable | handler catches, returns `{success:false}` | **preserved** | toast "同步 enterprise 智能体失败,请检查网络或重新登录 enterprise_server" |
| JWT expired | `loginGate.requireEnterprise()` triggers `loginGate.lock()` | **preserved** | UI redirects to login |
| Server returns `agent_id` null/empty | upsert phase skips, `report.skipped++` | preserved | `console.warn` |
| Server-side `model` not present in desktop model catalog | upsert with `effectiveModel = ''`, `report.skipped++` | preserved | `console.debug` |
| `skill_id` no longer in catalog | upsert with `getCatalogLocalId(sid) ?? sid` (passes the raw id through) | preserved | runtime silent skip if not installed |
| Throttle hit | return last report | preserved | silent |
| Admin POST/PUT with invalid `skillIds` / `subagentAllowAgentIds` | server returns 400 with field path | not applicable | admin UI inline error |
| `agent_admin` requests `/api/roles/vocabulary` | 403 | not applicable | admin UI uses `/api/agent-marketplace/role-options` instead |
| `enterpriseAgentPrefsStore.upsert` fails (SQLite) | keep old `workingDirectory`, agent uses default cwd | preserved | `console.error` |

## Testing

### Server (`enterprise_server/tests/`)
- `routes/agentMarketplacePublic.test.ts` — auth, role filter, enabled filter, super_admin short-circuit.
- `routes/agentMarketplaceAdmin.test.ts` — CRUD, validation (`no_roles`, bad `skillIds`, bad `subagentAllowAgentIds`), delete-with-references cleanup, references endpoint.
- `routes/agentMarketplaceRoleOptions.test.ts` — public requireAuth, content matches CORE_ROLES ∪ user roles.
- `models/agentMarketplaceView.test.ts` — `mapAgent` snake→camel, `allowedRoles` JSONB→string[], null-tolerant.

### Desktop (`src/main/**/*.test.ts`, `src/renderer/**/*.test.tsx`)
- `genworkStore.test.ts` — new column `enterprise_agent_id` round-trip, `source: 'enterprise'` CRUD, `mapAgentRow` NULL→undefined.
- `enterpriseAgentPrefsStore.test.ts` — upsert / remove / get.
- `agentEnterpriseSync.test.ts` — 3-agent happy path (upserted=3); second-pass removal (removed=1); model fallback (skipped=1); prefs orphan cleanup on removal; throw-on-fetch preserves local state.
- `agentEnterpriseSyncThrottle.test.ts` — 3s window cache hit; 3s+1ms cache miss; per-account isolation.
- `agentSlice.test.ts` — `addAgent(source='enterprise')` → `isReadOnly=true`; `addAgent(source='custom')` → `isReadOnly=false`.
- `MyAgentSidebarTree.test.tsx` — enterprise agent kebab renders only "置顶"; custom agent renders all three.
- `AgentSettingsPanel.test.tsx` — enterprise agent → readOnly mode, IM tab absent, save button absent, `workingDirectory` editable.
- `ipcHandlers/agents/handlers.enterprise.test.ts` — `loginGate.requireEnterprise()` gates; HTTP failure returns `{success:false}` without sync call; HTTP success triggers sync and returns report.

### Manual (`npm run electron:dev`)
- Login as enterprise user → enterprise agents appear in "我的 Agent" list.
- Switch into an enterprise agent → `workingDirectory` empty (uses global default); changing session cwd persists to `enterprise_agent_prefs`.
- Switch enterprise account to a different role → strict mirror recomputes; agents not allowed for new role disappear.
- As `agent_admin` on web SPA, create an enterprise agent → click "刷新 enterprise 智能体" on desktop → it appears.
- As `agent_admin`, delete an enterprise agent that is referenced by another → confirm references warning → confirm delete → other agent's `subagent_allow_agent_ids` is cleared; both desktop rows reflect the change after refresh.
- Disable network → click refresh → toast appears; local enterprise rows **preserved**.

## Migration & rollout

### Commit split (9 commits)

1. `feat(enterprise_server): add agent_marketplace_agents table + agent_admin role` (migration 025 + `PermissionCode.AgentsManage` + `AuditAction.Agent*` + seed; zero behavior change)
2. `feat(enterprise_server): add agent marketplace public + admin routes` (route files + view model + `buildApp` mount + pglite tests)
3. `feat(enterprise_server): add agent management admin SPA page` (web/src/api + AgentManagePage + i18n + sidebar + route)
4. `feat(desktop): add enterprise_agent_id column + AgentSource='enterprise'` (schema + types + mapAgentRow; zero behavior change)
5. `feat(desktop): add enterprise_agent_prefs table + store` (data layer only)
6. `feat(desktop): add enterpriseClient.listEnterpriseAgents + IPC + handler` (fetch path, no auto-sync yet)
7. `feat(desktop): add enterprise agent strict-mirror sync engine` (mirror engine + throttle + failure preservation + b/c/d/e triggers)
8. `feat(desktop): hide edit/delete on enterprise agents in MyAgentSidebarTree + AgentSettingsPanel readOnly`
9. `feat(desktop): agentSlice isReadOnly derived field`

Each commit runs `npm run lint`, `npm test`, `npm run compile:electron` independently.

### Rollback

- Commits 1-3 are server-only; revert independently.
- Commits 4-5 are SQLite additions; rollback drops the column and the table (`ALTER TABLE agents DROP COLUMN enterprise_agent_id; DROP TABLE enterprise_agent_prefs;` — SQLite supports both).
- Commits 6-9 require a feature flag for safe rollback; see "Feature flag" below.
- Production DB rollback for commit 1: hand-written reverse migration `999_drop_agent_marketplace_agents.sql` that `DROP TABLE agent_marketplace_agents` and `DELETE FROM roles WHERE name = 'agent_admin'`.

### Feature flag (deferred)

A `cowork_config.flags.enterpriseAgentManagement` flag (default false) is **not** part of the initial 9 commits. It is added only if the user asks for a staged rollout (e.g., to a specific organization first). When added, it becomes commit 0 (placed before commit 1) and gates every commit 6-9 surface.

## Open questions

None at spec time; all clarifying questions resolved during brainstorming (see Decisions below).

## Decisions (resolved during the session)

| # | Question | Decision |
|---|---|---|
| 1 | Desktop形态:A catalog / B auto-sync / C read-only template | D — read-only mirror; server is authoritative, desktop mirrors directly into `agents` table |
| 2 | Strict mirror vs orphan retention | D1 strict mirror + failure preservation (network blips preserve local rows; successful sync deletes invisible rows) |
| 3 | Trigger timing | b (startup) + c (open list) + d (account switch) + e (manual button), 3s throttle |
| 4 | `working_directory` persistence + default | β (new `enterprise_agent_prefs` table) + i (default = Cowork global default cwd) |
| 5 | `agents` table identity key | B (add `enterprise_agent_id` column, no UNIQUE; server id and local id can collide visually) |
| 6 | Server agent fields + skill reference + model fallback + IM | a (skill_ids reference enterprise skill catalog), b① (model fallback on desktop), c (no IM bindings, IM tab hidden on enterprise agent detail) |
| 7 | Admin form field set + id generation + skill selector + subagent selector + cleanup | auto id, skill selector from enterprise skill catalog, subagent selector from enterprise agent list, referenced-agents cleanup on delete |
| 8 | Delete mode | A — hard delete |
| 9 | Permission topology | P2 — new role `agent_admin` with `agents.manage` only |