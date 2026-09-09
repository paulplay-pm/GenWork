# MCP 管理 (MCP Management) Redesign — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rebuild the enterprise_server MCP 管理 feature to match the `mcp-standalone.html` prototype (remote-MCP-server model), and wire per-MCP role permissions into the user-role system so a user's role determines which MCPs they can see/use.

**Architecture:** Evolve the `mcp_marketplace_servers` table in place (new migration adds URL/auth/credential/timeout/roles/health columns). Rewrite the public catalog route to be role-filtered (server-side enforcement), rewrite the admin CRUD + add read endpoints + a health-probe endpoint, add a role-vocabulary endpoint, and build a new SPA `MCPManagePage` (category sidebar + card grid + create form + detail drawer) with role chips.

**Tech Stack:** TypeScript, Hono, Postgres/pglite (via `pool`), Zod, Vitest (backend), React + TanStack Query + react-router (web SPA), Tailwind + `var(--*)` design tokens, `t()` i18n.

**Spec:** `docs/superpowers/specs/2026-09-12-mcp-management-redesign-design.md`

## Global Constraints

- **Working dir for all backend files:** `enterprise_server/`. Backend runs via `tsx` (no tsc build gate); tests via Vitest. Full backend suite runs with `--no-file-parallelism`.
- **Credential crypto:** reuse `encrypt`/`decrypt` from `enterprise_server/src/vault/crypto.ts` (AES-256-GCM). Test env sets `GENWORK_VAULT_MASTER_KEY` (see `tests/helpers/setupEnv.ts`). Never return plaintext; expose a masked value (`••••<last4>`).
- **Roles / enforcement:** JWT `claims.roles` is the `extra_roles` set. `super_admin` short-circuits (sees/uses all). MCP access = `allowed_roles ∩ claims.roles ≠ ∅` OR `super_admin`. Position-inherited roles deliberately excluded.
- **Auth gates:** new public endpoints use `requireAuth`; new admin endpoints use `requireAuth` + `requireCapability('org_admin')` (imported from `src/auth/middleware`).
- **i18n:** every user-visible string goes through `t('key')` in `web/src/i18n.ts` with **both** `en` and `zh` keys. `t()` does NOT interpolate `{x}` placeholders — avoid placeholders; build phrases by concatenation in components or use distinct keys.
- **String constants:** use existing `as const` patterns; transport values `['stdio','sse','http']`, auth `['none','bearer','api-key','oauth']`.
- **Tests:** backend tests colocate under `enterprise_server/tests/`, import from `vitest`, mock `pool` via `vi.mock('../../src/db/pool', ...)` → `testDb.testPool`, use `signToken` + `app.request()`. Web tests under `enterprise_server/web/tests/`, render inside `QueryClientProvider` + `MemoryRouter`, seed `useAuthStore.setState`, mock `globalThis.fetch`.
- **Lint gate:** every touched TS/TSX file must be clean under `npx eslint --ext ts,tsx --report-unused-disable-directives --max-warnings 0 <files>`.
- **Commit style:** Conventional Commits, English, scoped. No `Co-Authored-By` trailer.
- **No broad refactors / no unrelated churn.**

### Reusable test boilerplate (backend)

Every backend route test starts with (copy verbatim, adjusting imports):

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
```

Helpers: `const tokenFor = (sub: string, orgId: string, roles: string[] = []) => signToken({ sub, orgId, roles });` and `const auth = (t: string) => ({ authorization: `Bearer ${t}` });`.

### Reusable seed helper (backend, for role tests)

```ts
async function seedUserWithRoles(userId: string, orgId: string, extraRoles: string[]): Promise<void> {
  await testPool.query('INSERT INTO orgs(id, name) VALUES ($1, $2) ON CONFLICT DO NOTHING', [orgId, orgId]);
  await testPool.query(
    `INSERT INTO users(id, org_id, username, password_hash, extra_roles)
     VALUES ($1, $2, $3, 'x', $4::jsonb) ON CONFLICT (id) DO NOTHING`,
    [userId, orgId, userId, JSON.stringify(extraRoles)],
  );
}
```

---

## File Structure (what changes and why)

**Backend (`enterprise_server/src/`):**
- `db/migrations/018_mcp_marketplace_v2.sql` (NEW) — add columns, relax `command`, seed `uncategorized`, backfill `allowed_roles`.
- `vault/mask.ts` (NEW) — `maskCredential(cipher)` → masked string.
- `models/mcpMarketplaceView.ts` (NEW) — `ServerRow`, `McpServerView`, `CategoryRow`, `SERVER_COLUMNS`, `mapServer()`, `AUTH_METHODS`, `TRANSPORT_TYPES` constants + the `UNCATEGORIZED` id.
- `routes/roleVocabulary.ts` (NEW) — `GET /api/roles/vocabulary`.
- `routes/mcpMarketplace.ts` (REWRITE) — role-filtered `GET /api/mcp-marketplace`.
- `routes/mcpMarketplaceAdmin.ts` (REWRITE) — new create/patch/delete + `GET /servers`, `GET /categories`, `POST /servers/:id/test`, migrate-on-delete.
- `server.ts` (MODIFY) — mount `roleVocabularyRoutes`.

**Web (`enterprise_server/web/src/`):**
- `api/client.ts` (MODIFY) — add `put<T>` method.
- `api/mcpMarketplace.ts` (NEW) — SPA API module.
- `lib/autoIcon.ts` (NEW) — `autoIcon(name)` deterministic emoji.
- `i18n.ts` (MODIFY) — en + zh keys.
- `pages/MCPManagePage.tsx` (NEW) — top-level page (state + view switching).
- `pages/mcpManage/CategorySidebar.tsx` (NEW)
- `pages/mcpManage/McpCardGrid.tsx` (NEW) — grid + `McpCard`.
- `pages/mcpManage/CreateMcpForm.tsx` (NEW)
- `pages/mcpManage/DetailDrawer.tsx` (NEW)
- `pages/mcpManage/RoleChips.tsx` (NEW)
- `pages/mcpManage/types.ts` (NEW) — shared view types mirroring backend.
- `App.tsx` (MODIFY) — new route.
- `components/Sidebar.tsx` (MODIFY) — new nav item.

**Tests:**
- `enterprise_server/tests/db/migration018.test.ts` (NEW)
- `enterprise_server/tests/vault/mask.test.ts` (NEW)
- `enterprise_server/tests/routes/roleVocabulary.test.ts` (NEW)
- `enterprise_server/tests/routes/mcpMarketplace.test.ts` (REWRITE) — role-filtered catalog.
- `enterprise_server/tests/routes/mcpMarketplaceAdmin.test.ts` (NEW) — CRUD + reads + probe + category migrate.
- `enterprise_server/web/tests/lib/autoIcon.test.ts` (NEW)
- `enterprise_server/web/tests/pages/mcpManage/RoleChips.test.tsx` (NEW)
- `enterprise_server/web/tests/pages/mcpManage/MCPManagePage.test.tsx` (NEW)

---

### Task 1: Migration 018 — schema v2

**Files:**
- Create: `enterprise_server/src/db/migrations/018_mcp_marketplace_v2.sql`
- Test: `enterprise_server/tests/db/migration018.test.ts`

**Interfaces:**
- Consumes: existing `mcp_marketplace_categories` / `mcp_marketplace_servers` (from 012).
- Produces: columns `server_url`, `auth_method`, `credential_cipher`, `api_key_header`, `timeout_seconds`, `allowed_roles`, `last_status`, `last_latency_ms`, `last_tested_at`; `command` now nullable; a reserved `uncategorized` category row; existing servers backfilled `allowed_roles = ["super_admin"]`.

- [ ] **Step 1: Write the failing test**

```ts
import '../helpers/setupEnv';
import { beforeEach, describe, expect, test } from 'vitest';
vi.mock('../../src/db/pool', async () => {
  const td = await import('../../src/db/testDb');
  return { pool: td.testPool };
});
import { resetSchema, runMigrations, testPool } from '../../src/db/testDb';

