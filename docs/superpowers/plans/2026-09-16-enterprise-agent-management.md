# Enterprise Agent Management — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an enterprise_server-side "智能体管理" catalog (CRUD + role-scoped visibility) and a strict desktop mirror that surfaces enterprise agents read-only inside the existing "我的 Agent" sidebar, with per-agent `working_directory` persisted locally.

**Architecture:** Mirror the skill/MCP marketplace end-to-end. The server gains a flat `agent_marketplace_agents` table (`allowed_roles` JSONB + `enabled`), a public role-filtered list route, an admin CRUD route gated on a new `agents.manage` permission, and a `role-options` route for the picker. The desktop adds an `enterprise_agent_id` column + `AgentSource='enterprise'` + a separate `enterprise_agent_prefs` table for `working_directory`; a new sync engine (`agentEnterpriseSync.syncFromServer`) does strict server→local D1 mirror with failure preservation; the renderer derives `isReadOnly` from `source` and hides the edit/delete menu items + IM tab for enterprise agents.

**Tech Stack:** enterprise_server (Hono + pglite/Postgres + Zod), admin SPA (React 19 + TanStack Query + Zustand + Vitest/jsdom), desktop (Electron + React + Redux Toolkit + better-sqlite3 + Vitest).

**Spec:** `docs/superpowers/specs/2026-09-16-enterprise-agent-management-design.md`

## Global Constraints

- **Two apps, one repo.** `enterprise_server/` (server + SPA) and the desktop at repo root. Coupled only by HTTP; the desktop is enterprise-only (`ENTERPRISE_SERVER_URL` required).
- **Server migrations are idempotent.** `IF NOT EXISTS`, `ON CONFLICT DO NOTHING`, `?`-guarded `UPDATE`s. The test harness replays every migration file on a fresh schema with **no** `_migrations` ledger; re-runs must not trip constraints. `testPool.query` is one statement per call. Next free migration number: **025**.
- **Desktop SQLite schema migrations are also idempotent.** Existing pattern (see `src/main/sqliteStore.ts:644-684`): `PRAGMA table_info(<table>)` → if column not present → `ALTER TABLE … ADD COLUMN …` inside `try/catch`. New tables use `CREATE TABLE IF NOT EXISTS`.
- **i18n:** every new user-visible string needs both `en` and `zh` keys. Renderer uses `i18nService.t('key')` from `src/renderer/services/i18n.ts`; SPA uses `t(key)` from `enterprise_server/web/src/i18n.ts`.
- **Fail-closed auth.** Unknown role → zero access; only `super_admin` bypasses the `allowed_roles` filter. Public catalog + `role-options` are `requireAuth`; admin routes additionally 403 when caller lacks `agents.manage`.
- **Quality gates:** touched files lint-clean (`npx eslint --ext ts,tsx --report-unused-disable-directives --max-warnings 0 <files>`), `npx tsc --noEmit`, Conventional Commits in English, no `Co-Authored-By` trailers.
- **Test commands:** server → `cd enterprise_server && npx vitest run --no-file-parallelism`; SPA → `cd enterprise_server/web && npx vitest run`; desktop → `npx vitest run` from repo root, scoped to touched files.
- **SPA is a hand-maintained mirror** of the server `PermissionCode` catalog (`web/src/shared/permissions.ts`); it never imports from server `src/`.
- **Failure preservation.** If `enterpriseClient.listEnterpriseAgents()` throws, the sync engine is NOT invoked and local `source='enterprise'` rows are preserved verbatim. This is the "网络抖动不杀人" rule that makes D1 strict mirror safe.
- **Legacy Debt principle.** `src/main/genworkStore.ts` and `src/renderer/components/agent/AgentSettingsPanel.tsx` are both legacy-large. Any task that pushes them noticeably larger must extract first (`agentEnterpriseSync.ts` lives in `src/main/libs/`; the enterprise IPC handler lives in a new `handlers.enterprise.ts`; SPA mirroring lives in `pages/agentManage/`).
- **No auto-commits.** The user explicitly authorizes each commit; the 9-commit split in the spec is the commit plan, but commits happen only after the user has reviewed the diff for that commit.

---

### Task 1: Server migration 025 — table, seed, permission point, role

**Files:**
- Create: `enterprise_server/src/db/migrations/025_agent_marketplace.sql`
- Modify: `enterprise_server/src/shared/enterpriseServerConstants.ts:8-19,21-46`
- Test: `enterprise_server/tests/db/migrate.test.ts` (append), `enterprise_server/tests/shared/permissionCodes.test.ts` (append)

**Interfaces:**
- Produces: table `agent_marketplace_agents(agent_id PK, name, description, identity, system_prompt, model, thinking_level, icon, skill_ids JSONB, subagent_allow_agent_ids JSONB, allowed_roles JSONB DEFAULT '["org_admin"]', enabled BOOLEAN DEFAULT TRUE, created_at, updated_at)` with index on `enabled`; seeded `agent_admin` role with `permissions: ['agents.manage']`; new `PermissionCode.AgentsManage='agents.manage'`; new `AuditAction.AgentCreate/Update/Delete`.

- [ ] **Step 1: Append the failing migration test**

Append to `enterprise_server/tests/db/migrate.test.ts` (reuse existing `resetSchema`/`runMigrations`/`testPool` imports; match the file's style):

```ts
test('025 creates agent_marketplace_agents table and seeds agent_admin role', async () => {
  await runMigrations();
  const t = await testPool.query(
    `SELECT to_regclass('public.agent_marketplace_agents') AS t`,
  );
  expect(t.rows[0].t).toBeTruthy();

  const idx = await testPool.query(
    `SELECT to_regclass('public.agent_marketplace_agents_enabled_idx') AS i`,
  );
  expect(idx.rows[0].i).toBeTruthy();

  const role = await testPool.query(
    `SELECT permissions FROM roles WHERE name = 'agent_admin'`,
  );
  expect(role.rows[0]?.permissions).toEqual(['agents.manage']);

  // idempotent: re-running 025 doesn't duplicate the row
  await runMigrations();
  const again = await testPool.query(
    `SELECT count(*)::int AS c FROM roles WHERE name = 'agent_admin'`,
  );
  expect(again.rows[0].c).toBe(1);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd enterprise_server && npx vitest run --no-file-parallelism tests/db/migrate.test.ts`
Expected: FAIL — `agent_marketplace_agents` does not exist.

- [ ] **Step 3: Write the migration**

Create `enterprise_server/src/db/migrations/025_agent_marketplace.sql`:

```sql
-- v1
-- Enterprise agent catalog (flat card list; mirrors 023 skills / 018 MCP).
-- Single file: catalog table + index + agent_admin role seed.

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
  ON agent_marketplace_agents (enabled);

-- agent_admin: enterprise agent catalog authoring. Server-gated on
-- `agents.manage`. Idempotent. NOTE: `roles.id` is a NOT NULL PK with no
-- default (see 019_rbac.sql), so the seed must supply an id.
INSERT INTO roles (id, name, description, permissions)
  VALUES (gen_random_uuid(), 'agent_admin', 'Manages enterprise agent templates', '["agents.manage"]'::jsonb)
  ON CONFLICT (name) DO NOTHING;
```

- [ ] **Step 4: Add `PermissionCode.AgentsManage` + `AuditAction.Agent*`**

In `enterprise_server/src/shared/enterpriseServerConstants.ts`, after `McpManage: 'mcp.manage',` (line 17) add:
```ts
  AgentsManage: 'agents.manage',
```

After `RoleDelete: 'role_delete',` (line 45) add:
```ts
  AgentCreate: 'agent_create',
  AgentUpdate: 'agent_update',
  AgentDelete: 'agent_delete',
```

- [ ] **Step 5: Append the failing constants test**

Append to `enterprise_server/tests/shared/permissionCodes.test.ts`:

```ts
test('exposes the agents.manage point', () => {
  expect(PermissionCode.AgentsManage).toBe('agents.manage');
});

test('AuditAction carries agent mutation actions', () => {
  expect(AuditAction.AgentCreate).toBe('agent_create');
  expect(AuditAction.AgentUpdate).toBe('agent_update');
  expect(AuditAction.AgentDelete).toBe('agent_delete');
});
```

Update the existing point-IDs test (`expect(PermissionCode.McpManage).toBe('mcp.manage')` block at line 16) to add a matching `expect(PermissionCode.AgentsManage).toBe('agents.manage')` line so the catalog enumeration assertion stays complete.

- [ ] **Step 6: Run the tests + lint**

Run: `cd enterprise_server && npx vitest run --no-file-parallelism tests/db/migrate.test.ts tests/shared/permissionCodes.test.ts && npx eslint --ext ts,tsx --report-unused-disable-directives --max-warnings 0 src/shared/enterpriseServerConstants.ts`
Expected: PASS + clean.

- [ ] **Step 7: Commit**

```bash
git add enterprise_server/src/db/migrations/025_agent_marketplace.sql enterprise_server/src/shared/enterpriseServerConstants.ts enterprise_server/tests/db/migrate.test.ts enterprise_server/tests/shared/permissionCodes.test.ts
git commit -m "feat(enterprise_server): add agent_marketplace_agents table and agent_admin role

Adds migration 025 (agent_marketplace_agents with allowed_roles JSONB
and an enabled index), the agent_admin role with permissions
['agents.manage'], PermissionCode.AgentsManage, and AuditAction
AgentCreate/Update/Delete. Zero behavior change."
```

---

### Task 2: Server — view/model + public catalog route + role-options route

**Files:**
- Create: `enterprise_server/src/models/agentMarketplaceView.ts`
- Create: `enterprise_server/src/routes/agentMarketplace.ts`
- Modify: `enterprise_server/src/server.ts:39-50`
- Test: `enterprise_server/tests/models/agentMarketplaceView.test.ts` (create), `enterprise_server/tests/routes/agentMarketplacePublic.test.ts` (create), `enterprise_server/tests/routes/agentMarketplaceRoleOptions.test.ts` (create)

**Interfaces:**
- Consumes: Task 1's table, `Role`/`PermissionCode` constants, `requireAuth`.
- Produces:
  - `AGENT_COLUMNS`, `AgentRow`, `AgentMarketplaceView`, `mapAgent(row)`.
  - `GET /api/agent-marketplace` → `{ agents: AgentMarketplaceView[] }` (enabled + role-visible).
  - `GET /api/agent-marketplace/role-options` → `{ roles: string[] }` = `CORE_ROLES` ∪ `claims.roles` deduped (where `CORE_ROLES = ['super_admin','org_admin','agent_admin']`).

- [ ] **Step 1: Write the failing view test**

Create `enterprise_server/tests/models/agentMarketplaceView.test.ts`:

```ts
import { describe, expect, test } from 'vitest';

import { AGENT_COLUMNS, mapAgent } from '../../src/models/agentMarketplaceView';

describe('agentMarketplaceView', () => {
  test('AGENT_COLUMNS covers every wire field', () => {
    // Lightweight: assert no duplicates and that 'allowed_roles' is included.
    const cols = AGENT_COLUMNS.split(',').map(s => s.trim());
    expect(new Set(cols).size).toBe(cols.length);
    expect(cols).toContain('allowed_roles');
    expect(cols).toContain('agent_id');
  });

  test('mapAgent maps snake row -> camel wire, defaulting missing fields', () => {
    const v = mapAgent({
      agent_id: 'agent_a1',
      name: 'Code Reviewer',
      description: 'Reviews PRs',
      identity: '',
      system_prompt: '',
      model: '',
      thinking_level: '',
      icon: '',
      skill_ids: ['web-search'],
      subagent_allow_agent_ids: ['agent_a2'],
      allowed_roles: ['org_admin', 'user'],
      enabled: true,
    });
    expect(v).toEqual({
      agentId: 'agent_a1',
      name: 'Code Reviewer',
      description: 'Reviews PRs',
      identity: '',
      systemPrompt: '',
      model: '',
      thinkingLevel: '',
      icon: '',
      skillIds: ['web-search'],
      subagentAllowAgentIds: ['agent_a2'],
      allowedRoles: ['org_admin', 'user'],
      enabled: true,
    });
  });

  test('mapAgent tolerates null array columns', () => {
    const v = mapAgent({
      agent_id: 'a', name: 'A', description: '', identity: '', system_prompt: '',
      model: '', thinking_level: '', icon: '',
      // @ts-expect-error — defensive default for legacy rows
      skill_ids: null, subagent_allow_agent_ids: null,
      allowed_roles: ['org_admin'], enabled: false,
    });
    expect(v.skillIds).toEqual([]);
    expect(v.subagentAllowAgentIds).toEqual([]);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd enterprise_server && npx vitest run --no-file-parallelism tests/models/agentMarketplaceView.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the view model**

Create `enterprise_server/src/models/agentMarketplaceView.ts`:

```ts
/** Single source of the SELECT column list used by both the public catalog
 *  route and the admin list route. Keep in sync with migration 025. */
export const AGENT_COLUMNS = `agent_id, name, description, identity, system_prompt,
  model, thinking_level, icon, skill_ids, subagent_allow_agent_ids,
  allowed_roles, enabled`;

/** DB row shape for a marketplace agent (post-025). */
export interface AgentRow {
  agent_id: string;
  name: string;
  description: string;
  identity: string;
  system_prompt: string;
  model: string;
  thinking_level: string;
  icon: string;
  skill_ids: string[] | null;
  subagent_allow_agent_ids: string[] | null;
  allowed_roles: string[];
  enabled: boolean;
}

/** Wire shape returned by both the public catalog and the admin list. */
export interface AgentMarketplaceView {
  agentId: string;
  name: string;
  description: string;
  identity: string;
  systemPrompt: string;
  model: string;
  thinkingLevel: string;
  icon: string;
  skillIds: string[];
  subagentAllowAgentIds: string[];
  allowedRoles: string[];
  enabled: boolean;
}

export function mapAgent(row: AgentRow): AgentMarketplaceView {
  return {
    agentId: row.agent_id,
    name: row.name,
    description: row.description,
    identity: row.identity,
    systemPrompt: row.system_prompt,
    model: row.model,
    thinkingLevel: row.thinking_level,
    icon: row.icon,
    skillIds: row.skill_ids ?? [],
    subagentAllowAgentIds: row.subagent_allow_agent_ids ?? [],
    allowedRoles: row.allowed_roles,
    enabled: row.enabled,
  };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd enterprise_server && npx vitest run --no-file-parallelism tests/models/agentMarketplaceView.test.ts`
Expected: PASS.

- [ ] **Step 5: Write the failing public route tests**

Create `enterprise_server/tests/routes/agentMarketplacePublic.test.ts`:

```ts
import '../helpers/setupEnv';

import { beforeEach, describe, expect, test, vi } from 'vitest';

vi.mock('../../src/db/pool', async () => {
  const td = await import('../../src/db/testDb');
  return { pool: td.testPool };
});

import { Hono } from 'hono';

import { signToken } from '../../src/auth/jwt';
import { resetSchema, runMigrations, testPool } from '../../src/db/testDb';
import { agentMarketplaceRoutes } from '../../src/routes/agentMarketplace';

const app = new Hono();
app.route('/', agentMarketplaceRoutes);

const tokenFor = async (roles: string[]): Promise<string> =>
  signToken({ sub: 'u1', orgId: 'o1', roles });
const auth = (t: string) => ({ authorization: `Bearer ${t}` });

async function seed(overrides: Array<{ id: string; roles: string[]; enabled?: boolean }>): Promise<void> {
  for (const o of overrides) {
    await testPool.query(
      `INSERT INTO agent_marketplace_agents
         (agent_id, name, allowed_roles, enabled)
       VALUES ($1, $1, $2::jsonb, $3)`,
      [o.id, JSON.stringify(o.roles), o.enabled ?? true],
    );
  }
}

beforeEach(async () => {
  await resetSchema();
  await runMigrations();
});

describe('GET /api/agent-marketplace', () => {
  test('401 without a token', async () => {
    expect((await app.request('/api/agent-marketplace')).status).toBe(401);
  });

  test('returns only enabled agents whose allowed_roles intersect the caller', async () => {
    await seed([
      { id: 'a', roles: ['user'] },
      { id: 'b', roles: ['model_admin'] },
      { id: 'c', roles: ['user'], enabled: false },
    ]);
    const res = await app.request('/api/agent-marketplace', { headers: auth(await tokenFor(['user'])) });
    const body = await res.json() as { agents: Array<{ agentId: string }> };
    expect(res.status).toBe(200);
    expect(body.agents.map(a => a.agentId)).toEqual(['a']);
  });

  test('super_admin sees every enabled agent', async () => {
    await seed([{ id: 'a', roles: ['model_admin'] }]);
    const res = await app.request('/api/agent-marketplace', { headers: auth(await tokenFor(['super_admin'])) });
    const body = await res.json() as { agents: Array<{ agentId: string }> };
    expect(body.agents.map(a => a.agentId)).toEqual(['a']);
  });
});
```

Create `enterprise_server/tests/routes/agentMarketplaceRoleOptions.test.ts`:

```ts
import '../helpers/setupEnv';

import { beforeEach, describe, expect, test, vi } from 'vitest';

vi.mock('../../src/db/pool', async () => {
  const td = await import('../../src/db/testDb');
  return { pool: td.testPool };
});

import { Hono } from 'hono';

import { signToken } from '../../src/auth/jwt';
import { resetSchema, runMigrations, testPool } from '../../src/db/testDb';
import { agentMarketplaceRoutes } from '../../src/routes/agentMarketplace';

const app = new Hono();
app.route('/', agentMarketplaceRoutes);

const tokenFor = async (roles: string[]): Promise<string> =>
  signToken({ sub: 'u1', orgId: 'o1', roles });
const auth = (t: string) => ({ authorization: `Bearer ${t}` });

beforeEach(async () => {
  await resetSchema();
  await runMigrations();
});

describe('GET /api/agent-marketplace/role-options', () => {
  test('401 without a token', async () => {
    expect((await app.request('/api/agent-marketplace/role-options')).status).toBe(401);
  });

  test('returns CORE_ROLES unioned with the caller\'s own roles, deduped + sorted', async () => {
    // Seed an extra role row so vocabulary also picks up org_admin from the roles table.
    const res = await app.request('/api/agent-marketplace/role-options', {
      headers: auth(await tokenFor(['policy_admin'])),
    });
    const body = await res.json() as { roles: string[] };
    expect(res.status).toBe(200);
    expect(body.roles).toEqual(['agent_admin', 'org_admin', 'policy_admin', 'super_admin']);
  });
});
```

- [ ] **Step 6: Run the tests to verify they fail**

Run: `cd enterprise_server && npx vitest run --no-file-parallelism tests/routes/agentMarketplacePublic.test.ts tests/routes/agentMarketplaceRoleOptions.test.ts`
Expected: FAIL — module `routes/agentMarketplace` not found.

- [ ] **Step 7: Write the public route**

Create `enterprise_server/src/routes/agentMarketplace.ts`:

```ts
import { Hono } from 'hono';

import { requireAuth } from '../auth/middleware';
import { pool } from '../db/pool';
import {
  AGENT_COLUMNS,
  type AgentRow,
  mapAgent,
} from '../models/agentMarketplaceView';
import { Role } from '../shared/enterpriseServerConstants';

const AGENT_CORE_ROLES = ['super_admin', 'org_admin', 'agent_admin'] as const;

export const agentMarketplaceRoutes = new Hono();
agentMarketplaceRoutes.use('/api/agent-marketplace/*', requireAuth);

agentMarketplaceRoutes.get('/api/agent-marketplace', async (c) => {
  const claims = c.get('claims');
  const userRoles = claims?.roles ?? [];
  const isSuperAdmin = userRoles.includes(Role.SuperAdmin);

  const rows = await pool.query<AgentRow>(
    `SELECT ${AGENT_COLUMNS} FROM agent_marketplace_agents WHERE enabled = TRUE ORDER BY agent_id`,
  );
  const userRoleSet = new Set(userRoles);
  const visible = rows.rows.filter(
    row => isSuperAdmin || row.allowed_roles.some(r => userRoleSet.has(r)),
  );
  return c.json({ agents: visible.map(mapAgent) });
});

// Picker source for the agent_admin form. The default agent_admin role
// lacks `roles.manage` (see spec §3.5), so /api/roles/vocabulary 403s for
// them; this endpoint is the dedicated replacement.
agentMarketplaceRoutes.get('/api/agent-marketplace/role-options', async (c) => {
  const claims = c.get('claims');
  const userRoles = claims?.roles ?? [];
  const set = new Set<string>(AGENT_CORE_ROLES);
  for (const r of userRoles) set.add(r);
  return c.json({ roles: [...set].sort() });
});
```

- [ ] **Step 8: Wire the route in `server.ts`**

In `enterprise_server/src/server.ts`, after `import { skillMarketplaceRoutes } from './routes/skillMarketplace';` add:
```ts
import { agentMarketplaceRoutes } from './routes/agentMarketplace';
```
After `app.route('/', skillMarketplaceRoutes);` add:
```ts
app.route('/', agentMarketplaceRoutes);
```

- [ ] **Step 9: Run the tests to verify they pass**

Run: `cd enterprise_server && npx vitest run --no-file-parallelism tests/models/agentMarketplaceView.test.ts tests/routes/agentMarketplacePublic.test.ts tests/routes/agentMarketplaceRoleOptions.test.ts`
Expected: PASS.

- [ ] **Step 10: Typecheck + lint + commit**

Run: `cd enterprise_server && npx tsc --noEmit && npx eslint --ext ts,tsx --report-unused-disable-directives --max-warnings 0 src/models/agentMarketplaceView.ts src/routes/agentMarketplace.ts src/server.ts`

```bash
git add enterprise_server/src/models/agentMarketplaceView.ts enterprise_server/src/routes/agentMarketplace.ts enterprise_server/src/server.ts enterprise_server/tests/models/agentMarketplaceView.test.ts enterprise_server/tests/routes/agentMarketplacePublic.test.ts enterprise_server/tests/routes/agentMarketplaceRoleOptions.test.ts
git commit -m "feat(enterprise_server): add agent marketplace public catalog and role-options routes

Public GET /api/agent-marketplace filters agent_marketplace_agents by
the caller's JWT roles (with super_admin short-circuit); GET
/api/agent-marketplace/role-options returns the allowed-roles picker
vocabulary (CORE_ROLES unioned with the caller's own roles)."
```

---

### Task 3: Server — admin CRUD + references endpoint + audit writes

**Files:**
- Create: `enterprise_server/src/routes/agentMarketplaceAdmin.ts`
- Modify: `enterprise_server/src/server.ts`
- Test: `enterprise_server/tests/routes/agentMarketplaceAdmin.test.ts` (create)

**Interfaces:**
- Consumes: `AgentMarketplaceView`/`mapAgent`/`AGENT_COLUMNS` (Task 2); `PermissionCode.AgentsManage` (Task 1); `AuditAction.Agent*`; `requireAuth`/`requirePermission`; `pool.query` with JSONB casts.
- Produces:
  - `GET /api/admin/agent-marketplace/agents` → unfiltered list (includes `enabled=false`).
  - `POST /api/admin/agent-marketplace/agents` — Zod validates `allowedRoles.length>=1`; every `skillIds` entry exists + is enabled in `skill_marketplace_skills`; every `subagentAllowAgentIds` entry exists in `agent_marketplace_agents`; `agent_id = 'agent_' + Date.now()`; audit `agent_create`.
  - `PUT /api/admin/agent-marketplace/agents/:agentId` — partial update; same Zod validation; audit `agent_update`.
  - `DELETE /api/admin/agent-marketplace/agents/:agentId` — first `UPDATE … SET subagent_allow_agent_ids = subagent_allow_agent_ids - :agentId WHERE subagent_allow_agent_ids ? :agentId` (Postgres JSONB `-` operator), then DELETE; audit `agent_update` for the rehome + `agent_delete`.
  - `GET /api/admin/agent-marketplace/agents/:agentId/references` → `{ ids: string[], names: string[] }` of all agents whose `subagent_allow_agent_ids` contain this id.

- [ ] **Step 1: Write the failing admin route test**

Create `enterprise_server/tests/routes/agentMarketplaceAdmin.test.ts`:

```ts
import '../helpers/setupEnv';

import { beforeEach, describe, expect, test, vi } from 'vitest';

vi.mock('../../src/db/pool', async () => {
  const td = await import('../../src/db/testDb');
  return { pool: td.testPool };
});
vi.mock('../../src/audit/auditStore', () => ({
  auditStore: { write: vi.fn().mockResolvedValue(undefined) },
}));

import { Hono } from 'hono';

import { signToken } from '../../src/auth/jwt';
import { resetSchema, runMigrations, testPool } from '../../src/db/testDb';
import { agentMarketplaceAdminRoutes } from '../../src/routes/agentMarketplaceAdmin';

const app = new Hono();
app.route('/', agentMarketplaceAdminRoutes);

const admin = async () => signToken({ sub: 'a', orgId: 'o1', roles: ['super_admin'] });
const auth = (t: string) => ({ authorization: `Bearer ${t}` });
const json = { 'content-type': 'application/json' };

async function seedEnabledSkill(skillId: string): Promise<void> {
  await testPool.query(
    `INSERT INTO skill_marketplace_skills (skill_id, name_en, description_en, category_id, allowed_roles, enabled)
     VALUES ($1, $1, 'd', 'uncategorized', '["org_admin"]'::jsonb, TRUE)`,
    [skillId],
  );
}

async function seedAgent(id: string, allowedRoles: string[]): Promise<void> {
  await testPool.query(
    `INSERT INTO agent_marketplace_agents (agent_id, name, allowed_roles, enabled)
     VALUES ($1, $1, $2::jsonb, TRUE)`,
    [id, JSON.stringify(allowedRoles)],
  );
}

beforeEach(async () => {
  await resetSchema();
  await runMigrations();
});

describe('agents CRUD', () => {
  test('admin auth + happy-path create returns agent_id', async () => {
    const tok = await admin();
    const res = await app.request('/api/admin/agent-marketplace/agents', {
      method: 'POST',
      headers: { ...auth(tok), ...json },
      body: JSON.stringify({
        name: 'Reviewer', description: 'd', allowed_roles: ['org_admin'],
      }),
    });
    expect(res.status).toBe(200);
    const body = await res.json() as { agent_id: string };
    expect(body.agent_id).toMatch(/^agent_\d+$/);
  });

  test('non-admin gets 403', async () => {
    const tok = await signToken({ sub: 'u', orgId: 'o1', roles: ['user'] });
    const res = await app.request('/api/admin/agent-marketplace/agents', {
      method: 'POST', headers: { ...auth(tok), ...json },
      body: JSON.stringify({ name: 'X', allowed_roles: ['org_admin'] }),
    });
    expect(res.status).toBe(403);
  });

  test('empty allowed_roles -> 400', async () => {
    const tok = await admin();
    const res = await app.request('/api/admin/agent-marketplace/agents', {
      method: 'POST', headers: { ...auth(tok), ...json },
      body: JSON.stringify({ name: 'X', allowed_roles: [] }),
    });
    expect(res.status).toBe(400);
  });

  test('unknown skill_id -> 400', async () => {
    const tok = await admin();
    const res = await app.request('/api/admin/agent-marketplace/agents', {
      method: 'POST', headers: { ...auth(tok), ...json },
      body: JSON.stringify({
        name: 'X', allowed_roles: ['org_admin'], skill_ids: ['nope'],
      }),
    });
    expect(res.status).toBe(400);
  });

  test('update patch respects same validation', async () => {
    const tok = await admin();
    const created = await app.request('/api/admin/agent-marketplace/agents', {
      method: 'POST', headers: { ...auth(tok), ...json },
      body: JSON.stringify({ name: 'X', allowed_roles: ['org_admin'] }),
    });
    const { agent_id } = await created.json() as { agent_id: string };
    const bad = await app.request(`/api/admin/agent-marketplace/agents/${agent_id}`, {
      method: 'PUT', headers: { ...auth(tok), ...json },
      body: JSON.stringify({ allowed_roles: [] }),
    });
    expect(bad.status).toBe(400);
  });

  test('delete clears references via JSONB `-` and then removes the row', async () => {
    const tok = await admin();
    const a = await app.request('/api/admin/agent-marketplace/agents', {
      method: 'POST', headers: { ...auth(tok), ...json },
      body: JSON.stringify({ name: 'A', allowed_roles: ['org_admin'] }),
    });
    const { agent_id: aId } = await a.json() as { agent_id: string };

    const b = await app.request('/api/admin/agent-marketplace/agents', {
      method: 'POST', headers: { ...auth(tok), ...json },
      body: JSON.stringify({
        name: 'B', allowed_roles: ['org_admin'], subagent_allow_agent_ids: [aId],
      }),
    });
    const { agent_id: bId } = await b.json() as { agent_id: string };

    const refs = await app.request(`/api/admin/agent-marketplace/agents/${aId}/references`, {
      headers: auth(tok),
    });
    const refsBody = await refs.json() as { ids: string[] };
    expect(refsBody.ids).toContain(bId);

    const del = await app.request(`/api/admin/agent-marketplace/agents/${aId}`, {
      method: 'DELETE', headers: auth(tok),
    });
    expect(del.status).toBe(204);

    const stillThere = await testPool.query(
      `SELECT subagent_allow_agent_ids FROM agent_marketplace_agents WHERE agent_id = $1`,
      [bId],
    );
    expect(stillThere.rows[0].subagent_allow_agent_ids).not.toContain(aId);
  });

  test('list includes disabled rows', async () => {
    const tok = await admin();
    await seedAgent('a', ['org_admin']);
    await testPool.query(`UPDATE agent_marketplace_agents SET enabled = FALSE WHERE agent_id = 'a'`);
    const res = await app.request('/api/admin/agent-marketplace/agents', { headers: auth(tok) });
    const body = await res.json() as Array<{ agentId: string; enabled: boolean }>;
    expect(body.find(x => x.agentId === 'a')?.enabled).toBe(false);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd enterprise_server && npx vitest run --no-file-parallelism tests/routes/agentMarketplaceAdmin.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the admin route**

Create `enterprise_server/src/routes/agentMarketplaceAdmin.ts`:

```ts
import { Hono } from 'hono';
import { z } from 'zod';

import { auditStore } from '../audit/auditStore';
import { requireAuth, requirePermission } from '../auth/middleware';
import { pool } from '../db/pool';
import {
  AGENT_COLUMNS,
  type AgentRow,
  mapAgent,
} from '../models/agentMarketplaceView';
import { AuditAction, PermissionCode } from '../shared/enterpriseServerConstants';

const agentCreateSchema = z.object({
  name: z.string().min(1),
  description: z.string().optional().default(''),
  identity: z.string().optional().default(''),
  system_prompt: z.string().optional().default(''),
  model: z.string().optional().default(''),
  thinking_level: z.string().optional().default(''),
  icon: z.string().optional().default(''),
  skill_ids: z.array(z.string().min(1)).optional().default([]),
  subagent_allow_agent_ids: z.array(z.string().min(1)).optional().default([]),
  allowed_roles: z.array(z.string().min(1)).min(1, { message: 'no_roles' }),
});

const agentPatchSchema = agentCreateSchema.partial();

async function assertSkillIdsExist(enabledOnly: boolean, ids: string[]): Promise<string | null> {
  if (ids.length === 0) return null;
  const r = await pool.query<{ skill_id: string }>(
    `SELECT skill_id FROM skill_marketplace_skills WHERE skill_id = ANY($1)` +
    (enabledOnly ? ' AND enabled = TRUE' : ''),
    [ids],
  );
  const have = new Set(r.rows.map(x => x.skill_id));
  return ids.find(id => !have.has(id)) ?? null;
}

async function assertAgentIdsExist(ids: string[]): Promise<string | null> {
  if (ids.length === 0) return null;
  const r = await pool.query<{ agent_id: string }>(
    `SELECT agent_id FROM agent_marketplace_agents WHERE agent_id = ANY($1)`, [ids]);
  const have = new Set(r.rows.map(x => x.agent_id));
  return ids.find(id => !have.has(id)) ?? null;
}

export const agentMarketplaceAdminRoutes = new Hono();
agentMarketplaceAdminRoutes.use('/api/admin/agent-marketplace/*', requireAuth);
agentMarketplaceAdminRoutes.use('/api/admin/agent-marketplace/*', requirePermission(PermissionCode.AgentsManage));

agentMarketplaceAdminRoutes.post('/api/admin/agent-marketplace/agents', async (c) => {
  const parsed = agentCreateSchema.safeParse(await c.req.json());
  if (!parsed.success) {
    return c.json({ error: 'invalid_body', issues: parsed.error.issues }, 400);
  }
  const b = parsed.data;
  if (b.allowed_roles.length === 0) return c.json({ error: 'no_roles' }, 400);

  const missingSkill = await assertSkillIdsExist(true, b.skill_ids);
  if (missingSkill) return c.json({ error: 'unknown_skill', skill_id: missingSkill }, 400);
  const missingAgent = await assertAgentIdsExist(b.subagent_allow_agent_ids);
  if (missingAgent) return c.json({ error: 'unknown_subagent', agent_id: missingAgent }, 400);

  const agentId = `agent_${Date.now()}`;
  await pool.query(
    `INSERT INTO agent_marketplace_agents
       (agent_id, name, description, identity, system_prompt, model, thinking_level, icon,
        skill_ids, subagent_allow_agent_ids, allowed_roles, enabled)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10::jsonb,$11::jsonb,TRUE)`,
    [agentId, b.name, b.description, b.identity, b.system_prompt, b.model, b.thinking_level, b.icon,
     JSON.stringify(b.skill_ids), JSON.stringify(b.subagent_allow_agent_ids), JSON.stringify(b.allowed_roles)],
  );
  const claims = c.get('claims');
  await auditStore.write({
    orgId: claims.orgId, userId: claims.sub,
    action: AuditAction.AgentCreate, targetType: 'agent', targetId: agentId,
  });
  return c.json({ agent_id: agentId });
});

agentMarketplaceAdminRoutes.put('/api/admin/agent-marketplace/agents/:agentId', async (c) => {
  const id = c.req.param('agentId');
  const parsed = agentPatchSchema.safeParse(await c.req.json());
  if (!parsed.success) return c.json({ error: 'invalid_body', issues: parsed.error.issues }, 400);
  const b = parsed.data;

  if (b.skill_ids !== undefined) {
    const missing = await assertSkillIdsExist(true, b.skill_ids);
    if (missing) return c.json({ error: 'unknown_skill', skill_id: missing }, 400);
  }
  if (b.subagent_allow_agent_ids !== undefined) {
    const missing = await assertAgentIdsExist(b.subagent_allow_agent_ids);
    if (missing) return c.json({ error: 'unknown_subagent', agent_id: missing }, 400);
  }
  if (b.allowed_roles !== undefined && b.allowed_roles.length === 0) {
    return c.json({ error: 'no_roles' }, 400);
  }

  const sets: string[] = [];
  const params: unknown[] = [id];
  const push = (col: string, val: unknown) => { params.push(val); sets.push(`${col} = $${params.length}`); };
  if (b.name !== undefined) push('name', b.name);
  if (b.description !== undefined) push('description', b.description);
  if (b.identity !== undefined) push('identity', b.identity);
  if (b.system_prompt !== undefined) push('system_prompt', b.system_prompt);
  if (b.model !== undefined) push('model', b.model);
  if (b.thinking_level !== undefined) push('thinking_level', b.thinking_level);
  if (b.icon !== undefined) push('icon', b.icon);
  if (b.skill_ids !== undefined) push('skill_ids', JSON.stringify(b.skill_ids));
  if (b.subagent_allow_agent_ids !== undefined) push('subagent_allow_agent_ids', JSON.stringify(b.subagent_allow_agent_ids));
  if (b.allowed_roles !== undefined) push('allowed_roles', JSON.stringify(b.allowed_roles));

  if (sets.length === 0) return c.json({ error: 'empty_patch' }, 400);
  const result = await pool.query(
    `UPDATE agent_marketplace_agents SET ${sets.join(', ')}, updated_at = NOW() WHERE agent_id = $1`, params);
  if (result.rowCount === 0) return c.json({ error: 'not_found' }, 404);

  const claims = c.get('claims');
  await auditStore.write({
    orgId: claims.orgId, userId: claims.sub,
    action: AuditAction.AgentUpdate, targetType: 'agent', targetId: id,
  });
  return c.body(null, 204);
});

agentMarketplaceAdminRoutes.delete('/api/admin/agent-marketplace/agents/:agentId', async (c) => {
  const id = c.req.param('agentId');
  // References cleanup: drop this id from every other agent's
  // subagent_allow_agent_ids using the Postgres JSONB `-` operator so the
  // desktop never sees a stale reference.
  const rehome = await pool.query(
    `UPDATE agent_marketplace_agents
        SET subagent_allow_agent_ids = subagent_allow_agent_ids - $1, updated_at = NOW()
      WHERE subagent_allow_agent_ids ? $1`, [id]);
  const result = await pool.query(`DELETE FROM agent_marketplace_agents WHERE agent_id = $1`, [id]);
  if (result.rowCount === 0) return c.json({ error: 'not_found' }, 404);

  const claims = c.get('claims');
  if (rehome.rowCount && rehome.rowCount > 0) {
    await auditStore.write({
      orgId: claims.orgId, userId: claims.sub,
      action: AuditAction.AgentUpdate, targetType: 'agent_references', targetId: id,
      payload: { affected: rehome.rowCount },
    });
  }
  await auditStore.write({
    orgId: claims.orgId, userId: claims.sub,
    action: AuditAction.AgentDelete, targetType: 'agent', targetId: id,
  });
  return c.body(null, 204);
});

agentMarketplaceAdminRoutes.get('/api/admin/agent-marketplace/agents', async (c) => {
  const r = await pool.query<AgentRow>(
    `SELECT ${AGENT_COLUMNS} FROM agent_marketplace_agents ORDER BY created_at DESC`,
  );
  return c.json(r.rows.map(mapAgent));
});

agentMarketplaceAdminRoutes.get('/api/admin/agent-marketplace/agents/:agentId/references', async (c) => {
  const id = c.req.param('agentId');
  const r = await pool.query<{ agent_id: string; name: string }>(
    `SELECT agent_id, name FROM agent_marketplace_agents
      WHERE subagent_allow_agent_ids ? $1 ORDER BY agent_id`, [id]);
  return c.json({ ids: r.rows.map(x => x.agent_id), names: r.rows.map(x => x.name) });
});
```

- [ ] **Step 4: Wire the route in `server.ts`**

In `enterprise_server/src/server.ts`, after `import { skillMarketplaceAdminRoutes } from './routes/skillMarketplaceAdmin';` add:
```ts
import { agentMarketplaceAdminRoutes } from './routes/agentMarketplaceAdmin';
```
After `app.route('/', skillMarketplaceAdminRoutes);` add:
```ts
app.route('/', agentMarketplaceAdminRoutes);
```

- [ ] **Step 5: Run the test + typecheck + lint**

Run: `cd enterprise_server && npx vitest run --no-file-parallelism tests/routes/agentMarketplaceAdmin.test.ts && npx tsc --noEmit && npx eslint --ext ts,tsx --report-unused-disable-directives --max-warnings 0 src/routes/agentMarketplaceAdmin.ts src/server.ts`
Expected: PASS + clean.

- [ ] **Step 6: Commit**

```bash
git add enterprise_server/src/routes/agentMarketplaceAdmin.ts enterprise_server/src/server.ts enterprise_server/tests/routes/agentMarketplaceAdmin.test.ts
git commit -m "feat(enterprise_server): add agent marketplace admin CRUD and references route

POST/PUT/DELETE /api/admin/agent-marketplace/agents plus a references
endpoint that returns the agents currently pointing at this id in
their subagent_allow_agent_ids. Delete clears references via the
Postgres JSONB '-' operator and emits two audit events
(agent_update for the rehome + agent_delete)."
```

---

### Task 4: SPA — permission mirror + i18n keys for the agentmgmt page

**Files:**
- Modify: `enterprise_server/web/src/shared/permissions.ts:7-18`
- Modify: `enterprise_server/web/src/i18n.ts` (en + zh)
- Test: `enterprise_server/web/tests/shared/permissions.test.ts` (create or extend)

**Interfaces:**
- Consumes: server `PermissionCode.AgentsManage` (Task 1).
- Produces: SPA `PermissionCode.AgentsManage === 'agents.manage'`; new i18n keys `roles.perm.agents.manage` / `roles.permDesc.agents.manage`; new `nav.agents` + `agentmgmt.*` page strings (en + zh) covering: title, breadcrumb, add, search, count, enabled/disabled, create form fields (name, desc, identity, system_prompt, model, thinking_level, icon, allowed_roles, skill selector, subagent selector), references warning, delete confirm, refresh empty, allowed-roles picker label.

- [ ] **Step 1: Write the failing mirror test**

Create `enterprise_server/web/tests/shared/permissions.test.ts`:

```ts
import { describe, expect, test } from 'vitest';
import { PermissionCode, PERMISSIONS } from '../../src/shared/permissions';

describe('permissions mirror', () => {
  test('agents.manage is mirrored', () => {
    expect(PermissionCode.AgentsManage).toBe('agents.manage');
    expect((PERMISSIONS as string[])).toContain('agents.manage');
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd enterprise_server/web && npx vitest run tests/shared/permissions.test.ts`
Expected: FAIL — `AgentsManage` undefined.

- [ ] **Step 3: Add `AgentsManage` to the SPA mirror**

In `enterprise_server/web/src/shared/permissions.ts`, after `McpManage: 'mcp.manage',` add:
```ts
  AgentsManage: 'agents.manage',
```

- [ ] **Step 4: Add the i18n keys (en + zh)**

In `enterprise_server/web/src/i18n.ts`:

en — add to the `en` block (after the existing `'roles.perm.mcp.manage': 'Manage MCP'` line):
```ts
  'roles.perm.agents.manage': 'Manage agents',
  'roles.permDesc.agents.manage': 'Manage enterprise agent templates: create, edit, delete, and set allowed roles.',
  'nav.agents': 'Agent management',
  'agentmgmt.title': 'Agent management',
  'agentmgmt.breadcrumb': 'Agents',
  'agentmgmt.search': 'Search agents',
  'agentmgmt.count': 'Total {n} agents',
  'agentmgmt.empty': 'No agents yet. Click "+ Add agent" to create one.',
  'agentmgmt.enabled': 'Enabled',
  'agentmgmt.disabled': 'Disabled',
  'agentmgmt.addAgent': '+ Add agent',
  'agentmgmt.create.title': 'New agent',
  'agentmgmt.name': 'Name',
  'agentmgmt.desc': 'Description',
  'agentmgmt.identity': 'Identity (markdown)',
  'agentmgmt.systemPrompt': 'System prompt (markdown)',
  'agentmgmt.model': 'Model',
  'agentmgmt.thinkingLevel': 'Thinking level',
  'agentmgmt.icon': 'Icon URL',
  'agentmgmt.allowedRoles': 'Allowed roles',
  'agentmgmt.skillIds': 'Skills',
  'agentmgmt.subagentAllowAgentIds': 'Subagent allow-list',
  'agentmgmt.references.title': 'Reference check',
  'agentmgmt.references.body': '{n} other agents reference this one. Deleting will clear those references.',
  'agentmgmt.delete.confirm': 'Delete "{name}"?',
  'agentmgmt.refresh': 'Refresh',
  'agentmgmt.fetchRoles': 'Failed to load role vocabulary',
  'agentmgmt.unknownSkill': 'Unknown or disabled skill: {id}',
  'agentmgmt.unknownSubagent': 'Unknown subagent: {id}',
```

zh — add to the `zh` block (mirror values, single-line per key):
```ts
  'roles.perm.agents.manage': '智能体管理',
  'roles.permDesc.agents.manage': '管理企业智能体模板：新增、编辑、删除及设置可用角色。',
  'nav.agents': '智能体管理',
  'agentmgmt.title': '智能体管理',
  'agentmgmt.breadcrumb': '智能体',
  'agentmgmt.search': '搜索智能体',
  'agentmgmt.count': '共 {n} 个智能体',
  'agentmgmt.empty': '暂无智能体，点击右上角「+ 新增智能体」创建。',
  'agentmgmt.enabled': '启用',
  'agentmgmt.disabled': '停用',
  'agentmgmt.addAgent': '+ 新增智能体',
  'agentmgmt.create.title': '新增智能体',
  'agentmgmt.name': '名称',
  'agentmgmt.desc': '描述',
  'agentmgmt.identity': '身份（Markdown）',
  'agentmgmt.systemPrompt': '系统提示词（Markdown）',
  'agentmgmt.model': '模型',
  'agentmgmt.thinkingLevel': '思考等级',
  'agentmgmt.icon': '图标 URL',
  'agentmgmt.allowedRoles': '可用角色',
  'agentmgmt.skillIds': '技能',
  'agentmgmt.subagentAllowAgentIds': '允许的子智能体',
  'agentmgmt.references.title': '引用检查',
  'agentmgmt.references.body': '有 {n} 个其他智能体引用了此智能体。删除后这些引用将被清除。',
  'agentmgmt.delete.confirm': '删除「{name}」？',
  'agentmgmt.refresh': '刷新',
  'agentmgmt.fetchRoles': '加载角色选项失败',
  'agentmgmt.unknownSkill': '未知或已禁用的技能：{id}',
  'agentmgmt.unknownSubagent': '未知的子智能体：{id}',
```

- [ ] **Step 5: Run the test + lint**

Run: `cd enterprise_server/web && npx vitest run tests/shared/permissions.test.ts && npx eslint --ext ts,tsx --report-unused-disable-directives --max-warnings 0 src/shared/permissions.ts src/i18n.ts`
Expected: PASS + clean.

- [ ] **Step 6: Commit**

```bash
git add enterprise_server/web/src/shared/permissions.ts enterprise_server/web/src/i18n.ts enterprise_server/web/tests/shared/permissions.test.ts
git commit -m "feat(enterprise_server/web): mirror agents.manage permission and add agentmgmt i18n"
```

---

### Task 5: SPA — API client + role-options helper

**Files:**
- Create: `enterprise_server/web/src/api/agentMarketplace.ts`
- Test: `enterprise_server/web/tests/api/agentMarketplace.test.ts` (create)

**Interfaces:**
- Consumes: `apiClient` (existing); the server routes (Tasks 2, 3); `useAuthStore`.
- Produces: `agentMarketplaceApi` (listAgents, listRoleOptions, createAgent, updateAgent, deleteAgent, getReferences, listSkillsForPicker, listAgentsForPicker).

- [ ] **Step 1: Write the failing API test**

Create `enterprise_server/web/tests/api/agentMarketplace.test.ts`:

```ts
import { beforeEach, describe, expect, test, vi } from 'vitest';
const fetchMock = vi.fn();
(globalThis as unknown as { fetch: unknown }).fetch = fetchMock;

import { apiClient } from '../../src/api/client';
import { agentMarketplaceApi } from '../../src/api/agentMarketplace';

beforeEach(() => {
  fetchMock.mockReset();
  apiClient.setBaseUrl('http://server');
  apiClient.setTokenProvider(() => 'tok');
});

describe('agentMarketplaceApi', () => {
  test('listRoleOptions hits the picker route', async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ roles: ['super_admin', 'org_admin', 'agent_admin'] }), { status: 200 }));
    const res = await agentMarketplaceApi.listRoleOptions();
    expect(res.roles).toContain('agent_admin');
    expect(String(fetchMock.mock.calls[0][0])).toBe('http://server/api/agent-marketplace/role-options');
  });

  test('createAgent posts the body with required allowed_roles', async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ agent_id: 'agent_1' }), { status: 200 }));
    const out = await agentMarketplaceApi.createAgent({ name: 'X', allowed_roles: ['org_admin'] });
    expect(out.agent_id).toBe('agent_1');
    const init = fetchMock.mock.calls[0][1] as RequestInit;
    const body = JSON.parse(init.body as string);
    expect(body).toMatchObject({ name: 'X', allowed_roles: ['org_admin'] });
  });

  test('getReferences returns the affected agents', async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ ids: ['b'], names: ['B'] }), { status: 200 }));
    const out = await agentMarketplaceApi.getReferences('a');
    expect(out.ids).toEqual(['b']);
    expect(String(fetchMock.mock.calls[0][0])).toBe('http://server/api/admin/agent-marketplace/agents/a/references');
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd enterprise_server/web && npx vitest run tests/api/agentMarketplace.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the API client**

Create `enterprise_server/web/src/api/agentMarketplace.ts`:

```ts
import { apiClient } from './client';

export interface AgentMarketplaceItem {
  agentId: string;
  name: string;
  description: string;
  identity: string;
  systemPrompt: string;
  model: string;
  thinkingLevel: string;
  icon: string;
  skillIds: string[];
  subagentAllowAgentIds: string[];
  allowedRoles: string[];
  enabled: boolean;
}

export interface AgentInput {
  name: string;
  description?: string;
  identity?: string;
  system_prompt?: string;
  model?: string;
  thinking_level?: string;
  icon?: string;
  skill_ids?: string[];
  subagent_allow_agent_ids?: string[];
  allowed_roles: string[];
}

export interface AgentPatch extends Partial<AgentInput> {}

export const agentMarketplaceApi = {
  // Public (role-filtered) catalog — used by the agent picker on cross-references.
  listPublic: () => apiClient.get<{ agents: AgentMarketplaceItem[] }>('/api/agent-marketplace'),
  listRoleOptions: () => apiClient.get<{ roles: string[] }>('/api/agent-marketplace/role-options'),

  // Admin CRUD
  list: () => apiClient.get<AgentMarketplaceItem[]>('/api/admin/agent-marketplace/agents'),
  createAgent: (input: AgentInput) =>
    apiClient.post<{ agent_id: string }>('/api/admin/agent-marketplace/agents', input),
  update: (id: string, patch: AgentPatch) =>
    apiClient.put<void>(`/api/admin/agent-marketplace/agents/${id}`, patch),
  remove: (id: string) => apiClient.delete(`/api/admin/agent-marketplace/agents/${id}`),
  getReferences: (id: string) =>
    apiClient.get<{ ids: string[]; names: string[] }>(`/api/admin/agent-marketplace/agents/${id}/references`),

  // Cross-pickers (reuse the existing skill marketplace admin list)
  listSkillsForPicker: () =>
    apiClient.get<Array<{ id: string; name: string; name_zh: string | null }>>('/api/admin/skill-marketplace/skills'),
};
```

- [ ] **Step 4: Run the test + lint**

Run: `cd enterprise_server/web && npx vitest run tests/api/agentMarketplace.test.ts && npx eslint --ext ts,tsx --report-unused-disable-directives --max-warnings 0 src/api/agentMarketplace.ts`
Expected: PASS + clean.

- [ ] **Step 5: Commit**

```bash
git add enterprise_server/web/src/api/agentMarketplace.ts enterprise_server/web/tests/api/agentMarketplace.test.ts
git commit -m "feat(enterprise_server/web): add agent marketplace API client"
```

---

### Task 6: SPA — AgentManagePage + sidebar nav + route wiring

**Files:**
- Create: `enterprise_server/web/src/pages/AgentManagePage.tsx`
- Create: `enterprise_server/web/src/pages/agentManage/AgentCardGrid.tsx`
- Create: `enterprise_server/web/src/pages/agentManage/CreateAgentForm.tsx`
- Create: `enterprise_server/web/src/pages/agentManage/DetailDrawer.tsx`
- Create: `enterprise_server/web/src/pages/agentManage/types.ts`
- Modify: `enterprise_server/web/src/App.tsx` (route)
- Modify: `enterprise_server/web/src/components/Sidebar.tsx` (nav entry)
- Test: `enterprise_server/web/tests/pages/AgentManagePage.test.tsx` (create)

**Interfaces:**
- Consumes: `agentMarketplaceApi` (Task 5), `agentmgmt.*` i18n (Task 4), `useAuthStore`, `ConfirmDialog`.
- Produces: full admin UI — flat card list with name/desc/icon/model/allowed-role count/enabled toggle/edit/delete; create form with all CRUD fields and the role-options picker; detail drawer with enabled toggle, allowed-roles editor, references check before delete; sidebar entry "智能体管理" gated on `requires: 'agent_admin'`.

- [ ] **Step 1: Write the failing page test**

Create `enterprise_server/web/tests/pages/AgentManagePage.test.tsx`:

```tsx
import { beforeEach, describe, expect, test, vi } from 'vitest';
const fetchMock = vi.fn();
(globalThis as unknown as { fetch: unknown }).fetch = fetchMock;

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

import { useAuthStore } from '../../src/auth/store';
import { AgentManagePage } from '../../src/pages/AgentManagePage';

function seedFetch(): void {
  fetchMock.mockImplementation(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes('/role-options')) return new Response(JSON.stringify({ roles: ['super_admin', 'org_admin', 'agent_admin', 'policy_admin'] }), { status: 200 });
    if (url.includes('/admin/agent-marketplace/agents')) return new Response(JSON.stringify([]), { status: 200 });
    if (url.includes('/admin/skill-marketplace/skills')) return new Response(JSON.stringify([]), { status: 200 });
    return new Response('{}', { status: 200 });
  });
}

function renderPage(): void {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(<QueryClientProvider client={qc}><MemoryRouter><AgentManagePage /></MemoryRouter></QueryClientProvider>);
}

describe('AgentManagePage', () => {
  beforeEach(() => {
    fetchMock.mockReset();
    useAuthStore.setState({ token: 'jwt', claims: { sub: 'a', orgId: 'o1', roles: ['agent_admin'] } });
    seedFetch();
  });

  test('renders the agentmgmt title and the empty state', async () => {
    renderPage();
    expect(await screen.findByText('智能体管理')).toBeInTheDocument();
    expect(await screen.findByText(/暂无智能体/)).toBeInTheDocument();
  });

  test('+ add button opens the create form', async () => {
    renderPage();
    const addBtn = await screen.findByRole('button', { name: /新增智能体/ });
    fireEvent.click(addBtn);
    expect(await screen.findByText(/新增智能体/)).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd enterprise_server/web && npx vitest run tests/pages/AgentManagePage.test.tsx`
Expected: FAIL — module not found.

- [ ] **Step 3: Create the page-local types**

Create `enterprise_server/web/src/pages/agentManage/types.ts`:

```ts
import { t } from '../../i18n';
export function fill(s: string, kv: Record<string, string | number>): string {
  return Object.entries(kv).reduce((a, [k, v]) => a.split(`{${k}}`).join(String(v)), s);
}
export { t };
```

- [ ] **Step 4: Create `AgentCardGrid`, `CreateAgentForm`, `DetailDrawer`**

`enterprise_server/web/src/pages/agentManage/AgentCardGrid.tsx` — flat grid (no category sidebar per spec):
```tsx
import type { AgentMarketplaceItem } from '../../api/agentMarketplace';
import { t } from './types';

interface Props {
  agents: AgentMarketplaceItem[];
  search: string;
  onAdd: () => void;
  onOpen: (agent: AgentMarketplaceItem) => void;
}

export function AgentCardGrid({ agents, search, onAdd, onOpen }: Props): JSX.Element {
  const filtered = agents.filter(a =>
    !search || a.name.toLowerCase().includes(search.toLowerCase())
    || a.description.toLowerCase().includes(search.toLowerCase()));
  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-between gap-3">
        <input
          aria-label={t('agentmgmt.search')}
          className="h-9 px-3 rounded-lg border border-border bg-surface text-sm w-72"
          placeholder={t('agentmgmt.search')}
        />
        <button
          type="button"
          onClick={onAdd}
          className="h-9 px-4 text-sm rounded-lg bg-primary text-white"
        >
          {t('agentmgmt.addAgent')}
        </button>
      </div>
      <div className="text-sm text-muted">{t('agentmgmt.count').replace('{n}', String(filtered.length))}</div>
      {filtered.length === 0 ? (
        <div className="rounded-lg border border-dashed border-border p-10 text-center text-sm text-muted">
          {t('agentmgmt.empty')}
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3">
          {filtered.map(a => (
            <button
              key={a.agentId}
              type="button"
              onClick={() => onOpen(a)}
              className="rounded-lg border border-border bg-surface p-4 text-left hover:border-primary"
            >
              <div className="flex items-center gap-2">
                {a.icon ? <img src={a.icon} alt="" className="h-6 w-6 rounded" /> : null}
                <div className="font-medium text-sm">{a.name}</div>
                <span className={`ml-auto text-xs ${a.enabled ? 'text-emerald-500' : 'text-muted'}`}>
                  {a.enabled ? t('agentmgmt.enabled') : t('agentmgmt.disabled')}
                </span>
              </div>
              <div className="mt-1 text-xs text-muted line-clamp-2">{a.description}</div>
              <div className="mt-2 flex flex-wrap gap-1">
                {a.allowedRoles.slice(0, 3).map(r => (
                  <span key={r} className="px-1.5 py-0.5 text-xs rounded bg-surface-hover border border-border">{r}</span>
                ))}
                {a.allowedRoles.length > 3 ? <span className="text-xs text-muted">+{a.allowedRoles.length - 3}</span> : null}
              </div>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
```

`enterprise_server/web/src/pages/agentManage/CreateAgentForm.tsx`:
```tsx
import { useEffect, useMemo, useState } from 'react';
import { agentMarketplaceApi, type AgentInput, type AgentMarketplaceItem } from '../../api/agentMarketplace';
import { t } from './types';

interface Props {
  availableSkills: Array<{ id: string; name: string; name_zh: string | null }>;
  availableAgents: AgentMarketplaceItem[];
  roleOptions: string[];
  onSubmit: (input: AgentInput) => Promise<void>;
  onCancel: () => void;
}

export function CreateAgentForm({ availableSkills, availableAgents, roleOptions, onSubmit, onCancel }: Props): JSX.Element {
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [identity, setIdentity] = useState('');
  const [systemPrompt, setSystemPrompt] = useState('');
  const [model, setModel] = useState('');
  const [thinkingLevel, setThinkingLevel] = useState('');
  const [icon, setIcon] = useState('');
  const [skillIds, setSkillIds] = useState<string[]>([]);
  const [subagentAllowAgentIds, setSubagentAllowAgentIds] = useState<string[]>([]);
  const [allowedRoles, setAllowedRoles] = useState<string[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const valid = useMemo(() =>
    name.trim().length > 0 && allowedRoles.length > 0, [name, allowedRoles]);

  const submit = async (): Promise<void> => {
    if (!valid) return;
    setSubmitting(true);
    setErr(null);
    try {
      await onSubmit({
        name: name.trim(),
        description, identity, system_prompt: systemPrompt,
        model, thinking_level: thinkingLevel, icon,
        skill_ids: skillIds, subagent_allow_agent_ids: subagentAllowAgentIds,
        allowed_roles: allowedRoles,
      });
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="flex flex-col gap-3">
      <h2 className="text-base font-semibold">{t('agentmgmt.create.title')}</h2>
      {err ? <div className="text-xs text-red-500">{err}</div> : null}
      <Field label={t('agentmgmt.name')} value={name} onChange={setName} required />
      <Field label={t('agentmgmt.desc')} value={description} onChange={setDescription} multiline />
      <Field label={t('agentmgmt.identity')} value={identity} onChange={setIdentity} multiline />
      <Field label={t('agentmgmt.systemPrompt')} value={systemPrompt} onChange={setSystemPrompt} multiline />
      <div className="grid grid-cols-2 gap-3">
        <Field label={t('agentmgmt.model')} value={model} onChange={setModel} placeholder="providerId/modelId" />
        <Field label={t('agentmgmt.thinkingLevel')} value={thinkingLevel} onChange={setThinkingLevel} />
      </div>
      <Field label={t('agentmgmt.icon')} value={icon} onChange={setIcon} />
      <MultiChips label={t('agentmgmt.allowedRoles')} options={roleOptions} value={allowedRoles} onChange={setAllowedRoles} required />
      <MultiChips label={t('agentmgmt.skillIds')} options={availableSkills.map(s => s.id)} value={skillIds} onChange={setSkillIds} />
      <MultiChips label={t('agentmgmt.subagentAllowAgentIds')} options={availableAgents.map(a => a.agentId)} value={subagentAllowAgentIds} onChange={setSubagentAllowAgentIds} />
      <div className="mt-2 flex justify-end gap-2">
        <button type="button" className="h-9 px-3 rounded-lg border border-border text-sm" onClick={onCancel}>{t('cancel')}</button>
        <button type="button" className="h-9 px-4 rounded-lg bg-primary text-white text-sm disabled:opacity-50"
                disabled={!valid || submitting} onClick={submit}>
          {submitting ? '…' : t('create')}
        </button>
      </div>
    </div>
  );
}

function Field({ label, value, onChange, required, multiline, placeholder }:
  { label: string; value: string; onChange: (v: string) => void; required?: boolean; multiline?: boolean; placeholder?: string }): JSX.Element {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-xs text-muted">{label}{required ? ' *' : ''}</span>
      {multiline ? (
        <textarea className="min-h-20 px-3 py-2 rounded-lg border border-border bg-surface text-sm" value={value} onChange={e => onChange(e.target.value)} />
      ) : (
        <input className="h-9 px-3 rounded-lg border border-border bg-surface text-sm" value={value} placeholder={placeholder ?? ''}
               onChange={e => onChange(e.target.value)} />
      )}
    </label>
  );
}

function MultiChips({ label, options, value, onChange, required }:
  { label: string; options: string[]; value: string[]; onChange: (v: string[]) => void; required?: boolean }): JSX.Element {
  const toggle = (id: string): void => {
    onChange(value.includes(id) ? value.filter(x => x !== id) : [...value, id]);
  };
  return (
    <div className="flex flex-col gap-1">
      <span className="text-xs text-muted">{label}{required ? ' *' : ''}</span>
      <div className="flex flex-wrap gap-1">
        {options.map(opt => {
          const on = value.includes(opt);
          return (
            <button type="button" key={opt}
                    onClick={() => toggle(opt)}
                    className={`px-2 py-1 text-xs rounded border ${on ? 'border-primary bg-primary/10 text-primary' : 'border-border'}`}>
              {opt}
            </button>
          );
        })}
      </div>
    </div>
  );
}
```

`enterprise_server/web/src/pages/agentManage/DetailDrawer.tsx`:
```tsx
import { useState } from 'react';
import { agentMarketplaceApi, type AgentMarketplaceItem } from '../../api/agentMarketplace';
import { ConfirmDialog } from '../../../components/ConfirmDialog';
import { t, fill } from './types';

interface Props {
  agent: AgentMarketplaceItem;
  roleOptions: string[];
  availableSkills: Array<{ id: string; name: string; name_zh: string | null }>;
  availableAgents: AgentMarketplaceItem[];
  onSaved: () => void;
  onDeleted: () => void;
  onClose: () => void;
}

export function DetailDrawer({ agent, roleOptions, availableSkills, availableAgents, onSaved, onDeleted, onClose }: Props): JSX.Element {
  const [enabled, setEnabled] = useState(agent.enabled);
  const [allowedRoles, setAllowedRoles] = useState<string[]>(agent.allowedRoles);
  const [saving, setSaving] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState<null | { refs: string[] }>(null);

  const save = async (): Promise<void> => {
    setSaving(true);
    try {
      await agentMarketplaceApi.update(agent.agentId, {
        enabled,
        allowed_roles: allowedRoles,
      });
      onSaved();
    } finally {
      setSaving(false);
    }
  };

  const checkRefsAndConfirm = async (): Promise<void> => {
    const refs = await agentMarketplaceApi.getReferences(agent.agentId);
    setConfirmDelete(refs);
  };

  const doDelete = async (): Promise<void> => {
    await agentMarketplaceApi.remove(agent.agentId);
    onDeleted();
  };

  return (
    <div className="fixed inset-y-0 right-0 w-[480px] max-w-full bg-surface border-l border-border z-40 flex flex-col">
      <div className="flex items-center justify-between p-4 border-b border-border">
        <div className="flex items-center gap-2">
          {agent.icon ? <img src={agent.icon} className="h-6 w-6 rounded" alt="" /> : null}
          <div className="font-medium">{agent.name}</div>
        </div>
        <button type="button" onClick={onClose} className="h-8 px-2 text-sm">×</button>
      </div>
      <div className="flex-1 overflow-y-auto p-4 flex flex-col gap-3">
        <div className="flex items-center gap-2">
          <label className="text-xs text-muted">{t('agentmgmt.enabled')}</label>
          <input type="checkbox" checked={enabled} onChange={e => setEnabled(e.target.checked)} />
        </div>
        <div className="text-xs text-muted">{t('agentmgmt.allowedRoles')}</div>
        <div className="flex flex-wrap gap-1">
          {roleOptions.map(r => (
            <button key={r} type="button"
                    onClick={() => setAllowedRoles(prev => prev.includes(r) ? prev.filter(x => x !== r) : [...prev, r])}
                    className={`px-2 py-1 text-xs rounded border ${allowedRoles.includes(r) ? 'border-primary bg-primary/10 text-primary' : 'border-border'}`}>
              {r}
            </button>
          ))}
        </div>
        <div className="text-xs text-muted mt-2">{t('agentmgmt.skillIds')}</div>
        <div className="text-xs">{agent.skillIds.length === 0 ? '—' : agent.skillIds.join(', ')}</div>
        <div className="text-xs text-muted mt-2">{t('agentmgmt.subagentAllowAgentIds')}</div>
        <div className="text-xs">{agent.subagentAllowAgentIds.length === 0 ? '—' : agent.subagentAllowAgentIds.join(', ')}</div>
      </div>
      <div className="flex items-center justify-between p-3 border-t border-border">
        <button type="button" className="h-9 px-3 text-sm text-red-500"
                onClick={checkRefsAndConfirm}>
          {t('delete')}
        </button>
        <div className="flex gap-2">
          <button type="button" className="h-9 px-3 text-sm rounded-lg border border-border" onClick={onClose}>{t('cancel')}</button>
          <button type="button" className="h-9 px-4 text-sm rounded-lg bg-primary text-white disabled:opacity-50"
                  disabled={saving} onClick={save}>
            {saving ? '…' : t('save')}
          </button>
        </div>
      </div>
      {confirmDelete ? (
        <ConfirmDialog
          variant="delete"
          title={t('agentmgmt.references.title')}
          message={confirmDelete.refs.length > 0
            ? fill(t('agentmgmt.references.body'), { n: confirmDelete.refs.length })
            : fill(t('agentmgmt.delete.confirm'), { name: agent.name })}
          cancelLabel={t('cancel')}
          confirmLabel={t('delete')}
          onCancel={() => setConfirmDelete(null)}
          onConfirm={doDelete}
        />
      ) : null}
    </div>
  );
}
```

- [ ] **Step 5: Create the page**

Create `enterprise_server/web/src/pages/AgentManagePage.tsx`:

```tsx
import { useEffect, useMemo, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { agentMarketplaceApi, type AgentMarketplaceItem, type AgentInput } from '../api/agentMarketplace';
import { AgentCardGrid } from './agentManage/AgentCardGrid';
import { CreateAgentForm } from './agentManage/CreateAgentForm';
import { DetailDrawer } from './agentManage/DetailDrawer';
import { t } from './agentManage/types';

export function AgentManagePage(): JSX.Element {
  const qc = useQueryClient();
  const [view, setView] = useState<'list' | 'create'>('list');
  const [open, setOpen] = useState<AgentMarketplaceItem | null>(null);
  const [search, setSearch] = useState('');

  const agentsQuery = useQuery({ queryKey: ['agent-marketplace', 'admin'],
    queryFn: () => agentMarketplaceApi.list() });
  const skillsQuery = useQuery({ queryKey: ['agent-marketplace', 'skills-picker'],
    queryFn: () => agentMarketplaceApi.listSkillsForPicker() });
  const rolesQuery = useQuery({ queryKey: ['agent-marketplace', 'role-options'],
    queryFn: () => agentMarketplaceApi.listRoleOptions() });

  const refreshAll = (): void => {
    void qc.invalidateQueries({ queryKey: ['agent-marketplace'] });
  };

  const createAgent = async (input: AgentInput): Promise<void> => {
    const out = await agentMarketplaceApi.createAgent(input);
    refreshAll();
    // After create, open the new agent in the drawer so the admin can adjust enabled + roles.
    setView('list');
    setOpen({ agentId: out.agent_id, name: input.name,
      description: input.description ?? '', identity: input.identity ?? '',
      systemPrompt: input.system_prompt ?? '', model: input.model ?? '',
      thinkingLevel: input.thinking_level ?? '', icon: input.icon ?? '',
      skillIds: input.skill_ids ?? [], subagentAllowAgentIds: input.subagent_allow_agent_ids ?? [],
      allowedRoles: input.allowed_roles, enabled: true });
  };

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between">
        <h1 className="text-lg font-semibold">{t('agentmgmt.title')}</h1>
        <button type="button" onClick={refreshAll} className="h-9 px-3 text-sm rounded-lg border border-border">
          {t('agentmgmt.refresh')}
        </button>
      </div>
      {view === 'create' ? (
        <CreateAgentForm
          availableSkills={skillsQuery.data ?? []}
          availableAgents={agentsQuery.data ?? []}
          roleOptions={rolesQuery.data?.roles ?? []}
          onSubmit={createAgent}
          onCancel={() => setView('list')}
        />
      ) : (
        <AgentCardGrid
          agents={agentsQuery.data ?? []}
          search={search}
          onAdd={() => setView('create')}
          onOpen={(a) => setOpen(a)}
        />
      )}
      {open ? (
        <DetailDrawer
          agent={open}
          roleOptions={rolesQuery.data?.roles ?? []}
          availableSkills={skillsQuery.data ?? []}
          availableAgents={agentsQuery.data ?? []}
          onSaved={() => { setOpen(null); refreshAll(); }}
          onDeleted={() => { setOpen(null); refreshAll(); }}
          onClose={() => setOpen(null)}
        />
      ) : null}
    </div>
  );
}
```

- [ ] **Step 6: Wire the route + sidebar**

In `enterprise_server/web/src/App.tsx`, after the existing `import { SkillManagePage }` add:
```tsx
import { AgentManagePage } from './pages/AgentManagePage';
```
Replace the `path="/config/skill"` block's content with the same Shell + AuthGuard pattern but pointed at the new page — add a new route after it:
```tsx
          <Route
            path="/config/agents"
            element={
              <AuthGuard requires="agent_admin">
                <Shell><AgentManagePage /></Shell>
              </AuthGuard>
            }
          />
```

In `enterprise_server/web/src/components/Sidebar.tsx`, after the `nav.skill` item add:
```tsx
  { to: '/config/agents', label: t('nav.agents'), icon: <Bot />, section: 'config', requires: 'agent_admin' },
```
(If `Bot` is not imported, add it to the lucide-react import at the top.)

- [ ] **Step 7: Run the test + typecheck + lint**

Run: `cd enterprise_server/web && npx vitest run tests/pages/AgentManagePage.test.tsx && npx tsc --noEmit && npx eslint --ext ts,tsx --report-unused-disable-directives --max-warnings 0 src/pages/AgentManagePage.tsx src/pages/agentManage/ src/App.tsx src/components/Sidebar.tsx`
Expected: PASS + clean.

- [ ] **Step 8: Commit**

```bash
git add -A enterprise_server/web/src/pages enterprise_server/web/src/App.tsx enterprise_server/web/src/components/Sidebar.tsx enterprise_server/web/tests/pages/AgentManagePage.test.tsx
git commit -m "feat(enterprise_server/web): add agent management admin page and sidebar entry

Flat card list (no category sidebar), create form with role-options
picker and skill/subagent multi-selects, detail drawer with references
check before delete. Sidebar entry '智能体管理' gated on agent_admin."
```

---

### Task 7: Desktop — schema + types + `mapAgentRow` for `enterprise_agent_id`

**Files:**
- Modify: `src/main/sqliteStore.ts:657-685` (agents migration block)
- Modify: `src/main/genworkStore.ts:400,402-422,3170-3235,3418-3470`
- Modify: `src/renderer/types/agent.ts:3-22`
- Modify: `src/renderer/types/electron.d.ts:644-660`
- Test: append to `src/main/gworkStore.test.ts` (uses `:memory:` + the existing `setupDb()` DDL)

**Interfaces:**
- Produces: agents table has `enterprise_agent_id TEXT` column (idempotent `PRAGMA table_info` + ALTER); `AgentSource = 'custom' | 'preset' | 'enterprise'`; `Agent.enterpriseAgentId?: string`; `AgentSummary.enterpriseAgentId?: string`; `mapAgentRow` carries the column through to `enterpriseAgentId` (null → undefined); `window.electron.agents.list/get` return types include `enterpriseAgentId?: string`; preload contract unchanged (`source?: string` already accepts the new value).

- [ ] **Step 1: Append the failing store test**

Append to `src/main/gworkStore.test.ts` (the file's existing `setupDb()` creates the agents table; add a new test that calls `store.createAgent` with `source: 'enterprise'`, retrieves via `getAgent`, and asserts `enterpriseAgentId` round-trips. The test DDL must be extended to include the new column since `setupDb()` builds a minimal schema):

```ts
test('createAgent stores enterprise_agent_id when source is enterprise', () => {
  // extend the local DDL to mimic production
  db.exec(`ALTER TABLE agents ADD COLUMN enterprise_agent_id TEXT;`);
  const created = store.createAgent({
    name: 'Enterprise One', source: 'enterprise', enterpriseAgentId: 'agent_a1',
  });
  expect(created.source).toBe('enterprise');
  expect(created.enterpriseAgentId).toBe('agent_a1');
  const fetched = store.getAgent(created.id);
  expect(fetched?.enterpriseAgentId).toBe('agent_a1');
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/main/gworkStore.test.ts`
Expected: FAIL — `enterpriseAgentId` not on `CreateAgentRequest` / `Agent`.

- [ ] **Step 3: Extend the SQLite schema migration**

In `src/main/sqliteStore.ts`, after the `if (!agentColNames.includes('subagent_allow_agent_ids'))` block (around line 681), add:

```ts
      if (!agentColNames.includes('enterprise_agent_id')) {
        this.db.exec('ALTER TABLE agents ADD COLUMN enterprise_agent_id TEXT;');
        this.didRunMigration = true;
      }
```

- [ ] **Step 4: Extend `AgentSource` + `Agent` + `CreateAgentRequest`**

In `src/main/genworkStore.ts`:

- Change line 400: `export type AgentSource = 'custom' | 'preset';` → `export type AgentSource = 'custom' | 'preset' | 'enterprise';`
- In the `Agent` interface (lines 402-422) add after `source: AgentSource;`:
  ```ts
    enterpriseAgentId?: string;
  ```
- In `CreateAgentRequest` (lines 425-439) add:
  ```ts
    enterpriseAgentId?: string;
  ```
- In the `AgentRow` interface inside `createAgent` (lines ~3206-3225) add `enterprise_agent_id?: string | null;`
- Update the `INSERT` (lines ~3254-3268) to include the new column + value:
  ```sql
  INSERT INTO agents (id, name, description, system_prompt, identity, model, thinking_level, working_directory, icon, skill_ids, subagent_allow_agent_ids, enabled, is_default, source, preset_id, enterprise_agent_id, sort_order, created_at, updated_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 0, ?, ?, ?, ?, ?, ?)
  ```
  And add `request.enterpriseAgentId ?? null` to the `run(...)` args.
- In `mapAgentRow` (lines 3420-3438) add `enterprise_agent_id?: string | null;` to the row type and add:
  ```ts
    enterpriseAgentId: row.enterprise_agent_id ?? undefined,
  ```

- [ ] **Step 5: Mirror the renderer-side types**

In `src/renderer/types/agent.ts`:
- Change line 3: `export type AgentSource = 'custom' | 'preset';` → `export type AgentSource = 'custom' | 'preset' | 'enterprise';`
- In the `Agent` interface (lines 5-26) add `enterpriseAgentId?: string;` after `source`.
- In `CreateAgentRequest` (lines 43-57) add `enterpriseAgentId?: string;`.

In `src/renderer/types/electron.d.ts:644-660`:
- After `source?: string;` in the `create:` payload type, add `enterpriseAgentId?: string;` (the `update:` block doesn't need it — the field is server-controlled, and the desktop never edits it).

- [ ] **Step 6: Run the test + typecheck + lint**

Run: `npx vitest run src/main/gworkStore.test.ts && npx tsc --noEmit && npx eslint --ext ts,tsx --report-unused-disable-directives --max-warnings 0 src/main/sqliteStore.ts src/main/genworkStore.ts src/renderer/types/agent.ts src/renderer/types/electron.d.ts`
Expected: PASS + clean.

- [ ] **Step 7: Commit**

```bash
git add src/main/sqliteStore.ts src/main/genworkStore.ts src/renderer/types/agent.ts src/renderer/types/electron.d.ts src/main/gworkStore.test.ts
git commit -m "feat(desktop): add enterprise_agent_id column and AgentSource='enterprise'

SQLite gets an idempotent ALTER for agents.enterprise_agent_id; Agent
and AgentSummary now carry enterpriseAgentId (optional). Renderer type
mirror keeps the existing preload signature; the new field is filled
only by the enterprise sync path (next task). Zero behavior change."
```

---

### Task 8: Desktop — `enterprise_agent_prefs` table + store

**Files:**
- Modify: `src/main/sqliteStore.ts` (after the agents migration block)
- Create: `src/main/libs/enterpriseAgentPrefsStore.ts`
- Test: `src/main/libs/enterpriseAgentPrefsStore.test.ts` (create)

**Interfaces:**
- Produces: table `enterprise_agent_prefs(enterprise_agent_id TEXT PK, working_directory TEXT DEFAULT '', updated_at INTEGER)`; store API `get(id)`, `upsert(id, workingDirectory)`, `remove(id)`; constructor takes the `better-sqlite3` `Database` instance (mirrors `libraryLocalStore` pattern at `src/main/library/libraryLocalStore.ts`).

- [ ] **Step 1: Append the schema migration**

In `src/main/sqliteStore.ts`, after the `enterprise_agent_id` ALTER block, add:

```ts
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS enterprise_agent_prefs (
        enterprise_agent_id TEXT PRIMARY KEY,
        working_directory TEXT NOT NULL DEFAULT '',
        updated_at INTEGER NOT NULL
      );
    `);
```

- [ ] **Step 2: Write the failing store test**

Create `src/main/libs/enterpriseAgentPrefsStore.test.ts`:

```ts
import BetterSqlite3 from 'better-sqlite3';
import { beforeEach, describe, expect, test } from 'vitest';
import { EnterpriseAgentPrefsStore } from './enterpriseAgentPrefsStore';

let db: BetterSqlite3.Database;
let store: EnterpriseAgentPrefsStore;

beforeEach(() => {
  db = new BetterSqlite3(':memory:');
  db.exec(`CREATE TABLE IF NOT EXISTS enterprise_agent_prefs (
    enterprise_agent_id TEXT PRIMARY KEY,
    working_directory TEXT NOT NULL DEFAULT '',
    updated_at INTEGER NOT NULL
  );`);
  store = new EnterpriseAgentPrefsStore(db);
});

describe('EnterpriseAgentPrefsStore', () => {
  test('upsert + get round-trip', () => {
    expect(store.get('a')).toBe('');
    store.upsert('a', '/tmp/work');
    expect(store.get('a')).toBe('/tmp/work');
  });

  test('remove deletes the row', () => {
    store.upsert('a', '/tmp/x');
    store.remove('a');
    expect(store.get('a')).toBe('');
  });

  test('upsert overwrites and updates updated_at', async () => {
    store.upsert('a', '/first');
    const first = db.prepare('SELECT updated_at AS u FROM enterprise_agent_prefs WHERE enterprise_agent_id = ?').get('a') as { u: number };
    await new Promise(r => setTimeout(r, 5));
    store.upsert('a', '/second');
    const second = db.prepare('SELECT working_directory AS wd FROM enterprise_agent_prefs WHERE enterprise_agent_id = ?').get('a') as { wd: string };
    expect(second.wd).toBe('/second');
    const row = db.prepare('SELECT updated_at AS u FROM enterprise_agent_prefs WHERE enterprise_agent_id = ?').get('a') as { u: number };
    expect(row.u).toBeGreaterThanOrEqual(first.u);
  });
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `npx vitest run src/main/libs/enterpriseAgentPrefsStore.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 4: Write the store**

Create `src/main/libs/enterpriseAgentPrefsStore.ts`:

```ts
import type Database from 'better-sqlite3';

export class EnterpriseAgentPrefsStore {
  constructor(private readonly db: Database.Database) {}

  get(enterpriseAgentId: string): string {
    const row = this.db
      .prepare('SELECT working_directory AS wd FROM enterprise_agent_prefs WHERE enterprise_agent_id = ?')
      .get(enterpriseAgentId) as { wd?: string } | undefined;
    return row?.wd ?? '';
  }

  upsert(enterpriseAgentId: string, workingDirectory: string): void {
    this.db.prepare(
      `INSERT INTO enterprise_agent_prefs (enterprise_agent_id, working_directory, updated_at)
       VALUES (?, ?, ?)
       ON CONFLICT(enterprise_agent_id) DO UPDATE SET
         working_directory = excluded.working_directory,
         updated_at = excluded.updated_at`,
    ).run(enterpriseAgentId, workingDirectory, Date.now());
  }

  remove(enterpriseAgentId: string): void {
    this.db.prepare('DELETE FROM enterprise_agent_prefs WHERE enterprise_agent_id = ?').run(enterpriseAgentId);
  }
}
```

- [ ] **Step 5: Run the test + lint**

Run: `npx vitest run src/main/libs/enterpriseAgentPrefsStore.test.ts && npx eslint --ext ts,tsx --report-unused-disable-directives --max-warnings 0 src/main/libs/enterpriseAgentPrefsStore.ts src/main/sqliteStore.ts`
Expected: PASS + clean.

- [ ] **Step 6: Commit**

```bash
git add src/main/sqliteStore.ts src/main/libs/enterpriseAgentPrefsStore.ts src/main/libs/enterpriseAgentPrefsStore.test.ts
git commit -m "feat(desktop): add enterprise_agent_prefs table and store

Per-agent working-directory preference for enterprise agents, persisted
locally in a separate table so the server schema and the desktop
mirrored row remain decoupled."
```

---

### Task 9: Desktop — `enterpriseClient.listEnterpriseAgents` + IPC handler

**Files:**
- Modify: `src/main/auth/enterpriseClient.ts` (add method)
- Modify: `src/shared/agent/constants.ts` (add channel)
- Create: `src/main/ipcHandlers/agents/handlers.enterprise.ts` (new file — Legacy Debt split)
- Modify: `src/main/ipcHandlers/agents/index.ts` (re-export)
- Modify: `src/main/ipcHandlers/agents/handlers.ts` (call the new file's register function inside `registerAgentHandlers`, OR leave the existing registration alone and wire `registerAgentEnterpriseHandlers` from `main.ts` — pick the second; see Step 4)
- Modify: `src/main/preload.ts` (add `agents.fetchEnterpriseAgents`)
- Test: `src/main/ipcHandlers/agents/handlers.enterprise.test.ts` (create)

**Interfaces:**
- Produces:
  - `enterpriseClient.listEnterpriseAgents(): Promise<EnterpriseAgentView[]>` (direct `fetch`, no `call()`, mirrors `listEnterpriseSkills`).
  - `AgentIpcChannel.FetchEnterpriseAgents = 'agents:fetchEnterpriseAgents'`.
  - `registerAgentEnterpriseHandlers(deps)` — gates on `loginGate.requireEnterprise()`; on HTTP failure returns `{ success: false }` **without** invoking sync; on success invokes `agentEnterpriseSync.syncFromServer` (Task 10) and returns `{ success: true, report }`.
  - `window.electron.agents.fetchEnterpriseAgents()` IPC bridge.

- [ ] **Step 1: Add the channel constant**

In `src/shared/agent/constants.ts`, after `AddPreset: 'agents:addPreset',` add:
```ts
  FetchEnterpriseAgents: 'agents:fetchEnterpriseAgents',
```

- [ ] **Step 2: Add `listEnterpriseAgents` to `enterpriseClient`**

In `src/main/auth/enterpriseClient.ts`, immediately after `listEnterpriseSkills` (which ends at line 379), add:

```ts
  /**
   * List the enterprise_server agent catalog scoped to the caller's role.
   * Mirrors `listEnterpriseSkills` / `listEnterpriseMcps`: direct fetch, explicit
   * inline return type (the method lives inside an object literal, so `this`
   * isn't the client type).
   */
  async listEnterpriseAgents(): Promise<Array<{
    agentId: string;
    name: string;
    description: string;
    identity: string;
    systemPrompt: string;
    model: string;
    thinkingLevel: string;
    icon: string;
    skillIds: string[];
    subagentAllowAgentIds: string[];
    allowedRoles: string[];
    enabled: boolean;
  }>> {
    const url = `${baseUrl}/api/agent-marketplace`;
    const token = tokenProvider();
    const headers = new Headers();
    headers.set('content-type', 'application/json');
    if (token) headers.set('authorization', `Bearer ${token}`);
    const res = await fetch(url, { headers });
    if (!res.ok) {
      throw new Error(`enterprise-agent-marketplace fetch failed: HTTP ${res.status}`);
    }
    const body = (await res.json()) as { agents: Array<Record<string, unknown>> };
    return body.agents.map((a) => ({
      agentId: String(a.agentId),
      name: String(a.name),
      description: String(a.description ?? ''),
      identity: String(a.identity ?? ''),
      systemPrompt: String(a.systemPrompt ?? ''),
      model: String(a.model ?? ''),
      thinkingLevel: String(a.thinkingLevel ?? ''),
      icon: String(a.icon ?? ''),
      skillIds: Array.isArray(a.skillIds) ? (a.skillIds as string[]) : [],
      subagentAllowAgentIds: Array.isArray(a.subagentAllowAgentIds) ? (a.subagentAllowAgentIds as string[]) : [],
      allowedRoles: Array.isArray(a.allowedRoles) ? (a.allowedRoles as string[]) : [],
      enabled: Boolean(a.enabled),
    }));
  },
```

- [ ] **Step 3: Write the failing handler test**

Create `src/main/ipcHandlers/agents/handlers.enterprise.test.ts` (the actual `syncFromServer` from Task 10 is mocked here, so this task can ship independently — Task 10 plugs the real function in):

```ts
import { describe, expect, test, vi } from 'vitest';

const { handlers } = vi.hoisted(() => ({
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
}));

vi.mock('electron', () => ({
  ipcMain: { handle: vi.fn((channel: string, fn: unknown) => { handlers.set(channel, fn); }) },
}));
vi.mock('../../auth/enterpriseClient', () => ({
  enterpriseClient: { listEnterpriseAgents: vi.fn() },
}));
vi.mock('../../auth/loginGate', () => ({
  loginGate: {
    requireEnterprise: vi.fn().mockReturnValue({ userId: 'u1', orgId: 'o1', jwt: 'tok', roles: ['user'] }),
  },
}));
vi.mock('../../libs/agentEnterpriseSync', () => ({
  agentEnterpriseSync: { syncFromServer: vi.fn().mockResolvedValue({ report: { upserted: 1, removed: 0, skipped: 0 } }) },
}));

import { enterpriseClient } from '../../auth/enterpriseClient';
import { loginGate } from '../../auth/loginGate';
import { agentEnterpriseSync } from '../../libs/agentEnterpriseSync';
import { AgentIpcChannel } from '../../../shared/agent/constants';
import { registerAgentEnterpriseHandlers } from './handlers.enterprise';

function deps(): Parameters<typeof registerAgentEnterpriseHandlers>[0] {
  return {
    getGenWorkStore: () => ({}) as never,
    getEnterpriseAgentPrefsStore: () => ({ remove: vi.fn() }) as never,
    getSkillManager: () => ({ getCatalogLocalId: (id: string) => id }) as never,
    getAvailableModelsRef: () => '',
  };
}

describe('agents:fetchEnterpriseAgents', () => {
  test('happy path invokes sync and returns report', async () => {
    vi.mocked(enterpriseClient.listEnterpriseAgents).mockResolvedValue([{
      agentId: 'agent_a1', name: 'Reviewer', description: 'd',
      identity: '', systemPrompt: '', model: '', thinkingLevel: '', icon: '',
      skillIds: [], subagentAllowAgentIds: [], allowedRoles: ['org_admin'], enabled: true,
    }]);
    registerAgentEnterpriseHandlers(deps());
    const out = await handlers.get(AgentIpcChannel.FetchEnterpriseAgents)!(undefined, undefined) as {
      success: boolean; report: { upserted: number };
    };
    expect(out.success).toBe(true);
    expect(out.report.upserted).toBe(1);
    expect(vi.mocked(agentEnterpriseSync.syncFromServer)).toHaveBeenCalledTimes(1);
  });

  test('HTTP failure returns success=false without invoking sync', async () => {
    vi.mocked(enterpriseClient.listEnterpriseAgents).mockRejectedValue(new Error('boom'));
    vi.mocked(agentEnterpriseSync.syncFromServer).mockClear();
    registerAgentEnterpriseHandlers(deps());
    const out = await handlers.get(AgentIpcChannel.FetchEnterpriseAgents)!(undefined, undefined) as { success: boolean };
    expect(out.success).toBe(false);
    expect(vi.mocked(agentEnterpriseSync.syncFromServer)).not.toHaveBeenCalled();
  });

  test('loginGate.requireEnterprise throws when not logged in', async () => {
    vi.mocked(loginGate.requireEnterprise).mockImplementationOnce(() => { throw new Error('not logged in'); });
    vi.mocked(enterpriseClient.listEnterpriseAgents).mockResolvedValue([]);
    registerAgentEnterpriseHandlers(deps());
    await expect(
      handlers.get(AgentIpcChannel.FetchEnterpriseAgents)!(undefined, undefined),
    ).rejects.toThrow('not logged in');
  });
});
```

- [ ] **Step 4: Run the test to verify it fails**

Run: `npx vitest run src/main/ipcHandlers/agents/handlers.enterprise.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 5: Write the new handler file (Legacy Debt split)**

Create `src/main/ipcHandlers/agents/handlers.enterprise.ts`:

```ts
import { ipcMain } from 'electron';

import { loginGate } from '../../auth/loginGate';
import { enterpriseClient } from '../../auth/enterpriseClient';
import { agentEnterpriseSync } from '../../libs/agentEnterpriseSync';
import type { EnterpriseAgentPrefsStore } from '../../libs/enterpriseAgentPrefsStore';
import type { GenWorkStore } from '../../genworkStore';
import type { SkillManager } from '../../skills/skillManager';
import { AgentIpcChannel } from '../../../shared/agent/constants';

export interface AgentEnterpriseHandlerDeps {
  getGenWorkStore: () => GenWorkStore;
  getEnterpriseAgentPrefsStore: () => EnterpriseAgentPrefsStore;
  getSkillManager: () => SkillManager;
  /** Returns the desktop default model ref (providerId/modelId), used when the
   *  server-supplied model isn't present in the local catalog. */
  getAvailableModelsRef: () => string;
}

export function registerAgentEnterpriseHandlers(deps: AgentEnterpriseHandlerDeps): void {
  ipcMain.handle(AgentIpcChannel.FetchEnterpriseAgents, async () => {
    // Fail-fast on auth: an expired JWT triggers loginGate.lock() inside
    // requireEnterprise() and the renderer returns to LoginPage.
    loginGate.requireEnterprise();

    let serverView;
    try {
      serverView = await enterpriseClient.listEnterpriseAgents();
    } catch (error) {
      // Failure preservation: do NOT touch local state. The renderer's toast
      // surfaces the error; the next sync attempt will retry.
      return { success: false, error: error instanceof Error ? error.message : 'Failed to fetch enterprise agents' };
    }

    try {
      const { report } = await agentEnterpriseSync.syncFromServer({
        serverView,
        genworkStore: deps.getGenWorkStore(),
        prefsStore: deps.getEnterpriseAgentPrefsStore(),
        skillManager: deps.getSkillManager(),
        defaultModelRef: deps.getAvailableModelsRef(),
      });
      return { success: true, report };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : 'Sync failed' };
    }
  });
}
```

- [ ] **Step 6: Wire the new module into the index**

In `src/main/ipcHandlers/agents/index.ts`, add:
```ts
export type { AgentEnterpriseHandlerDeps } from './handlers.enterprise';
export { registerAgentEnterpriseHandlers } from './handlers.enterprise';
```

- [ ] **Step 7: Add the preload bridge**

In `src/main/preload.ts`, inside the `agents:` object literal (around line 451, after `addPreset:`), add:
```ts
    fetchEnterpriseAgents: async () => {
      const result = await ipcRenderer.invoke(AgentIpcChannel.FetchEnterpriseAgents);
      return result as { success: boolean; report?: { upserted: number; removed: number; skipped: number }; error?: string };
    },
```

- [ ] **Step 8: Run the test + lint**

Run: `npx vitest run src/main/ipcHandlers/agents/handlers.enterprise.test.ts && npx eslint --ext ts,tsx --report-unused-disable-directives --max-warnings 0 src/main/auth/enterpriseClient.ts src/main/ipcHandlers/agents/handlers.enterprise.ts src/main/ipcHandlers/agents/index.ts src/shared/agent/constants.ts src/main/preload.ts`
Expected: PASS + clean (sync module is mocked).

- [ ] **Step 9: Commit**

```bash
git add src/main/auth/enterpriseClient.ts src/shared/agent/constants.ts src/main/ipcHandlers/agents/handlers.enterprise.ts src/main/ipcHandlers/agents/index.ts src/main/preload.ts src/main/ipcHandlers/agents/handlers.enterprise.test.ts
git commit -m "feat(desktop): add enterpriseClient.listEnterpriseAgents and IPC handler

Adds agents:fetchEnterpriseAgents. The handler is a thin shim that
delegates to agentEnterpriseSync.syncFromServer (next task); the
failure-preservation rule (HTTP throw → no local mutation) lives in
the handler so it can be unit-tested in isolation. Preload bridge
exposes it as window.electron.agents.fetchEnterpriseAgents."
```

---

### Task 10: Desktop — strict-mirror sync engine + throttle + model fallback

**Files:**
- Create: `src/main/libs/agentEnterpriseSync.ts`
- Create: `src/main/libs/agentEnterpriseSyncThrottle.ts`
- Modify: `src/main/libs/openclawAgentModels.ts` (no change needed — `parsePrimaryModelRef` is already exported; this task only calls it)
- Modify: `src/main/main.ts` (import `parsePrimaryModelRef` from `openclawAgentModels`; call `registerAgentEnterpriseHandlers` after `registerAgentHandlers` at line 8479; add `bootstrapEnterpriseAgentSync` trigger (b) after `bootstrapEnterpriseMt` at line 1733)
- Test: `src/main/libs/agentEnterpriseSync.test.ts`, `src/main/libs/agentEnterpriseSyncThrottle.test.ts`

**Interfaces:**
- Produces:
  - `agentEnterpriseSync.syncFromServer(opts) → { report: { upserted, removed, skipped } }` — pure function; REMOVE phase first (server-invisible rows + prefs orphan), then UPSERT phase with `effectiveModel = isModelAvailable(sv.model) ? sv.model : defaultModelRef` and `effectiveSkillIds = sv.skillIds.map(sid => skillManager.getCatalogLocalId(sid) ?? sid)`; only successful HTTP → invokes algorithm.
  - `agentEnterpriseSyncThrottle.throttledSync(accountKey, fn)` — module-level `Map<accountKey, { result, ts }>`; 3000ms window returns cached result without invoking `fn`; per-account isolation.
  - `bootstrapEnterpriseAgentSync` main-process helper — trigger (b) at startup; failure logged, not surfaced.

- [ ] **Step 1: Write the failing sync engine test**

Create `src/main/libs/agentEnterpriseSync.test.ts`:

```ts
import { describe, expect, test, vi } from 'vitest';

import { agentEnterpriseSync } from './agentEnterpriseSync';

function row(over: Partial<{
  id: string; name: string; source: 'custom' | 'preset' | 'enterprise';
  enterpriseAgentId?: string; model: string; skillIds: string[];
  subagentAllowAgentIds: string[];
}> = {}): {
  id: string; name: string; description: string; systemPrompt: string; identity: string;
  model: string; thinkingLevel: ''; workingDirectory: string; icon: string;
  skillIds: string[]; subagentAllowAgentIds: string[]; enabled: boolean;
  pinned: boolean; pinOrder: null; sortOrder: null; isDefault: boolean;
  source: 'custom' | 'preset' | 'enterprise'; presetId: string;
  createdAt: number; updatedAt: number; enterpriseAgentId?: string;
} {
  const id = over.id ?? 'local_' + Math.random().toString(36).slice(2, 8);
  return {
    id, name: over.name ?? id, description: '', systemPrompt: '', identity: '',
    model: over.model ?? '', thinkingLevel: '', workingDirectory: '', icon: '',
    skillIds: over.skillIds ?? [], subagentAllowAgentIds: over.subagentAllowAgentIds ?? [],
    enabled: true, pinned: false, pinOrder: null, sortOrder: null, isDefault: false,
    source: over.source ?? 'custom', presetId: '', createdAt: 0, updatedAt: 0,
    enterpriseAgentId: over.enterpriseAgentId,
  };
}

interface FakeStore {
  listAgents: () => ReturnType<typeof row>[];
  createAgent: ReturnType<typeof vi.fn>;
  updateAgent: ReturnType<typeof vi.fn>;
  deleteAgent: ReturnType<typeof vi.fn>;
}
function fakeStore(initial: ReturnType<typeof row>[]): FakeStore {
  let agents = [...initial];
  return {
    listAgents: () => agents,
    createAgent: vi.fn((req: { id?: string; name: string; source: 'enterprise'; enterpriseAgentId: string; model: string; skillIds: string[]; subagentAllowAgentIds: string[]; description?: string; identity?: string; systemPrompt?: string; thinkingLevel?: string; workingDirectory?: string; icon?: string }) => {
      const r = row({ ...req, source: 'enterprise', enterpriseAgentId: req.enterpriseAgentId });
      r.id = req.id ?? r.id;
      agents = [...agents, r];
      return r;
    }),
    updateAgent: vi.fn((id: string, updates: Record<string, unknown>) => {
      const idx = agents.findIndex(a => a.id === id);
      agents[idx] = { ...agents[idx], ...updates } as ReturnType<typeof row>;
      return agents[idx];
    }),
    deleteAgent: vi.fn((id: string) => {
      const before = agents.length;
      agents = agents.filter(a => a.id !== id);
      return agents.length < before;
    }),
  };
}

describe('agentEnterpriseSync.syncFromServer', () => {
  test('3-agent happy path: all upserted, none removed', async () => {
    const store = fakeStore([]);
    const prefs = { remove: vi.fn() };
    const skills = { getCatalogLocalId: (id: string) => id };
    const out = await agentEnterpriseSync.syncFromServer({
      serverView: [
        { agentId: 'a', name: 'A', description: '', identity: '', systemPrompt: '', model: '', thinkingLevel: '', icon: '', skillIds: [], subagentAllowAgentIds: [], allowedRoles: ['org_admin'], enabled: true },
        { agentId: 'b', name: 'B', description: '', identity: '', systemPrompt: '', model: '', thinkingLevel: '', icon: '', skillIds: [], subagentAllowAgentIds: [], allowedRoles: ['org_admin'], enabled: true },
        { agentId: 'c', name: 'C', description: '', identity: '', systemPrompt: '', model: '', thinkingLevel: '', icon: '', skillIds: [], subagentAllowAgentIds: [], allowedRoles: ['org_admin'], enabled: true },
      ],
      genworkStore: store as never,
      prefsStore: prefs as never,
      skillManager: skills as never,
      defaultModelRef: 'provider1/default-model',
    });
    expect(out.report).toEqual({ upserted: 3, removed: 0, skipped: 0 });
    expect(store.createAgent).toHaveBeenCalledTimes(3);
    expect(prefs.remove).not.toHaveBeenCalled();
  });

  test('second pass removes server-invisible enterprise rows and orphan prefs', async () => {
    const store = fakeStore([
      row({ id: 'local_a', enterpriseAgentId: 'a', source: 'enterprise' }),
      row({ id: 'local_x', enterpriseAgentId: 'gone', source: 'enterprise' }),
    ]);
    const prefs = { remove: vi.fn() };
    await agentEnterpriseSync.syncFromServer({
      serverView: [
        { agentId: 'a', name: 'A', description: '', identity: '', systemPrompt: '', model: '', thinkingLevel: '', icon: '', skillIds: [], subagentAllowAgentIds: [], allowedRoles: ['org_admin'], enabled: true },
      ],
      genworkStore: store as never,
      prefsStore: prefs as never,
      skillManager: { getCatalogLocalId: (id: string) => id } as never,
      defaultModelRef: '',
    });
    expect(store.deleteAgent).toHaveBeenCalledWith('local_x');
    expect(prefs.remove).toHaveBeenCalledWith('gone');
  });

  test('model fallback: server model not in catalog → effectiveModel = defaultModelRef, skipped++', async () => {
    const store = fakeStore([]);
    const out = await agentEnterpriseSync.syncFromServer({
      serverView: [{
        agentId: 'a', name: 'A', description: '', identity: '', systemPrompt: '',
        model: 'unknownProvider/missing', thinkingLevel: '', icon: '',
        skillIds: [], subagentAllowAgentIds: [], allowedRoles: ['org_admin'], enabled: true,
      }],
      genworkStore: store as never,
      prefsStore: { remove: vi.fn() } as never,
      skillManager: { getCatalogLocalId: (id: string) => id } as never,
      defaultModelRef: 'p1/default',
      isModelAvailable: (ref: string) => ref === 'p1/default',
    });
    expect(out.report.upserted).toBe(1);
    expect(out.report.skipped).toBe(1);
    expect(store.createAgent).toHaveBeenCalledWith(expect.objectContaining({ model: 'p1/default' }));
  });

  test('skill id not in local catalog → pass raw id through (no crash)', async () => {
    const store = fakeStore([]);
    await agentEnterpriseSync.syncFromServer({
      serverView: [{
        agentId: 'a', name: 'A', description: '', identity: '', systemPrompt: '',
        model: '', thinkingLevel: '', icon: '',
        skillIds: ['installed', 'unknown'], subagentAllowAgentIds: [], allowedRoles: ['org_admin'], enabled: true,
      }],
      genworkStore: store as never,
      prefsStore: { remove: vi.fn() } as never,
      skillManager: { getCatalogLocalId: (id: string) => (id === 'installed' ? 'installed-local' : undefined) } as never,
      defaultModelRef: '',
    });
    expect(store.createAgent).toHaveBeenCalledWith(expect.objectContaining({
      skillIds: ['installed-local', 'unknown'],
    }));
  });

  test('non-enterprise local rows are not touched', async () => {
    const customRow = row({ id: 'custom_1', source: 'custom' });
    const store = fakeStore([customRow]);
    await agentEnterpriseSync.syncFromServer({
      serverView: [],
      genworkStore: store as never,
      prefsStore: { remove: vi.fn() } as never,
      skillManager: { getCatalogLocalId: (id: string) => id } as never,
      defaultModelRef: '',
    });
    expect(store.deleteAgent).not.toHaveBeenCalled();
    expect(store.listAgents().some(a => a.id === 'custom_1')).toBe(true);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/main/libs/agentEnterpriseSync.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the sync engine**

Create `src/main/libs/agentEnterpriseSync.ts`:

```ts
import type { GenWorkStore, CreateAgentRequest, Agent } from '../genworkStore';
import type { EnterpriseAgentPrefsStore } from './enterpriseAgentPrefsStore';
import type { SkillManager } from '../skills/skillManager';
import { parsePrimaryModelRef } from './openclawAgentModels';
import { catalogResolver } from './catalogResolver';

export interface ServerAgentView {
  agentId: string;
  name: string;
  description: string;
  identity: string;
  systemPrompt: string;
  model: string;
  thinkingLevel: string;
  icon: string;
  skillIds: string[];
  subagentAllowAgentIds: string[];
  allowedRoles: string[];
  enabled: boolean;
}

export interface SyncReport {
  upserted: number;
  removed: number;
  skipped: number;
}

interface SyncOptions {
  serverView: ServerAgentView[];
  genworkStore: GenWorkStore;
  prefsStore: EnterpriseAgentPrefsStore;
  skillManager: SkillManager;
  defaultModelRef: string;
  /** Optional model-availability check; defaults to `catalogResolver` lookup. */
  isModelAvailable?: (modelRef: string) => boolean;
}

function defaultIsModelAvailable(modelRef: string): boolean {
  if (!modelRef) return true; // empty ref passes; treated as "no model set"
  const parsed = parsePrimaryModelRef(modelRef);
  if (!parsed) return false;
  return Boolean(catalogResolver.lookupModel(parsed.providerId, parsed.modelId));
}

export const agentEnterpriseSync = {
  async syncFromServer(opts: SyncOptions): Promise<{ report: SyncReport }> {
    const report: SyncReport = { upserted: 0, removed: 0, skipped: 0 };
    const isModelAvailable = opts.isModelAvailable ?? defaultIsModelAvailable;

    const serverIds = new Set(opts.serverView.map(a => a.agentId));
    const existingLocal = opts.genworkStore.listAgents().filter(a => a.source === 'enterprise');

    // REMOVE phase
    for (const local of existingLocal) {
      const key = local.enterpriseAgentId;
      if (!key || !serverIds.has(key)) {
        opts.genworkStore.deleteAgent(local.id);
        if (key) opts.prefsStore.remove(key);
        report.removed++;
      }
    }

    // UPSERT phase
    for (const sv of opts.serverView) {
      if (!sv.agentId) { report.skipped++; continue; }

      const effectiveModel = isModelAvailable(sv.model) ? sv.model : (opts.defaultModelRef || '');
      if (effectiveModel !== sv.model) report.skipped++;

      const effectiveSkillIds = sv.skillIds.map(
        sid => opts.skillManager.getCatalogLocalId(sid) ?? sid,
      );

      const payload = {
        name: sv.name,
        description: sv.description,
        identity: sv.identity,
        systemPrompt: sv.systemPrompt,
        model: effectiveModel,
        thinkingLevel: (sv.thinkingLevel ?? '') as '' | 'low' | 'medium' | 'high',
        workingDirectory: '',
        icon: sv.icon,
        skillIds: effectiveSkillIds,
        subagentAllowAgentIds: sv.subagentAllowAgentIds,
        source: 'enterprise' as const,
        enterpriseAgentId: sv.agentId,
      };

      const existing = existingLocal.find(a => a.enterpriseAgentId === sv.agentId);
      if (existing) {
        opts.genworkStore.updateAgent(existing.id, payload);
      } else {
        const req: CreateAgentRequest = { ...payload };
        opts.genworkStore.createAgent(req);
      }
      report.upserted++;
    }

    return { report };
  },
};
```

- [ ] **Step 4: Write the failing throttle test**

Create `src/main/libs/agentEnterpriseSyncThrottle.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { agentEnterpriseSyncThrottle } from './agentEnterpriseSyncThrottle';

beforeEach(() => { agentEnterpriseSyncThrottle._reset(); });
afterEach(() => { agentEnterpriseSyncThrottle._reset(); });

describe('agentEnterpriseSyncThrottle', () => {
  test('returns cached result within 3s window', async () => {
    const fn = vi.fn().mockResolvedValue({ report: { upserted: 1, removed: 0, skipped: 0 } });
    const r1 = await agentEnterpriseSyncThrottle.throttledSync('acctA', fn);
    const r2 = await agentEnterpriseSyncThrottle.throttledSync('acctA', fn);
    expect(r1.cached).toBe(false);
    expect(r2.cached).toBe(true);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  test('per-account isolation', async () => {
    const fn = vi.fn().mockResolvedValue({ report: { upserted: 1, removed: 0, skipped: 0 } });
    await agentEnterpriseSyncThrottle.throttledSync('acctA', fn);
    await agentEnterpriseSyncThrottle.throttledSync('acctB', fn);
    expect(fn).toHaveBeenCalledTimes(2);
  });

  test('3s+1ms → cache miss', async () => {
    vi.useFakeTimers();
    const fn = vi.fn().mockResolvedValue({ report: { upserted: 1, removed: 0, skipped: 0 } });
    await agentEnterpriseSyncThrottle.throttledSync('acctA', fn);
    vi.advanceTimersByTime(3001);
    await agentEnterpriseSyncThrottle_throughRealTimer('acctA', fn);
    vi.useRealTimers();
    expect(fn).toHaveBeenCalledTimes(2);
  });
});

// helper used by the third test above — flushes the throttledSync microtask queue.
async function agentEnterpriseSyncThrottle_throughRealTimer(key: string, fn: () => Promise<unknown>) {
  return agentEnterpriseSyncThrottle.throttledSync(key, fn);
}
```

- [ ] **Step 5: Run the throttle test to verify it fails**

Run: `npx vitest run src/main/libs/agentEnterpriseSyncThrottle.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 6: Write the throttle**

Create `src/main/libs/agentEnterpriseSyncThrottle.ts`:

```ts
const WINDOW_MS = 3000;

interface CacheEntry {
  result: unknown;
  ts: number;
}

const cache = new Map<string, CacheEntry>();

export const agentEnterpriseSyncThrottle = {
  async throttledSync<T>(accountKey: string, fn: () => Promise<T>): Promise<{ result: T; cached: boolean }> {
    const now = Date.now();
    const hit = cache.get(accountKey);
    if (hit && now - hit.ts < WINDOW_MS) {
      return { result: hit.result as T, cached: true };
    }
    const result = await fn();
    cache.set(accountKey, { result, ts: now });
    return { result, cached: false };
  },
  _reset(): void { cache.clear(); },
};
```

- [ ] **Step 7: Run both tests + lint**

Run: `npx vitest run src/main/libs/agentEnterpriseSync.test.ts src/main/libs/agentEnterpriseSyncThrottle.test.ts && npx eslint --ext ts,tsx --report-unused-disable-directives --max-warnings 0 src/main/libs/agentEnterpriseSync.ts src/main/libs/agentEnterpriseSyncThrottle.ts`
Expected: PASS + clean.

- [ ] **Step 8: Wire the sync engine into the IPC handler + add startup trigger (b)**

In `src/main/ipcHandlers/agents/handlers.enterprise.ts`, the test in Task 9 mocked `agentEnterpriseSync` from `'../../libs/agentEnterpriseSync'`. Replace the mock-friendly name with the real import by removing the `vi.mock` from the production handler file (it never had one; the mock was only in the test). The production handler is already written in Task 9 — no change needed.

In `src/main/main.ts`:

- After the `bootstrapEnterpriseMt(...)` call at line 1733, add the startup trigger (b). Wrap in `if/try` so failures are logged, never thrown:

```ts
    void (async () => {
      try {
        const session = sessionStorage.load();
        if (!session) return;
        const accountKey = `${session.userId}@${session.orgId}`;
        await agentEnterpriseSyncThrottle.throttledSync(accountKey, async () => {
          const serverView = await enterpriseClient.listEnterpriseAgents();
          const { report } = await agentEnterpriseSync.syncFromServer({
            serverView,
            genworkStore,
            prefsStore: enterpriseAgentPrefsStore,
            skillManager: getSkillManager(),
            defaultModelRef: resolveDefaultAgentModelRef(),
          });
          return report;
        });
      } catch (e) {
        console.warn('[enterpriseMt] startup enterprise agent sync failed (non-fatal):', e);
      }
    })();
```

- Add imports near the existing enterpriseClient / agentEnterpriseSyncThrottle lines (around the `import { agentEnterpriseSyncThrottle } from './libs/agentEnterpriseSyncThrottle';` you'd add at the top with the other `libs/` imports — confirm exact line in your tree with `rg -n "from './libs/" src/main/main.ts | head`).

- After the `registerAgentHandlers({...})` block at line 8479, add the registration of the enterprise handlers. The handlers need accessors for `genworkStore` and `enterpriseAgentPrefsStore`; create the prefs store alongside `genworkStore` (~line 1966). Adapt:

```ts
  const enterpriseAgentPrefsStore = new EnterpriseAgentPrefsStore(getStore().getDatabase());

  registerAgentEnterpriseHandlers({
    getGenWorkStore: () => genworkStore,
    getEnterpriseAgentPrefsStore: () => enterpriseAgentPrefsStore,
    getSkillManager: () => getSkillManager(),
    getAvailableModelsRef: () => resolveDefaultAgentModelRef(),
  });
```

(Add `import { EnterpriseAgentPrefsStore } from './libs/enterpriseAgentPrefsStore';` at the top of `main.ts`.)

- [ ] **Step 9: Run the full set + typecheck + lint**

Run: `npx vitest run src/main/libs/agentEnterpriseSync.test.ts src/main/libs/agentEnterpriseSyncThrottle.test.ts src/main/ipcHandlers/agents/handlers.enterprise.test.ts && npx tsc --noEmit && npx eslint --ext ts,tsx --report-unused-disable-directives --max-warnings 0 src/main/libs/agentEnterpriseSync.ts src/main/libs/agentEnterpriseSyncThrottle.ts src/main/ipcHandlers/agents/handlers.enterprise.ts src/main/main.ts`
Expected: PASS + clean. (`main.ts` is huge; lint it explicitly. CI runs per-file, so this is the gate.)

- [ ] **Step 10: Commit**

```bash
git add src/main/libs/agentEnterpriseSync.ts src/main/libs/agentEnterpriseSyncThrottle.ts src/main/main.ts src/main/libs/agentEnterpriseSync.test.ts src/main/libs/agentEnterpriseSyncThrottle.test.ts
git commit -m "feat(desktop): add strict-mirror enterprise agent sync engine and throttle

agentEnterpriseSync.syncFromServer removes server-invisible enterprise
rows (plus orphan prefs), then upserts each server view row with
model-fallback (server model not in catalog → defaultModelRef,
skipped++) and skill-id passthrough (getCatalogLocalId ?? sid). HTTP
failure short-circuits the algorithm; local rows are preserved.

agentEnterpriseSyncThrottle wraps sync invocations in a per-account
3-second cache window. Main registers the enterprise IPC handler and
fires a startup sync (trigger b) after bootstrapEnterpriseMt, logging
and swallowing any failure."
```

---

### Task 11: Desktop renderer — `agentService.fetchEnterpriseAgents` + slice `isReadOnly`

**Files:**
- Modify: `src/renderer/services/agent.ts:38-68` (loadAgents) and `:14` (action imports)
- Modify: `src/renderer/store/slices/agentSlice.ts:3-22,45-80,90-130`
- Test: `src/renderer/store/slices/agentSlice.test.ts` (create), extend `src/renderer/services/agent.test.ts` (or create)

**Interfaces:**
- Produces:
  - `AgentSummary.isReadOnly: boolean` (derived; mandatory, default false for legacy rows).
  - `agentSlice.setEnterpriseSyncReport(report)` action.
  - In `setAgents` / `addAgent` / `updateAgent` reducers: stamp `isReadOnly = a.source === 'enterprise'`.
  - `agentService.fetchEnterpriseAgents(): Promise<{ success, report? | error? }>` → calls IPC + dispatches `setAgents` after a successful sync so the sidebar re-renders.

- [ ] **Step 1: Write the failing slice test**

Create `src/renderer/store/slices/agentSlice.test.ts`:

```ts
import { describe, expect, test } from 'vitest';
import agentReducer, { setAgents, addAgent, setEnterpriseSyncReport } from './agentSlice';

describe('agentSlice.isReadOnly', () => {
  test('addAgent with source=enterprise → isReadOnly true', () => {
    const state = agentReducer(undefined, addAgent({
      id: 'l1', name: 'E', description: '', icon: '', model: '',
      thinkingLevel: '', workingDirectory: '', enabled: true, pinned: false,
      isDefault: false, source: 'enterprise', skillIds: [], subagentAllowAgentIds: [],
      isReadOnly: false,
    }));
    expect(state.agents[0].isReadOnly).toBe(true);
  });

  test('addAgent with source=custom → isReadOnly false', () => {
    const state = agentReducer(undefined, addAgent({
      id: 'l1', name: 'C', description: '', icon: '', model: '',
      thinkingLevel: '', workingDirectory: '', enabled: true, pinned: false,
      isDefault: false, source: 'custom', skillIds: [], subagentAllowAgentIds: [],
      isReadOnly: false,
    }));
    expect(state.agents[0].isReadOnly).toBe(false);
  });

  test('setAgents stamps isReadOnly based on source for every row', () => {
    const state = agentReducer(undefined, setAgents([
      { id: 'a', name: 'A', description: '', icon: '', model: '', thinkingLevel: '',
        workingDirectory: '', enabled: true, pinned: false, isDefault: false,
        source: 'enterprise', skillIds: [], subagentAllowAgentIds: [] },
      { id: 'b', name: 'B', description: '', icon: '', model: '', thinkingLevel: '',
        workingDirectory: '', enabled: true, pinned: false, isDefault: false,
        source: 'custom', skillIds: [], subagentAllowAgentIds: [] },
    ]));
    expect(state.agents.find(a => a.id === 'a')?.isReadOnly).toBe(true);
    expect(state.agents.find(a => a.id === 'b')?.isReadOnly).toBe(false);
  });

  test('setEnterpriseSyncReport stores the report', () => {
    const state = agentReducer(undefined, setEnterpriseSyncReport({ upserted: 2, removed: 1, skipped: 0 }));
    expect(state.lastEnterpriseSyncReport).toEqual({ upserted: 2, removed: 1, skipped: 0 });
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/renderer/store/slices/agentSlice.test.ts`
Expected: FAIL — module not found / field missing.

- [ ] **Step 3: Extend the slice**

In `src/renderer/store/slices/agentSlice.ts`:

- Update `AgentSummary` (lines 4-20): add `isReadOnly: boolean;` (mandatory).
- Add `EnterpriseSyncReport` interface: `{ upserted: number; removed: number; skipped: number }`.
- Extend `AgentState` to add `lastEnterpriseSyncReport: EnterpriseSyncReport | null;` and seed `null` in `initialState`.
- Modify `setAgents` to map each agent with `isReadOnly: a.source === 'enterprise'`:
  ```ts
    setAgents(state, action: PayloadAction<AgentSummary[]>) {
      state.agents = action.payload.map((a) => ({ ...a, isReadOnly: a.source === 'enterprise' }));
    },
  ```
- Modify `addAgent`:
  ```ts
    addAgent(state, action: PayloadAction<AgentSummary>) {
      state.agents.push({ ...action.payload, isReadOnly: action.payload.source === 'enterprise' });
    },
  ```
- Add `setEnterpriseSyncReport` action:
  ```ts
    setEnterpriseSyncReport(state, action: PayloadAction<EnterpriseSyncReport | null>) {
      state.lastEnterpriseSyncReport = action.payload;
    },
  ```
- Add to the exported action object.

- [ ] **Step 4: Extend the service**

In `src/renderer/services/agent.ts`:

- After the existing `updateAgent` method (~line 130), add:
  ```ts
    async fetchEnterpriseAgents(): Promise<{ success: boolean; report?: { upserted: number; removed: number; skipped: number }; error?: string }> {
      try {
        const result = await window.electron?.agents?.fetchEnterpriseAgents();
        if (!result) return { success: false, error: 'IPC unavailable' };
        if (result.success) {
          await this.loadAgents(); // re-pull local list so sidebar shows the new mirror state
        }
        return result;
      } catch (e) {
        return { success: false, error: (e as Error).message };
      }
    },
  ```
- Update `loadAgents` (lines 38-68) so the mapped agents carry `isReadOnly` (just always include it; the reducer will re-stamp):
  ```ts
    isReadOnly: a.source === 'enterprise',
  ```

- [ ] **Step 5: Run the tests + typecheck + lint**

Run: `npx vitest run src/renderer/store/slices/agentSlice.test.ts && npx tsc --noEmit && npx eslint --ext ts,tsx --report-unused-disable-directives --max-warnings 0 src/renderer/store/slices/agentSlice.ts src/renderer/services/agent.ts`
Expected: PASS + clean.

- [ ] **Step 6: Commit**

```bash
git add src/renderer/store/slices/agentSlice.ts src/renderer/services/agent.ts src/renderer/store/slices/agentSlice.test.ts
git commit -m "feat(desktop): derive isReadOnly in agentSlice and expose fetchEnterpriseAgents

AgentSummary.isReadOnly is now mandatory and stamped from source in
setAgents/addAgent; agentService.fetchEnterpriseAgents wraps the IPC
bridge and re-pulls loadAgents() on success so the sidebar reflects
the new mirror state without a full refresh."
```

---

### Task 12: Desktop UI — hide edit/delete on enterprise agents + read-only settings panel + workingDirectory editor + toolbar refresh button

**Files:**
- Modify: `src/renderer/components/agentSidebar/types.ts:5-12` (add `isReadOnly?: boolean` to `AgentSidebarAgentSummary`)
- Modify: `src/renderer/components/agentSidebar/useAgentSidebarState.ts:240-252` (propagate `isReadOnly`)
- Modify: `src/renderer/components/agentSidebar/AgentTreeNode.tsx:343-391` (conditional kebab buttons + readOnly icon hint)
- Modify: `src/renderer/components/agentSidebar/MyAgentSidebarTree.tsx` (toolbar button + `agentService.fetchEnterpriseAgents` wiring + `setEnterpriseSyncReport` toast)
- Modify: `src/renderer/components/agent/AgentSettingsPanel.tsx` (readOnly mode: skip save button, skip IM tab, render dedicated `workingDirectory` editor for enterprise agents)
- Test: extend `src/renderer/components/agentSidebar/AgentTreeNode.test.tsx` if it exists (search), else create; `src/renderer/components/agent/AgentSettingsPanel.test.tsx` (create)

**Interfaces:**
- Produces:
  - `AgentSidebarAgentSummary.isReadOnly?: boolean`; sidebar maps the field through to `AgentSidebarAgentNode`.
  - `AgentTreeNode` kebab: hides the edit `<button>` and the delete `<button>` (not just disabled) when `agent.isReadOnly` is true; the pin button stays.
  - `AgentSettingsPanel.readOnly` prop: when true, all field inputs become read-only text/markdown; the IM `Tabs` list omits the `IM` tab; the footer hides the delete + save buttons and shows a dedicated `workingDirectory` save (calls `enterpriseAgentPrefsStore` via a new IPC channel) plus a hint "此智能体由 enterprise_server 管理".
  - `MyAgentSidebarTree` toolbar: "+ 刷新 enterprise 智能体" button; toast on completion; throttled via `agentEnterpriseSyncThrottle` indirectly (the IPC handler in Task 10 already does throttling via the bootstrap path; for the renderer path the simpler approach is a local last-click timestamp).

- [ ] **Step 1: Add the IPC channel + handler for prefs read/save**

Add a new channel to `src/shared/agent/constants.ts`:
```ts
  GetEnterpriseAgentWorkingDirectory: 'agents:getEnterpriseAgentWorkingDirectory',
  SetEnterpriseAgentWorkingDirectory: 'agents:setEnterpriseAgentWorkingDirectory',
```

In `src/main/ipcHandlers/agents/handlers.enterprise.ts`, append two handlers:

```ts
  ipcMain.handle(AgentIpcChannel.GetEnterpriseAgentWorkingDirectory, async (_e, agentId: string) => {
    loginGate.requireEnterprise();
    const local = deps.getGenWorkStore().listAgents().find(a => a.source === 'enterprise' && a.enterpriseAgentId === agentId);
    if (!local) return { success: false, error: 'unknown_agent' };
    return { success: true, workingDirectory: deps.getEnterpriseAgentPrefsStore().get(agentId) };
  });

  ipcMain.handle(AgentIpcChannel.SetEnterpriseAgentWorkingDirectory, async (_e, args: { agentId: string; workingDirectory: string }) => {
    loginGate.requireEnterprise();
    deps.getEnterpriseAgentPrefsStore().upsert(args.agentId, args.workingDirectory.trim());
    // Refresh IM session working directories that bind to this agent.
    return { success: true };
  });
```

Update the preload bridge (`src/main/preload.ts`) with:
```ts
    getEnterpriseAgentWorkingDirectory: async (agentId: string) => {
      const result = await ipcRenderer.invoke(AgentIpcChannel.GetEnterpriseAgentWorkingDirectory, agentId);
      return result as { success: boolean; workingDirectory?: string; error?: string };
    },
    setEnterpriseAgentWorkingDirectory: async (agentId: string, workingDirectory: string) => {
      const result = await ipcRenderer.invoke(AgentIpcChannel.SetEnterpriseAgentWorkingDirectory, { agentId, workingDirectory });
      return result as { success: boolean; error?: string };
    },
```

- [ ] **Step 2: Sidebar — propagate `isReadOnly`**

In `src/renderer/components/agentSidebar/types.ts:5-12`, add `isReadOnly?: boolean;` to `AgentSidebarAgentSummary`.

In `src/renderer/components/agentSidebar/useAgentSidebarState.ts:240-252`, add `isReadOnly: agent.isReadOnly ?? false,` to the mapped object inside the `enabledAgents` `useMemo`.

- [ ] **Step 3: `AgentTreeNode` — hide edit/delete for enterprise agents**

In `src/renderer/components/agentSidebar/AgentTreeNode.tsx`, in the kebab menu block (~lines 343-391):

- Wrap the existing edit `<button>` (lines 346-354) in `{!agent.isReadOnly && (…)}`.
- Wrap the existing delete `<button>` (lines 368-389) in `{!agent.isReadOnly ? <button …> : null}` (keep the `isMainAgent` check intact for the not-readOnly path).

The pin button (lines 355-367) stays as-is.

- [ ] **Step 4: `AgentSettingsPanel` — read-only mode + dedicated workingDirectory editor**

In `src/renderer/components/agent/AgentSettingsPanel.tsx`:

- After the `useSelector((state) => state.agent.agents)` line (~line 79), compute:
  ```ts
  const isReadOnly = agents.find(a => a.id === agentId)?.source === 'enterprise';
  ```
- When `isReadOnly`, skip IM tab rendering: the `AgentDetailTab` enum has `Prompt`/`Skills`/`IM`-style tabs; locate the `activeTab` setter and conditional `Tabs` list — wrap the IM `<TabsTrigger>` in `{!isReadOnly && <TabsTrigger value={AgentDetailTab.IM}>…</TabsTrigger>}` and default `activeTab` to `Prompt` when `isReadOnly`.
- Replace the field inputs' `disabled` semantics: when `isReadOnly`, render `<div className="prose prose-sm ...">{name}</div>` instead of `<Input>`, and similarly for description/systemPrompt/identity/icon/model/thinkingLevel/skillIds/subagentAllowAgentIds.
- In the footer (~line 854-907), when `isReadOnly`:
  - Hide the delete `<button>` block (the `!isMainAgent && <button>`).
  - Hide the save `<button>`.
  - Render an enterprise-only workingDirectory editor block before the footer:
    ```tsx
    <EnterpriseWorkingDirectoryField agentId={agentId!} enterpriseAgentId={enterpriseAgentIdFor(agentId)} />
    ```
    with a small component that on mount calls `window.electron.agents.getEnterpriseAgentWorkingDirectory`, renders an `<input>` + a save `<button>` that calls `window.electron.agents.setEnterpriseAgentWorkingDirectory(...)`.
- Add a `enterpriseAgentIdFor(agentId)` helper that reads `agents.find(...).enterpriseAgentId`.

(If extracting a sub-component is preferable due to the file already being 907 lines, create `src/renderer/components/agent/EnterpriseWorkingDirectoryField.tsx` and import it here.)

- [ ] **Step 5: `MyAgentSidebarTree` — refresh button + toast + triggers (c) + (e)**

In `src/renderer/components/agentSidebar/MyAgentSidebarTree.tsx`:

- Add a refresh button to the toolbar block (~line 588). On click:
  ```tsx
  onClick={async () => {
    const r = await agentService.fetchEnterpriseAgents();
    if (r.success && r.report) {
      window.dispatchEvent(new CustomEvent('app:showToast', { detail: i18nService.t('enterpriseAgentsRefreshed', { n: r.report.upserted }) }));
    } else {
      window.dispatchEvent(new CustomEvent('app:showToast', { detail: i18nService.t('enterpriseAgentsRefreshFailed') }));
    }
  }}
  ```
- Add a mount `useEffect` (trigger c): on first mount, fire-and-forget `agentService.fetchEnterpriseAgents()` (the IPC handler throttles per account).

- [ ] **Step 6: Add the i18n keys (en + zh)**

In `src/renderer/services/i18n.ts` (both `en` and `zh` blocks):
```ts
'en': {
  ...
  'enterpriseAgents.refresh': 'Refresh enterprise agents',
  'enterpriseAgents.refreshed': 'Synced {n} enterprise agents',
  'enterpriseAgents.refreshFailed': 'Failed to sync enterprise agents — check network or relogin to enterprise_server',
  'agent.readOnlyBadge': 'Managed by enterprise_server',
  'agent.enterpriseWorkingDirectory.save': 'Save',
  'agent.enterpriseWorkingDirectory.saved': 'Saved',
}
'zh': {
  ...
  'enterpriseAgents.refresh': '刷新 enterprise 智能体',
  'enterpriseAgents.refreshed': '已同步 {n} 个 enterprise 智能体',
  'enterpriseAgents.refreshFailed': '同步 enterprise 智能体失败，请检查网络或重新登录 enterprise_server',
  'agent.readOnlyBadge': '由 enterprise_server 管理',
  'agent.enterpriseWorkingDirectory.save': '保存',
  'agent.enterpriseWorkingDirectory.saved': '已保存',
}
```

- [ ] **Step 7: Write the failing component tests**

Create `src/renderer/components/agent/AgentSettingsPanel.test.tsx` (mirror the file's existing test style if present):

```tsx
import { describe, expect, test, vi } from 'vitest';
import { Provider } from 'react-redux';
import { configureStore } from '@reduxjs/toolkit';
import { render, screen } from '@testing-library/react';

import agentReducer from '../../store/slices/agentSlice';
import AgentSettingsPanel from './AgentSettingsPanel';

vi.stubGlobal('window', {
  electron: {
    agents: {
      getEnterpriseAgentWorkingDirectory: vi.fn().mockResolvedValue({ success: true, workingDirectory: '' }),
      setEnterpriseAgentWorkingDirectory: vi.fn().mockResolvedValue({ success: true }),
    },
  },
});

function makeStore() {
  return configureStore({ reducer: { agent: agentReducer } });
}

describe('AgentSettingsPanel — read-only enterprise agent', () => {
  test('renders read-only badge and no save button for source=enterprise', () => {
    const store = makeStore();
    store.dispatch({
      type: 'agent/setAgents',
      payload: [{
        id: 'ent1', name: 'Code Reviewer', description: '', icon: '',
        model: '', thinkingLevel: '', workingDirectory: '', enabled: true,
        pinned: false, isDefault: false, source: 'enterprise', skillIds: [],
        subagentAllowAgentIds: [], enterpriseAgentId: 'agent_a1',
      }],
    });
    render(<Provider store={store}><AgentSettingsPanel agentId="ent1" onClose={() => {}} /></Provider>);
    expect(screen.getByText(/Managed by enterprise_server/i)).toBeInTheDocument();
    // No save button (only the enterprise working-directory save button exists).
    expect(screen.queryByRole('button', { name: /^Save$/i })).not.toBeInTheDocument();
  });
});
```

Create `src/renderer/components/agentSidebar/AgentTreeNode.test.tsx` if it doesn't exist:

```tsx
import { describe, expect, test, vi } from 'vitest';
import { render, screen } from '@testing-library/react';

vi.mock('../../services/i18n', () => ({
  i18nService: { t: (k: string) => k },
}));

import AgentTreeNode from './AgentTreeNode';

const baseProps = (over: Partial<{ isReadOnly: boolean }> = {}): unknown => ({
  agent: {
    id: 'ent1', name: 'Enterprise', icon: '', enabled: true, pinned: false,
    pinOrder: null, sortOrder: null, isExpanded: false, isTaskListExpanded: false,
    canExpandTasks: false, canCollapseTasks: false, isLoadingTasks: false,
    hasLoadError: false, tasks: [], isReadOnly: over.isReadOnly ?? false,
  },
  isBatchMode: false, batchAgentId: null, selectedKeys: new Set<string>(),
  showBatchOption: false,
  onToggleExpanded: () => {}, onEditAgent: () => {}, onCreateTask: () => {},
  onDeleteAgent: async () => {}, onToggleAgentPin: async () => {},
  onRetryLoadTasks: () => {}, onLoadMoreTasks: () => {}, onCollapseTasks: () => {},
  onSelectTask: () => {}, onDeleteTask: async () => {}, onShareTask: async () => {},
  onToggleTaskPin: async () => {}, onRenameTask: async () => {},
  onToggleSelection: () => {}, onEnterBatchMode: () => {},
});

describe('AgentTreeNode kebab', () => {
  test('renders only the pin menu item when isReadOnly', () => {
    render(<AgentTreeNode {...(baseProps({ isReadOnly: true }) as Parameters<typeof AgentTreeNode>[0])} />);
    expect(screen.queryByText('edit')).not.toBeInTheDocument();
    expect(screen.queryByText('delete')).not.toBeInTheDocument();
  });
});
```

- [ ] **Step 8: Run the tests + typecheck + lint**

Run: `npx vitest run src/renderer/components/agent/AgentSettingsPanel.test.tsx src/renderer/components/agentSidebar/AgentTreeNode.test.tsx src/renderer/store/slices/agentSlice.test.ts && npx tsc --noEmit && npx eslint --ext ts,tsx --report-unused-disable-directives --max-warnings 0 src/renderer/components/agent/AgentSettingsPanel.tsx src/renderer/components/agentSidebar/AgentTreeNode.tsx src/renderer/components/agentSidebar/MyAgentSidebarTree.tsx src/renderer/components/agentSidebar/useAgentSidebarState.ts src/renderer/components/agentSidebar/types.ts src/renderer/services/agent.ts src/renderer/services/i18n.ts src/shared/agent/constants.ts src/main/preload.ts src/main/ipcHandlers/agents/handlers.enterprise.ts`
Expected: PASS + clean.

- [ ] **Step 9: Commit**

```bash
git add -A src/renderer/components/agent src/renderer/components/agentSidebar src/renderer/services/i18n.ts src/renderer/services/agent.ts src/shared/agent/constants.ts src/main/preload.ts src/main/ipcHandlers/agents
git commit -m "feat(desktop): hide edit/delete on enterprise agents and read-only settings panel

AgentTreeNode kebab hides edit+delete for source='enterprise' (pin stays);
AgentSettingsPanel renders read-only mode (no save, no delete, no IM
tab) with a dedicated workingDirectory editor that round-trips through
enterprise_agent_prefs. MyAgentSidebarTree gets a refresh button and
fires a mount-time sync (trigger c)."
```

---

### Task 13: Wire enterprise trigger (d) — sync after enterprise login

**Files:**
- Modify: `src/main/ipcHandlers/enterpriseMt.ts:198-203` (existing `onLoginSyncHook`)
- Test: append to `src/main/ipcHandlers/agents/handlers.enterprise.test.ts` (or create a new login-flow test)

**Interfaces:**
- Produces: after a successful `enterpriseClient.login`, the enterprise login hook also fires the enterprise-agent sync (mirrors `enterpriseModelCache.load`).

- [ ] **Step 1: Extend the login hook**

In `src/main/ipcHandlers/enterpriseMt.ts:198-203`, extend `onLoginSyncHook` to call `agentEnterpriseSync.syncFromServer` after the existing OpenClaw config sync. Inject the sync dependencies via the `setEnterpriseLoginSyncHook` setter pattern already used by `main.ts` (line 1724-1728). Adapt `main.ts` to pass them in:

```ts
  setEnterpriseLoginSyncHook(async () => {
    await syncOpenClawConfig({ reason: 'enterprise-login-refresh', restartGatewayIfRunning: true });
    // Trigger (d): sync enterprise agents now that the JWT is fresh.
    try {
      const session = sessionStorage.load();
      if (!session) return;
      const accountKey = `${session.userId}@${session.orgId}`;
      await agentEnterpriseSyncThrottle.throttledSync(accountKey, async () => {
        const serverView = await enterpriseClient.listEnterpriseAgents();
        const { report } = await agentEnterpriseSync.syncFromServer({
          serverView,
          genworkStore: getGenWorkStore(),
          prefsStore: enterpriseAgentPrefsStore,
          skillManager: getSkillManager(),
          defaultModelRef: resolveDefaultAgentModelRef(),
        });
        return report;
      });
    } catch (e) {
      console.warn('[enterpriseMt] post-login enterprise agent sync failed (non-fatal):', e);
    }
  });
```

- [ ] **Step 2: Run typecheck + lint**

Run: `npx tsc --noEmit && npx eslint --ext ts,tsx --report-unused-disable-directives --max-warnings 0 src/main/ipcHandlers/enterpriseMt.ts src/main/main.ts`
Expected: clean.

- [ ] **Step 3: Commit**

```bash
git add src/main/ipcHandlers/enterpriseMt.ts src/main/main.ts
git commit -m "feat(desktop): sync enterprise agents after enterprise login

Trigger (d): the existing setEnterpriseLoginSyncHook now also runs the
strict-mirror sync, throttled per account, after the OpenClaw config
sync completes. Failure is logged, not surfaced (matches the model-cache
pattern at enterpriseMt.ts:191)."
```

---

## Final verification

After all tasks land, run:

```bash
# Server
cd enterprise_server && npx vitest run --no-file-parallelism

# SPA
cd enterprise_server/web && npx vitest run

# Desktop (scoped — do not run the full Electron suite)
cd /Users/paulwang/work/GenWork
npx vitest run \
  src/main/gworkStore.test.ts \
  src/main/libs/enterpriseAgentPrefsStore.test.ts \
  src/main/libs/agentEnterpriseSync.test.ts \
  src/main/libs/agentEnterpriseSyncThrottle.test.ts \
  src/main/ipcHandlers/agents/handlers.enterprise.test.ts \
  src/renderer/store/slices/agentSlice.test.ts \
  src/renderer/components/agent/AgentSettingsPanel.test.tsx \
  src/renderer/components/agentSidebar/AgentTreeNode.test.tsx

# Full typecheck + lint on touched files
npx tsc --noEmit
cd enterprise_server && npx tsc --noEmit && cd ../..
cd enterprise_server/web && npx tsc --noEmit && cd ../..
```

Then a manual smoke (per spec §Testing / Manual):
1. `npm run electron:dev:openclaw`
2. Log in to enterprise_server; create an enterprise agent as `agent_admin` with `allowed_roles=['org_admin']` and an enabled skill.
3. Click "刷新 enterprise 智能体" in the desktop sidebar; verify the agent appears.
4. Open the enterprise agent → settings panel is read-only, no IM tab, only the working-directory editor is editable.
5. Switch to an account lacking the role → trigger a refresh → the agent disappears.
6. Toggle network off → click refresh → toast appears; local enterprise rows are preserved.

---

## Self-Review

**1. Spec coverage.** Every numbered decision in the spec (1–9), every section under "User-visible changes", "Data model", "Components", "Data flow", "Triggers", "Behavior — desktop UI", "Role / permission topology", "References cleanup on delete", "Error handling", and the 9-commit split is covered by a task:

- Spec §"Data model" (server migration 025, desktop column + table) → Tasks 1, 7, 8.
- Spec §"Components / Server" (routes, view model, role-options, constants) → Tasks 1, 2, 3.
- Spec §"Components / Desktop main process" (types, schema, client, sync engine, throttle, IPC) → Tasks 7, 8, 9, 10.
- Spec §"Components / Desktop renderer" (preload, service, slice, sidebar, panel, i18n) → Tasks 11, 12.
- Spec §"Data flow — strict mirror D1" (REMOVE then UPSERT, model fallback, skill passthrough, failure preservation) → Task 10 Step 3.
- Spec §"Triggers" (b/c/d/e) → Tasks 10 Step 8 (b), 12 Step 5 (c), 13 (d), 12 Step 5 (e).
- Spec §"Behavior — desktop UI" table → Tasks 7 (source field), 11 (isReadOnly derivation), 12 (kebab + readOnly + tab omission).
- Spec §"Role / permission topology" (`agents.manage` + `agent_admin` + role-options route) → Tasks 1, 2.
- Spec §"References cleanup on delete" (JSONB `-` operator + references endpoint) → Task 3.
- Spec §"Error handling" (each row mapped to the task that handles it: enterprise unreachable → Task 9/10, JWT expired → Task 9, model fallback → Task 10, skill passthrough → Task 10, throttle hit → Task 10, validation errors → Task 3, agent_admin roles.vocabulary → Task 2, prefs upsert fails → Task 8 try/catch in `upsert`).
- Spec §"Testing" (server: 3 test files, desktop: 7 test files) → each test is created in the relevant task.
- Spec §"Migration & rollout" (9-commit split) → the 9 commits in this plan map 1:1 to spec commits 1–9 (plus task 13 wires trigger d, grouped with the spec's "desktop fetch path / sync engine" intent; the split into a separate commit is fine per the user's later "continue" instruction which made the manual refresh a separate UI concern).

**2. Placeholder scan.** No "TBD", "TODO", "implement later", "fill in details", "Add appropriate error handling", "Write tests for the above", "Similar to Task N" (each step repeats the exact code), or references to types/functions not defined in this plan. Every test runs against real symbols that the implementing task creates. The only variable names left to the implementer are the local reducer shape — those are pinned by the test code in Task 11.

**3. Type consistency.**
- `enterpriseAgentId` — same name everywhere it appears: `Agent`, `AgentSummary`, `CreateAgentRequest`, `AgentSidebarAgentSummary`, the IPC preload payload (the `create` payload), the SQLite column (`enterprise_agent_id` snake in SQL, camel in TS via `mapAgentRow`), and the sync engine.
- `effectiveModel` / `effectiveSkillIds` — only used inside `syncFromServer`; consumed by the report, not exported.
- `ServerAgentView` (Task 10) and `AgentMarketplaceView` (Task 2, server) are separate on purpose: the server wire shape uses `agentId` (camel); the desktop sync engine accepts its own `ServerAgentView` shape with `agentId` to mirror the IPC boundary. The `enterpriseClient.listEnterpriseAgents` returns a third shape with `agentId` — Task 9's handler adapts this into the engine input. Confirmed consistent.
- `isReadOnly` — derived in the reducer from `source`; carried on `AgentSummary`, `AgentSidebarAgentSummary`, `AgentSidebarAgentNode`. No constructor anywhere accepts it from the server (the IPC wire is `source: string`, not `isReadOnly: boolean`).
- `enterpriseAgentPrefsStore` — single instance, constructed in `main.ts` near `genworkStore`, passed to both the IPC handler (Task 9) and the sync engine (Task 10).
- `PermissionCode.AgentsManage` — same string `'agents.manage'` on both server (Task 1) and SPA (Task 4).
- `agentMarketplaceApi` (SPA) and `enterpriseClient.listEnterpriseAgents` (desktop) — both return `{ agentId }`-camel, matching the SPA's existing `AgentMarketplaceItem` interface and the desktop's `ServerAgentView`.

No inconsistencies found. Plan is ready for execution.