describe('migration 018', () => {
  beforeEach(async () => { await resetSchema(); await runMigrations(); });

  test('adds v2 columns and relaxes command', async () => {
    const r = await testPool.query<{ cols: string[] }>(
      `SELECT array_agg(column_name) AS cols
       FROM information_schema.columns
       WHERE table_name = 'mcp_marketplace_servers'
       AND column_name IN ('server_url','auth_method','credential_cipher','api_key_header','timeout_seconds','allowed_roles','last_status','last_latency_ms','last_tested_at')`,
    );
    expect(r.rows[0].cols.sort()).toEqual(
      ['allowed_roles','api_key_header','auth_method','credential_cipher','last_latency_ms','last_status','last_tested_at','server_url','timeout_seconds'].sort(),
    );
    // command is now nullable (no NOT NULL constraint).
    const notNull = await testPool.query<{ n: number }>(
      `SELECT COUNT(*)::int AS n FROM information_schema.columns
       WHERE table_name='mcp_marketplace_servers' AND column_name='command' AND is_nullable='NO'`,
    );
    expect(notNull.rows[0].n).toBe(0);
  });

  test('seeds reserved uncategorized category and backfills allowed_roles', async () => {
    const cat = await testPool.query<{ n: number }>(
      `SELECT COUNT(*)::int AS n FROM mcp_marketplace_categories WHERE category_id='uncategorized'`,
    );
    expect(cat.rows[0].n).toBe(1);
    const backfilled = await testPool.query<{ n: number }>(
      `SELECT COUNT(*)::int AS n FROM mcp_marketplace_servers
       WHERE server_id IN ('qichacha','exa-search','tavily-search')
       AND allowed_roles::text = '["super_admin"]'`,
    );
    expect(backfilled.rows[0].n).toBe(3);
  });

  test('is idempotent (re-run safe)', async () => {
    // resetSchema + runMigrations already ran; run again to prove no error.
    await resetSchema();
    await runMigrations();
    const cat = await testPool.query<{ n: number }>(
      `SELECT COUNT(*)::int AS n FROM mcp_marketplace_categories WHERE category_id='uncategorized'`,
    );
    expect(cat.rows[0].n).toBe(1);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd enterprise_server && npx vitest run tests/db/migration018.test.ts`
Expected: FAIL — columns / `uncategorized` missing.

- [ ] **Step 3: Write the migration**

Create `enterprise_server/src/db/migrations/018_mcp_marketplace_v2.sql`:

```sql
-- Migration 018: MCP marketplace v2 (remote-server model + role permissions).
-- Adds URL/auth/credential/timeout/allowed_roles/health columns, relaxes
-- `command` (only needed for stdio), seeds the reserved 未分类 category, and
-- backfills allowed_roles so pre-existing servers stay reachable to admins.
--
-- Re-run safe (the test harness re-runs every file with no ledger check):
-- every ADD COLUMN uses IF NOT EXISTS; the seed and backfill are guarded.

ALTER TABLE mcp_marketplace_servers ADD COLUMN IF NOT EXISTS server_url        TEXT;
ALTER TABLE mcp_marketplace_servers ADD COLUMN IF NOT EXISTS auth_method       TEXT NOT NULL DEFAULT 'none';
ALTER TABLE mcp_marketplace_servers ADD COLUMN IF NOT EXISTS credential_cipher TEXT;
ALTER TABLE mcp_marketplace_servers ADD COLUMN IF NOT EXISTS api_key_header    TEXT NOT NULL DEFAULT '';
ALTER TABLE mcp_marketplace_servers ADD COLUMN IF NOT EXISTS timeout_seconds   INTEGER NOT NULL DEFAULT 30;
ALTER TABLE mcp_marketplace_servers ADD COLUMN IF NOT EXISTS allowed_roles     JSONB NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE mcp_marketplace_servers ADD COLUMN IF NOT EXISTS last_status       TEXT;
ALTER TABLE mcp_marketplace_servers ADD COLUMN IF NOT EXISTS last_latency_ms   INTEGER;
ALTER TABLE mcp_marketplace_servers ADD COLUMN IF NOT EXISTS last_tested_at    TIMESTAMPTZ;

-- Relax `command`: make nullable (was NOT NULL).
ALTER TABLE mcp_marketplace_servers ALTER COLUMN command DROP NOT NULL;

-- Reserved 未分类 (Uncategorized) category: the target for delete-migration.
INSERT INTO mcp_marketplace_categories (category_id, name_zh, name_en, display_order)
VALUES ('uncategorized', '未分类', 'Uncategorized', 9999)
ON CONFLICT (category_id) DO NOTHING;

-- Backfill: pre-existing servers were un-gated; give them super_admin so
-- admins can still reach them. Only touch rows that have no roles yet.
UPDATE mcp_marketplace_servers
SET allowed_roles = '["super_admin"]'::jsonb
WHERE allowed_roles = '[]'::jsonb;

-- Guard the new CHECK on auth_method (add only once).
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'mcp_servers_auth_method_check'
  ) THEN
    ALTER TABLE mcp_marketplace_servers
      ADD CONSTRAINT mcp_servers_auth_method_check
      CHECK (auth_method IN ('none','bearer','api-key','oauth'));
  END IF;
END $$;
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd enterprise_server && npx vitest run tests/db/migration018.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add enterprise_server/src/db/migrations/018_mcp_marketplace_v2.sql enterprise_server/tests/db/migration018.test.ts
git commit -m "feat(enterprise_server/db): add mcp marketplace v2 schema with role columns"
```

---

### Task 2: Credential mask helper

**Files:**
- Create: `enterprise_server/src/vault/mask.ts`
- Test: `enterprise_server/tests/vault/mask.test.ts`

**Interfaces:**
- Consumes: `decrypt` from `src/vault/crypto`.
- Produces: `maskCredential(cipher: string | null | undefined): string | null` — returns `••••<last4>` for a non-empty credential, `null` when the input is falsy or the decrypted value is empty, `••••` if decrypt throws.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, test } from 'vitest';
import { encrypt } from '../../src/vault/crypto';
import { maskCredential } from '../../src/vault/mask';

describe('maskCredential', () => {
  test('masks to last 4 of the decrypted plaintext', () => {
    expect(maskCredential(encrypt('wk-abc-93bd'))).toBe('••••93bd');
  });
  test('returns null for empty input', () => {
    expect(maskCredential(null)).toBeNull();
    expect(maskCredential(undefined)).toBeNull();
    expect(maskCredential('')).toBeNull();
  });
  test('returns null when the decrypted value is empty', () => {
    expect(maskCredential(encrypt(''))).toBeNull();
  });
  test('returns generic mask when decrypt throws', () => {
    expect(maskCredential('not-valid-base64-ciphertext!!!')).toBe('••••');
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd enterprise_server && npx vitest run tests/vault/mask.test.ts`
Expected: FAIL — `Cannot find module '../../src/vault/mask'`.

- [ ] **Step 3: Write the implementation**

```ts
import { decrypt } from './crypto';

/**
 * Produce a short masked form of an encrypted credential for display.
 * Decrypts, then returns `••••<last4>`. Returns `null` when there is no
 * credential to mask, and a bare `••••` if decryption fails (we never surface
 * the plaintext, and we never leak an exception to the caller).
 */
export function maskCredential(cipher: string | null | undefined): string | null {
  if (!cipher) return null;
  try {
    const plain = decrypt(cipher);
    if (!plain) return null;
    return '••••' + plain.slice(-4);
  } catch {
    return '••••';
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd enterprise_server && npx vitest run tests/vault/mask.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add enterprise_server/src/vault/mask.ts enterprise_server/tests/vault/mask.test.ts
git commit -m "feat(enterprise_server/vault): add credential masking helper"
```

---

### Task 3: Shared MCP marketplace view module

**Files:**
- Create: `enterprise_server/src/models/mcpMarketplaceView.ts`

**Interfaces:**
- Consumes: `maskCredential` (Task 2).
- Produces (used by Tasks 4, 5, 6, 8):
  - `export const UNCATEGORIZED = 'uncategorized' as const;`
  - `export const TRANSPORT_TYPES = ['stdio', 'sse', 'http'] as const;`
  - `export const AUTH_METHODS = ['none', 'bearer', 'api-key', 'oauth'] as const;`
  - `export type TransportType = typeof TRANSPORT_TYPES[number];`
  - `export type AuthMethod = typeof AUTH_METHODS[number];`
  - `export interface ServerRow { ... }` (all columns incl. new ones; `last_tested_at: Date | null`).
  - `export interface McpServerView { ... }` (wire shape).
  - `export interface CategoryRow { category_id: string; name_zh: string; name_en: string; display_order: number; }`
  - `export function mapServer(row: ServerRow): McpServerView`

No direct test (covered by the route tests in Tasks 4–8 which import and assert on the mapped fields).

- [ ] **Step 1: Write the module**

```ts
import { maskCredential } from '../vault/mask';

export const UNCATEGORIZED = 'uncategorized' as const;

export const TRANSPORT_TYPES = ['stdio', 'sse', 'http'] as const;
export type TransportType = typeof TRANSPORT_TYPES[number];

export const AUTH_METHODS = ['none', 'bearer', 'api-key', 'oauth'] as const;
export type AuthMethod = typeof AUTH_METHODS[number];

/** Single source of the SELECT column list used by the public catalog and
 *  the admin list route. Keep in sync with the 018 schema. */
export const SERVER_COLUMNS = `server_id, name, name_zh, description_en, description_zh, icon,
  category_id, transport_type, command, default_args, required_env_keys,
  optional_env_keys, kind, enabled, server_url, auth_method, credential_cipher,
  api_key_header, timeout_seconds, allowed_roles, last_status, last_latency_ms, last_tested_at`;

/** DB row shape for a marketplace server (post-018). */
export interface ServerRow {
  server_id: string;
  name: string;
  name_zh: string | null;
  description_en: string;
  description_zh: string | null;
  icon: string | null;
  category_id: string;
  transport_type: TransportType;
  command: string | null;
  default_args: unknown;
  required_env_keys: unknown;
  optional_env_keys: unknown;
  kind: 'single' | 'bundle';
  enabled: boolean;
  server_url: string | null;
  auth_method: AuthMethod;
  credential_cipher: string | null;
  api_key_header: string;
  timeout_seconds: number;
  allowed_roles: string[];
  last_status: string | null;
  last_latency_ms: number | null;
  last_tested_at: Date | null;
}

/** Wire shape returned by both the public catalog and the admin list. */
export interface McpServerView {
  id: string;
  name: string;
  name_zh: string | null;
  description: string;
  category: string;
  transportType: TransportType;
  serverUrl: string | null;
  command: string | null;
  authMethod: AuthMethod;
  credentialMasked: string | null;
  timeoutSeconds: number;
  allowedRoles: string[];
  enabled: boolean;
  lastStatus: string | null;
  lastLatencyMs: number | null;
  lastTestedAt: string | null;
}

export interface CategoryRow {
  category_id: string;
  name_zh: string;
  name_en: string;
  display_order: number;
}

export function mapServer(row: ServerRow): McpServerView {
  return {
    id: row.server_id,
    name: row.name,
    name_zh: row.name_zh,
    description: row.description_zh ?? row.description_en,
    category: row.category_id,
    transportType: row.transport_type,
    serverUrl: row.server_url,
    command: row.command,
    authMethod: row.auth_method,
    credentialMasked: maskCredential(row.credential_cipher),
    timeoutSeconds: row.timeout_seconds,
    allowedRoles: row.allowed_roles,
    enabled: row.enabled,
    lastStatus: row.last_status,
    lastLatencyMs: row.last_latency_ms,
    lastTestedAt: row.last_tested_at ? row.last_tested_at.toISOString() : null,
  };
}
```

- [ ] **Step 2: Verify it type-checks**

Run: `cd enterprise_server && npx tsc --noEmit`
Expected: PASS (no errors referencing this file).

- [ ] **Step 3: Commit**

```bash
git add enterprise_server/src/models/mcpMarketplaceView.ts
git commit -m "feat(enterprise_server): add mcp marketplace view types"
```

---

### Task 4: Role-vocabulary endpoint

**Files:**
- Create: `enterprise_server/src/routes/roleVocabulary.ts`
- Modify: `enterprise_server/src/server.ts` (mount)
- Test: `enterprise_server/tests/routes/roleVocabulary.test.ts`

**Interfaces:**
- Produces: `roleVocabularyRoutes` (Hono). `GET /api/roles/vocabulary` → `{ roles: string[] }` (sorted, deduped) = union of distinct `users.extra_roles`, distinct `positions.inherits_roles`, and the core constants `['super_admin','org_admin','policy_admin','model_admin','auditor','user']`. Gated `requireAuth` + `requireCapability('org_admin')`.

- [ ] **Step 1: Write the failing test**

```ts
import '../helpers/setupEnv';
import { beforeEach, describe, expect, test } from 'vitest';
vi.mock('../../src/db/pool', async () => {
  const td = await import('../../src/db/testDb');
  return { pool: td.testPool };
});
import { Hono } from 'hono';
import { signToken } from '../../src/auth/jwt';
import { resetSchema, runMigrations, testPool } from '../../src/db/testDb';
import { roleVocabularyRoutes } from '../../src/routes/roleVocabulary';

const app = new Hono();
app.route('/', roleVocabularyRoutes);
const tokenFor = (sub: string, orgId: string, roles: string[] = []) => signToken({ sub, orgId, roles });
const auth = (t: string) => ({ authorization: `Bearer ${t}` });

async function seedRoles(): Promise<void> {
  await testPool.query('INSERT INTO orgs(id, name) VALUES (\'o1\', \'T\') ON CONFLICT DO NOTHING');
  await testPool.query(`INSERT INTO positions(id, org_id, name, inherits_roles)
    VALUES ('p1', 'o1', 'Eng', '["engineer","qa"]'::jsonb) ON CONFLICT DO NOTHING`);
  await testPool.query(`INSERT INTO users(id, org_id, username, password_hash, extra_roles)
    VALUES ('u1', 'o1', 'u1', 'x', '["org_admin","engineer"]'::jsonb) ON CONFLICT DO NOTHING`);
  await testPool.query(`INSERT INTO users(id, org_id, username, password_hash, extra_roles)
    VALUES ('u2', 'o1', 'u2', 'x', '["support"]'::jsonb) ON CONFLICT DO NOTHING`);
}

describe('GET /api/roles/vocabulary', () => {
  beforeEach(async () => { await resetSchema(); await runMigrations(); await seedRoles(); });

  test('returns the union of extra_roles + inherits_roles + core constants', async () => {
    const tok = await tokenFor('a', 'o1', ['org_admin']);
    const res = await app.request('/api/roles/vocabulary', { headers: auth(tok) });
    expect(res.status).toBe(200);
    const body = await res.json() as { roles: string[] };
    // org_admin, engineer, qa, support (from users) + engineer,qa (positions)
    // + core constants. Deduped + sorted.
    for (const r of ['org_admin', 'engineer', 'qa', 'support', 'super_admin', 'model_admin']) {
      expect(body.roles).toContain(r);
    }
    // sorted
    expect(body.roles).toEqual([...body.roles].sort());
    // no duplicates
    expect(new Set(body.roles).size).toBe(body.roles.length);
  });

  test('403 for a non org_admin token', async () => {
    const tok = await tokenFor('u', 'o1', ['user']);
    const res = await app.request('/api/roles/vocabulary', { headers: auth(tok) });
    expect(res.status).toBe(403);
  });

  test('401 without a token', async () => {
    const res = await app.request('/api/roles/vocabulary');
    expect(res.status).toBe(401);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd enterprise_server && npx vitest run tests/routes/roleVocabulary.test.ts`
Expected: FAIL — module not found / route missing.

- [ ] **Step 3: Write the route**

```ts
import { Hono } from 'hono';
import { requireAuth, requireCapability } from '../auth/middleware';
import { pool } from '../db/pool';

const CORE_ROLES = ['super_admin', 'org_admin', 'policy_admin', 'model_admin', 'auditor', 'user'];

export const roleVocabularyRoutes = new Hono();
roleVocabularyRoutes.use('/api/roles/vocabulary', requireAuth);
roleVocabularyRoutes.use('/api/roles/vocabulary', requireCapability('org_admin'));

roleVocabularyRoutes.get('/api/roles/vocabulary', async (c) => {
  const u = await pool.query<{ roles: string[] }>(
    'SELECT extra_roles AS roles FROM users',
  );
  const p = await pool.query<{ roles: string[] | null }>(
    'SELECT inherits_roles AS roles FROM positions',
  );
  const set = new Set<string>(CORE_ROLES);
  for (const row of u.rows) for (const r of row.roles ?? []) set.add(r);
  for (const row of p.rows) for (const r of row.roles ?? []) set.add(r);
  return c.json({ roles: [...set].sort() });
});
```

- [ ] **Step 4: Mount it in server.ts**

In `enterprise_server/src/server.ts`, add the import next to the other route imports and the mount next to the other `app.route('/', ...)` lines:

```ts
import { roleVocabularyRoutes } from './routes/roleVocabulary';
```
```ts
  app.route('/', roleVocabularyRoutes);
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `cd enterprise_server && npx vitest run tests/routes/roleVocabulary.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 6: Commit**

```bash
git add enterprise_server/src/routes/roleVocabulary.ts enterprise_server/src/server.ts enterprise_server/tests/routes/roleVocabulary.test.ts
git commit -m "feat(enterprise_server): add role vocabulary endpoint"
```

---

### Task 5: Rewrite public catalog (role-filtered)

**Files:**
- Modify: `enterprise_server/src/routes/mcpMarketplace.ts`
- Test: `enterprise_server/tests/routes/mcpMarketplace.test.ts` (REWRITE)

**Interfaces:**
- Consumes: `mapServer`, `ServerRow`, `CategoryRow`, `McpServerView` (Task 3); `pool`.
- Produces: `mcpMarketplaceRoutes`. `GET /api/mcp-marketplace` → `{ categories, servers }`; a server is included only if `enabled = TRUE` AND (`super_admin` in `claims.roles` OR `allowed_roles ∩ claims.roles ≠ ∅`). `categories` = all categories `{ id, name_zh, name_en }` (unfiltered).

- [ ] **Step 1: Write the failing test (full rewrite)**

Replace the file content of `enterprise_server/tests/routes/mcpMarketplace.test.ts` with:

```ts
import '../helpers/setupEnv';
import { beforeEach, describe, expect, test } from 'vitest';
vi.mock('../../src/db/pool', async () => {
  const td = await import('../../src/db/testDb');
  return { pool: td.testPool };
});
import { Hono } from 'hono';
import { signToken } from '../../src/auth/jwt';
import { resetSchema, runMigrations, testPool } from '../../src/db/testDb';
import { mcpMarketplaceRoutes } from '../../src/routes/mcpMarketplace';

const app = new Hono();
app.route('/', mcpMarketplaceRoutes);
const tokenFor = (sub: string, orgId: string, roles: string[] = []) => signToken({ sub, orgId, roles });
const auth = (t: string) => ({ authorization: `Bearer ${t}` });

describe('GET /api/mcp-marketplace (role-filtered)', () => {
  beforeEach(async () => { await resetSchema(); await runMigrations(); });

  test('401 without a token', async () => {
    expect((await app.request('/api/mcp-marketplace')).status).toBe(401);
  });

  test('super_admin sees every enabled server, with new fields', async () => {
    const tok = await tokenFor('a', 'o1', ['super_admin']);
    const res = await app.request('/api/mcp-marketplace', { headers: auth(tok) });
    expect(res.status).toBe(200);
    const body = await res.json() as {
      categories: Array<{ id: string; name_zh: string; name_en: string }>;
      servers: Array<{ id: string; allowedRoles: string[]; timeoutSeconds: number; authMethod: string }>;
    };
    // uncategorized is present in categories.
    expect(body.categories.map((c) => c.id)).toContain('uncategorized');
    expect(body.servers.map((s) => s.id).sort()).toEqual(['exa-search', 'qichacha', 'tavily-search']);
    const q = body.servers.find((s) => s.id === 'qichacha')!;
    expect(q.allowedRoles).toEqual(['super_admin']);
    expect(q.timeoutSeconds).toBe(30);
    expect(q.authMethod).toBe('none');
  });

  test('non-super admin sees only servers whose allowed_roles intersect their roles', async () => {
    await testPool.query(`UPDATE mcp_marketplace_servers SET allowed_roles = '["org_admin"]'::jsonb WHERE server_id = 'exa-search'`);
    await testPool.query(`UPDATE mcp_marketplace_servers SET allowed_roles = '["policy_admin"]'::jsonb WHERE server_id = 'tavily-search'`);
    const tok = await tokenFor('u', 'o1', ['org_admin']);
    const res = await app.request('/api/mcp-marketplace', { headers: auth(tok) });
    const body = await res.json() as { servers: Array<{ id: string }> };
    // exa-search (org_admin) visible; qichacha/tavily-search (super_admin/policy_admin) not.
    expect(body.servers.map((s) => s.id)).toEqual(['exa-search']);
  });

  test('user with no matching role sees an empty list', async () => {
    const tok = await tokenFor('u', 'o1', ['no_such_role']);
    const res = await app.request('/api/mcp-marketplace', { headers: auth(tok) });
    const body = await res.json() as { servers: unknown[] };
    expect(body.servers).toEqual([]);
  });

  test('disabled servers never appear even to super_admin', async () => {
    await testPool.query(`UPDATE mcp_marketplace_servers SET enabled = FALSE WHERE server_id = 'exa-search'`);
    const tok = await tokenFor('a', 'o1', ['super_admin']);
    const res = await app.request('/api/mcp-marketplace', { headers: auth(tok) });
    const body = await res.json() as { servers: Array<{ id: string }> };
    expect(body.servers.map((s) => s.id).sort()).toEqual(['qichacha', 'tavily-search']);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd enterprise_server && npx vitest run tests/routes/mcpMarketplace.test.ts`
Expected: FAIL — the current route returns all enabled servers regardless of role.

- [ ] **Step 3: Rewrite the route**

Replace `enterprise_server/src/routes/mcpMarketplace.ts` with:

```ts
import { Hono } from 'hono';
import { requireAuth } from '../auth/middleware';
import { pool } from '../db/pool';
import { type CategoryRow, type McpServerView, SERVER_COLUMNS, type ServerRow, mapServer } from '../models/mcpMarketplaceView';

export const mcpMarketplaceRoutes = new Hono();
mcpMarketplaceRoutes.use('/api/mcp-marketplace', requireAuth);

mcpMarketplaceRoutes.get('/api/mcp-marketplace', async (c) => {
  const claims = c.get('claims');
  const userRoles: string[] = claims?.roles ?? [];
  const isSuper = userRoles.includes('super_admin');

  const categoriesResult = await pool.query<CategoryRow>(
    'SELECT category_id, name_zh, name_en, display_order FROM mcp_marketplace_categories ORDER BY display_order, category_id',
  );
  const serversResult = await pool.query<ServerRow>(
    `SELECT ${SERVER_COLUMNS} FROM mcp_marketplace_servers WHERE enabled = TRUE ORDER BY server_id`,
  );

  const visible = serversResult.rows.filter((row) => {
    if (isSuper) return true;
    return row.allowed_roles.some((r) => userRoles.includes(r));
  });

  return c.json({
    categories: categoriesResult.rows.map((r) => ({ id: r.category_id, name_zh: r.name_zh, name_en: r.name_en })),
    servers: visible.map(mapServer) as McpServerView[],
  });
});
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd enterprise_server && npx vitest run tests/routes/mcpMarketplace.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Lint**

Run: `cd enterprise_server && npx eslint --ext ts,tsx --report-unused-disable-directives --max-warnings 0 src/routes/mcpMarketplace.ts src/models/mcpMarketplaceView.ts`
Expected: clean.

- [ ] **Step 6: Commit**

```bash
git add enterprise_server/src/routes/mcpMarketplace.ts enterprise_server/tests/routes/mcpMarketplace.test.ts
git commit -m "feat(enterprise_server): role-filter the mcp marketplace catalog"
```

---

### Task 6: Admin CRUD (create / patch / delete) with v2 fields

**Files:**
- Modify: `enterprise_server/src/routes/mcpMarketplaceAdmin.ts`
- Test: `enterprise_server/tests/routes/mcpMarketplaceAdmin.test.ts` (NEW)

**Interfaces:**
- Consumes: `ServerRow`, `McpServerView`, `mapServer`, `AUTH_METHODS`, `TRANSPORT_TYPES`, `UNCATEGORIZED` (Task 3); `encrypt` from `src/vault/crypto`; `pool`.
- Produces: `mcpMarketplaceAdminRoutes` with:
  - `POST /api/admin/mcp-marketplace/servers` — create. Body: `server_id`, `name`, `name_zh?`, `description_en`, `description_zh?`, `icon?`, `category_id`, `transport_type`, `server_url?`, `command?`, `auth_method?`, `api_key_header?`, `credential?`, `timeout_seconds?`, `allowed_roles` (≥1). 400 on: missing name, bad `server_url` (must `^https?://` for http/sse), empty `allowed_roles`, unknown `category_id`.
  - `PUT /api/admin/mcp-marketplace/servers/:serverId` — partial patch; `credential` omitted/empty → keep existing ciphertext; new `credential` → re-encrypt. 404 if unknown.
  - `DELETE /api/admin/mcp-marketplace/servers/:serverId` — 404 if unknown.
  - Gated `requireAuth` + `requireCapability('org_admin')`.

- [ ] **Step 1: Write the failing test**

```ts
import '../helpers/setupEnv';
import { beforeEach, describe, expect, test } from 'vitest';
vi.mock('../../src/db/pool', async () => {
  const td = await import('../../src/db/testDb');
  return { pool: td.testPool };
});
import { Hono } from 'hono';
import { signToken } from '../../src/auth/jwt';
import { resetSchema, runMigrations, testPool } from '../../src/db/testDb';
import { mcpMarketplaceAdminRoutes } from '../../src/routes/mcpMarketplaceAdmin';

const app = new Hono();
app.route('/', mcpMarketplaceAdminRoutes);
const tokenFor = (sub: string, orgId: string, roles: string[] = []) => signToken({ sub, orgId, roles });
const auth = (t: string) => ({ authorization: `Bearer ${t}` });
const CT = { 'content-type': 'application/json' };
const adminTok = () => signToken({ sub: 'a', orgId: 'o1', roles: ['org_admin'] });

describe('admin mcp-marketplace CRUD', () => {
  beforeEach(async () => { await resetSchema(); await runMigrations(); });

  test('create a server with roles + credential; 403 for non-admin', async () => {
    const res = await app.request('/api/admin/mcp-marketplace/servers', {
      method: 'POST', headers: { ...auth(await adminTok()), ...CT },
      body: JSON.stringify({
        server_id: 'gitlab', name: 'GitLab', description_en: 'd', category_id: 'search',
        transport_type: 'http', server_url: 'https://git.internal/mcp',
        auth_method: 'bearer', credential: 'glpat-2k9d', allowed_roles: ['super_admin', 'org_admin'],
      }),
    });
    expect(res.status).toBe(200);

    const bad = await app.request('/api/admin/mcp-marketplace/servers', {
      method: 'POST', headers: { ...auth(await signToken({ sub: 'u', orgId: 'o1', roles: [] })), ...CT },
      body: JSON.stringify({ server_id: 'x', name: 'X', description_en: 'd', category_id: 'search', transport_type: 'http', allowed_roles: ['user'] }),
    });
    expect(bad.status).toBe(403);
  });

  test('create rejects empty allowed_roles and bad server_url', async () => {
    const emptyRoles = await app.request('/api/admin/mcp-marketplace/servers', {
      method: 'POST', headers: { ...auth(await adminTok()), ...CT },
      body: JSON.stringify({ server_id: 'a', name: 'A', description_en: 'd', category_id: 'search', transport_type: 'http', server_url: 'https://x/mcp', allowed_roles: [] }),
    });
    expect(emptyRoles.status).toBe(400);
    const badUrl = await app.request('/api/admin/mcp-marketplace/servers', {
      method: 'POST', headers: { ...auth(await adminTok()), ...CT },
      body: JSON.stringify({ server_id: 'b', name: 'B', description_en: 'd', category_id: 'search', transport_type: 'http', server_url: 'not-a-url', allowed_roles: ['user'] }),
    });
    expect(badUrl.status).toBe(400);
  });

  test('create rejects unknown category', async () => {
    const res = await app.request('/api/admin/mcp-marketplace/servers', {
      method: 'POST', headers: { ...auth(await adminTok()), ...CT },
      body: JSON.stringify({ server_id: 'c', name: 'C', description_en: 'd', category_id: 'nope', transport_type: 'http', server_url: 'https://x/mcp', allowed_roles: ['user'] }),
    });
    expect(res.status).toBe(400);
  });

  test('patch keeps credential when omitted, and updates fields', async () => {
    await app.request('/api/admin/mcp-marketplace/servers', {
      method: 'POST', headers: { ...auth(await adminTok()), ...CT },
      body: JSON.stringify({ server_id: 's1', name: 'S', description_en: 'd', category_id: 'search', transport_type: 'http', server_url: 'https://x/mcp', auth_method: 'bearer', credential: 'secret-7788', allowed_roles: ['super_admin'] }),
    });
    const put = await app.request('/api/admin/mcp-marketplace/servers/s1', {
      method: 'PUT', headers: { ...auth(await adminTok()), ...CT },
      body: JSON.stringify({ name: 'S2', enabled: false }),
    });
    expect(put.status).toBe(204);
    const row = await testPool.query<{ name: string; credential_cipher: string | null; enabled: boolean }>(
      'SELECT name, credential_cipher, enabled FROM mcp_marketplace_servers WHERE server_id=$1', ['s1'],
    );
    expect(row.rows[0].name).toBe('S2');
    expect(row.rows[0].enabled).toBe(false);
    expect(row.rows[0].credential_cipher).toBeTruthy(); // unchanged
  });

  test('patch 404 for unknown id; delete removes row', async () => {
    const missing = await app.request('/api/admin/mcp-marketplace/servers/zzz', { method: 'PUT', headers: { ...auth(await adminTok()), ...CT }, body: JSON.stringify({ name: 'x' }) });
    expect(missing.status).toBe(404);
    await app.request('/api/admin/mcp-marketplace/servers', {
      method: 'POST', headers: { ...auth(await adminTok()), ...CT },
      body: JSON.stringify({ server_id: 'd1', name: 'D', description_en: 'd', category_id: 'search', transport_type: 'http', server_url: 'https://x/mcp', allowed_roles: ['user'] }),
    });
    const del = await app.request('/api/admin/mcp-marketplace/servers/d1', { method: 'DELETE', headers: auth(await adminTok()) });
    expect(del.status).toBe(204);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd enterprise_server && npx vitest run tests/routes/mcpMarketplaceAdmin.test.ts`
Expected: FAIL — current route lacks `server_url`/`allowed_roles`/`credential` handling.

- [ ] **Step 3: Rewrite the route (CRUD portion)**

Replace the **server** handlers in `enterprise_server/src/routes/mcpMarketplaceAdmin.ts` (keep the category handlers from Task 7 — they are appended in that task). Write the whole file as:

```ts
import { Hono } from 'hono';
import { z } from 'zod';
import { requireAuth, requireCapability } from '../auth/middleware';
import { pool } from '../db/pool';
import { type AuthMethod, type TransportType } from '../models/mcpMarketplaceView';
import { encrypt } from '../vault/crypto';

const transportEnum = z.enum(['stdio', 'sse', 'http']);
const authEnum = z.enum(['none', 'bearer', 'api-key', 'oauth']);

const serverWriteSchema = z.object({
  server_id: z.string().min(1),
  name: z.string().min(1),
  name_zh: z.string().optional(),
  description_en: z.string().min(1),
  description_zh: z.string().optional(),
  icon: z.string().optional(),
  category_id: z.string().min(1),
  transport_type: transportEnum,
  server_url: z.string().url().optional(),
  command: z.string().optional(),
  auth_method: authEnum.optional(),
  api_key_header: z.string().optional(),
  credential: z.string().optional(),
  timeout_seconds: z.number().int().min(1).max(600).optional(),
  allowed_roles: z.array(z.string().min(1)).min(1),
});

const serverPatch = z.object({
  name: z.string().min(1).optional(),
  name_zh: z.string().optional(),
  description_en: z.string().min(1).optional(),
  description_zh: z.string().optional(),
  icon: z.string().optional(),
  category_id: z.string().min(1).optional(),
  transport_type: transportEnum.optional(),
  server_url: z.string().url().optional(),
  command: z.string().optional(),
  auth_method: authEnum.optional(),
  api_key_header: z.string().optional(),
  credential: z.string().optional(),
  timeout_seconds: z.number().int().min(1).max(600).optional(),
  allowed_roles: z.array(z.string().min(1)).min(1).optional(),
  enabled: z.boolean().optional(),
});

async function categoryExists(categoryId: string): Promise<boolean> {
  const r = await pool.query<{ exists: boolean }>(
    'SELECT EXISTS(SELECT 1 FROM mcp_marketplace_categories WHERE category_id = $1) AS exists',
    [categoryId],
  );
  return r.rows[0]?.exists === true;
}

function badUrlForTransport(transport: TransportType, url: string | undefined): boolean {
  if (transport === 'stdio') return false; // url optional for stdio
  if (!url) return true;
  return !/^https?:\/\//.test(url);
}

export const mcpMarketplaceAdminRoutes = new Hono();
mcpMarketplaceAdminRoutes.use('/api/admin/mcp-marketplace/*', requireAuth);
mcpMarketplaceAdminRoutes.use('/api/admin/mcp-marketplace/*', requireCapability('org_admin'));

mcpMarketplaceAdminRoutes.post('/api/admin/mcp-marketplace/servers', async (c) => {
  const parsed = serverWriteSchema.safeParse(await c.req.json());
  if (!parsed.success) return c.json({ error: 'invalid_body', issues: parsed.error.issues }, 400);
  const b = parsed.data;
  if (!(await categoryExists(b.category_id))) return c.json({ error: 'unknown_category' }, 400);
  if (badUrlForTransport(b.transport_type, b.server_url)) return c.json({ error: 'bad_server_url' }, 400);
  if (b.allowed_roles.length === 0) return c.json({ error: 'no_roles' }, 400);
  const authMethod: AuthMethod = b.auth_method ?? 'none';
  const cipher = b.credential && b.credential.length > 0 ? encrypt(b.credential) : null;
  await pool.query(
    `INSERT INTO mcp_marketplace_servers
       (server_id, name, name_zh, description_en, description_zh, icon, category_id,
        transport_type, command, server_url, auth_method, credential_cipher, api_key_header,
        timeout_seconds, allowed_roles, enabled)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15::jsonb,TRUE)`,
    [b.server_id, b.name, b.name_zh ?? null, b.description_en, b.description_zh ?? null,
     b.icon ?? null, b.category_id, b.transport_type, b.command ?? null, b.server_url ?? null,
     authMethod, cipher, b.api_key_header ?? '', b.timeout_seconds ?? 30,
     JSON.stringify(b.allowed_roles)],
  );
  return c.json({ server_id: b.server_id });
});

mcpMarketplaceAdminRoutes.put('/api/admin/mcp-marketplace/servers/:serverId', async (c) => {
  const id = c.req.param('serverId');
  const parsed = serverPatch.safeParse(await c.req.json());
  if (!parsed.success) return c.json({ error: 'invalid_body', issues: parsed.error.issues }, 400);
  const b = parsed.data;
  if (b.category_id && !(await categoryExists(b.category_id))) return c.json({ error: 'unknown_category' }, 400);

  // Determine the final credential: re-encrypt if a non-empty credential was sent.
  const wantNewCredential = typeof b.credential === 'string' && b.credential.length > 0;
  const sets: string[] = [];
  const params: unknown[] = [id];
  const push = (col: string, val: unknown) => { params.push(val); sets.push(`${col} = $${params.length}`); };

  if (b.name !== undefined) push('name', b.name);
  if (b.name_zh !== undefined) push('name_zh', b.name_zh);
  if (b.description_en !== undefined) push('description_en', b.description_en);
  if (b.description_zh !== undefined) push('description_zh', b.description_zh);
  if (b.icon !== undefined) push('icon', b.icon);
  if (b.category_id !== undefined) push('category_id', b.category_id);
  if (b.transport_type !== undefined) push('transport_type', b.transport_type);
  if (b.server_url !== undefined) push('server_url', b.server_url);
  if (b.command !== undefined) push('command', b.command);
  if (b.auth_method !== undefined) push('auth_method', b.auth_method);
  if (b.api_key_header !== undefined) push('api_key_header', b.api_key_header);
  if (b.timeout_seconds !== undefined) push('timeout_seconds', b.timeout_seconds);
  if (b.enabled !== undefined) push('enabled', b.enabled);
  if (b.allowed_roles !== undefined) { if (b.allowed_roles.length === 0) return c.json({ error: 'no_roles' }, 400); push('allowed_roles', JSON.stringify(b.allowed_roles)); }
  if (wantNewCredential) push('credential_cipher', encrypt(b.credential!));

  if (sets.length === 0) return c.json({ error: 'empty_patch' }, 400);
  const result = await pool.query(
    `UPDATE mcp_marketplace_servers SET ${sets.join(', ')}, updated_at = NOW() WHERE server_id = $1`,
    params,
  );
  if (result.rowCount === 0) return c.json({ error: 'not_found' }, 404);
  return c.body(null, 204);
});

mcpMarketplaceAdminRoutes.delete('/api/admin/mcp-marketplace/servers/:serverId', async (c) => {
  const id = c.req.param('serverId');
  const result = await pool.query('DELETE FROM mcp_marketplace_servers WHERE server_id = $1', [id]);
  if (result.rowCount === 0) return c.json({ error: 'not_found' }, 404);
  return c.body(null, 204);
});

// Category endpoints are added in Task 7.
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd enterprise_server && npx vitest run tests/routes/mcpMarketplaceAdmin.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Lint**

Run: `cd enterprise_server && npx eslint --ext ts,tsx --report-unused-disable-directives --max-warnings 0 src/routes/mcpMarketplaceAdmin.ts`
Expected: clean.

- [ ] **Step 6: Commit**

```bash
git add enterprise_server/src/routes/mcpMarketplaceAdmin.ts enterprise_server/tests/routes/mcpMarketplaceAdmin.test.ts
git commit -m "feat(enterprise_server): rebuild mcp marketplace admin CRUD for v2 fields"
```

---

### Task 7: Admin read endpoints + category migrate-on-delete

**Files:**
- Modify: `enterprise_server/src/routes/mcpMarketplaceAdmin.ts`
- Test: `enterprise_server/tests/routes/mcpMarketplaceAdmin.test.ts` (append)

**Interfaces:**
- Consumes: Task 6 route; `mapServer`, `ServerRow`, `CategoryRow` (Task 3); `UNCATEGORIZED`.
- Produces:
  - `GET /api/admin/mcp-marketplace/servers` → `McpServerView[]` (all servers, enabled + disabled).
  - `GET /api/admin/mcp-marketplace/categories` → `{ id, name_zh, name_en, display_order }[]`.
  - `POST /categories`, `PUT /categories/:id`, `DELETE /categories/:id` — create/patch unchanged; **delete migrates the category's servers to `uncategorized`, then deletes the category; returns `409` if the target id is `uncategorized`.**

- [ ] **Step 1: Append failing tests**

Append to `enterprise_server/tests/routes/mcpMarketplaceAdmin.test.ts`:

```ts
describe('admin mcp-marketplace reads + category delete', () => {
  beforeEach(async () => { await resetSchema(); await runMigrations(); });
  const CT = { 'content-type': 'application/json' };
  const adminTok = () => signToken({ sub: 'a', orgId: 'o1', roles: ['org_admin'] });
  const auth = (t: string) => ({ authorization: `Bearer ${t}` });

  test('GET /servers lists all (enabled + disabled) with mapped fields', async () => {
    await testPool.query(`UPDATE mcp_marketplace_servers SET enabled = FALSE WHERE server_id = 'exa-search'`);
    const res = await app.request('/api/admin/mcp-marketplace/servers', { headers: auth(await adminTok()) });
    expect(res.status).toBe(200);
    const body = await res.json() as Array<{ id: string; enabled: boolean; timeoutSeconds: number }>;
    expect(body.map((s) => s.id).sort()).toEqual(['exa-search', 'qichacha', 'tavily-search']);
    expect(body.find((s) => s.id === 'exa-search')!.enabled).toBe(false);
    expect(body.find((s) => s.id === 'qichacha')!.timeoutSeconds).toBe(30);
  });

  test('GET /categories includes uncategorized', async () => {
    const res = await app.request('/api/admin/mcp-marketplace/categories', { headers: auth(await adminTok()) });
    expect(res.status).toBe(200);
    const body = await res.json() as Array<{ id: string }>;
    expect(body.map((c) => c.id)).toContain('uncategorized');
  });

  test('DELETE category migrates its servers into uncategorized', async () => {
    // put a server into the 'search' category and delete 'search'.
    const res = await app.request('/api/admin/mcp-marketplace/categories/search', { method: 'DELETE', headers: auth(await adminTok()) });
    expect(res.status).toBe(204);
    const rows = await testPool.query<{ n: number }>(
      `SELECT COUNT(*)::int AS n FROM mcp_marketplace_servers WHERE category_id='uncategorized' AND server_id IN ('exa-search','tavily-search')`,
    );
    expect(rows.rows[0].n).toBe(2);
    const gone = await testPool.query<{ n: number }>(
      `SELECT COUNT(*)::int AS n FROM mcp_marketplace_categories WHERE category_id='search'`,
    );
    expect(gone.rows[0].n).toBe(0);
  });

  test('DELETE uncategorized is 409', async () => {
    const res = await app.request('/api/admin/mcp-marketplace/categories/uncategorized', { method: 'DELETE', headers: auth(await adminTok()) });
    expect(res.status).toBe(409);
  });

  test('POST + PUT category work', async () => {
    const post = await app.request('/api/admin/mcp-marketplace/categories', {
      method: 'POST', headers: { ...auth(await adminTok()), ...CT },
      body: JSON.stringify({ category_id: 'design', name_zh: '设计', name_en: 'Design' }),
    });
    expect(post.status).toBe(200);
    const put = await app.request('/api/admin/mcp-marketplace/categories/design', {
      method: 'PUT', headers: { ...auth(await adminTok()), ...CT },
      body: JSON.stringify({ name_zh: '设计工具' }),
    });
    expect(put.status).toBe(204);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd enterprise_server && npx vitest run tests/routes/mcpMarketplaceAdmin.test.ts`
Expected: FAIL — the read endpoints + migrate-on-delete are not implemented (current file was reduced in Task 6).

- [ ] **Step 3: Add the reads + category handlers**

Append to `enterprise_server/src/routes/mcpMarketplaceAdmin.ts` (after the DELETE server handler). Also import `mapServer`/`ServerRow`/`CategoryRow`/`SERVER_COLUMNS` from the view module (all already exported there by Tasks 3 and 6).

```ts
import { type CategoryRow, type ServerRow, SERVER_COLUMNS, UNCATEGORIZED, mapServer } from '../models/mcpMarketplaceView';

mcpMarketplaceAdminRoutes.get('/api/admin/mcp-marketplace/servers', async (c) => {
  const r = await pool.query<ServerRow>(`SELECT ${SERVER_COLUMNS} FROM mcp_marketplace_servers ORDER BY server_id`);
  return c.json(r.rows.map(mapServer));
});

mcpMarketplaceAdminRoutes.get('/api/admin/mcp-marketplace/categories', async (c) => {
  const r = await pool.query<CategoryRow>(
    'SELECT category_id, name_zh, name_en, display_order FROM mcp_marketplace_categories ORDER BY display_order, category_id',
  );
  return c.json(r.rows.map((row) => ({ id: row.category_id, name_zh: row.name_zh, name_en: row.name_en, display_order: row.display_order })));
});

const categoryWriteSchema = z.object({
  category_id: z.string().min(1),
  name_zh: z.string().min(1),
  name_en: z.string().min(1),
  display_order: z.number().int().optional(),
});
const categoryPatchSchema = categoryWriteSchema.partial();

mcpMarketplaceAdminRoutes.post('/api/admin/mcp-marketplace/categories', async (c) => {
  const parsed = categoryWriteSchema.safeParse(await c.req.json());
  if (!parsed.success) return c.json({ error: 'invalid_body', issues: parsed.error.issues }, 400);
  await pool.query(
    `INSERT INTO mcp_marketplace_categories (category_id, name_zh, name_en, display_order)
     VALUES ($1,$2,$3,COALESCE($4,0)) ON CONFLICT (category_id) DO NOTHING`,
    [parsed.data.category_id, parsed.data.name_zh, parsed.data.name_en, parsed.data.display_order ?? null],
  );
  return c.json({ category_id: parsed.data.category_id });
});

mcpMarketplaceAdminRoutes.put('/api/admin/mcp-marketplace/categories/:categoryId', async (c) => {
  const id = c.req.param('categoryId');
  const parsed = categoryPatchSchema.safeParse(await c.req.json());
  if (!parsed.success) return c.json({ error: 'invalid_body', issues: parsed.error.issues }, 400);
  const result = await pool.query(
    `UPDATE mcp_marketplace_categories SET
       name_zh = COALESCE($2, name_zh), name_en = COALESCE($3, name_en),
       display_order = COALESCE($4, display_order) WHERE category_id = $1`,
    [id, parsed.data.name_zh ?? null, parsed.data.name_en ?? null, parsed.data.display_order ?? null],
  );
  if (result.rowCount === 0) return c.json({ error: 'not_found' }, 404);
  return c.body(null, 204);
});

// Migrate-on-delete: move the category's servers into 未分类, then delete it.
mcpMarketplaceAdminRoutes.delete('/api/admin/mcp-marketplace/categories/:categoryId', async (c) => {
  const id = c.req.param('categoryId');
  if (id === UNCATEGORIZED) return c.json({ error: 'reserved_category' }, 409);
  await pool.query('UPDATE mcp_marketplace_servers SET category_id = $1 WHERE category_id = $2', [UNCATEGORIZED, id]);
  const result = await pool.query('DELETE FROM mcp_marketplace_categories WHERE category_id = $1', [id]);
  if (result.rowCount === 0) return c.json({ error: 'not_found' }, 404);
  return c.body(null, 204);
});
```

- [ ] **Step 4: Confirm the public route uses the shared column list**

`mcpMarketplace.ts` (Task 5) already imports `SERVER_COLUMNS` from the view module — no local const remains. Verify with:

Run: `cd enterprise_server && grep -c "const SERVER_COLUMNS" src/routes/mcpMarketplace.ts`
Expected: `0`.

- [ ] **Step 5: Run the test to verify it passes**

Run: `cd enterprise_server && npx vitest run tests/routes/mcpMarketplaceAdmin.test.ts`
Expected: PASS (all tests, incl. the 5 new ones).

- [ ] **Step 6: Lint + run the full MCP backend tests**

Run: `cd enterprise_server && npx eslint --ext ts,tsx --report-unused-disable-directives --max-warnings 0 src/routes/mcpMarketplaceAdmin.ts src/routes/mcpMarketplace.ts src/models/mcpMarketplaceView.ts`
Run: `cd enterprise_server && npx vitest run tests/routes/mcpMarketplace.test.ts tests/routes/mcpMarketplaceAdmin.test.ts tests/routes/roleVocabulary.test.ts`
Expected: clean lint; all pass.

- [ ] **Step 7: Commit**

```bash
git add enterprise_server/src/routes/mcpMarketplaceAdmin.ts enterprise_server/src/routes/mcpMarketplace.ts enterprise_server/src/models/mcpMarketplaceView.ts enterprise_server/tests/routes/mcpMarketplaceAdmin.test.ts
git commit -m "feat(enterprise_server): add mcp admin reads and migrate-on category delete"
```

---

### Task 8: Test-connection probe

**Files:**
- Modify: `enterprise_server/src/routes/mcpMarketplaceAdmin.ts`
- Test: `enterprise_server/tests/routes/mcpMarketplaceAdmin.test.ts` (append)

**Interfaces:**
- Consumes: Task 7 route; `decrypt` from `src/vault/crypto`.
- Produces: `POST /api/admin/mcp-marketplace/servers/:serverId/test` → `{ status, latencyMs, error? }`; persists `last_status`, `last_latency_ms`, `last_tested_at = NOW()`. Behavior:
  - `stdio` → `{ status: 'unknown', error: 'stdio_not_probeable' }` (no command spawn), and persist `last_status='unknown'`.
  - `http`/`sse` → `fetch(server_url, { headers, signal: AbortSignal.timeout(10000) })`. Headers: `bearer` → `{ 'Authorization': 'Bearer <cred>' }`; `api-key` → if `api_key_header` non-empty, `{ [api_key_header]: <cred> }` else `{}`; else `{}`. 2xx/3xx → `connected`; else `failed` with `error = 'http_<status>'`. On network/abort error → `failed` with `error = 'network_error'`.

- [ ] **Step 1: Append failing tests**

```ts
describe('mcp-marketplace test-connection probe', () => {
  beforeEach(async () => { await resetSchema(); await runMigrations(); });
  const adminTok = () => signToken({ sub: 'a', orgId: 'o1', roles: ['org_admin'] });
  const auth = (t: string) => ({ authorization: `Bearer ${t}` });

  async function seedHttpServer(id: string, transport: string, authMethod: string, url: string): Promise<void> {
    await testPool.query(
      `INSERT INTO mcp_marketplace_servers
         (server_id, name, description_en, category_id, transport_type, server_url, auth_method, allowed_roles)
       VALUES ($1, $2, 'd', 'search', $3, $4, $5, '["super_admin"]'::jsonb)`,
      [id, id, transport, url, authMethod],
    );
  }

  test('http 200 -> connected, persists latency', async () => {
    await seedHttpServer('probe-ok', 'http', 'bearer', 'https://up.example/mcp');
    const fetchMock = vi.fn().mockResolvedValue(new Response('ok', { status: 200 }));
    (globalThis as unknown as { fetch: unknown }).fetch = fetchMock;
    const res = await app.request('/api/admin/mcp-marketplace/servers/probe-ok/test', { method: 'POST', headers: auth(await adminTok()) });
    expect(res.status).toBe(200);
    const body = await res.json() as { status: string };
    expect(body.status).toBe('connected');
    const row = await testPool.query<{ last_status: string; last_tested_at: string | null }>(
      'SELECT last_status, last_tested_at FROM mcp_marketplace_servers WHERE server_id=$1', ['probe-ok']);
    expect(row.rows[0].last_status).toBe('connected');
    expect(row.rows[0].last_tested_at).toBeTruthy();
    // bearer header was used
    const call = fetchMock.mock.calls[0] as [string, RequestInit];
    expect((call[1].headers as Record<string, string>)['Authorization']).toBe('Bearer ');
  });

  test('http 500 -> failed with error', async () => {
    await seedHttpServer('probe-bad', 'http', 'none', 'https://up.example/mcp');
    (globalThis as unknown as { fetch: unknown }).fetch = vi.fn().mockResolvedValue(new Response('err', { status: 500 }));
    const res = await app.request('/api/admin/mcp-marketplace/servers/probe-bad/test', { method: 'POST', headers: auth(await adminTok()) });
    const body = await res.json() as { status: string; error: string };
    expect(body.status).toBe('failed');
    expect(body.error).toBe('http_500');
  });

  test('stdio -> unknown, no fetch', async () => {
    await testPool.query(
      `INSERT INTO mcp_marketplace_servers (server_id, name, description_en, category_id, transport_type, command, allowed_roles)
       VALUES ('probe-stdio', 'x', 'd', 'search', 'stdio', 'npx -y docs', '["super_admin"]'::jsonb)`,
    );
    const fetchMock = vi.fn();
    (globalThis as unknown as { fetch: unknown }).fetch = fetchMock;
    const res = await app.request('/api/admin/mcp-marketplace/servers/probe-stdio/test', { method: 'POST', headers: auth(await adminTok()) });
    const body = await res.json() as { status: string };
    expect(body.status).toBe('unknown');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test('unknown server 404', async () => {
    const res = await app.request('/api/admin/mcp-marketplace/servers/nope/test', { method: 'POST', headers: auth(await adminTok()) });
    expect(res.status).toBe(404);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd enterprise_server && npx vitest run tests/routes/mcpMarketplaceAdmin.test.ts`
Expected: FAIL — probe route missing.

- [ ] **Step 3: Add the probe handler**

Append to `enterprise_server/src/routes/mcpMarketplaceAdmin.ts`:

```ts
mcpMarketplaceAdminRoutes.post('/api/admin/mcp-marketplace/servers/:serverId/test', async (c) => {
  const id = c.req.param('serverId');
  const r = await pool.query<{
    transport_type: TransportType; server_url: string | null; auth_method: AuthMethod;
    credential_cipher: string | null; api_key_header: string;
  }>(
    `SELECT transport_type, server_url, auth_method, credential_cipher, api_key_header
     FROM mcp_marketplace_servers WHERE server_id = $1`, [id],
  );
  if (r.rowCount === 0) return c.json({ error: 'not_found' }, 404);
  const row = r.rows[0];

  const persist = (status: string, latencyMs: number | null) =>
    pool.query('UPDATE mcp_marketplace_servers SET last_status=$2, last_latency_ms=$3, last_tested_at=NOW() WHERE server_id=$1',
      [id, status, latencyMs]);

  if (row.transport_type === 'stdio') {
    await persist('unknown', null);
    return c.json({ status: 'unknown', error: 'stdio_not_probeable' });
  }
  if (!row.server_url) { await persist('failed', null); return c.json({ status: 'failed', error: 'no_url' }); }

  let cred: string | null = null;
  if (row.credential_cipher) { try { cred = decrypt(row.credential_cipher); } catch { cred = null; } }
  const headers: Record<string, string> = {};
  if (row.auth_method === 'bearer' && cred) headers['Authorization'] = `Bearer ${cred}`;
  else if (row.auth_method === 'api-key' && cred && row.api_key_header) headers[row.api_key_header] = cred;

  const started = Date.now();
  let status: string; let error: string | undefined; let latencyMs = Date.now() - started;
  try {
    const resp = await fetch(row.server_url, { headers, signal: AbortSignal.timeout(10_000) });
    latencyMs = Date.now() - started;
    if (resp.status >= 200 && resp.status < 400) { status = 'connected'; }
    else { status = 'failed'; error = `http_${resp.status}`; }
  } catch {
    status = 'failed'; error = 'network_error';
  }
  await persist(status, status === 'connected' ? latencyMs : null);
  return c.json({ status, latencyMs: status === 'connected' ? latencyMs : undefined, ...(error ? { error } : {}) });
});
```

> Import `decrypt` from `../vault/crypto` at the top.

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd enterprise_server && npx vitest run tests/routes/mcpMarketplaceAdmin.test.ts`
Expected: PASS (all tests).

- [ ] **Step 5: Lint**

Run: `cd enterprise_server && npx eslint --ext ts,tsx --report-unused-disable-directives --max-warnings 0 src/routes/mcpMarketplaceAdmin.ts`
Expected: clean.

- [ ] **Step 6: Commit**

```bash
git add enterprise_server/src/routes/mcpMarketplaceAdmin.ts enterprise_server/tests/routes/mcpMarketplaceAdmin.test.ts
git commit -m "feat(enterprise_server): add mcp test-connection probe"
```

---

### Task 9: SPA `put` client + MCP marketplace API module

**Files:**
- Modify: `enterprise_server/web/src/api/client.ts`
- Create: `enterprise_server/web/src/api/mcpMarketplace.ts`

**Interfaces:**
- Produces: `apiClient.put<T>(path, body?)`.
- `McpServer`, `McpCategory` types; `mcpMarketplaceApi` with `listServers()`, `listCategories()`, `createServer(input)`, `updateServer(id, input)`, `deleteServer(id)`, `testServer(id)`, `listRoleVocabulary()`, `createCategory(input)`, `updateCategory(id, input)`, `deleteCategory(id)`.

- [ ] **Step 1: Add `put` to the client**

In `enterprise_server/web/src/api/client.ts`, add `put` to the `ApiClient` interface (next to `patch`) and to the returned object:

```ts
  put<T = unknown>(path: string, body?: unknown): Promise<T>;
```
```ts
  put: <T>(p: string, body?: unknown) => call<T>('PUT', p, body),
```
(Confirm `call()` accepts a method string; it already handles GET/POST/PATCH/DELETE — verify the internal `call` signature accepts `'PUT'`. If `call` hard-codes method validation, add `'PUT'` to its allowed set.)

- [ ] **Step 2: Write the API module**

```ts
import { apiClient } from './client';

export type TransportType = 'stdio' | 'sse' | 'http';
export type AuthMethod = 'none' | 'bearer' | 'api-key' | 'oauth';

export interface McpCategory {
  id: string;
  name_zh: string;
  name_en: string;
  display_order?: number;
}

export interface McpServer {
  id: string;
  name: string;
  name_zh: string | null;
  description: string;
  category: string;
  transportType: TransportType;
  serverUrl: string | null;
  command: string | null;
  authMethod: AuthMethod;
  credentialMasked: string | null;
  timeoutSeconds: number;
  allowedRoles: string[];
  enabled: boolean;
  lastStatus: string | null;
  lastLatencyMs: number | null;
  lastTestedAt: string | null;
}

export interface ServerInput {
  server_id: string;
  name: string;
  description_en: string;
  category_id: string;
  transport_type: TransportType;
  server_url?: string;
  command?: string;
  auth_method?: AuthMethod;
  api_key_header?: string;
  credential?: string;
  timeout_seconds?: number;
  allowed_roles: string[];
}

export interface ServerPatch {
  name?: string;
  description_en?: string;
  category_id?: string;
  transport_type?: TransportType;
  server_url?: string;
  auth_method?: AuthMethod;
  api_key_header?: string;
  credential?: string;
  timeout_seconds?: number;
  allowed_roles?: string[];
  enabled?: boolean;
}

export interface ProbeResult { status: string; latencyMs?: number; error?: string; }

export const mcpMarketplaceApi = {
  listServers: () => apiClient.get<McpServer[]>('/api/admin/mcp-marketplace/servers'),
  listCategories: () => apiClient.get<McpCategory[]>('/api/admin/mcp-marketplace/categories'),
  listRoleVocabulary: () => apiClient.get<{ roles: string[] }>('/api/roles/vocabulary'),
  createServer: (input: ServerInput) => apiClient.post<{ server_id: string }>('/api/admin/mcp-marketplace/servers', input),
  updateServer: (id: string, input: ServerPatch) => apiClient.put<void>(`/api/admin/mcp-marketplace/servers/${id}`, input),
  deleteServer: (id: string) => apiClient.delete(`/api/admin/mcp-marketplace/servers/${id}`),
  testServer: (id: string) => apiClient.post<ProbeResult>(`/api/admin/mcp-marketplace/servers/${id}/test`),
  createCategory: (input: { category_id: string; name_zh: string; name_en: string }) =>
    apiClient.post<{ category_id: string }>('/api/admin/mcp-marketplace/categories', input),
  updateCategory: (id: string, input: { name_zh?: string; name_en?: string }) =>
    apiClient.put<void>(`/api/admin/mcp-marketplace/categories/${id}`, input),
  deleteCategory: (id: string) => apiClient.delete(`/api/admin/mcp-marketplace/categories/${id}`),
};
```

- [ ] **Step 3: Type-check the web package**

Run: `cd enterprise_server/web && npx tsc --noEmit`
Expected: PASS. (If the web package has no `tsc` script, run `npx tsc --noEmit -p tsconfig.json`.)

- [ ] **Step 4: Lint**

Run: `cd enterprise_server/web && npx eslint --ext ts,tsx --report-unused-disable-directives --max-warnings 0 src/api/client.ts src/api/mcpMarketplace.ts`
Expected: clean.

- [ ] **Step 5: Commit**

```bash
git add enterprise_server/web/src/api/client.ts enterprise_server/web/src/api/mcpMarketplace.ts
git commit -m "feat(enterprise_server/web): add mcp marketplace api module and put client"
```

---

### Task 10: `autoIcon` helper

**Files:**
- Create: `enterprise_server/web/src/lib/autoIcon.ts`
- Test: `enterprise_server/web/tests/lib/autoIcon.test.ts`

**Interfaces:**
- Produces: `autoIcon(seed: string): string` — deterministic emoji from a small pool, keyed by a stable string hash.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, test } from 'vitest';
import { autoIcon } from '../../src/lib/autoIcon';

describe('autoIcon', () => {
  test('is deterministic for the same name', () => {
    expect(autoIcon('企查查')).toBe(autoIcon('企查查'));
  });
  test('returns a non-empty string for empty input', () => {
    expect(autoIcon('')).toBeTruthy();
  });
  test('stably maps different names into the pool', () => {
    const a = autoIcon('a');
    const b = autoIcon('b');
    expect(typeof a).toBe('string');
    expect(typeof b).toBe('string');
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd enterprise_server/web && npx vitest run tests/lib/autoIcon.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the helper**

```ts
const ICON_POOL = ['🧩', '📦', '🚀', '🤖', '🧠', '🛰', '🧲', '🔧', '🔌', '📡', '🧾', '📚'];

/** Deterministic emoji for a name (no per-entity icon column). Same name → same icon. */
export function autoIcon(seed: string): string {
  let h = 0;
  for (let i = 0; i < seed.length; i++) {
    h = (h * 31 + seed.charCodeAt(i)) >>> 0;
  }
  return ICON_POOL[h % ICON_POOL.length];
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `cd enterprise_server/web && npx vitest run tests/lib/autoIcon.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add enterprise_server/web/src/lib/autoIcon.ts enterprise_server/web/tests/lib/autoIcon.test.ts
git commit -m "feat(enterprise_server/web): add deterministic auto-icon helper"
```

---

### Task 11: i18n keys (en + zh)

**Files:**
- Modify: `enterprise_server/web/src/i18n.ts`

**Interfaces:**
- Produces: the `mcp.*` keys consumed by Tasks 12–17. No logic.

- [ ] **Step 1: Add `en` keys**

Add to the `en` dict (before the closing `};` of `en`):

```ts
  // MCP 管理 (mcp manage)
  'nav.mcpManage': 'MCP management',
  'mcp.title': 'MCP management',
  'mcp.breadcrumb': 'MCP',
  'mcp.all': 'All',
  'mcp.search': 'Search MCP services',
  'mcp.categories': 'Categories',
  'mcp.addCategory': '+ New category',
  'mcp.addMcp': '+ Add MCP',
  'mcp.count': 'Total {n} MCP services',
  'mcp.empty': 'No MCP services in this category yet. Click “+ Add MCP” to create one.',
  'mcp.enabled': 'Enabled',
  'mcp.disabled': 'Disabled',
  'mcp.roleCount': 'roles',
  'mcp.create.title': 'New MCP',
  'mcp.create.hint': 'Fill in the MCP service details and the roles allowed to use it. Takes effect on save.',
  'mcp.name': 'Name',
  'mcp.category': 'Category',
  'mcp.note': 'Note',
  'mcp.notePlaceholder': 'One-line description of what this MCP does',
  'mcp.serverUrl': 'Server URL',
  'mcp.serverUrlPlaceholder': 'https://example.com/mcp',
  'mcp.transport': 'Transport',
  'mcp.transport.http': 'Streamable HTTP',
  'mcp.transport.sse': 'SSE',
  'mcp.transport.stdio': 'Stdio (local process)',
  'mcp.transportShort.http': 'HTTP',
  'mcp.transportShort.sse': 'SSE',
  'mcp.transportShort.stdio': 'Stdio',
  'mcp.auth': 'Auth',
  'mcp.auth.none': 'No auth',
  'mcp.auth.bearer': 'Bearer Token',
  'mcp.auth.api-key': 'API Key Header',
  'mcp.auth.oauth': 'OAuth 2.0',
  'mcp.authShort.none': 'No auth',
  'mcp.authShort.bearer': 'Bearer',
  'mcp.authShort.api-key': 'API Key',
  'mcp.authShort.oauth': 'OAuth',
  'mcp.credential': 'Credential',
  'mcp.credentialHint': 'Token / Key, stored masked',
  'mcp.credentialOptional': 'Optional',
  'mcp.timeout': 'Timeout (seconds)',
  'mcp.roles.title': 'Role permissions',
  'mcp.roles.hint': 'Users with a selected role can see and use this MCP on the Desktop client under Skills & connectors → Connectors.',
  'mcp.roles.summary': 'Authorized {n} / {total} roles',
  'mcp.roles.none': 'none',
  'mcp.roles.guard': 'Keep at least one role',
  'mcp.status.connected': 'Connected',
  'mcp.status.failed': 'Connection failed',
  'mcp.status.unknown': 'Untested',
  'mcp.status.testing': 'Testing…',
  'mcp.status.notTested': 'Not tested yet',
  'mcp.status.latency': 'Latency {ms}',
  'mcp.status.lastTest': 'Last test {ts}',
  'mcp.test': 'Test connection',
  'mcp.test.noUrl': 'No Server URL configured',
  'mcp.enabled.titleOn': 'Enabled',
  'mcp.enabled.titleOff': 'Disabled',
  'mcp.enabled.hint': 'When disabled, no user can see it on the Desktop client',
  'mcp.save': 'Save',
  'mcp.saveEnable': 'Save & enable',
  'mcp.cancel': 'Cancel',
  'mcp.delete': 'Delete',
  'mcp.delete.confirm': 'Delete MCP “{name}”? {n} roles will lose access. This cannot be undone.',
  'mcp.categoryDelete.confirm': 'Category “{name}” has {n} MCPs. They will move to Uncategorized. Delete?',
  'mcp.categoryDelete.confirmEmpty': 'Delete category “{name}”?',
  'mcp.category.uncategorized': 'Uncategorized',
  'mcp.error.nameRequired': 'Name is required',
  'mcp.error.urlRequired': 'Server URL is required and must start with http(s)://',
  'mcp.error.duplicate': 'An MCP with this name already exists',
  'mcp.basicInfo': 'Basic info',
```

- [ ] **Step 2: Add `zh` keys**

Add to the `zh` dict (mirror, before its closing `};`):

```ts
  'nav.mcpManage': 'MCP 管理',
  'mcp.title': 'MCP 管理',
  'mcp.breadcrumb': 'MCP 管理',
  'mcp.all': '全部',
  'mcp.search': '搜索 MCP 服务',
  'mcp.categories': '分类',
  'mcp.addCategory': '+ 新增分类',
  'mcp.addMcp': '+ 添加 MCP',
  'mcp.count': '共 {n} 个 MCP 服务',
  'mcp.empty': '该分类下暂无 MCP 服务，点击右上角「+ 添加 MCP」创建',
  'mcp.enabled': '启用',
  'mcp.disabled': '停用',
  'mcp.roleCount': '个角色',
  'mcp.create.title': '新增 MCP',
  'mcp.create.hint': '填写 MCP 服务信息并配置可使用的角色，保存后立即生效。',
  'mcp.name': '名称',
  'mcp.category': '分类',
  'mcp.note': '备注',
  'mcp.notePlaceholder': '一句话说明该 MCP 的用途',
  'mcp.serverUrl': 'Server URL',
  'mcp.serverUrlPlaceholder': 'https://example.com/mcp',
  'mcp.transport': '传输协议',
  'mcp.transport.http': 'Streamable HTTP',
  'mcp.transport.sse': 'SSE',
  'mcp.transport.stdio': 'Stdio（本地进程）',
  'mcp.transportShort.http': 'HTTP',
  'mcp.transportShort.sse': 'SSE',
  'mcp.transportShort.stdio': 'Stdio',
  'mcp.auth': '鉴权方式',
  'mcp.auth.none': '无鉴权',
  'mcp.auth.bearer': 'Bearer Token',
  'mcp.auth.api-key': 'API Key Header',
  'mcp.auth.oauth': 'OAuth 2.0',
  'mcp.authShort.none': '无鉴权',
  'mcp.authShort.bearer': 'Bearer',
  'mcp.authShort.api-key': 'API Key',
  'mcp.authShort.oauth': 'OAuth',
  'mcp.credential': '凭证',
  'mcp.credentialHint': 'Token / Key，脱敏存储',
  'mcp.credentialOptional': '选填',
  'mcp.timeout': '超时时间（秒）',
  'mcp.roles.title': '角色权限',
  'mcp.roles.hint': '拥有权限的用户登录 Desktop 端后，在「技能与连接器 → 连接器」页面可以看到并使用该 MCP。',
  'mcp.roles.summary': '已授权 {n} / {total} 个角色',
  'mcp.roles.none': '无',
  'mcp.roles.guard': '至少保留一个角色',
  'mcp.status.connected': '已连接',
  'mcp.status.failed': '连接失败',
  'mcp.status.unknown': '未测试',
  'mcp.status.testing': '测试中…',
  'mcp.status.notTested': '尚未进行连接测试',
  'mcp.status.latency': '延迟 {ms}',
  'mcp.status.lastTest': '最近测试 {ts}',
  'mcp.test': '测试连接',
  'mcp.test.noUrl': '该 MCP 未配置 Server URL',
  'mcp.enabled.titleOn': '已启用',
  'mcp.enabled.titleOff': '已停用',
  'mcp.enabled.hint': '停用后所有用户 Desktop 端不可见',
  'mcp.save': '保存',
  'mcp.saveEnable': '保存并启用',
  'mcp.cancel': '取消',
  'mcp.delete': '删除',
  'mcp.delete.confirm': '确认删除 MCP「{name}」？{n} 个角色将失去访问能力。此操作不可撤销。',
  'mcp.categoryDelete.confirm': '分类「{name}」下还有 {n} 个 MCP 服务，删除后它们将移入「未分类」，确认删除？',
  'mcp.categoryDelete.confirmEmpty': '确认删除分类「{name}」？',
  'mcp.category.uncategorized': '未分类',
  'mcp.error.nameRequired': '请填写 MCP 名称',
  'mcp.error.urlRequired': '请填写合法的 Server URL（http/https 开头）',
  'mcp.error.duplicate': '已存在同名 MCP 服务',
  'mcp.basicInfo': '基本信息',
```

> **Note:** `t()` does not interpolate `{x}`. Components that use these keys must replace placeholders manually. Provide a tiny local helper in each component: `const fill = (s: string, kv: Record<string, string | number>) => Object.entries(kv).reduce((a, [k, v]) => a.split(`{${k}}`).join(String(v)), s);` and use `fill(t('mcp.count'), { n: count })`.

- [ ] **Step 3: Verify no duplicate keys**

Run: `cd enterprise_server/web && node -e "const s=require('fs').readFileSync('src/i18n.ts','utf8'); const m=s.match(/'mcp\.[a-zA-Z.]+':/g)||[]; const d=m.filter((x,i)=>m.indexOf(x)!==i); if(d.length){console.log('DUPES',d);process.exit(1)} console.log('ok', m.length)"`
Expected: `ok <n>` (no duplicates).

- [ ] **Step 4: Commit**

```bash
git add enterprise_server/web/src/i18n.ts
git commit -m "feat(enterprise_server/web): add mcp manage i18n keys"
```

---

### Task 12: RoleChips component

**Files:**
- Create: `enterprise_server/web/src/pages/mcpManage/types.ts`
- Create: `enterprise_server/web/src/pages/mcpManage/RoleChips.tsx`
- Test: `enterprise_server/web/tests/pages/mcpManage/RoleChips.test.tsx`

**Interfaces:**
- `types.ts` produces `fill`, `TransportType`/`AuthMethod` re-exports from the api module, and the `RoleChipProps` shape.
- `RoleChips` props: `{ roles: string[]; value: string[]; onChange: (next: string[]) => void; disabled?: boolean }`. Renders a chip per role; clicking toggles membership; refuses to deselect the last selected role (shows a transient `mcp.roles.guard` message). A live summary line below: `fill(t('mcp.roles.summary'), { n: value.length, total: roles.length })` + the selected names joined by `、`.

- [ ] **Step 1: Write `types.ts`**

```ts
import { t } from '../../i18n';
import type { AuthMethod, TransportType } from '../../api/mcpMarketplace';

export type { AuthMethod, TransportType };

/** Replace `{key}` placeholders in a translated string (t() does not interpolate). */
export function fill(s: string, kv: Record<string, string | number>): string {
  return Object.entries(kv).reduce((a, [k, v]) => a.split(`{${k}}`).join(String(v)), s);
}

export const UNCATEGORIZED = 'uncategorized';

export { t };
```

- [ ] **Step 2: Write the failing test**

```tsx
import { beforeEach, describe, expect, test } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';

import { RoleChips } from '../../../src/pages/mcpManage/RoleChips';

const ROLES = ['super_admin', 'org_admin', 'user'];

describe('RoleChips', () => {
  beforeEach(() => { vi.resetModules(); });

  test('toggles selection and shows a live summary', () => {
    let value: string[] = ['super_admin'];
    const onChange = (next: string[]) => { value = next; };
    const { rerender } = render(<RoleChips roles={ROLES} value={value} onChange={onChange} />);
    fireEvent.click(screen.getByRole('button', { name: 'org_admin' }));
    expect(value).toEqual(['super_admin', 'org_admin']);
    rerender(<RoleChips roles={ROLES} value={value} onChange={onChange} />);
    expect(screen.getByText(/Authorized 2 \/ 3/i)).toBeInTheDocument();
  });

  test('refuses to deselect the last role', () => {
    let value: string[] = ['super_admin'];
    const onChange = (next: string[]) => { value = next; };
    const { rerender } = render(<RoleChips roles={ROLES} value={value} onChange={onChange} />);
    fireEvent.click(screen.getByRole('button', { name: 'super_admin' }));
    expect(value).toEqual(['super_admin']); // unchanged
    rerender(<RoleChips roles={ROLES} value={value} onChange={onChange} />);
    expect(screen.getByText(/at least one role/i)).toBeInTheDocument();
  });
});
```

- [ ] **Step 3: Run to verify it fails**

Run: `cd enterprise_server/web && npx vitest run tests/pages/mcpManage/RoleChips.test.tsx`
Expected: FAIL — module not found.

- [ ] **Step 4: Write the component**

```tsx
import { useState } from 'react';
import type { JSX } from 'react';
import { t } from '../../i18n';
import { fill } from './types';

interface Props {
  roles: string[];
  value: string[];
  onChange: (next: string[]) => void;
  disabled?: boolean;
}

export function RoleChips({ roles, value, onChange, disabled = false }: Props): JSX.Element {
  const [guardMsg, setGuardMsg] = useState(false);

  function toggle(role: string): void {
    if (disabled) return;
    if (value.includes(role)) {
      if (value.length === 1) { setGuardMsg(true); setTimeout(() => setGuardMsg(false), 3000); return; }
      onChange(value.filter((r) => r !== role));
    } else {
      onChange([...value, role]);
    }
  }

  return (
    <div>
      <div className="flex flex-wrap gap-2">
        {roles.map((role) => {
          const active = value.includes(role);
          return (
            <button
              key={role}
              type="button"
              onClick={() => toggle(role)}
              disabled={disabled}
              className={`rounded-full border px-3 py-1 text-[13px] transition ${active
                ? 'border-[var(--accent-primary)] bg-[var(--accent-primary)]/10 text-[var(--accent-primary)] font-medium'
                : 'border-[var(--border-default)] text-[var(--text-secondary)] hover:border-[var(--accent-primary)]'} disabled:opacity-50`}
            >
              {role}
            </button>
          );
        })}
      </div>
      <p className="mt-2 text-[12px] text-[var(--text-secondary)]">
        {fill(t('mcp.roles.summary'), { n: value.length, total: roles.length })}:{' '}
        {value.join('、') || t('mcp.roles.none')}
      </p>
      {guardMsg && <p className="mt-1 text-[12px] text-[var(--danger-primary)]">{t('mcp.roles.guard')}</p>}
    </div>
  );
}
```

- [ ] **Step 5: Run to verify it passes**

Run: `cd enterprise_server/web && npx vitest run tests/pages/mcpManage/RoleChips.test.tsx`
Expected: PASS (2 tests).

- [ ] **Step 6: Lint**

Run: `cd enterprise_server/web && npx eslint --ext ts,tsx --report-unused-disable-directives --max-warnings 0 src/pages/mcpManage/RoleChips.tsx src/pages/mcpManage/types.ts`
Expected: clean.

- [ ] **Step 7: Commit**

```bash
git add enterprise_server/web/src/pages/mcpManage/ enterprise_server/web/tests/pages/mcpManage/RoleChips.test.tsx
git commit -m "feat(enterprise_server/web): add role chips component"
```

---

### Task 13: CategorySidebar component

**Files:**
- Create: `enterprise_server/web/src/pages/mcpManage/CategorySidebar.tsx`
- Test: `enterprise_server/web/tests/pages/mcpManage/CategorySidebar.test.tsx`

**Interfaces:**
- Consumes: `autoIcon`, `fill`, `UNCATEGORIZED`.
- Props: `{ categories: McpCategory[]; counts: Record<string, number>; total: number; current: string; onSelect: (id: string) => void; onAdd: () => void; onDelete: (id: string, name: string) => void; search: string; onSearch: (q: string) => void }`.
  - Renders "全部" first (count = `total`), then each category (count = `counts[c.id] ?? 0`). Each row shows `autoIcon(name)` (or `▦` for 全部), name, count badge; hover-reveals a delete ✕ (hidden for `uncategorized`). `onSelect` on row click; ✕ stopPropagation → `onDelete(id, name)`.

- [ ] **Step 1: Write the failing test**

```tsx
import { describe, expect, test } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';

import { CategorySidebar } from '../../../src/pages/mcpManage/CategorySidebar';

const cats = [
  { id: 'search', name_zh: '搜索', name_en: 'Search', display_order: 1 },
  { id: 'uncategorized', name_zh: '未分类', name_en: 'Uncategorized', display_order: 9999 },
];

describe('CategorySidebar', () => {
  test('lists 全部 first with the total, and each category with its count', () => {
    render(<CategorySidebar categories={cats} counts={{ search: 3 }} total={5} current="all"
      onSelect={() => {}} onAdd={() => {}} onDelete={() => {}} search="" onSearch={() => {}} />);
    expect(screen.getByText('5')).toBeInTheDocument();
    expect(screen.getByText('3')).toBeInTheDocument();
  });

  test('row click selects the category; delete button is hidden for uncategorized', () => {
    let selected = '';
    render(<CategorySidebar categories={cats} counts={{}} total={0} current="all"
      onSelect={(id) => { selected = id; }} onAdd={() => {}} onDelete={() => {}} search="" onSearch={() => {}} />);
    fireEvent.click(screen.getByText('Search'));
    expect(selected).toBe('search');
    // uncategorized has no delete affordance (no ✕ bound to it)
    const delButtons = screen.queryAllByRole('button', { name: /delete/i });
    expect(delButtons.some((b) => b.textContent === 'Uncategorized')).toBe(false);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd enterprise_server/web && npx vitest run tests/pages/mcpManage/CategorySidebar.test.tsx`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the component**

```tsx
import { useState } from 'react';
import type { JSX } from 'react';
import { t } from '../../i18n';
import type { McpCategory } from '../../api/mcpMarketplace';
import { autoIcon } from '../../lib/autoIcon';
import { UNCATEGORIZED } from './types';

interface Props {
  categories: McpCategory[];
  counts: Record<string, number>;
  total: number;
  current: string; // 'all' or a category id
  onSelect: (id: string) => void;
  onAdd: () => void;
  onDelete: (id: string, name: string) => void;
  search: string;
  onSearch: (q: string) => void;
}

export function CategorySidebar(p: Props): JSX.Element {
  const [hovered, setHovered] = useState<string | null>(null);
  const rows = [
    { id: 'all', name: t('mcp.all'), icon: '▦', count: p.total },
    ...p.categories.map((c) => ({ id: c.id, name: c.name_zh || c.name_en, icon: autoIcon(c.name_zh || c.name_en), count: p.counts[c.id] ?? 0 })),
  ];
  return (
    <aside className="w-[280px] shrink-0 border-r border-[var(--border-default)] p-3">
      <h2 className="mb-3 text-[15px] font-semibold">{t('mcp.title')}</h2>
      <input
        value={p.search}
        onChange={(e) => p.onSearch(e.target.value)}
        placeholder={t('mcp.search')}
        className="mb-3 w-full rounded-[6px] border border-[var(--border-default)] bg-[var(--bg)] px-3 py-2 text-[12px] outline-none focus:border-[var(--accent-primary)]"
      />
      <div className="mb-1 px-2 text-[11px] font-medium text-[var(--text-secondary)]">{t('mcp.categories')}</div>
      <div className="flex flex-col gap-[2px]">
        {rows.map((row) => {
          const active = p.current === row.id;
          const showDel = row.id !== UNCATEGORIZED && hovered === row.id;
          return (
            <button
              key={row.id}
              type="button"
              onMouseEnter={() => setHovered(row.id)}
              onMouseLeave={() => setHovered((h) => (h === row.id ? null : h))}
              onClick={() => p.onSelect(row.id)}
              className={`flex items-center gap-2 rounded-[6px] px-2 py-1.5 text-left text-[13px] ${active
                ? 'bg-[var(--accent-primary)]/10 font-medium text-[var(--accent-primary)]'
                : 'text-[var(--text-secondary)] hover:bg-[var(--bg)]'}`}
            >
              <span aria-hidden>{row.icon}</span>
              <span className="flex-1 truncate">{row.name}</span>
              <span className="rounded-[8px] bg-[var(--bg)] px-1.5 text-[10px] text-[var(--text-secondary)]">{row.count}</span>
              {showDel && (
                <span
                  role="button"
                  aria-label={t('common.delete')}
                  onClick={(e) => { e.stopPropagation(); p.onDelete(row.id, row.name); }}
                  className="text-[var(--text-secondary)] hover:text-[var(--danger-primary)]"
                >
                  ✕
                </span>
              )}
            </button>
          );
        })}
      </div>
      <button type="button" onClick={p.onAdd}
        className="mt-3 w-full rounded-[6px] border border-dashed border-[var(--border-default)] px-2 py-1.5 text-[12px] text-[var(--text-secondary)] hover:border-[var(--accent-primary)] hover:text-[var(--accent-primary)]">
        {t('mcp.addCategory')}
      </button>
    </aside>
  );
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `cd enterprise_server/web && npx vitest run tests/pages/mcpManage/CategorySidebar.test.tsx`
Expected: PASS (2 tests).

- [ ] **Step 5: Lint + commit**

Run: `cd enterprise_server/web && npx eslint --ext ts,tsx --report-unused-disable-directives --max-warnings 0 src/pages/mcpManage/CategorySidebar.tsx`
```bash
git add enterprise_server/web/src/pages/mcpManage/CategorySidebar.tsx enterprise_server/web/tests/pages/mcpManage/CategorySidebar.test.tsx
git commit -m "feat(enterprise_server/web): add mcp category sidebar"
```

---

### Task 14: McpCardGrid component

**Files:**
- Create: `enterprise_server/web/src/pages/mcpManage/McpCardGrid.tsx`
- Test: `enterprise_server/web/tests/pages/mcpManage/McpCardGrid.test.tsx`

**Interfaces:**
- Consumes: `autoIcon`, `fill`, `McpServer`.
- Props: `{ servers: McpServer[]; categoryName: string; current: string; onAdd: () => void; onOpen: (id: string) => void }`.
  - Header: breadcrumb `t('mcp.breadcrumb')` + current, `<h1>` = `categoryName`, count `fill(t('mcp.count'), { n: servers.length })`, `+ 添加 MCP` button → `onAdd`.
  - Grid of cards: icon, name, status dot, enabled tag, 2-line-clamped description, meta tags (transport short / auth short / `👥 N`). Click → `onOpen(id)`.
  - Empty state when `servers.length === 0` → `t('mcp.empty')`.
  - Status color map: connected → `var(--success)`, failed → `var(--danger)`, else `var(--text-secondary)`; unknown → grey.

- [ ] **Step 1: Write the failing test**

```tsx
import { describe, expect, test } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';

import { McpCardGrid } from '../../../src/pages/mcpManage/McpCardGrid';

const server = {
  id: 'qcc', name: '企查查', name_zh: '企查查', description: '企业工商信息查询',
  category: 'search', transportType: 'http' as const, serverUrl: 'https://x/mcp', command: null,
  authMethod: 'oauth' as const, credentialMasked: null, timeoutSeconds: 30,
  allowedRoles: ['super_admin', 'org_admin'], enabled: true, lastStatus: 'connected',
  lastLatencyMs: 142, lastTestedAt: '2026-09-11 18:30',
};

describe('McpCardGrid', () => {
  test('renders the card and opens the drawer on click', () => {
    let opened = '';
    render(<McpCardGrid servers={[server]} categoryName="搜索" current="search"
      onAdd={() => {}} onOpen={(id) => { opened = id; }} />);
    fireEvent.click(screen.getByText('企查查'));
    expect(opened).toBe('qcc');
  });

  test('shows the empty state when there are no servers', () => {
    render(<McpCardGrid servers={[]} categoryName="搜索" current="search" onAdd={() => {}} onOpen={() => {}} />);
    expect(screen.getByText(/No MCP services|暂无 MCP/i)).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd enterprise_server/web && npx vitest run tests/pages/mcpManage/McpCardGrid.test.tsx`
Expected: FAIL.

- [ ] **Step 3: Write the component**

```tsx
import type { JSX } from 'react';
import { t } from '../../i18n';
import type { McpServer } from '../../api/mcpMarketplace';
import { autoIcon } from '../../lib/autoIcon';
import { fill } from './types';

interface Props {
  servers: McpServer[];
  categoryName: string;
  current: string;
  onAdd: () => void;
  onOpen: (id: string) => void;
}

const STATUS_COLOR: Record<string, string> = {
  connected: 'var(--success)',
  failed: 'var(--danger)',
  unknown: 'var(--text-secondary)',
};

export function McpCardGrid({ servers, categoryName, onAdd, onOpen }: Props): JSX.Element {
  return (
    <div className="flex-1 overflow-y-auto p-6">
      <div className="mb-4 flex items-end justify-between">
        <div>
          <div className="text-[12px] text-[var(--text-secondary)]">
            {t('mcp.breadcrumb')} <span className="opacity-50">/</span> <span className="text-[var(--text-primary)]">{categoryName}</span>
          </div>
          <h1 className="text-[20px] font-semibold">{categoryName}</h1>
          <p className="text-[13px] text-[var(--text-secondary)]">{fill(t('mcp.count'), { n: servers.length })}</p>
        </div>
        <button type="button" onClick={onAdd}
          className="rounded-[6px] bg-[var(--accent-primary)] px-3.5 py-2 text-[13px] text-white hover:bg-[var(--accent-primary-hover)]">
          {t('mcp.addMcp')}
        </button>
      </div>

      {servers.length === 0 ? (
        <div className="py-10 text-center text-[var(--text-secondary)]">{t('mcp.empty')}</div>
      ) : (
        <div className="grid grid-cols-[repeat(auto-fill,minmax(280px,1fr))] gap-3.5">
          {servers.map((s) => (
            <button
              key={s.id}
              type="button"
              onClick={() => onOpen(s.id)}
              className={`rounded-[10px] border border-[var(--border-default)] bg-[var(--surface)] p-4 text-left transition hover:border-[var(--accent-primary)] hover:shadow-md ${s.enabled ? '' : 'opacity-60'}`}
            >
              <div className="mb-2.5 flex items-center gap-2.5">
                <span className="flex h-9 w-9 items-center justify-center rounded-[8px] bg-[var(--accent-primary)]/10 text-[17px]" aria-hidden>{autoIcon(s.name)}</span>
                <strong className="text-[14px]">{s.name}</strong>
                <span className="h-2 w-2 rounded-full" style={{ background: STATUS_COLOR[s.lastStatus ?? 'unknown'] }} title={t(`mcp.status.${s.lastStatus ?? 'unknown'}`)} />
                <span className={`rounded-[4px] px-1.5 py-0.5 text-[11px] ${s.enabled ? 'bg-[var(--success)]/15 text-[var(--success)]' : 'bg-[var(--bg)] text-[var(--text-secondary)]'}`}>
                  {s.enabled ? t('mcp.enabled') : t('mcp.disabled')}
                </span>
              </div>
              <p className="mb-3 line-clamp-2 text-[12.5px] leading-snug text-[var(--text-secondary)]">{s.description}</p>
              <div className="flex flex-wrap gap-1.5">
                <span className="rounded-[4px] border border-[var(--border-default)] bg-[var(--bg)] px-1.5 py-0.5 text-[11px] text-[var(--text-secondary)]">{t(`mcp.transportShort.${s.transportType}`)}</span>
                <span className="rounded-[4px] border border-[var(--border-default)] bg-[var(--bg)] px-1.5 py-0.5 text-[11px] text-[var(--text-secondary)]">{t(`mcp.authShort.${s.authMethod}`)}</span>
                <span className="rounded-[4px] bg-[var(--accent-primary)]/10 px-1.5 py-0.5 text-[11px] text-[var(--accent-primary)]">👥 {s.allowedRoles.length}</span>
              </div>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `cd enterprise_server/web && npx vitest run tests/pages/mcpManage/McpCardGrid.test.tsx`
Expected: PASS (2 tests).

- [ ] **Step 5: Lint + commit**

Run: `cd enterprise_server/web && npx eslint --ext ts,tsx --report-unused-disable-directives --max-warnings 0 src/pages/mcpManage/McpCardGrid.tsx`
```bash
git add enterprise_server/web/src/pages/mcpManage/McpCardGrid.tsx enterprise_server/web/tests/pages/mcpManage/McpCardGrid.test.tsx
git commit -m "feat(enterprise_server/web): add mcp card grid"
```

---

### Task 15: CreateMcpForm component

**Files:**
- Create: `enterprise_server/web/src/pages/mcpManage/CreateMcpForm.tsx`
- Test: `enterprise_server/web/tests/pages/mcpManage/CreateMcpForm.test.tsx`

**Interfaces:**
- Consumes: `RoleChips`, `fill`, `McpCategory`, `ServerInput`, `TransportType`, `AuthMethod`.
- Props: `{ categories: McpCategory[]; defaultCategory: string; roles: string[]; onCancel: () => void; onSave: (input: ServerInput) => void }`.
  - Fields: name*, category (select, default = `defaultCategory`), note, serverUrl*, transport (select, default `http`), auth (select, default `bearer`), credential (password), timeout (number, default 30). Then a RoleChips block (perm hint + chips). Footer 取消 / 保存并启用.
  - Validation: name required; serverUrl required + `^https?://` for http/sse (stdio skips url). On invalid → set an inline error (t('mcp.error.nameRequired' | 'mcp.error.urlRequired')) and do not call `onSave`.
  - `onSave` receives a `ServerInput` with `server_id` generated as `mcp_<Date.now()>` (the backend also allows admin-supplied ids; the SPA supplies this).

- [ ] **Step 1: Write the failing test**

```tsx
import { describe, expect, test } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';

import { CreateMcpForm } from '../../../src/pages/mcpManage/CreateMcpForm';

const cats = [{ id: 'search', name_zh: '搜索', name_en: 'Search' }];
const roles = ['super_admin', 'org_admin'];

describe('CreateMcpForm', () => {
  test('valid submit calls onSave with a server_id and roles', () => {
    let out: unknown = null;
    render(<CreateMcpForm categories={cats} defaultCategory="search" roles={roles}
      onCancel={() => {}} onSave={(i) => { out = i; }} />);
    fireEvent.change(screen.getByPlaceholderText(/example.com\/mcp/i), { target: { value: 'https://x.test/mcp' } });
    fireEvent.change(screen.getByLabelText(/Name/i), { target: { value: '企查查' } });
    fireEvent.click(screen.getByRole('button', { name: /Save|保存/i }));
    expect(out).not.toBeNull();
    const input = out as { server_id: string; name: string; server_url: string; allowed_roles: string[] };
    expect(input.server_id).toMatch(/^mcp_/);
    expect(input.name).toBe('企查查');
    expect(input.server_url).toBe('https://x.test/mcp');
    expect(input.allowed_roles).toContain('super_admin');
  });

  test('invalid (empty name) shows an error and does not save', () => {
    let saved = false;
    render(<CreateMcpForm categories={cats} defaultCategory="search" roles={roles}
      onCancel={() => {}} onSave={() => { saved = true; }} />);
    fireEvent.click(screen.getByRole('button', { name: /Save|保存/i }));
    expect(saved).toBe(false);
    expect(screen.getByText(/Name is required|MCP 名称/i)).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd enterprise_server/web && npx vitest run tests/pages/mcpManage/CreateMcpForm.test.tsx`
Expected: FAIL.

- [ ] **Step 3: Write the component**

```tsx
import { useState } from 'react';
import type { JSX } from 'react';
import { t } from '../../i18n';
import type { AuthMethod, McpCategory, ServerInput, TransportType } from '../../api/mcpMarketplace';
import { RoleChips } from './RoleChips';

interface Props {
  categories: McpCategory[];
  defaultCategory: string;
  roles: string[];
  onCancel: () => void;
  onSave: (input: ServerInput) => void;
}

const TRANSPORTS: TransportType[] = ['http', 'sse', 'stdio'];
const AUTHS: AuthMethod[] = ['bearer', 'none', 'api-key', 'oauth'];

export function CreateMcpForm(p: Props): JSX.Element {
  const [name, setName] = useState('');
  const [category, setCategory] = useState(p.defaultCategory);
  const [note, setNote] = useState('');
  const [url, setUrl] = useState('');
  const [transport, setTransport] = useState<TransportType>('http');
  const [auth, setAuth] = useState<AuthMethod>('bearer');
  const [credential, setCredential] = useState('');
  const [timeout, setTimeout] = useState('30');
  const [roleValues, setRoleValues] = useState<string[]>(['super_admin']);
  const [error, setError] = useState('');

  function submit(): void {
    if (!name.trim()) { setError(t('mcp.error.nameRequired')); return; }
    if (transport !== 'stdio' && !/^https?:\/\//.test(url.trim())) { setError(t('mcp.error.urlRequired')); return; }
    p.onSave({
      server_id: `mcp_${Date.now()}`,
      name: name.trim(),
      description_en: note.trim() || name.trim(),
      category_id: category,
      transport_type: transport,
      server_url: transport === 'stdio' ? undefined : url.trim(),
      auth_method: auth,
      credential: credential.trim() || undefined,
      timeout_seconds: parseInt(timeout, 10) || 30,
      allowed_roles: roleValues,
    });
  }

  const inputCls = 'w-full rounded-[6px] border border-[var(--border-default)] px-2.5 py-1.5 text-[13px] outline-none focus:border-[var(--accent-primary)]';
  return (
    <div className="flex-1 overflow-y-auto p-6">
      <div className="rounded-[8px] border border-[var(--border-default)] bg-[var(--surface)] p-5">
        <h2 className="mb-1 text-[15px] font-semibold">{t('mcp.create.title')}</h2>
        <p className="mb-4 rounded-[6px] bg-[var(--accent-primary)]/10 px-3 py-2.5 text-[13px] text-[var(--text-secondary)]">{t('mcp.create.hint')}</p>
        <div className="grid grid-cols-2 gap-3.5">
          <label className="flex flex-col gap-1 text-[12px] font-medium text-[var(--text-secondary)]">
            {t('mcp.name')} <span className="text-[var(--danger-primary)]">*</span>
            <input className={inputCls} aria-label={t('mcp.name')} value={name} onChange={(e) => setName(e.target.value)} />
          </label>
          <label className="flex flex-col gap-1 text-[12px] font-medium text-[var(--text-secondary)]">
            {t('mcp.category')}
            <select className={inputCls} value={category} onChange={(e) => setCategory(e.target.value)}>
              {p.categories.map((c) => <option key={c.id} value={c.id}>{c.name_zh || c.name_en}</option>)}
            </select>
          </label>
          <label className="col-span-2 flex flex-col gap-1 text-[12px] font-medium text-[var(--text-secondary)]">
            {t('mcp.note')}
            <input className={inputCls} placeholder={t('mcp.notePlaceholder')} value={note} onChange={(e) => setNote(e.target.value)} />
          </label>
          <label className="col-span-2 flex flex-col gap-1 text-[12px] font-medium text-[var(--text-secondary)]">
            {t('mcp.serverUrl')} <span className="text-[var(--danger-primary)]">*</span>
            <input className={`${inputCls} font-mono`} placeholder={t('mcp.serverUrlPlaceholder')} value={url} onChange={(e) => setUrl(e.target.value)} />
          </label>
          <label className="flex flex-col gap-1 text-[12px] font-medium text-[var(--text-secondary)]">
            {t('mcp.transport')}
            <select className={inputCls} value={transport} onChange={(e) => setTransport(e.target.value as TransportType)}>
              {TRANSPORTS.map((v) => <option key={v} value={v}>{t(`mcp.transport.${v}`)}</option>)}
            </select>
          </label>
          <label className="flex flex-col gap-1 text-[12px] font-medium text-[var(--text-secondary)]">
            {t('mcp.auth')}
            <select className={inputCls} value={auth} onChange={(e) => setAuth(e.target.value as AuthMethod)}>
              {AUTHS.map((v) => <option key={v} value={v}>{t(`mcp.auth.${v}`)}</option>)}
            </select>
          </label>
          <label className="col-span-2 flex flex-col gap-1 text-[12px] font-medium text-[var(--text-secondary)]">
            {t('mcp.credential')} <span className="font-normal text-[var(--text-secondary)]">（{t('mcp.credentialHint')}）</span>
            <input type="password" className={`${inputCls} font-mono`} placeholder={t('mcp.credentialOptional')} value={credential} onChange={(e) => setCredential(e.target.value)} />
          </label>
          <label className="flex flex-col gap-1 text-[12px] font-medium text-[var(--text-secondary)]">
            {t('mcp.timeout')}
            <input type="number" min={1} max={600} className={inputCls} value={timeout} onChange={(e) => setTimeout(e.target.value)} />
          </label>
        </div>
        {error && <p className="mt-2.5 text-[12px] text-[var(--danger-primary)]">{error}</p>}
      </div>

      <div className="mt-4 rounded-[8px] border border-[var(--border-default)] bg-[var(--surface)] p-5">
        <h2 className="mb-1 text-[15px] font-semibold">{t('mcp.roles.title')}</h2>
        <p className="mb-3 rounded-[6px] bg-[var(--accent-primary)]/10 px-3 py-2.5 text-[13px] text-[var(--text-secondary)]">{t('mcp.roles.hint')}</p>
        <RoleChips roles={p.roles} value={roleValues} onChange={setRoleValues} />
      </div>

      <div className="mt-5 flex justify-end gap-2.5">
        <button type="button" onClick={p.onCancel} className="rounded-[6px] border border-[var(--border-default)] px-3.5 py-2 text-[13px] hover:bg-[var(--bg)]">{t('mcp.cancel')}</button>
        <button type="button" onClick={submit} className="rounded-[6px] bg-[var(--accent-primary)] px-3.5 py-2 text-[13px] text-white hover:bg-[var(--accent-primary-hover)]">{t('mcp.saveEnable')}</button>
      </div>
    </div>
  );
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `cd enterprise_server/web && npx vitest run tests/pages/mcpManage/CreateMcpForm.test.tsx`
Expected: PASS (2 tests).

- [ ] **Step 5: Lint + commit**

Run: `cd enterprise_server/web && npx eslint --ext ts,tsx --report-unused-disable-directives --max-warnings 0 src/pages/mcpManage/CreateMcpForm.tsx`
```bash
git add enterprise_server/web/src/pages/mcpManage/CreateMcpForm.tsx enterprise_server/web/tests/pages/mcpManage/CreateMcpForm.test.tsx
git commit -m "feat(enterprise_server/web): add mcp create form"
```

---

### Task 16: DetailDrawer component

**Files:**
- Create: `enterprise_server/web/src/pages/mcpManage/DetailDrawer.tsx`
- Test: `enterprise_server/web/tests/pages/mcpManage/DetailDrawer.test.tsx`

**Interfaces:**
- Consumes: `RoleChips`, `Switch`, `fill`, `McpServer`, `McpCategory`, `ServerPatch`, `ProbeResult`.
- Props: `{ server: McpServer; categories: McpCategory[]; roles: string[]; onClose: () => void; onSave: (patch: ServerPatch) => void; onDelete: () => void; onToggleEnabled: (enabled: boolean) => void; onTest: () => Promise<ProbeResult> }`.
  - Renders a right-slide panel (a simple `<aside>`; mask + transform are CSS). Header (category, name, url) + close ✕.
  - Enable `Switch` row (title 已启用/已停用, hint) → `onToggleEnabled`.
  - Connection status line + `测试连接` button → `onTest` (optimistically set local "testing" state; on resolve show connected/failed).
  - 基本信息 form (name, category, note, url, transport, auth, credential — credential shows the masked value, editing sends the new value only if changed).
  - 角色权限 RoleChips + summary.
  - Footer: 删除 / 取消 / 保存. `保存` → `onSave` with the edited fields + current roles.

- [ ] **Step 1: Write the failing test**

```tsx
import { describe, expect, test } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';

import { DetailDrawer } from '../../../src/pages/mcpManage/DetailDrawer';

const server = {
  id: 'qcc', name: '企查查', name_zh: '企查查', description: 'desc',
  category: 'search', transportType: 'http' as const, serverUrl: 'https://x/mcp', command: null,
  authMethod: 'bearer' as const, credentialMasked: '••••93bd', timeoutSeconds: 30,
  allowedRoles: ['super_admin'], enabled: true, lastStatus: 'connected',
  lastLatencyMs: 142, lastTestedAt: '2026-09-11 18:30',
};
const cats = [{ id: 'search', name_zh: '搜索', name_en: 'Search' }];
const roles = ['super_admin', 'org_admin'];

describe('DetailDrawer', () => {
  test('renders name/url and a save button; save sends the edited name', async () => {
    let patch: unknown = null;
    render(<DetailDrawer server={server} categories={cats} roles={roles} onClose={() => {}}
      onSave={(p) => { patch = p; }} onDelete={() => {}} onToggleEnabled={() => {}} onTest={async () => ({ status: 'connected' })} />);
    fireEvent.change(screen.getByLabelText(/Name/i), { target: { value: '企查查Pro' } });
    fireEvent.click(screen.getByRole('button', { name: /Save|保存/i }));
    expect((patch as { name: string }).name).toBe('企查查Pro');
  });

  test('enable switch toggles via onToggleEnabled', () => {
    let enabled: boolean | null = null;
    render(<DetailDrawer server={server} categories={cats} roles={roles} onClose={() => {}}
      onSave={() => {}} onDelete={() => {}} onToggleEnabled={(v) => { enabled = v; }} onTest={async () => ({ status: 'connected' })} />);
    fireEvent.click(screen.getByRole('switch'));
    expect(enabled).toBe(false);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd enterprise_server/web && npx vitest run tests/pages/mcpManage/DetailDrawer.test.tsx`
Expected: FAIL.

- [ ] **Step 3: Write the component**

```tsx
import { useState } from 'react';
import type { JSX } from 'react';
import { t } from '../../i18n';
import type { AuthMethod, McpCategory, McpServer, ProbeResult, ServerPatch, TransportType } from '../../api/mcpMarketplace';
import { Switch } from '../../components/Switch';
import { RoleChips } from './RoleChips';
import { fill } from './types';

interface Props {
  server: McpServer;
  categories: McpCategory[];
  roles: string[];
  onClose: () => void;
  onSave: (patch: ServerPatch) => void;
  onDelete: () => void;
  onToggleEnabled: (enabled: boolean) => void;
  onTest: () => Promise<ProbeResult>;
}

export function DetailDrawer(p: Props): JSX.Element {
  const s = p.server;
  const [name, setName] = useState(s.name);
  const [category, setCategory] = useState(s.category);
  const [note, setNote] = useState(s.description);
  const [url, setUrl] = useState(s.serverUrl ?? '');
  const [transport, setTransport] = useState<TransportType>(s.transportType);
  const [auth, setAuth] = useState<AuthMethod>(s.authMethod);
  const [credential, setCredential] = useState('');
  const [timeout, setTimeout] = useState(String(s.timeoutSeconds));
  const [roleValues, setRoleValues] = useState<string[]>(s.allowedRoles);
  const [testing, setTesting] = useState(false);

  async function runTest(): Promise<void> {
    if (transport !== 'stdio' && !url.trim()) { return; }
    setTesting(true);
    try { await p.onTest(); } finally { setTesting(false); }
  }

  function save(): void {
    p.onSave({
      name: name.trim(),
      description_en: note.trim(),
      category_id: category,
      transport_type: transport,
      server_url: transport === 'stdio' ? undefined : url.trim(),
      auth_method: auth,
      credential: credential.trim() || undefined,
      timeout_seconds: parseInt(timeout, 10) || 30,
      allowed_roles: roleValues,
    });
  }

  const inputCls = 'w-full rounded-[6px] border border-[var(--border-default)] px-2.5 py-1.5 text-[13px] outline-none focus:border-[var(--accent-primary)]';
  const status = testing ? 'testing' : s.lastStatus ?? 'unknown';
  const STATUS_COLOR: Record<string, string> = { connected: 'var(--success)', failed: 'var(--danger)', testing: 'var(--accent-primary)', unknown: 'var(--text-secondary)' };

  return (
    <aside className="fixed inset-y-0 right-0 z-[101] flex w-[460px] max-w-[92vw] flex-col border-l border-[var(--border-default)] bg-[var(--surface)] shadow-[-8px_0_24px_rgba(15,23,42,0.08)]">
      <header className="flex items-start justify-between gap-3 border-b border-[var(--border-default)] p-5">
        <div>
          <div className="text-[12px] text-[var(--text-secondary)]">{s.category}</div>
          <h3 className="my-1 text-[18px] font-semibold">{s.name}</h3>
          <code className="font-mono text-[12px]">{s.serverUrl ?? ''}</code>
        </div>
        <button type="button" onClick={p.onClose} aria-label={t('common.close')} className="flex h-8 w-8 items-center justify-center rounded-[6px] text-[var(--text-secondary)] hover:bg-[var(--bg)]">✕</button>
      </header>

      <div className="flex-1 overflow-y-auto p-5">
        <div className="mb-3 flex items-center justify-between rounded-[8px] bg-[var(--bg)] p-3">
          <div>
            <div className="text-[13px] font-medium">{s.enabled ? t('mcp.enabled.titleOn') : t('mcp.enabled.titleOff')}</div>
            <div className="text-[12px] text-[var(--text-secondary)]">{t('mcp.enabled.hint')}</div>
          </div>
          <Switch checked={s.enabled} label={s.enabled ? t('mcp.enabled.titleOn') : t('mcp.enabled.titleOff')} onChange={p.onToggleEnabled} />
        </div>
        <div className="mb-3 flex items-center gap-2 text-[12px]">
          <span className="h-2 w-2 rounded-full" style={{ background: STATUS_COLOR[status] }} />
          <strong style={{ color: STATUS_COLOR[status] }}>{t(`mcp.status.${status}`)}</strong>
          {status === 'unknown'
            ? <span className="text-[var(--text-secondary)]">| {t('mcp.status.notTested')}</span>
            : <span className="text-[var(--text-secondary)]">| {fill(t('mcp.status.latency'), { ms: s.lastLatencyMs != null ? `${s.lastLatencyMs}ms` : '-' })} | {fill(t('mcp.status.lastTest'), { ts: s.lastTestedAt ?? '-' })}</span>}
        </div>
        <button type="button" onClick={runTest} disabled={testing} className="mb-4 rounded-[6px] border border-[var(--border-default)] px-2.5 py-1 text-[12px] hover:bg-[var(--bg)] disabled:opacity-50">
          🔌 {t('mcp.test')}
        </button>

        <section className="border-t border-dashed border-[var(--border-default)] pt-4">
          <h4 className="mb-3 text-[13px] font-semibold uppercase tracking-wide text-[var(--text-secondary)]">{t('mcp.basicInfo')}</h4>
          <div className="grid grid-cols-2 gap-3.5">
            <label className="flex flex-col gap-1 text-[12px] font-medium text-[var(--text-secondary)]">{t('mcp.name')}
              <input className={inputCls} aria-label={t('mcp.name')} value={name} onChange={(e) => setName(e.target.value)} /></label>
            <label className="flex flex-col gap-1 text-[12px] font-medium text-[var(--text-secondary)]">{t('mcp.category')}
              <select className={inputCls} value={category} onChange={(e) => setCategory(e.target.value)}>
                {p.categories.map((c) => <option key={c.id} value={c.id}>{c.name_zh || c.name_en}</option>)}
              </select></label>
            <label className="col-span-2 flex flex-col gap-1 text-[12px] font-medium text-[var(--text-secondary)]">{t('mcp.note')}
              <input className={inputCls} value={note} onChange={(e) => setNote(e.target.value)} /></label>
            <label className="col-span-2 flex flex-col gap-1 text-[12px] font-medium text-[var(--text-secondary)]">{t('mcp.serverUrl')}
              <input className={`${inputCls} font-mono`} value={url} onChange={(e) => setUrl(e.target.value)} /></label>
            <label className="flex flex-col gap-1 text-[12px] font-medium text-[var(--text-secondary)]">{t('mcp.transport')}
              <select className={inputCls} value={transport} onChange={(e) => setTransport(e.target.value as TransportType)}>
                {(['http', 'sse', 'stdio'] as const).map((v) => <option key={v} value={v}>{t(`mcp.transport.${v}`)}</option>)}
              </select></label>
            <label className="flex flex-col gap-1 text-[12px] font-medium text-[var(--text-secondary)]">{t('mcp.auth')}
              <select className={inputCls} value={auth} onChange={(e) => setAuth(e.target.value as AuthMethod)}>
                {(['none', 'bearer', 'api-key', 'oauth'] as const).map((v) => <option key={v} value={v}>{t(`mcp.auth.${v}`)}</option>)}
              </select></label>
            <label className="col-span-2 flex flex-col gap-1 text-[12px] font-medium text-[var(--text-secondary)]">{t('mcp.credential')}
              <input type="password" className={`${inputCls} font-mono`} placeholder={s.credentialMasked ?? ''} value={credential} onChange={(e) => setCredential(e.target.value)} /></label>
          </div>
        </section>

        <section className="mt-4 border-t border-dashed border-[var(--border-default)] pt-4">
          <h4 className="mb-3 text-[13px] font-semibold uppercase tracking-wide text-[var(--text-secondary)]">{t('mcp.roles.title')}</h4>
          <p className="mb-3 rounded-[6px] bg-[var(--accent-primary)]/10 px-3 py-2.5 text-[13px] text-[var(--text-secondary)]">{t('mcp.roles.hint')}</p>
          <RoleChips roles={p.roles} value={roleValues} onChange={setRoleValues} />
        </section>
      </div>

      <footer className="flex items-center gap-2 border-t border-[var(--border-default)] bg-[var(--bg)] p-3">
        <button type="button" onClick={p.onDelete} className="rounded-[6px] border border-[var(--danger-primary)]/40 px-3 py-1.5 text-[13px] text-[var(--danger-primary)] hover:bg-[var(--danger-primary)]/10">{t('mcp.delete')}</button>
        <span className="flex-1" />
        <button type="button" onClick={p.onClose} className="rounded-[6px] border border-[var(--border-default)] px-3 py-1.5 text-[13px] hover:bg-[var(--bg)]">{t('mcp.cancel')}</button>
        <button type="button" onClick={save} className="rounded-[6px] bg-[var(--accent-primary)] px-3 py-1.5 text-[13px] text-white hover:bg-[var(--accent-primary-hover)]">{t('mcp.save')}</button>
      </footer>
    </aside>
  );
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `cd enterprise_server/web && npx vitest run tests/pages/mcpManage/DetailDrawer.test.tsx`
Expected: PASS (2 tests).

- [ ] **Step 5: Lint + commit**

Run: `cd enterprise_server/web && npx eslint --ext ts,tsx --report-unused-disable-directives --max-warnings 0 src/pages/mcpManage/DetailDrawer.tsx`
```bash
git add enterprise_server/web/src/pages/mcpManage/DetailDrawer.tsx enterprise_server/web/tests/pages/mcpManage/DetailDrawer.test.tsx
git commit -m "feat(enterprise_server/web): add mcp detail drawer"
```

---

### Task 17: MCPManagePage (wire it all) + test

**Files:**
- Create: `enterprise_server/web/src/pages/MCPManagePage.tsx`
- Test: `enterprise_server/web/tests/pages/mcpManage/MCPManagePage.test.tsx`

**Interfaces:**
- Consumes: all of Tasks 9–16; `mcpMarketplaceApi`; `useAuthStore` (for `claims.orgId`, `hasCapability`).
- Top-level state: `current` (`'all'` | category id), `search`, `view` (`'list' | 'create'`), `openId` (drawer server id | null), `addingCategory` (bool).
- Queries: `listServers()`, `listCategories()`, `listRoleVocabulary()` via TanStack Query (keys `['mcp','servers']`, `['mcp','categories']`, `['mcp','roles']`).
- Derived: `counts` per category (respecting `search` + `current`), `filteredServers` (by `current` + `search`).
- Mutations (invalidate both servers + categories on success): create, update, delete, test, toggle enabled, category add/delete.
  - **create** → on success set `current` to the new category, `view='list'`, then open the new server's drawer.
  - **category delete** → `confirm(fill(t('mcp.categoryDelete.confirm' | 'mcp.categoryDelete.confirmEmpty'), ...))`; on success re-select `'all'`.
  - **delete server** → `confirm(fill(t('mcp.delete.confirm'), { name, n }))`; on success close drawer.
  - **toggle enabled** → `updateServer(id, { enabled })`.
  - **test** → `testServer(id)` then invalidate servers (to refresh the status dot).
  - ESC: if drawer open → close; else if create view → back to list. (Add a `keydown` listener.)
- Layout: `<div className="flex h-full">` with `CategorySidebar` + a main area that shows `McpCardGrid` (list view) or `CreateMcpForm` (create view). Drawer renders when `openId` is set (mask + panel; mask click closes).

- [ ] **Step 1: Write the failing test**

```tsx
import { beforeEach, describe, expect, test, vi } from 'vitest';
const fetchMock = vi.fn();
(globalThis as unknown as { fetch: unknown }).fetch = fetchMock;

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

import { useAuthStore } from '../../src/auth/store';
import { MCPManagePage } from '../../src/pages/MCPManagePage';

function seedFetch(): void {
  // Order matters: the page issues 3 queries (servers, categories, roles) in
  // parallel; mock enough responses. Use a dispatcher keyed on the URL.
  fetchMock.mockImplementation(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes('/servers')) {
      return new Response(JSON.stringify([
        { id: 'qcc', name: '企查查', name_zh: '企查查', description: 'd', category: 'search', transportType: 'http', serverUrl: 'https://x/mcp', command: null, authMethod: 'none', credentialMasked: null, timeoutSeconds: 30, allowedRoles: ['super_admin'], enabled: true, lastStatus: 'connected', lastLatencyMs: 142, lastTestedAt: '2026-09-11 18:30' },
      ]), { status: 200 });
    }
    if (url.includes('/categories')) {
      return new Response(JSON.stringify([{ id: 'search', name_zh: '搜索', name_en: 'Search', display_order: 1 }, { id: 'uncategorized', name_zh: '未分类', name_en: 'Uncategorized', display_order: 9999 }]), { status: 200 });
    }
    if (url.includes('/roles/vocabulary')) {
      return new Response(JSON.stringify({ roles: ['super_admin', 'org_admin', 'user'] }), { status: 200 });
    }
    return new Response('{}', { status: 200 });
  });
}

function renderPage(): void {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(<QueryClientProvider client={qc}><MemoryRouter><MCPManagePage /></MemoryRouter></QueryClientProvider>);
}

describe('MCPManagePage', () => {
  beforeEach(() => {
    fetchMock.mockReset();
    useAuthStore.setState({ token: 'jwt', claims: { sub: 'a', orgId: 'o1', roles: ['org_admin'] } });
    seedFetch();
  });

  test('renders the sidebar + a card, and opening a card opens the drawer', async () => {
    renderPage();
    const card = await screen.findByText('企查查');
    expect(card).toBeInTheDocument();
    fireEvent.click(card);
    await waitFor(() => expect(screen.getByRole('switch')).toBeInTheDocument());
  });

  test('+ Add MCP switches to the create form', async () => {
    renderPage();
    await screen.findByText('企查查');
    fireEvent.click(screen.getByRole('button', { name: /\+ Add MCP|添加 MCP/i }));
    expect(screen.getByText(/New MCP|新增 MCP/i)).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd enterprise_server/web && npx vitest run tests/pages/mcpManage/MCPManagePage.test.tsx`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the page**

```tsx
import { useEffect, useMemo, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { JSX } from 'react';
import { mcpMarketplaceApi } from '../api/mcpMarketplace';
import { t } from '../i18n';
import { fill, UNCATEGORIZED } from './mcpManage/types';
import { CategorySidebar } from './mcpManage/CategorySidebar';
import { McpCardGrid } from './mcpManage/McpCardGrid';
import { CreateMcpForm } from './mcpManage/CreateMcpForm';
import { DetailDrawer } from './mcpManage/DetailDrawer';

export function MCPManagePage(): JSX.Element {
  const qc = useQueryClient();
  const [current, setCurrent] = useState('all');
  const [search, setSearch] = useState('');
  const [view, setView] = useState<'list' | 'create'>('list');
  const [openId, setOpenId] = useState<string | null>(null);

  const serversQ = useQuery({ queryKey: ['mcp', 'servers'], queryFn: mcpMarketplaceApi.listServers });
  const catsQ = useQuery({ queryKey: ['mcp', 'categories'], queryFn: mcpMarketplaceApi.listCategories });
  const rolesQ = useQuery({ queryKey: ['mcp', 'roles'], queryFn: mcpMarketplaceApi.listRoleVocabulary });

  const servers = serversQ.data ?? [];
  const categories = catsQ.data ?? [];
  const roles = rolesQ.data?.roles ?? [];

  const q = search.trim().toLowerCase();
  const matchesSearch = (name: string) => !q || name.toLowerCase().includes(q);
  const filtered = servers.filter((s) => (current === 'all' || s.category === current) && matchesSearch(s.name));
  const counts = useMemo(() => {
    const c: Record<string, number> = {};
    for (const s of servers) if (matchesSearch(s.name)) c[s.category] = (c[s.category] ?? 0) + 1;
    return c;
  }, [servers, q]);

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ['mcp', 'servers'] });
    qc.invalidateQueries({ queryKey: ['mcp', 'categories'] });
  };

  const openServer = servers.find((s) => s.id === openId) ?? null;

  useEffect(() => {
    function onKey(e: KeyboardEvent): void {
      if (e.key !== 'Escape') return;
      if (openId) setOpenId(null);
      else if (view === 'create') setView('list');
    }
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [openId, view]);

  const deleteCategory = (id: string, name: string): void => {
    const n = servers.filter((s) => s.category === id).length;
    const msg = n > 0 ? fill(t('mcp.categoryDelete.confirm'), { name, n }) : fill(t('mcp.categoryDelete.confirmEmpty'), { name });
    if (!window.confirm(msg)) return;
    mcpMarketplaceApi.deleteCategory(id).then(invalidate).catch(() => undefined);
    if (current === id) setCurrent('all');
  };

  const categoryName = current === 'all' ? t('mcp.all') : categories.find((c) => c.id === current)?.name_zh ?? current;

  return (
    <div className="flex h-full">
      <CategorySidebar
        categories={categories}
        counts={counts}
        total={servers.filter((s) => matchesSearch(s.name)).length}
        current={current}
        onSelect={(id) => { setCurrent(id); setView('list'); }}
        onAdd={() => {
          const name = window.prompt(t('mcp.addCategory'));
          if (!name || !name.trim()) return;
          const slug = name.trim().toLowerCase().replace(/\s+/g, '-');
          mcpMarketplaceApi.createCategory({ category_id: slug, name_zh: name.trim(), name_en: name.trim() })
            .then(() => { invalidate(); setCurrent(slug); })
            .catch(() => undefined);
        }}
        onDelete={deleteCategory}
        search={search}
        onSearch={setSearch}
      />

      {view === 'create' ? (
        <CreateMcpForm
          categories={categories}
          defaultCategory={current === 'all' ? (categories[0]?.id ?? UNCATEGORIZED) : current}
          roles={roles}
          onCancel={() => setView('list')}
          onSave={(input) =>
            mcpMarketplaceApi.createServer(input).then((res) => {
              invalidate();
              setCurrent(input.category_id);
              setView('list');
              setOpenId(res.server_id);
            }).catch(() => undefined)
          }
        />
      ) : (
        <McpCardGrid
          servers={filtered}
          categoryName={categoryName}
          current={current}
          onAdd={() => setView('create')}
          onOpen={setOpenId}
        />
      )}

      {openServer && (
        <>
          <div className="fixed inset-0 z-[100] bg-[rgba(15,23,42,0.35)]" onClick={() => setOpenId(null)} />
          <DetailDrawer
            server={openServer}
            categories={categories}
            roles={roles}
            onClose={() => setOpenId(null)}
            onDelete={() => {
              if (!window.confirm(fill(t('mcp.delete.confirm'), { name: openServer.name, n: openServer.allowedRoles.length }))) return;
              mcpMarketplaceApi.deleteServer(openServer.id).then(() => { setOpenId(null); invalidate(); }).catch(() => undefined);
            }}
            onSave={(patch) => mcpMarketplaceApi.updateServer(openServer.id, patch).then(invalidate).then(() => setOpenId(null)).catch(() => undefined)}
            onToggleEnabled={(enabled) => mcpMarketplaceApi.updateServer(openServer.id, { enabled }).then(invalidate).catch(() => undefined)}
            onTest={() => mcpMarketplaceApi.testServer(openServer.id).then(() => invalidate())}
          />
        </>
      )}
    </div>
  );
}
```

> **Note for the implementer:** the page uses `queryFn` promises + `invalidate()` directly (simpler than mutation objects). The `counts`/`matchesSearch` are derived client-side to drive the sidebar count badges and search filter (matching the prototype).

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd enterprise_server/web && npx vitest run tests/pages/mcpManage/MCPManagePage.test.tsx`
Expected: PASS (2 tests).

- [ ] **Step 5: Lint + commit**

Run: `cd enterprise_server/web && npx eslint --ext ts,tsx --report-unused-disable-directives --max-warnings 0 src/pages/MCPManagePage.tsx`
```bash
git add enterprise_server/web/src/pages/MCPManagePage.tsx enterprise_server/web/tests/pages/mcpManage/MCPManagePage.test.tsx
git commit -m "feat(enterprise_server/web): add mcp management page"
```

---

### Task 18: Wire route + sidebar nav

**Files:**
- Modify: `enterprise_server/web/src/App.tsx`
- Modify: `enterprise_server/web/src/components/Sidebar.tsx`
- Test: `enterprise_server/web/tests/components/Sidebar.test.tsx` (append)

**Interfaces:**
- Consumes: `MCPManagePage`, `t`.
- Produces: route `/config/mcp-manage` (AuthGuard `org_admin`) and a sidebar nav item.

- [ ] **Step 1: Add a Sidebar test**

Append this test inside the existing `describe('components/Sidebar', …)` block in `enterprise_server/web/tests/components/Sidebar.test.tsx` (the file already imports `useAuthStore`, `render`, `screen`, `MemoryRouter`):

```tsx
  test('shows the MCP management nav item for org_admin', () => {
    useAuthStore.setState({ token: 'jwt', claims: { sub: 'a', orgId: 'o1', roles: ['org_admin'] } });
    renderSidebar('/config/mcp-manage');
    expect(screen.getByRole('link', { name: /MCP management/i })).toBeInTheDocument();
  });

  test('hides the MCP management nav item when lacking org_admin', () => {
    useAuthStore.setState({ token: 'jwt', claims: { sub: 'u', orgId: 'o1', roles: ['user'] } });
    renderSidebar();
    expect(screen.queryByRole('link', { name: /MCP management/i })).toBeNull();
  });
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd enterprise_server/web && npx vitest run tests/components/Sidebar.test.tsx`
Expected: FAIL — item not present.

- [ ] **Step 3: Add the sidebar item**

In `enterprise_server/web/src/components/Sidebar.tsx`, import `Plug` (or `Plug2`) from `lucide-react` and add to `ITEMS`:

```ts
{ to: '/config/mcp-manage', label: t('nav.mcpManage'), icon: <Plug2 />, section: 'config', requires: 'org_admin' },
```

- [ ] **Step 4: Add the route**

In `enterprise_server/web/src/App.tsx`:
- `import { MCPManagePage } from './pages/MCPManagePage';`
- Add a `<Route>` (mirror the `/config/mcp` block):
```tsx
        <Route
          path="/config/mcp-manage"
          element={
            <AuthGuard requires="org_admin">
              <Shell><MCPManagePage /></Shell>
            </AuthGuard>
          }
        />
```

- [ ] **Step 5: Run the Sidebar test to verify it passes**

Run: `cd enterprise_server/web && npx vitest run tests/components/Sidebar.test.tsx`
Expected: PASS (including the new test).

- [ ] **Step 6: Type-check + lint + commit**

Run: `cd enterprise_server/web && npx tsc --noEmit`
Run: `cd enterprise_server/web && npx eslint --ext ts,tsx --report-unused-disable-directives --max-warnings 0 src/App.tsx src/components/Sidebar.tsx`
```bash
git add enterprise_server/web/src/App.tsx enterprise_server/web/src/components/Sidebar.tsx enterprise_server/web/tests/components/Sidebar.test.tsx
git commit -m "feat(enterprise_server/web): route and nav the mcp management page"
```

---

### Task 19: Full-suite verification

**Files:** none (verification only).

- [ ] **Step 1: Run the full backend suite**

Run: `cd enterprise_server && npx vitest run --no-file-parallelism`
Expected: all tests pass. If a legacy/unrelated test was already failing before this work, confirm via `git stash` + re-run that it's pre-existing, note it, and leave it.

- [ ] **Step 2: Run the full web suite**

Run: `cd enterprise_server/web && npx vitest run`
Expected: all tests pass (same pre-existing-debt caveat).

- [ ] **Step 3: Backend type-check**

Run: `cd enterprise_server && npx tsc --noEmit`
Expected: PASS.

- [ ] **Step 4: Report**

Report: backend pass/fail counts, web pass/fail counts, any pre-existing failures (with evidence they pre-date this work), and confirm `git status` is clean of unintended files.
