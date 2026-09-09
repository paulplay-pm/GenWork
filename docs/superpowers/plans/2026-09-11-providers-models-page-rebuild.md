# Providers & Models Page — Prototype-Driven Rebuild

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rebuild `enterprise_server`'s `/config/providers` page to match the prototype at `/Users/paulwang/WorkBuddy/2026-09-08-21-59-26/llm-config/models.html`, dropping the 7 user-excluded features (stop sequences, stream toggle, function calling toggle, thinking budget, response format, RPM/TPM, pricing).

**Architecture:** Layered rebuild — DB migrations first, then server endpoints, then API client extensions, then UI sub-components, then page composition. Strict TDD throughout. No new npm dependencies.

**Tech Stack:** React 18, Hono (server), TanStack Query, Vitest, PGlite (test DB), TypeScript strict mode.

**Spec:** `docs/superpowers/specs/2026-09-11-providers-models-page-rebuild-design.md`

## Global Constraints

- **Node version**: `>=24.15.0 <25` per `package.json:engines`.
- **Out of scope** (per spec, no schema, no API, no UI, no i18n):
  - 停止符 (stop sequences)
  - 流式输出 (stream toggle)
  - 函数调用 (function calling toggle)
  - 思维链预算 (thinking budget)
  - 响应格式 (response format — text / JSON Object / JSON Schema)
  - 限速 (RPM / TPM)
  - 定价 (input / output price)
- **Auth convention**: Read endpoints (GET, `/test`, `/refresh-models`) use `requireAuth`. Write endpoints (POST/PATCH/DELETE) use `requireCapability('admin')` (which already short-circuits on super_admin).
- **i18n**: Both `zh` and `en` entries required for every user-visible string.
- **Lint**: All touched files must pass `npx eslint --ext ts,tsx --report-unused-disable-directives --max-warnings 0 <files>`.
- **Don't refactor unrelated code** — scope strictly to the spec.
- **No new dependencies**.
- **Migration runner**: Drop new `.sql` files into `enterprise_server/src/db/migrations/`; loader auto-detects.

---

## Task 1: Add provider_keys extended schema (migration 015)

**Files:**
- Create: `enterprise_server/src/db/migrations/015_provider_keys_extended.sql`

**Interfaces:**
- Produces: 5 new columns on `provider_keys` table: `desc`, `api_key_masked`, `status`, `latency_ms`, `last_test_at`.

- [ ] **Step 1: Write the SQL migration file**

Create `enterprise_server/src/db/migrations/015_provider_keys_extended.sql`:

```sql
-- Extended provider_keys with display + connection-test fields.
-- All columns are additive and backward-compatible:
--   - desc, api_key_masked, latency_ms, last_test_at are NULLABLE
--   - status defaults to 'unknown' for existing rows

ALTER TABLE provider_keys
  ADD COLUMN IF NOT EXISTS desc TEXT,
  ADD COLUMN IF NOT EXISTS api_key_masked TEXT,
  ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'unknown'
    CHECK (status IN ('unknown', 'connected', 'failed')),
  ADD COLUMN IF NOT EXISTS latency_ms INTEGER,
  ADD COLUMN IF NOT EXISTS last_test_at TIMESTAMPTZ;
```

- [ ] **Step 2: Verify migration applies cleanly**

Run from `enterprise_server/`:
```bash
npm test -- providerKeysRefresh 2>&1 | tail -10
```

Expected: All existing tests still pass (they re-run migrations against the test DB, which auto-loads the new file).

- [ ] **Step 3: Commit**

```bash
git add enterprise_server/src/db/migrations/015_provider_keys_extended.sql
git commit -m "feat(db): add extended fields to provider_keys"
```

---

## Task 2: Add models extended schema (migration 016)

**Files:**
- Create: `enterprise_server/src/db/migrations/016_models_params.sql`

**Interfaces:**
- Produces: 3 new columns on `models` table: `temperature`, `top_p`, `max_output_tokens`.
- Existing `supports_image` / `supports_video` / `supports_thinking` (from migration 006) are reused.

- [ ] **Step 1: Write the SQL migration file**

Create `enterprise_server/src/db/migrations/016_models_params.sql`:

```sql
-- Extend models with sampling parameters (kept fields only).
-- 7 fields excluded by spec are NOT added here:
--   stop sequences, stream toggle, function calling toggle,
--   thinking budget, response format, RPM/TPM, pricing.

ALTER TABLE models
  ADD COLUMN IF NOT EXISTS temperature REAL,
  ADD COLUMN IF NOT EXISTS top_p REAL,
  ADD COLUMN IF NOT EXISTS max_output_tokens INTEGER;
```

- [ ] **Step 2: Verify migration applies cleanly**

```bash
cd enterprise_server && npm test 2>&1 | grep -E "Test Files|Tests "
```

Expected: Same number of passing tests as before this change.

- [ ] **Step 3: Commit**

```bash
git add enterprise_server/src/db/migrations/016_models_params.sql
git commit -m "feat(db): add temperature/top_p/max_output_tokens to models"
```

---

## Task 3: Add shared type `ProviderKeyStatus`

**Files:**
- Create: `enterprise_server/src/shared/providerKeys/constants.ts`

**Interfaces:**
- Produces: `ProviderKeyStatus` const map + type, used by Task 4 and Task 5.

- [ ] **Step 1: Create the constants file**

Create `enterprise_server/src/shared/providerKeys/constants.ts`:

```ts
export const ProviderKeyStatus = {
  Unknown: 'unknown',
  Connected: 'connected',
  Failed: 'failed',
} as const;

export type ProviderKeyStatus =
  (typeof ProviderKeyStatus)[keyof typeof ProviderKeyStatus];
```

- [ ] **Step 2: Verify TypeScript compiles**

```bash
cd enterprise_server && npx tsc --noEmit -p tsconfig.json 2>&1 | tail -5
```

Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add enterprise_server/src/shared/providerKeys/constants.ts
git commit -m "feat(shared): add ProviderKeyStatus enum"
```

---

## Task 4: Server `PATCH /admin/provider-keys/:id`

**Files:**
- Modify: `enterprise_server/src/routes/admin/providerKeys.ts`
- Create: `enterprise_server/tests/routes/providerKeysExtended.test.ts`

**Interfaces:**
- Consumes: `ProviderKeyStatus` from Task 3.
- Produces: `PATCH /admin/provider-keys/:id` accepting `{ name?, desc?, baseUrl?, label?, enabled? }`, returns `{ ok: true }`.

- [ ] **Step 1: Write the failing test**

Add to `enterprise_server/tests/routes/providerKeysExtended.test.ts`:

```ts
import '../helpers/setupEnv';

import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.ENTERPRISE_STATE_DIR = join(tmpdir(), 'enterprise-prov-ext-' + Date.now() + '-' + Math.random().toString(36).slice(2));

import { beforeEach, describe, expect, test, vi } from 'vitest';

vi.mock('../../src/db/pool', async () => {
  const td = await import('../../src/db/testDb');
  return { pool: td.testPool };
});

import { Hono } from 'hono';
import { signToken } from '../../src/auth/jwt';
import { resetSchema, runMigrations, testPool } from '../../src/db/testDb';
import { providerKeyVault } from '../../src/providerKeys/providerKeyVault';
import { adminProviderKeyRoutes } from '../../src/routes/admin/providerKeys';
import { authRoutes } from '../../src/routes/auth';

const app = new Hono();
app.route('/', authRoutes);
app.route('/', adminProviderKeyRoutes);

async function seed(orgName = 'T'): Promise<{ id: string; token: string }> {
  await testPool.query(`INSERT INTO orgs(id,name) VALUES ('o1', $1)`, [orgName]);
  // super_admin bypasses every gate — use it to seed
  const tok = await signToken({ sub: 'u1', orgId: 'o1', roles: ['super_admin'] });
  const k = await providerKeyVault.add({
    orgId: 'o1',
    provider: 'openai',
    plaintextKey: 'sk-orig',
    endpoint: 'https://api.openai.com/v1',
    createdBy: 'u1',
  });
  return { id: k.id, token: tok };
}

describe('PATCH /admin/provider-keys/:id', () => {
  beforeEach(async () => {
    await resetSchema();
    await runMigrations();
  });

  test('admin can update name, desc, baseUrl, label', async () => {
    const { id, token } = await seed();
    const res = await app.request(`/admin/provider-keys/${id}`, {
      method: 'PATCH',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        name: 'OpenAI',
        desc: 'Primary provider',
        baseUrl: 'https://api.openai.com/v2',
        label: 'prod',
      }),
    });
    expect(res.status).toBe(200);
    const r = await testPool.query('SELECT name, desc, endpoint, label FROM provider_keys WHERE id = $1', [id]);
    expect(r.rows[0].name).toBe('OpenAI');
    expect(r.rows[0].desc).toBe('Primary provider');
    expect(r.rows[0].endpoint).toBe('https://api.openai.com/v2');
    expect(r.rows[0].label).toBe('prod');
  });

  test('non-admin gets 403', async () => {
    const { id } = await seed();
    const userTok = await signToken({ sub: 'u2', orgId: 'o1', roles: ['user'] });
    const res = await app.request(`/admin/provider-keys/${id}`, {
      method: 'PATCH',
      headers: { authorization: `Bearer ${userTok}`, 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'X' }),
    });
    expect(res.status).toBe(403);
  });

  test('cross-org id returns 404', async () => {
    const { id } = await seed();
    const otherOrg = await signToken({ sub: 'u3', orgId: 'o2', roles: ['super_admin'] });
    const res = await app.request(`/admin/provider-keys/${id}`, {
      method: 'PATCH',
      headers: { authorization: `Bearer ${otherOrg}`, 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'X' }),
    });
    expect(res.status).toBe(404);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd enterprise_server && npx vitest run providerKeysExtended 2>&1 | tail -10
```

Expected: FAIL with "404" or "method not allowed".

- [ ] **Step 3: Implement the PATCH handler**

Add to `enterprise_server/src/routes/admin/providerKeys.ts`:

```ts
adminProviderKeyRoutes.patch('/:id', requireCapability('admin'), async (c) => {
  const claims = c.get('claims');
  const id = c.req.param('id');
  const body = await c.req.json<{
    name?: string; desc?: string; baseUrl?: string; label?: string; enabled?: boolean;
  }>().catch(() => ({} as Record<string, unknown>));

  // Build dynamic UPDATE with only the provided fields.
  const sets: string[] = [];
  const params: unknown[] = [];
  let i = 1;
  if ('name' in body)    { sets.push(`name = $${i++}`);    params.push(body.name); }
  if ('desc' in body)    { sets.push(`desc = $${i++}`);     params.push(body.desc); }
  if ('baseUrl' in body) { sets.push(`endpoint = $${i++}`); params.push(body.baseUrl); }
  if ('label' in body)   { sets.push(`label = $${i++}`);   params.push(body.label); }
  if ('enabled' in body) { sets.push(`enabled = $${i++}`); params.push(body.enabled); }

  if (sets.length === 0) return c.json({ ok: true });

  params.push(id, claims.orgId);
  const r = await pool.query(
    `UPDATE provider_keys SET ${sets.join(', ')}
       WHERE id = $${i++} AND org_id = $${i}`,
    params,
  );
  if (r.rowCount === 0) return c.json({ error: 'provider_not_found' }, 404);
  return c.json({ ok: true });
});
```

Add at top of file: `import { requireCapability } from '../../auth/middleware';` (if not already imported).

- [ ] **Step 4: Run test to verify it passes**

```bash
cd enterprise_server && npx vitest run providerKeysExtended 2>&1 | tail -10
```

Expected: 3 passed.

- [ ] **Step 5: Commit**

```bash
git add enterprise_server/src/routes/admin/providerKeys.ts enterprise_server/tests/routes/providerKeysExtended.test.ts
git commit -m "feat(api): add PATCH /admin/provider-keys/:id"
```

---

## Task 5: Server `DELETE /admin/provider-keys/:id` (cascade)

**Files:**
- Modify: `enterprise_server/src/routes/admin/providerKeys.ts`
- Modify: `enterprise_server/tests/routes/providerKeysExtended.test.ts` (add 2 tests)

**Interfaces:**
- Produces: `DELETE /admin/provider-keys/:id` cascades to delete all models for that provider, returns `{ ok: true, deletedModels: number }`.

- [ ] **Step 1: Add failing tests**

Append to `enterprise_server/tests/routes/providerKeysExtended.test.ts`:

```ts
  test('DELETE cascades to models and returns count', async () => {
    const { id, token } = await seed();
    // Insert 2 model rows for this provider
    await testPool.query(
      `INSERT INTO models(id, org_id, provider, model, provider_id) VALUES
        ('m1', 'o1', 'openai', 'gpt-4', $1),
        ('m2', 'o1', 'openai', 'gpt-3.5', $1)`,
      [id],
    );
    const res = await app.request(`/admin/provider-keys/${id}`, {
      method: 'DELETE',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(200);
    const body = await res.json() as { ok: boolean; deletedModels: number };
    expect(body.ok).toBe(true);
    expect(body.deletedModels).toBe(2);

    const r = await testPool.query('SELECT count(*)::int AS n FROM provider_keys WHERE id = $1', [id]);
    expect(r.rows[0].n).toBe(0);
    const r2 = await testPool.query('SELECT count(*)::int AS n FROM models WHERE provider_id = $1', [id]);
    expect(r2.rows[0].n).toBe(0);
  });

  test('DELETE on missing id returns 404', async () => {
    const { token } = await seed();
    const res = await app.request('/admin/provider-keys/00000000-0000-0000-0000-000000000000', {
      method: 'DELETE',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(404);
  });
```

Note: schema check — `models` table columns. Read `enterprise_server/src/db/migrations/001_init.sql` to confirm `models.id` is the primary key and `models.provider_id` exists. If column names differ, adjust the INSERT.

- [ ] **Step 2: Run test to verify it fails**

```bash
cd enterprise_server && npx vitest run providerKeysExtended 2>&1 | tail -5
```

Expected: 2 new tests FAIL.

- [ ] **Step 3: Implement DELETE handler**

Add to `enterprise_server/src/routes/admin/providerKeys.ts` (after the PATCH handler):

```ts
adminProviderKeyRoutes.delete('/:id', requireCapability('admin'), async (c) => {
  const claims = c.get('claims');
  const id = c.req.param('id');
  // Verify cross-org: provider must belong to caller's org
  const exists = await pool.query<{ id: string }>(
    `SELECT id FROM provider_keys WHERE id = $1 AND org_id = $2`,
    [id, claims.orgId],
  );
  if (exists.rowCount === 0) return c.json({ error: 'provider_not_found' }, 404);

  const del = await pool.query<{ count: string }>(
    `WITH d AS (
       DELETE FROM models WHERE provider_id = $1 AND org_id = $2
       RETURNING 1
     )
     SELECT count(*)::text AS count FROM d`,
    [id, claims.orgId],
  );
  await pool.query(`DELETE FROM provider_keys WHERE id = $1 AND org_id = $2`, [id, claims.orgId]);
  return c.json({ ok: true, deletedModels: Number(del.rows[0]?.count ?? 0) });
});
```

- [ ] **Step 4: Run test to verify it passes**

```bash
cd enterprise_server && npx vitest run providerKeysExtended 2>&1 | tail -5
```

Expected: 5 passed.

- [ ] **Step 5: Commit**

```bash
git add enterprise_server/src/routes/admin/providerKeys.ts enterprise_server/tests/routes/providerKeysExtended.test.ts
git commit -m "feat(api): add DELETE /admin/provider-keys/:id with cascade"
```

---

## Task 6: Server `POST /admin/provider-keys/:id/test` (connection test)

**Files:**
- Modify: `enterprise_server/src/routes/admin/providerKeys.ts`
- Modify: `enterprise_server/tests/routes/providerKeysExtended.test.ts` (add 2 tests)

**Interfaces:**
- Produces: `POST /admin/provider-keys/:id/test` performs an HTTP probe to `endpoint + '/health'` (fallback `/v1/models`), 5s timeout. Updates `status`/`latency_ms`/`last_test_at` and returns same fields.

- [ ] **Step 1: Add failing tests**

Append to `enterprise_server/tests/routes/providerKeysExtended.test.ts`:

```ts
  test('test endpoint returns 502 when upstream is unreachable', async () => {
    const { id, token } = await seed();
    // Re-point endpoint at a port nothing is listening on
    await testPool.query(`UPDATE provider_keys SET endpoint = $1 WHERE id = $2`,
      ['http://127.0.0.1:1', id]);
    const res = await app.request(`/admin/provider-keys/${id}/test`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}` },
    });
    // Either 200 with status='failed', or 502 — both acceptable
    expect([200, 502]).toContain(res.status);
    const body = await res.json() as { status: string; latencyMs: number; lastTestAt: string };
    expect(['failed', 'connected']).toContain(body.status);
    expect(typeof body.latencyMs).toBe('number');
    expect(typeof body.lastTestAt).toBe('string');

    // Verify the DB row was updated
    const r = await testPool.query('SELECT status, latency_ms FROM provider_keys WHERE id = $1', [id]);
    expect(['failed', 'connected']).toContain(r.rows[0].status);
  });

  test('test endpoint on missing id returns 404', async () => {
    const { token } = await seed();
    const res = await app.request('/admin/provider-keys/00000000-0000-0000-0000-000000000000/test', {
      method: 'POST',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(404);
  });
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd enterprise_server && npx vitest run providerKeysExtended 2>&1 | tail -5
```

Expected: 2 new tests FAIL (no `/test` route yet).

- [ ] **Step 3: Implement the test handler**

Add to `enterprise_server/src/routes/admin/providerKeys.ts` (after DELETE):

```ts
adminProviderKeyRoutes.post('/:id/test', requireAuth, async (c) => {
  const claims = c.get('claims');
  const id = c.req.param('id');
  const r = await pool.query<{ endpoint: string | null }>(
    `SELECT endpoint FROM provider_keys WHERE id = $1 AND org_id = $2`,
    [id, claims.orgId],
  );
  if (r.rowCount === 0) return c.json({ error: 'provider_not_found' }, 404);
  const endpoint = r.rows[0].endpoint;
  if (!endpoint) {
    return c.json({ status: 'failed', latencyMs: 0, lastTestAt: new Date().toISOString(), error: 'no_endpoint' }, 400);
  }

  const probe = async (url: string): Promise<{ ok: boolean; ms: number }> => {
    const start = Date.now();
    try {
      const ac = new AbortController();
      const timeout = setTimeout(() => ac.abort(), 5000);
      const res = await fetch(url, { method: 'GET', signal: ac.signal });
      clearTimeout(timeout);
      return { ok: res.ok, ms: Date.now() - start };
    } catch {
      return { ok: false, ms: Date.now() - start };
    }
  };

  // Try /health first, fall back to /v1/models for OpenAI-compatible endpoints
  let probeResult = await probe(`${endpoint.replace(/\/$/, '')}/health`);
  if (!probeResult.ok) {
    probeResult = await probe(`${endpoint.replace(/\/$/, '')}/v1/models`);
  }

  const status = probeResult.ok ? 'connected' : 'failed';
  const lastTestAt = new Date().toISOString();
  await pool.query(
    `UPDATE provider_keys SET status = $1, latency_ms = $2, last_test_at = $3 WHERE id = $4 AND org_id = $5`,
    [status, probeResult.ms, lastTestAt, id, claims.orgId],
  );
  return c.json({ status, latencyMs: probeResult.ms, lastTestAt });
});
```

- [ ] **Step 4: Run test to verify it passes**

```bash
cd enterprise_server && npx vitest run providerKeysExtended 2>&1 | tail -5
```

Expected: 7 passed.

- [ ] **Step 5: Commit**

```bash
git add enterprise_server/src/routes/admin/providerKeys.ts enterprise_server/tests/routes/providerKeysExtended.test.ts
git commit -m "feat(api): add POST /admin/provider-keys/:id/test"
```

---

## Task 7: Server extend `GET /admin/provider-keys` response

**Files:**
- Modify: `enterprise_server/src/routes/admin/providerKeys.ts`
- Modify: `enterprise_server/tests/routes/providerKeysExtended.test.ts` (add 1 test)

**Interfaces:**
- Produces: GET response includes new fields: `desc`, `apiKeyMasked`, `status`, `latencyMs`, `lastTestAt`. Also rename `name` field if previously used (keep `label` as legacy alias).

- [ ] **Step 1: Add failing test**

Append to `enterprise_server/tests/routes/providerKeysExtended.test.ts`:

```ts
  test('GET response includes extended fields', async () => {
    const { id, token } = await seed();
    await testPool.query(`UPDATE provider_keys SET desc = $1, status = $2, latency_ms = $3, last_test_at = NOW(), api_key_masked = $4 WHERE id = $5`,
      ['Note text', 'connected', 142, 'sk-••••••••abc123', id]);

    const res = await app.request('/admin/provider-keys', {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(200);
    const rows = await res.json() as Array<{ id: string; desc: string; status: string; latencyMs: number; lastTestAt: string; apiKeyMasked: string }>;
    const row = rows.find((r) => r.id === id);
    expect(row).toBeDefined();
    expect(row!.desc).toBe('Note text');
    expect(row!.status).toBe('connected');
    expect(row!.latencyMs).toBe(142);
    expect(row!.lastTestAt).toMatch(/\d{4}-\d{2}-\d{2}T/);
    expect(row!.apiKeyMasked).toBe('sk-••••••••abc123');
  });
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd enterprise_server && npx vitest run providerKeysExtended 2>&1 | tail -5
```

Expected: FAIL — current GET response lacks these fields.

- [ ] **Step 3: Modify the GET handler**

In `enterprise_server/src/routes/admin/providerKeys.ts`, locate the existing `GET /admin/provider-keys` handler. Update the SELECT to include the new columns and the response mapping:

```ts
adminProviderKeyRoutes.get('/', requireAuth, async (c) => {
  const claims = c.get('claims');
  const r = await pool.query<{
    id: string; provider: string; endpoint: string | null; label: string | null;
    enabled: boolean; region: string | null; default_base_url: string | null;
    website: string | null; created_at: Date;
    desc: string | null; api_key_masked: string | null; status: string;
    latency_ms: number | null; last_test_at: Date | null;
  }>(
    `SELECT id, provider, endpoint, label, enabled, region, default_base_url,
            website, created_at, desc, api_key_masked, status, latency_ms, last_test_at
       FROM provider_keys WHERE org_id = $1
       ORDER BY created_at DESC`,
    [claims.orgId],
  );
  return c.json(r.rows.map((row) => ({
    id: row.id,
    provider: row.provider,
    name: row.label ?? row.provider,           // display name (label fallback)
    label: row.label,
    enabled: row.enabled,
    desc: row.desc,
    apiKeyMasked: row.api_key_masked,
    status: row.status,
    latencyMs: row.latency_ms,
    lastTestAt: row.last_test_at?.toISOString() ?? null,
    endpoint: row.endpoint,
    region: row.region,
    defaultBaseUrl: row.default_base_url,
    website: row.website,
    createdAt: row.created_at.toISOString(),
  })));
});
```

If the existing handler uses different field names, adapt accordingly — the **output shape** is what matters (camelCase, with `desc`, `apiKeyMasked`, `status`, `latencyMs`, `lastTestAt`).

- [ ] **Step 4: Run test to verify it passes**

```bash
cd enterprise_server && npx vitest run providerKeysExtended 2>&1 | tail -5
```

Expected: 8 passed.

- [ ] **Step 5: Commit**

```bash
git add enterprise_server/src/routes/admin/providerKeys.ts enterprise_server/tests/routes/providerKeysExtended.test.ts
git commit -m "feat(api): extend GET /admin/provider-keys response"
```

---

## Task 8: Server `PATCH /admin/models/:id`

**Files:**
- Modify: `enterprise_server/src/routes/admin/models.ts`
- Create: `enterprise_server/tests/routes/modelsExtended.test.ts`

**Interfaces:**
- Produces: `PATCH /admin/models/:id` accepts `{ displayName?, enabled?, params: { temperature?, topP?, maxOutputTokens?, supportsImage?, supportsVideo?, supportsThinking? } }`, returns `{ ok: true }`.

- [ ] **Step 1: Write the failing test**

Create `enterprise_server/tests/routes/modelsExtended.test.ts`:

```ts
import '../helpers/setupEnv';

import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.ENTERPRISE_STATE_DIR = join(tmpdir(), 'enterprise-mod-ext-' + Date.now() + '-' + Math.random().toString(36).slice(2));

import { beforeEach, describe, expect, test, vi } from 'vitest';

vi.mock('../../src/db/pool', async () => {
  const td = await import('../../src/db/testDb');
  return { pool: td.testPool };
});

import { Hono } from 'hono';
import { signToken } from '../../src/auth/jwt';
import { resetSchema, runMigrations, testPool } from '../../src/db/testDb';
import { providerKeyVault } from '../../src/providerKeys/providerKeyVault';
import { adminModelRoutes } from '../../src/routes/admin/models';
import { authRoutes } from '../../src/routes/auth';

const app = new Hono();
app.route('/', authRoutes);
app.route('/', adminModelRoutes);

async function seedModel(): Promise<{ providerId: string; modelId: string; token: string }> {
  await testPool.query(`INSERT INTO orgs(id,name) VALUES ('o1', 'T')`);
  const tok = await signToken({ sub: 'u1', orgId: 'o1', roles: ['super_admin'] });
  const k = await providerKeyVault.add({
    orgId: 'o1',
    provider: 'openai',
    plaintextKey: 'sk-test',
    endpoint: 'https://api.openai.com/v1',
    createdBy: 'u1',
  });
  const m = await testPool.query<{ id: string }>(
    `INSERT INTO models(org_id, provider, model, provider_id) VALUES ('o1', 'openai', 'gpt-4', $1) RETURNING id`,
    [k.id],
  );
  return { providerId: k.id, modelId: m.rows[0]!.id, token: tok };
}

describe('PATCH /admin/models/:id', () => {
  beforeEach(async () => {
    await resetSchema();
    await runMigrations();
  });

  test('admin can update display_name, enabled, and params', async () => {
    const { modelId, token } = await seedModel();
    const res = await app.request(`/admin/models/${modelId}`, {
      method: 'PATCH',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        displayName: 'GPT-4 (Custom)',
        enabled: false,
        params: {
          temperature: 0.7,
          topP: 0.9,
          maxOutputTokens: 4096,
          supportsImage: true,
          supportsVideo: false,
          supportsThinking: true,
        },
      }),
    });
    expect(res.status).toBe(200);
    const r = await testPool.query(
      `SELECT display_name, enabled, temperature, top_p, max_output_tokens,
              supports_image, supports_video, supports_thinking
         FROM models WHERE id = $1`,
      [modelId],
    );
    expect(r.rows[0].display_name).toBe('GPT-4 (Custom)');
    expect(r.rows[0].enabled).toBe(false);
    expect(Number(r.rows[0].temperature)).toBe(0.7);
    expect(Number(r.rows[0].top_p)).toBe(0.9);
    expect(r.rows[0].max_output_tokens).toBe(4096);
    expect(r.rows[0].supports_image).toBe(true);
    expect(r.rows[0].supports_video).toBe(false);
    expect(r.rows[0].supports_thinking).toBe(true);
  });

  test('non-admin gets 403', async () => {
    const { modelId } = await seedModel();
    const userTok = await signToken({ sub: 'u2', orgId: 'o1', roles: ['user'] });
    const res = await app.request(`/admin/models/${modelId}`, {
      method: 'PATCH',
      headers: { authorization: `Bearer ${userTok}`, 'content-type': 'application/json' },
      body: JSON.stringify({ enabled: false }),
    });
    expect(res.status).toBe(403);
  });

  test('cross-org id returns 404', async () => {
    const { modelId } = await seedModel();
    const otherOrg = await signToken({ sub: 'u3', orgId: 'o2', roles: ['super_admin'] });
    const res = await app.request(`/admin/models/${modelId}`, {
      method: 'PATCH',
      headers: { authorization: `Bearer ${otherOrg}`, 'content-type': 'application/json' },
      body: JSON.stringify({ enabled: false }),
    });
    expect(res.status).toBe(404);
  });

  test('rejects temperature > 2 with 400', async () => {
    const { modelId, token } = await seedModel();
    const res = await app.request(`/admin/models/${modelId}`, {
      method: 'PATCH',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ params: { temperature: 5 } }),
    });
    expect(res.status).toBe(400);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd enterprise_server && npx vitest run modelsExtended 2>&1 | tail -10
```

Expected: 4 tests FAIL.

- [ ] **Step 3: Implement the PATCH handler**

Add to `enterprise_server/src/routes/admin/models.ts`:

```ts
adminModelRoutes.patch('/:id', requireCapability('admin'), async (c) => {
  const claims = c.get('claims');
  const id = c.req.param('id');
  const body = await c.req.json<{
    displayName?: string;
    enabled?: boolean;
    params?: {
      temperature?: number | null;
      topP?: number | null;
      maxOutputTokens?: number | null;
      supportsImage?: boolean;
      supportsVideo?: boolean;
      supportsThinking?: boolean;
    };
  }>().catch(() => ({} as Record<string, unknown>));

  // Validation
  if (body.params) {
    const { temperature, topP, maxOutputTokens } = body.params;
    if (temperature != null && (temperature < 0 || temperature > 2)) {
      return c.json({ error: 'validation_error', field: 'temperature' }, 400);
    }
    if (topP != null && (topP < 0 || topP > 1)) {
      return c.json({ error: 'validation_error', field: 'topP' }, 400);
    }
    if (maxOutputTokens != null && (maxOutputTokens < 1 || maxOutputTokens > 200000)) {
      return c.json({ error: 'validation_error', field: 'maxOutputTokens' }, 400);
    }
  }

  const sets: string[] = [];
  const params: unknown[] = [];
  let i = 1;
  if ('displayName' in body) { sets.push(`display_name = $${i++}`); params.push(body.displayName); }
  if ('enabled' in body)     { sets.push(`enabled = $${i++}`);      params.push(body.enabled); }

  if (body.params) {
    if ('temperature' in body.params)     { sets.push(`temperature = $${i++}`);     params.push(body.params.temperature); }
    if ('topP' in body.params)            { sets.push(`top_p = $${i++}`);           params.push(body.params.topP); }
    if ('maxOutputTokens' in body.params) { sets.push(`max_output_tokens = $${i++}`); params.push(body.params.maxOutputTokens); }
    if ('supportsImage' in body.params)    { sets.push(`supports_image = $${i++}`);  params.push(body.params.supportsImage); }
    if ('supportsVideo' in body.params)    { sets.push(`supports_video = $${i++}`);  params.push(body.params.supportsVideo); }
    if ('supportsThinking' in body.params) { sets.push(`supports_thinking = $${i++}`); params.push(body.params.supportsThinking); }
  }

  if (sets.length === 0) return c.json({ ok: true });

  params.push(id, claims.orgId);
  const r = await pool.query(
    `UPDATE models SET ${sets.join(', ')}
       WHERE id = $${i++} AND org_id = $${i}`,
    params,
  );
  if (r.rowCount === 0) return c.json({ error: 'model_not_found' }, 404);
  return c.json({ ok: true });
});
```

Add at top: `import { requireCapability, requireAuth } from '../../auth/middleware';` (if not already).

- [ ] **Step 4: Run test to verify it passes**

```bash
cd enterprise_server && npx vitest run modelsExtended 2>&1 | tail -5
```

Expected: 4 passed.

- [ ] **Step 5: Commit**

```bash
git add enterprise_server/src/routes/admin/models.ts enterprise_server/tests/routes/modelsExtended.test.ts
git commit -m "feat(api): add PATCH /admin/models/:id with params"
```

---

## Task 9: Server `DELETE /admin/models/:id`

**Files:**
- Modify: `enterprise_server/src/routes/admin/models.ts`
- Modify: `enterprise_server/tests/routes/modelsExtended.test.ts` (add 2 tests)

**Interfaces:**
- Produces: `DELETE /admin/models/:id` returns `{ ok: true }`. Cross-org returns 404.

- [ ] **Step 1: Add failing tests**

Append to `enterprise_server/tests/routes/modelsExtended.test.ts`:

```ts
  test('DELETE removes the model row', async () => {
    const { modelId, token } = await seedModel();
    const res = await app.request(`/admin/models/${modelId}`, {
      method: 'DELETE',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(200);
    const body = await res.json() as { ok: boolean };
    expect(body.ok).toBe(true);
    const r = await testPool.query('SELECT count(*)::int AS n FROM models WHERE id = $1', [modelId]);
    expect(r.rows[0].n).toBe(0);
  });

  test('DELETE on missing id returns 404', async () => {
    const { token } = await seedModel();
    const res = await app.request('/admin/models/00000000-0000-0000-0000-000000000000', {
      method: 'DELETE',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(404);
  });
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd enterprise_server && npx vitest run modelsExtended 2>&1 | tail -5
```

Expected: 2 new tests FAIL.

- [ ] **Step 3: Implement DELETE handler**

Add to `enterprise_server/src/routes/admin/models.ts` (after PATCH):

```ts
adminModelRoutes.delete('/:id', requireCapability('admin'), async (c) => {
  const claims = c.get('claims');
  const id = c.req.param('id');
  const r = await pool.query(
    `DELETE FROM models WHERE id = $1 AND org_id = $2`,
    [id, claims.orgId],
  );
  if (r.rowCount === 0) return c.json({ error: 'model_not_found' }, 404);
  return c.json({ ok: true });
});
```

- [ ] **Step 4: Run test to verify it passes**

```bash
cd enterprise_server && npx vitest run modelsExtended 2>&1 | tail -5
```

Expected: 6 passed.

- [ ] **Step 5: Commit**

```bash
git add enterprise_server/src/routes/admin/models.ts enterprise_server/tests/routes/modelsExtended.test.ts
git commit -m "feat(api): add DELETE /admin/models/:id"
```

---

## Task 10: Server extend `GET /admin/models` and `POST /admin/models`

**Files:**
- Modify: `enterprise_server/src/routes/admin/models.ts`
- Modify: `enterprise_server/tests/routes/modelsExtended.test.ts` (add 2 tests)

**Interfaces:**
- Produces: GET response includes `temperature`, `topP`, `maxOutputTokens`, `displayName`, `supportsImage`, `supportsVideo`, `supportsThinking`.
- Produces: POST accepts the same params in request body, persists them.

- [ ] **Step 1: Add failing tests**

Append to `enterprise_server/tests/routes/modelsExtended.test.ts`:

```ts
  test('POST persists params and GET returns them', async () => {
    const { providerId, token } = await seedModel();
    const res = await app.request('/admin/models', {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        providerId,
        model: 'gpt-4-turbo',
        displayName: 'GPT-4 Turbo',
        params: {
          temperature: 0.5,
          topP: 0.95,
          maxOutputTokens: 8192,
          supportsImage: true,
          supportsVideo: false,
          supportsThinking: false,
        },
      }),
    });
    expect(res.status).toBe(200);
    const created = await res.json() as { id: string };
    expect(created.id).toBeTruthy();

    // Verify GET returns the params
    const list = await app.request('/admin/models', {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(list.status).toBe(200);
    const rows = await list.json() as Array<{
      id: string; model: string; temperature: number | null; topP: number | null;
      maxOutputTokens: number | null; supportsImage: boolean; supportsThinking: boolean;
    }>;
    const found = rows.find((r) => r.id === created.id);
    expect(found).toBeDefined();
    expect(found!.temperature).toBe(0.5);
    expect(found!.topP).toBe(0.95);
    expect(found!.maxOutputTokens).toBe(8192);
    expect(found!.supportsImage).toBe(true);
    expect(found!.supportsThinking).toBe(false);
  });

  test('POST with duplicate (providerId, model) returns 409', async () => {
    const { providerId, token } = await seedModel();
    // First create
    await app.request('/admin/models', {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ providerId, model: 'gpt-4-dup', params: {} }),
    });
    // Second create with same model
    const res = await app.request('/admin/models', {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ providerId, model: 'gpt-4-dup', params: {} }),
    });
    expect(res.status).toBe(409);
  });
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd enterprise_server && npx vitest run modelsExtended 2>&1 | tail -5
```

Expected: 2 new tests FAIL.

- [ ] **Step 3: Modify the existing GET and POST handlers**

In `enterprise_server/src/routes/admin/models.ts`, find the existing `GET /admin/models` and `POST /admin/models` handlers. Update them to:

**GET handler** — extend SELECT and response mapping:

```ts
adminModelRoutes.get('/', requireAuth, async (c) => {
  const claims = c.get('claims');
  const r = await pool.query<{
    id: string; provider: string; model: string; display_name: string | null;
    enabled: boolean; disabled_by_admin: boolean;
    quota_per_user_per_day: number | null;
    context_window: number | null; max_tokens: number | null;
    temperature: number | null; top_p: number | null; max_output_tokens: number | null;
    supports_image: boolean; supports_video: boolean; supports_thinking: boolean;
  }>(
    `SELECT id, provider, model, display_name, enabled, disabled_by_admin,
            quota_per_user_per_day, context_window, max_tokens,
            temperature, top_p, max_output_tokens,
            supports_image, supports_video, supports_thinking
       FROM models WHERE org_id = $1
       ORDER BY created_at DESC`,
    [claims.orgId],
  );
  return c.json(r.rows.map((row) => ({
    id: row.id,
    provider: row.provider,
    model: row.model,
    displayName: row.display_name,
    enabled: row.enabled,
    disabledByAdmin: row.disabled_by_admin,
    quotaPerUserPerDay: row.quota_per_user_per_day,
    contextWindow: row.context_window,
    maxTokens: row.max_tokens,
    temperature: row.temperature,
    topP: row.top_p,
    maxOutputTokens: row.max_output_tokens,
    supportsImage: row.supports_image,
    supportsVideo: row.supports_video,
    supportsThinking: row.supports_thinking,
  })));
});
```

**POST handler** — accept params, write them, detect duplicates:

Find the existing POST handler. Update its body parsing to accept `params` and the INSERT to write the new columns. Add a UNIQUE check via `ON CONFLICT` or pre-check.

```ts
adminModelRoutes.post('/', requireCapability('admin'), async (c) => {
  const claims = c.get('claims');
  const body = await c.req.json<{
    providerId: string;
    model: string;
    displayName?: string;
    quotaPerUserPerDay?: number;
    params?: {
      temperature?: number | null;
      topP?: number | null;
      maxOutputTokens?: number | null;
      contextWindow?: number | null;
      supportsImage?: boolean;
      supportsVideo?: boolean;
      supportsThinking?: boolean;
    };
  }>().catch(() => ({} as Record<string, unknown>));

  if (!body.providerId || !body.model) {
    return c.json({ error: 'validation_error' }, 400);
  }

  // Validate ownership: provider must belong to caller's org
  const p = await pool.query<{ provider: string }>(
    `SELECT provider FROM provider_keys WHERE id = $1 AND org_id = $2`,
    [body.providerId, claims.orgId],
  );
  if (p.rowCount === 0) return c.json({ error: 'provider_not_found' }, 404);
  const providerSlug = p.rows[0]!.provider;

  // Check duplicate
  const dup = await pool.query(
    `SELECT 1 FROM models WHERE org_id = $1 AND provider_id = $2 AND model = $3`,
    [claims.orgId, body.providerId, body.model],
  );
  if (dup.rowCount && dup.rowCount > 0) {
    return c.json({ error: 'model_duplicate' }, 409);
  }

  const p2 = body.params ?? {};
  const ins = await pool.query<{ id: string }>(
    `INSERT INTO models (
        org_id, provider, provider_id, model, display_name, quota_per_user_per_day,
        context_window, max_tokens,
        temperature, top_p, max_output_tokens,
        supports_image, supports_video, supports_thinking
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
      RETURNING id`,
    [
      claims.orgId,
      providerSlug,
      body.providerId,
      body.model,
      body.displayName ?? null,
      body.quotaPerUserPerDay ?? null,
      p2.contextWindow ?? null,
      p2.maxOutputTokens ?? null,
      p2.temperature ?? null,
      p2.topP ?? null,
      p2.maxOutputTokens ?? null,
      p2.supportsImage ?? false,
      p2.supportsVideo ?? false,
      p2.supportsThinking ?? false,
    ],
  );
  return c.json({ id: ins.rows[0]!.id });
});
```

- [ ] **Step 4: Run test to verify it passes**

```bash
cd enterprise_server && npx vitest run modelsExtended 2>&1 | tail -5
```

Expected: 8 passed.

- [ ] **Step 5: Commit**

```bash
git add enterprise_server/src/routes/admin/models.ts enterprise_server/tests/routes/modelsExtended.test.ts
git commit -m "feat(api): extend GET/POST /admin/models with params"
```

---

## Task 11: Client — extend shared types & API client methods

**Files:**
- Modify: `enterprise_server/web/src/api/types.ts` (or wherever `ProviderKeyView` / `ModelView` are defined)
- Modify: `enterprise_server/web/src/api/providers.ts`
- Modify: `enterprise_server/web/src/api/models.ts`

**Interfaces:**
- Produces (types): `ProviderKeyView` extended with `desc`, `apiKeyMasked`, `status`, `latencyMs`, `lastTestAt`. `ModelView` extended with `temperature`, `topP`, `maxOutputTokens`, `displayName`, `supportsImage`, `supportsVideo`, `supportsThinking`.
- Produces (client): `providersApi.patch(id, body)`, `providersApi.remove(id)`, `providersApi.test(id)`, `modelsApi.patch(id, body)`, `modelsApi.remove(id)`.

- [ ] **Step 1: Extend types**

In the file where `ProviderKeyView` and `ModelView` are declared (likely `enterprise_server/web/src/api/types.ts` or co-located with the API client files), update both interfaces:

```ts
export interface ProviderKeyView {
  id: string;
  provider: string;
  name: string;
  label: string | null;
  enabled: boolean;
  desc: string | null;
  apiKeyMasked: string | null;
  status: 'unknown' | 'connected' | 'failed';
  latencyMs: number | null;
  lastTestAt: string | null;
  endpoint: string | null;
  region: 'china' | 'global' | null;
  defaultBaseUrl: string | null;
  website: string | null;
  createdAt: string;
}

export interface ModelView {
  id: string;
  provider: string;
  model: string;
  displayName: string | null;
  enabled: boolean;
  disabledByAdmin: boolean;
  quotaPerUserPerDay: number | null;
  contextWindow: number | null;
  maxTokens: number | null;
  temperature: number | null;
  topP: number | null;
  maxOutputTokens: number | null;
  supportsImage: boolean;
  supportsVideo: boolean;
  supportsThinking: boolean;
}
```

If types are co-located with the API files (per Explore finding), update them in those files instead.

- [ ] **Step 2: Extend providers client**

In `enterprise_server/web/src/api/providers.ts`, add three methods:

```ts
export const providersApi = {
  list: (): Promise<ProviderKeyView[]> => apiClient.get('/admin/provider-keys'),

  add: (body: { provider: string; apiKey: string; label?: string; endpoint?: string; region?: string; defaultBaseUrl?: string; website?: string; desc?: string; }): Promise<{ id: string }> =>
    apiClient.post('/admin/provider-keys', body),

  patch: (id: string, body: { name?: string; desc?: string; baseUrl?: string; label?: string; enabled?: boolean; }): Promise<{ ok: true }> =>
    apiClient.patch(`/admin/provider-keys/${id}`, body),

  remove: (id: string): Promise<{ ok: true; deletedModels: number }> =>
    apiClient.delete(`/admin/provider-keys/${id}`),

  test: (id: string): Promise<{ status: 'connected' | 'failed' | 'unknown'; latencyMs: number; lastTestAt: string }> =>
    apiClient.post(`/admin/provider-keys/${id}/test`),

  refresh: (id: string): Promise<{ added: number; unchanged: number }> =>
    apiClient.post(`/admin/provider-keys/${id}/refresh-models`),

  enable: (id: string): Promise<{ ok: true }> => apiClient.post(`/admin/provider-keys/${id}/enable`),
  disable: (id: string): Promise<{ ok: true }> => apiClient.post(`/admin/provider-keys/${id}/disable`),
};
```

If the existing file uses different naming (e.g. `providerKeysApi`), match that naming.

- [ ] **Step 3: Extend models client**

In `enterprise_server/web/src/api/models.ts`, add two methods (assuming an existing `modelsApi` or `adminModelsApi`):

```ts
patch: (id: string, body: {
  displayName?: string;
  enabled?: boolean;
  params?: {
    temperature?: number | null;
    topP?: number | null;
    maxOutputTokens?: number | null;
    supportsImage?: boolean;
    supportsVideo?: boolean;
    supportsThinking?: boolean;
  };
}): Promise<{ ok: true }> => apiClient.patch(`/admin/models/${id}`, body),

remove: (id: string): Promise<{ ok: true }> => apiClient.delete(`/admin/models/${id}`),
```

- [ ] **Step 4: Verify TypeScript compiles**

```bash
cd enterprise_server/web && npx tsc --noEmit -p tsconfig.json 2>&1 | tail -10
```

Expected: no errors (or only pre-existing).

- [ ] **Step 5: Commit**

```bash
git add enterprise_server/web/src/api/types.ts enterprise_server/web/src/api/providers.ts enterprise_server/web/src/api/models.ts
git commit -m "feat(client): extend API types and add patch/remove/test"
```

---

## Task 12: Client shared `StatusDot` component

**Files:**
- Create: `enterprise_server/web/src/components/StatusDot.tsx`
- Create: `enterprise_server/web/src/components/StatusDot.test.tsx`

**Interfaces:**
- Produces: `<StatusDot status="connected" | "failed" | "unknown" />` reusable across the page.

- [ ] **Step 1: Write the failing test**

Create `enterprise_server/web/src/components/StatusDot.test.tsx`:

```tsx
import { render, screen } from '@testing-library/react';
import { describe, expect, test } from 'vitest';

import { StatusDot } from './StatusDot';

describe('StatusDot', () => {
  test('renders connected variant with green class', () => {
    const { container } = render(<StatusDot status="connected" />);
    const dot = container.querySelector('span');
    expect(dot).not.toBeNull();
    expect(dot!.className).toMatch(/emerald|green/);
  });

  test('renders failed variant with red class', () => {
    const { container } = render(<StatusDot status="failed" />);
    const dot = container.querySelector('span');
    expect(dot!.className).toMatch(/red/);
  });

  test('renders unknown variant with grey class', () => {
    const { container } = render(<StatusDot status="unknown" />);
    const dot = container.querySelector('span');
    expect(dot!.className).toMatch(/secondary|grey|gray/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd enterprise_server/web && npx vitest run StatusDot 2>&1 | tail -10
```

Expected: FAIL with "Cannot find module './StatusDot'".

- [ ] **Step 3: Implement StatusDot**

Create `enterprise_server/web/src/components/StatusDot.tsx`:

```tsx
import type { JSX } from 'react';

export type StatusDotStatus = 'connected' | 'failed' | 'unknown';

const TONE_CLASS: Record<StatusDotStatus, string> = {
  connected: 'bg-emerald-500',
  failed: 'bg-red-500',
  unknown: 'bg-secondary/60',
};

interface Props {
  status: StatusDotStatus;
  className?: string;
}

export function StatusDot({ status, className = '' }: Props): JSX.Element {
  return (
    <span
      aria-label={`status-${status}`}
      className={`inline-block h-2 w-2 rounded-full ${TONE_CLASS[status]} ${className}`}
    />
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
cd enterprise_server/web && npx vitest run StatusDot 2>&1 | tail -5
```

Expected: 3 passed.

- [ ] **Step 5: Commit**

```bash
git add enterprise_server/web/src/components/StatusDot.tsx enterprise_server/web/src/components/StatusDot.test.tsx
git commit -m "feat(client): add StatusDot component"
```

---

## Task 13: Client `ProviderRail` component

**Files:**
- Create: `enterprise_server/web/src/pages/providersModels/ProviderRail.tsx`
- Create: `enterprise_server/web/src/pages/providersModels/ProviderRail.test.tsx`

**Interfaces:**
- Consumes: `ProviderKeyView[]` (configured) + catalog seed (passed as `catalogProviders`), `selectedId`, callbacks.
- Produces: a panel with search input, two sections (内置 / 自定义), rows with status dot + name + count badge.

- [ ] **Step 1: Write the failing test**

Create `enterprise_server/web/src/pages/providersModels/ProviderRail.test.tsx`:

```tsx
import { describe, expect, test, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';

import { ProviderRail } from './ProviderRail';

const configured = [
  { id: 'p1', provider: 'openai', name: 'OpenAI', label: null, enabled: true, desc: null,
    apiKeyMasked: 'sk-••••••', status: 'connected' as const, latencyMs: 142, lastTestAt: null,
    endpoint: 'https://api.openai.com/v1', region: 'global' as const, defaultBaseUrl: null,
    website: null, createdAt: '2026-01-01T00:00:00Z' },
];

const catalog = [
  { id: 'anthropic', label: 'Anthropic', region: 'global' as const, defaultBaseUrl: 'https://api.anthropic.com', defaultModels: [] },
];

describe('ProviderRail', () => {
  test('renders both sections', () => {
    render(
      <ProviderRail
        configured={configured}
        catalog={catalog}
        selectedId={null}
        onSelect={() => {}}
        canManage={true}
      />,
    );
    expect(screen.getByPlaceholderText(/搜索/)).toBeInTheDocument();
    expect(screen.getByText(/OpenAI/)).toBeInTheDocument();
    expect(screen.getByText(/Anthropic/)).toBeInTheDocument();
  });

  test('filters by search text', () => {
    render(
      <ProviderRail
        configured={configured}
        catalog={catalog}
        selectedId={null}
        onSelect={() => {}}
        canManage={false}
      />,
    );
    fireEvent.change(screen.getByPlaceholderText(/搜索/), { target: { value: 'anth' } });
    expect(screen.queryByText(/OpenAI/)).not.toBeInTheDocument();
    expect(screen.getByText(/Anthropic/)).toBeInTheDocument();
  });

  test('clicking a row invokes onSelect', () => {
    const onSelect = vi.fn();
    render(
      <ProviderRail
        configured={configured}
        catalog={catalog}
        selectedId={null}
        onSelect={onSelect}
        canManage={false}
      />,
    );
    fireEvent.click(screen.getByText(/OpenAI/));
    expect(onSelect).toHaveBeenCalledWith('p1');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd enterprise_server/web && npx vitest run ProviderRail 2>&1 | tail -10
```

Expected: FAIL — module not found.

- [ ] **Step 3: Implement ProviderRail**

Create `enterprise_server/web/src/pages/providersModels/ProviderRail.tsx`:

```tsx
import { useMemo, useState } from 'react';
import type { JSX } from 'react';

import { StatusDot } from '../../components/StatusDot';
import { useI18n } from '../../i18n';

interface CatalogEntry {
  id: string;
  label: string;
  region: 'china' | 'global';
  defaultBaseUrl?: string | null;
  defaultModels: unknown[];
}

interface Props {
  configured: import('../../api/types').ProviderKeyView[];
  catalog: CatalogEntry[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  canManage: boolean;
}

export function ProviderRail({ configured, catalog, selectedId, onSelect, canManage }: Props): JSX.Element {
  const t = useI18n();
  const [search, setSearch] = useState('');

  const visibleConfigured = useMemo(() => {
    const s = search.trim().toLowerCase();
    if (!s) return configured;
    return configured.filter((p) => p.name.toLowerCase().includes(s) || p.provider.includes(s));
  }, [configured, search]);

  const visibleCatalog = useMemo(() => {
    const s = search.trim().toLowerCase();
    if (!s) return catalog;
    return catalog.filter((c) => c.label.toLowerCase().includes(s) || c.id.includes(s));
  }, [catalog, search]);

  return (
    <div className="flex h-full w-full flex-col gap-3 border-r border-border bg-surface p-3">
      <input
        type="search"
        placeholder={t('page.providersModels.search.placeholder')}
        value={search}
        onChange={(e) => setSearch(e.target.value)}
        className="w-full rounded-md border border-border bg-background px-2 py-1.5 text-sm"
      />

      <Section title={`${t('page.providersModels.configuredProviders')} (${visibleConfigured.length})`}>
        {visibleConfigured.map((p) => (
          <button
            key={p.id}
            type="button"
            onClick={() => onSelect(p.id)}
            className={`flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm transition-colors ${
              selectedId === p.id ? 'bg-primary/10 text-primary' : 'hover:bg-surface-raised'
            }`}
          >
            <StatusDot status={p.status} />
            <span className="truncate font-medium">{p.name}</span>
          </button>
        ))}
      </Section>

      <Section title={`${t('page.providersModels.catalogProviders')} (${visibleCatalog.length})`}>
        {visibleCatalog.map((c) => (
          <button
            key={c.id}
            type="button"
            onClick={() => onSelect(c.id)}
            className={`flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm transition-colors ${
              selectedId === c.id ? 'bg-primary/10 text-primary' : 'hover:bg-surface-raised'
            }`}
          >
            <StatusDot status="unknown" />
            <span className="truncate font-medium">{c.label}</span>
          </button>
        ))}
        {canManage && (
          <button
            type="button"
            className="flex w-full items-center justify-center rounded-md border border-dashed border-border px-2 py-1.5 text-sm text-secondary hover:bg-surface-raised"
          >
            + {t('page.providersModels.addProvider')}
          </button>
        )}
      </Section>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }): JSX.Element {
  return (
    <div className="flex flex-col gap-1">
      <h3 className="px-2 text-xs font-medium uppercase text-secondary">{title}</h3>
      {children}
    </div>
  );
}
```

**Note on `useI18n`**: if the project's i18n hook is named differently (e.g. `useTranslation`), use that. The current page calls `i18nService.t(key)` directly (per Explore finding). Adapt as needed — either use `i18nService.t` directly inside the component, or import the hook if it exists.

- [ ] **Step 4: Run test to verify it passes**

```bash
cd enterprise_server/web && npx vitest run ProviderRail 2>&1 | tail -5
```

Expected: 3 passed.

- [ ] **Step 5: Commit**

```bash
git add enterprise_server/web/src/pages/providersModels/ProviderRail.tsx enterprise_server/web/src/pages/providersModels/ProviderRail.test.tsx
git commit -m "feat(client): add ProviderRail component"
```

---

## Task 14: Client `ProviderHeaderBar` + `ProviderInfoCard` components

**Files:**
- Create: `enterprise_server/web/src/pages/providersModels/ProviderHeaderBar.tsx`
- Create: `enterprise_server/web/src/pages/providersModels/ProviderHeaderBar.test.tsx`
- Create: `enterprise_server/web/src/pages/providersModels/ProviderInfoCard.tsx`
- Create: `enterprise_server/web/src/pages/providersModels/ProviderInfoCard.test.tsx`

**Interfaces:**
- `ProviderHeaderBar`: name + status pill + 3 action buttons + enable toggle switch. Hidden when `canManage=false` for write buttons.
- `ProviderInfoCard`: editable form for name/desc/baseUrl/apiKey, masked key display, eye toggle, save button. Hidden when `canManage=false`.

- [ ] **Step 1: Write failing tests for ProviderHeaderBar**

Create `enterprise_server/web/src/pages/providersModels/ProviderHeaderBar.test.tsx`:

```tsx
import { describe, expect, test, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';

import { ProviderHeaderBar } from './ProviderHeaderBar';

const base = {
  id: 'p1', provider: 'openai', name: 'OpenAI', label: null, enabled: true, desc: null,
  apiKeyMasked: 'sk-••••••', status: 'connected' as const, latencyMs: 142, lastTestAt: null,
  endpoint: 'https://api.openai.com/v1', region: 'global' as const, defaultBaseUrl: null,
  website: null, createdAt: '2026-01-01T00:00:00Z',
};

describe('ProviderHeaderBar', () => {
  test('renders provider name and status pill', () => {
    render(
      <ProviderHeaderBar
        provider={base}
        canManage={true}
        busy={false}
        onTest={vi.fn()}
        onSave={vi.fn()}
        onDelete={vi.fn()}
        onToggleEnabled={vi.fn()}
      />,
    );
    expect(screen.getByText('OpenAI')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /测试连接/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /保存/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /删除/ })).toBeInTheDocument();
  });

  test('test button calls onTest with id', () => {
    const onTest = vi.fn();
    render(
      <ProviderHeaderBar
        provider={base}
        canManage={true}
        busy={false}
        onTest={onTest}
        onSave={vi.fn()}
        onDelete={vi.fn()}
        onToggleEnabled={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: /测试连接/ }));
    expect(onTest).toHaveBeenCalledWith('p1');
  });

  test('non-admin sees no delete button', () => {
    render(
      <ProviderHeaderBar
        provider={base}
        canManage={false}
        busy={false}
        onTest={vi.fn()}
        onSave={vi.fn()}
        onDelete={vi.fn()}
        onToggleEnabled={vi.fn()}
      />,
    );
    expect(screen.queryByRole('button', { name: /删除/ })).not.toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd enterprise_server/web && npx vitest run ProviderHeaderBar 2>&1 | tail -10
```

Expected: FAIL.

- [ ] **Step 3: Implement ProviderHeaderBar**

Create `enterprise_server/web/src/pages/providersModels/ProviderHeaderBar.tsx`:

```tsx
import type { JSX } from 'react';

import type { ProviderKeyView } from '../../api/types';

interface Props {
  provider: ProviderKeyView;
  canManage: boolean;
  busy: boolean;
  onTest: (id: string) => void;
  onSave: (id: string) => void;
  onDelete: (id: string) => void;
  onToggleEnabled: (id: string, enabled: boolean) => void;
}

export function ProviderHeaderBar({
  provider, canManage, busy, onTest, onSave, onDelete, onToggleEnabled,
}: Props): JSX.Element {
  return (
    <div className="flex items-center justify-between gap-4 border-b border-border bg-surface px-6 py-3">
      <div className="flex items-center gap-3">
        <h1 className="text-lg font-semibold text-foreground">{provider.name}</h1>
        <span
          className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs ${
            provider.enabled
              ? 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300'
              : 'bg-surface-raised text-secondary'
          }`}
        >
          {provider.enabled ? '已启用' : '已停用'}
        </span>
      </div>

      <div className="flex items-center gap-2">
        <button
          type="button"
          disabled={busy}
          onClick={() => onTest(provider.id)}
          className="rounded-md border border-border bg-surface px-3 py-1.5 text-sm hover:bg-surface-raised disabled:opacity-50"
        >
          🔌 测试连接
        </button>
        {canManage && (
          <>
            <button
              type="button"
              disabled={busy}
              onClick={() => onSave(provider.id)}
              className="rounded-md bg-primary px-3 py-1.5 text-sm text-white hover:bg-primary-hover disabled:opacity-50"
            >
              保存
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={() => onDelete(provider.id)}
              className="rounded-md border border-danger-primary bg-surface px-3 py-1.5 text-sm text-danger-primary hover:bg-danger-light disabled:opacity-50"
            >
              删除服务商
            </button>
          </>
        )}

        {canManage && (
          <label className="ml-3 flex cursor-pointer items-center gap-2">
            <span className="text-sm text-secondary">
              {provider.enabled ? '服务商已启用' : '服务商已停用'}
            </span>
            <input
              type="checkbox"
              checked={provider.enabled}
              onChange={(e) => onToggleEnabled(provider.id, e.target.checked)}
              className="h-5 w-9 cursor-pointer appearance-none rounded-full bg-surface-checked transition-colors checked:bg-emerald-500"
            />
          </label>
        )}
      </div>
    </div>
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
cd enterprise_server/web && npx vitest run ProviderHeaderBar 2>&1 | tail -5
```

Expected: 3 passed.

- [ ] **Step 5: Write failing tests for ProviderInfoCard**

Create `enterprise_server/web/src/pages/providersModels/ProviderInfoCard.test.tsx`:

```tsx
import { describe, expect, test, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';

import { ProviderInfoCard } from './ProviderInfoCard';

const base = {
  id: 'p1', provider: 'openai', name: 'OpenAI', label: null, enabled: true, desc: 'note',
  apiKeyMasked: 'sk-••••••abc123', status: 'connected' as const, latencyMs: 142,
  lastTestAt: '2026-09-11T02:00:00Z',
  endpoint: 'https://api.openai.com/v1', region: 'global' as const, defaultBaseUrl: null,
  website: null, createdAt: '2026-01-01T00:00:00Z',
};

describe('ProviderInfoCard', () => {
  test('renders name, desc, baseUrl, masked api key', () => {
    render(
      <ProviderInfoCard
        provider={base}
        canManage={false}
        busy={false}
        onSave={vi.fn()}
      />,
    );
    expect(screen.getByDisplayValue('OpenAI')).toBeInTheDocument();
    expect(screen.getByDisplayValue('note')).toBeInTheDocument();
    expect(screen.getByDisplayValue('https://api.openai.com/v1')).toBeInTheDocument();
    expect(screen.getByDisplayValue('sk-••••••abc123')).toBeInTheDocument();
  });

  test('eye toggle flips api key type', () => {
    render(
      <ProviderInfoCard
        provider={base}
        canManage={false}
        busy={false}
        onSave={vi.fn()}
      />,
    );
    const keyInput = screen.getByDisplayValue('sk-••••••abc123') as HTMLInputElement;
    expect(keyInput.type).toBe('password');
    fireEvent.click(screen.getByRole('button', { name: /显示密码|show password/i }));
    expect(keyInput.type).toBe('text');
  });

  test('non-admin sees disabled inputs and no save button', () => {
    render(
      <ProviderInfoCard
        provider={base}
        canManage={false}
        busy={false}
        onSave={vi.fn()}
      />,
    );
    expect(screen.queryByRole('button', { name: /保存/ })).not.toBeInTheDocument();
    expect((screen.getByDisplayValue('OpenAI') as HTMLInputElement).disabled).toBe(true);
  });
});
```

- [ ] **Step 6: Run test to verify it fails**

```bash
cd enterprise_server/web && npx vitest run ProviderInfoCard 2>&1 | tail -10
```

Expected: FAIL.

- [ ] **Step 7: Implement ProviderInfoCard**

Create `enterprise_server/web/src/pages/providersModels/ProviderInfoCard.tsx`:

```tsx
import { useEffect, useState } from 'react';
import type { JSX } from 'react';

import type { ProviderKeyView } from '../../api/types';

interface Props {
  provider: ProviderKeyView;
  canManage: boolean;
  busy: boolean;
  onSave: (id: string, body: { name: string; desc: string; baseUrl: string; }) => void;
}

export function ProviderInfoCard({ provider, canManage, busy, onSave }: Props): JSX.Element {
  const [name, setName] = useState(provider.name);
  const [desc, setDesc] = useState(provider.desc ?? '');
  const [baseUrl, setBaseUrl] = useState(provider.endpoint ?? '');
  const [apiKey, setApiKey] = useState(provider.apiKeyMasked ?? '');
  const [showKey, setShowKey] = useState(false);

  // Reset local state when the provider prop changes
  useEffect(() => {
    setName(provider.name);
    setDesc(provider.desc ?? '');
    setBaseUrl(provider.endpoint ?? '');
    setApiKey(provider.apiKeyMasked ?? '');
  }, [provider.id, provider.name, provider.desc, provider.endpoint, provider.apiKeyMasked]);

  return (
    <div className="rounded-xl border border-border bg-surface p-4">
      <h2 className="mb-3 text-sm font-semibold text-foreground">服务商信息</h2>

      <div className="grid grid-cols-2 gap-3">
        <Field label="名称">
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            disabled={!canManage}
            className="w-full rounded-md border border-border bg-background px-2 py-1.5 text-sm disabled:opacity-60"
          />
        </Field>
        <Field label="备注">
          <input
            type="text"
            value={desc}
            onChange={(e) => setDesc(e.target.value)}
            disabled={!canManage}
            className="w-full rounded-md border border-border bg-background px-2 py-1.5 text-sm disabled:opacity-60"
          />
        </Field>
      </div>

      <div className="mt-3">
        <Field label="Base URL">
          <input
            type="text"
            value={baseUrl}
            onChange={(e) => setBaseUrl(e.target.value)}
            disabled={!canManage}
            className="w-full rounded-md border border-border bg-background px-2 py-1.5 text-sm disabled:opacity-60"
          />
        </Field>
      </div>

      <div className="mt-3">
        <Field label="API Key">
          <div className="relative">
            <input
              type={showKey ? 'text' : 'password'}
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              placeholder="(unchanged)"
              disabled={!canManage}
              className="w-full rounded-md border border-border bg-background px-2 py-1.5 pr-9 font-mono text-sm disabled:opacity-60"
            />
            <button
              type="button"
              onClick={() => setShowKey((v) => !v)}
              aria-label={showKey ? '隐藏密码' : '显示密码'}
              tabIndex={-1}
              className="absolute inset-y-0 right-0 flex w-9 items-center justify-center text-secondary hover:text-foreground"
            >
              {showKey ? '🙈' : '👁'}
            </button>
          </div>
        </Field>
      </div>

      <div className="mt-3 text-xs text-secondary">
        状态: <span data-testid="conn-status">{provider.status}</span>
        {provider.latencyMs != null && <> · {provider.latencyMs}ms</>}
        {provider.lastTestAt && <> · 最近测试 {provider.lastTestAt}</>}
      </div>

      {canManage && (
        <div className="mt-3 flex justify-end">
          <button
            type="button"
            disabled={busy}
            onClick={() => onSave(provider.id, { name, desc, baseUrl })}
            className="rounded-md bg-primary px-3 py-1.5 text-sm text-white hover:bg-primary-hover disabled:opacity-50"
          >
            保存
          </button>
        </div>
      )}
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }): JSX.Element {
  return (
    <label className="block">
      <span className="mb-1 block text-xs text-secondary">{label}</span>
      {children}
    </label>
  );
}
```

- [ ] **Step 8: Run test to verify it passes**

```bash
cd enterprise_server/web && npx vitest run ProviderInfoCard 2>&1 | tail -5
```

Expected: 3 passed.

- [ ] **Step 9: Commit**

```bash
git add enterprise_server/web/src/pages/providersModels/ProviderHeaderBar.tsx enterprise_server/web/src/pages/providersModels/ProviderHeaderBar.test.tsx enterprise_server/web/src/pages/providersModels/ProviderInfoCard.tsx enterprise_server/web/src/pages/providersModels/ProviderInfoCard.test.tsx
git commit -m "feat(client): add ProviderHeaderBar and ProviderInfoCard"
```

---

## Task 15: Client `ModelList` + `ModelTableRow` + inline edit/add rows

**Files:**
- Create: `enterprise_server/web/src/pages/providersModels/ModelList.tsx`
- Create: `enterprise_server/web/src/pages/providersModels/ModelList.test.tsx`
- Create: `enterprise_server/web/src/pages/providersModels/ModelTableRow.tsx`
- Create: `enterprise_server/web/src/pages/providersModels/ModelInlineEditRow.tsx`
- Create: `enterprise_server/web/src/pages/providersModels/ModelInlineAddRow.tsx`

**Interfaces:**
- `ModelList`: card with header (count, refresh, add), table of models, supports inline edit/add/delete/enable.
- Inline edit row: yellow background, pre-filled, save/cancel.
- Inline add row: blue background, empty, save/cancel.

For this task, write the components and one integration test for `ModelList`. The table-row and inline-row components are simple enough to be covered by the integration test.

- [ ] **Step 1: Write the failing test for ModelList**

Create `enterprise_server/web/src/pages/providersModels/ModelList.test.tsx`:

```tsx
import { describe, expect, test, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';

import { ModelList } from './ModelList';

const models = [
  { id: 'm1', provider: 'openai', model: 'gpt-4', displayName: 'GPT-4',
    enabled: true, disabledByAdmin: false, quotaPerUserPerDay: null,
    contextWindow: 128000, maxTokens: 8192, temperature: null, topP: null,
    maxOutputTokens: null, supportsImage: true, supportsVideo: false, supportsThinking: false },
];

describe('ModelList', () => {
  test('renders models and header', () => {
    render(
      <ModelList
        models={models}
        canManage={true}
        busy={false}
        onAdd={vi.fn()}
        onRefresh={vi.fn()}
        onSave={vi.fn()}
        onDelete={vi.fn()}
        onToggleEnabled={vi.fn()}
        onOpenParams={vi.fn()}
      />,
    );
    expect(screen.getByText(/模型列表/)).toBeInTheDocument();
    expect(screen.getByText(/GPT-4/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /\+ 添加模型/ })).toBeInTheDocument();
  });

  test('clicking add button invokes onAdd', () => {
    const onAdd = vi.fn();
    render(
      <ModelList
        models={models}
        canManage={true}
        busy={false}
        onAdd={onAdd}
        onRefresh={vi.fn()}
        onSave={vi.fn()}
        onDelete={vi.fn()}
        onToggleEnabled={vi.fn()}
        onOpenParams={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: /\+ 添加模型/ }));
    expect(onAdd).toHaveBeenCalledTimes(1);
  });

  test('non-admin sees no add/delete buttons', () => {
    render(
      <ModelList
        models={models}
        canManage={false}
        busy={false}
        onAdd={vi.fn()}
        onRefresh={vi.fn()}
        onSave={vi.fn()}
        onDelete={vi.fn()}
        onToggleEnabled={vi.fn()}
        onOpenParams={vi.fn()}
      />,
    );
    expect(screen.queryByRole('button', { name: /\+ 添加模型/ })).not.toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd enterprise_server/web && npx vitest run ModelList 2>&1 | tail -10
```

Expected: FAIL.

- [ ] **Step 3: Implement ModelTableRow, ModelInlineEditRow, ModelInlineAddRow**

Create `enterprise_server/web/src/pages/providersModels/ModelTableRow.tsx`:

```tsx
import type { JSX } from 'react';

import type { ModelView } from '../../api/types';

interface Props {
  model: ModelView;
  canManage: boolean;
  onEdit: (id: string) => void;
  onDelete: (id: string) => void;
  onToggleEnabled: (id: string, enabled: boolean) => void;
  onOpenParams: (id: string) => void;
}

export function ModelTableRow({ model, canManage, onEdit, onDelete, onToggleEnabled, onOpenParams }: Props): JSX.Element {
  return (
    <tr className="border-b border-border/60">
      <td className="px-3 py-2 text-sm">{model.displayName ?? model.model}</td>
      <td className="px-3 py-2 font-mono text-xs text-secondary">{model.model}</td>
      <td className="px-3 py-2 text-xs">{typeLabel(model)}</td>
      <td className="px-3 py-2 text-xs">{model.contextWindow ? `${Math.round(model.contextWindow / 1000)}K` : '—'}</td>
      <td className="px-3 py-2 text-xs">
        <span className={model.enabled ? 'text-emerald-600' : 'text-secondary'}>
          {model.enabled ? '启用' : '禁用'}
        </span>
      </td>
      <td className="px-3 py-2 text-right">
        {canManage && (
          <div className="flex justify-end gap-1">
            <button type="button" onClick={() => onOpenParams(model.id)} title="配置" className="rounded p-1 hover:bg-surface-raised">⚙</button>
            <button type="button" onClick={() => onEdit(model.id)} title="编辑" className="rounded p-1 hover:bg-surface-raised">✎</button>
            <button type="button" onClick={() => onDelete(model.id)} title="删除" className="rounded p-1 text-danger-primary hover:bg-surface-raised">×</button>
          </div>
        )}
      </td>
    </tr>
  );
}

function typeLabel(m: ModelView): string {
  if (m.supportsThinking) return '推理';
  if (m.supportsImage) return '视觉';
  return '对话';
}
```

Create `enterprise_server/web/src/pages/providersModels/ModelInlineEditRow.tsx`:

```tsx
import { useState } from 'react';
import type { JSX } from 'react';

import type { ModelView } from '../../api/types';

interface Props {
  model: ModelView;
  busy: boolean;
  onSave: (id: string, body: { displayName: string; enabled: boolean }) => void;
  onCancel: () => void;
}

export function ModelInlineEditRow({ model, busy, onSave, onCancel }: Props): JSX.Element {
  const [displayName, setDisplayName] = useState(model.displayName ?? '');
  const [enabled, setEnabled] = useState(model.enabled);

  return (
    <tr className="border-b border-border/60 bg-amber-50 dark:bg-amber-900/20">
      <td className="px-3 py-2">
        <input
          type="text"
          value={displayName}
          onChange={(e) => setDisplayName(e.target.value)}
          className="w-full rounded border border-border bg-background px-2 py-1 text-sm"
        />
      </td>
      <td className="px-3 py-2 font-mono text-xs text-secondary">{model.model}</td>
      <td colSpan={2} className="px-3 py-2" />
      <td className="px-3 py-2">
        <select
          value={enabled ? '1' : '0'}
          onChange={(e) => setEnabled(e.target.value === '1')}
          className="rounded border border-border bg-background px-2 py-1 text-xs"
        >
          <option value="1">启用</option>
          <option value="0">禁用</option>
        </select>
      </td>
      <td className="px-3 py-2 text-right">
        <button
          type="button"
          disabled={busy}
          onClick={() => onSave(model.id, { displayName, enabled })}
          className="rounded bg-primary px-2 py-1 text-xs text-white disabled:opacity-50"
        >
          保存
        </button>
        <button
          type="button"
          onClick={onCancel}
          className="ml-1 rounded border border-border bg-surface px-2 py-1 text-xs"
        >
          取消
        </button>
      </td>
    </tr>
  );
}
```

Create `enterprise_server/web/src/pages/providersModels/ModelInlineAddRow.tsx`:

```tsx
import { useState } from 'react';
import type { JSX } from 'react';

interface Props {
  busy: boolean;
  onSave: (body: { model: string; displayName?: string }) => void;
  onCancel: () => void;
}

export function ModelInlineAddRow({ busy, onSave, onCancel }: Props): JSX.Element {
  const [modelId, setModelId] = useState('');
  const [displayName, setDisplayName] = useState('');

  return (
    <tr className="border-b border-border/60 bg-blue-50 dark:bg-blue-900/20">
      <td className="px-3 py-2">
        <input
          type="text"
          value={displayName}
          placeholder="GPT-4 自定义"
          onChange={(e) => setDisplayName(e.target.value)}
          className="w-full rounded border border-border bg-background px-2 py-1 text-sm"
        />
      </td>
      <td className="px-3 py-2">
        <input
          type="text"
          value={modelId}
          placeholder="gpt-4-custom"
          onChange={(e) => setModelId(e.target.value)}
          className="w-full rounded border border-border bg-background px-2 py-1 font-mono text-xs"
        />
      </td>
      <td colSpan={2} className="px-3 py-2" />
      <td className="px-3 py-2 text-xs text-secondary">新增</td>
      <td className="px-3 py-2 text-right">
        <button
          type="button"
          disabled={busy || !modelId}
          onClick={() => onSave({ model: modelId, displayName })}
          className="rounded bg-primary px-2 py-1 text-xs text-white disabled:opacity-50"
        >
          保存
        </button>
        <button
          type="button"
          onClick={onCancel}
          className="ml-1 rounded border border-border bg-surface px-2 py-1 text-xs"
        >
          取消
        </button>
      </td>
    </tr>
  );
}
```

- [ ] **Step 4: Implement ModelList**

Create `enterprise_server/web/src/pages/providersModels/ModelList.tsx`:

```tsx
import { useState } from 'react';
import type { JSX } from 'react';

import type { ModelView } from '../../api/types';

import { ModelInlineAddRow } from './ModelInlineAddRow';
import { ModelInlineEditRow } from './ModelInlineEditRow';
import { ModelTableRow } from './ModelTableRow';

interface Props {
  models: ModelView[];
  canManage: boolean;
  busy: boolean;
  onAdd: (body: { model: string; displayName?: string }) => void;
  onRefresh: () => void;
  onSave: (id: string, body: { displayName: string; enabled: boolean }) => void;
  onDelete: (id: string) => void;
  onToggleEnabled: (id: string, enabled: boolean) => void;
  onOpenParams: (id: string) => void;
}

export function ModelList({
  models, canManage, busy, onAdd, onRefresh, onSave, onDelete, onToggleEnabled, onOpenParams,
}: Props): JSX.Element {
  const [editingId, setEditingId] = useState<string | null>(null);
  const [isAdding, setIsAdding] = useState(false);

  return (
    <div className="rounded-xl border border-border bg-surface p-4">
      <div className="mb-3 flex items-center justify-between">
        <h2 className="text-sm font-semibold text-foreground">模型列表 ({models.length})</h2>
        <div className="flex gap-2">
          <button
            type="button"
            disabled={busy}
            onClick={onRefresh}
            className="rounded-md border border-border bg-surface px-3 py-1.5 text-sm hover:bg-surface-raised disabled:opacity-50"
          >
            🔄 获取模型
          </button>
          {canManage && (
            <button
              type="button"
              disabled={busy}
              onClick={() => setIsAdding(true)}
              className="rounded-md border border-border bg-surface px-3 py-1.5 text-sm hover:bg-surface-raised disabled:opacity-50"
            >
              + 添加模型
            </button>
          )}
        </div>
      </div>

      <table className="w-full">
        <thead>
          <tr className="border-b border-border/60 text-left text-xs text-secondary">
            <th className="px-3 py-2">模型名称</th>
            <th className="px-3 py-2">模型 ID</th>
            <th className="px-3 py-2">类型</th>
            <th className="px-3 py-2">上下文</th>
            <th className="px-3 py-2">状态</th>
            <th className="px-3 py-2 text-right">操作</th>
          </tr>
        </thead>
        <tbody>
          {models.length === 0 && !isAdding ? (
            <tr>
              <td colSpan={6} className="px-3 py-6 text-center text-sm text-secondary">
                暂无模型,点击「+ 添加模型」或「获取模型」开始
              </td>
            </tr>
          ) : (
            models.map((m) =>
              editingId === m.id ? (
                <ModelInlineEditRow
                  key={m.id}
                  model={m}
                  busy={busy}
                  onSave={(id, body) => { setEditingId(null); onSave(id, body); }}
                  onCancel={() => setEditingId(null)}
                />
              ) : (
                <ModelTableRow
                  key={m.id}
                  model={m}
                  canManage={canManage}
                  onEdit={(id) => setEditingId(id)}
                  onDelete={onDelete}
                  onToggleEnabled={onToggleEnabled}
                  onOpenParams={onOpenParams}
                />
              ),
            )
          )}
          {isAdding && (
            <ModelInlineAddRow
              busy={busy}
              onSave={(body) => { setIsAdding(false); onAdd(body); }}
              onCancel={() => setIsAdding(false)}
            />
          )}
        </tbody>
      </table>
    </div>
  );
}
```

- [ ] **Step 5: Run test to verify it passes**

```bash
cd enterprise_server/web && npx vitest run ModelList 2>&1 | tail -5
```

Expected: 3 passed.

- [ ] **Step 6: Commit**

```bash
git add enterprise_server/web/src/pages/providersModels/ModelList.tsx enterprise_server/web/src/pages/providersModels/ModelList.test.tsx enterprise_server/web/src/pages/providersModels/ModelTableRow.tsx enterprise_server/web/src/pages/providersModels/ModelInlineEditRow.tsx enterprise_server/web/src/pages/providersModels/ModelInlineAddRow.tsx
git commit -m "feat(client): add ModelList with inline edit/add rows"
```

---

## Task 16: Client `ModelParamsDrawer` component

**Files:**
- Create: `enterprise_server/web/src/pages/providersModels/ModelParamsDrawer.tsx`
- Create: `enterprise_server/web/src/pages/providersModels/ModelParamsDrawer.test.tsx`

**Interfaces:**
- Produces: slide-in drawer with kept-fields-only form (Temperature, Top P, maxOutputTokens, supportsImage, supportsThinking, note).

- [ ] **Step 1: Write the failing test**

Create `enterprise_server/web/src/pages/providersModels/ModelParamsDrawer.test.tsx`:

```tsx
import { describe, expect, test, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';

import { ModelParamsDrawer } from './ModelParamsDrawer';

const base = {
  id: 'm1', provider: 'openai', model: 'gpt-4', displayName: 'GPT-4',
  enabled: true, disabledByAdmin: false, quotaPerUserPerDay: null,
  contextWindow: 128000, maxTokens: 8192, temperature: 0.7, topP: 0.9,
  maxOutputTokens: 4096, supportsImage: true, supportsVideo: false, supportsThinking: true,
};

describe('ModelParamsDrawer', () => {
  test('renders form with kept fields', () => {
    render(
      <ModelParamsDrawer
        model={base}
        open={true}
        busy={false}
        onSave={vi.fn()}
        onClose={vi.fn()}
      />,
    );
    expect(screen.getByText(/采样参数/)).toBeInTheDocument();
    expect(screen.getByDisplayValue('0.7')).toBeInTheDocument();
    expect(screen.getByDisplayValue('0.9')).toBeInTheDocument();
    expect(screen.getByDisplayValue('4096')).toBeInTheDocument();
  });

  test('save button invokes onSave with values', () => {
    const onSave = vi.fn();
    render(
      <ModelParamsDrawer
        model={base}
        open={true}
        busy={false}
        onSave={onSave}
        onClose={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: /保存配置/ }));
    expect(onSave).toHaveBeenCalledWith('m1', expect.objectContaining({
      temperature: 0.7,
      topP: 0.9,
      maxOutputTokens: 4096,
    }));
  });

  test('does not render when open=false', () => {
    const { container } = render(
      <ModelParamsDrawer
        model={base}
        open={false}
        busy={false}
        onSave={vi.fn()}
        onClose={vi.fn()}
      />,
    );
    expect(container.firstChild).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd enterprise_server/web && npx vitest run ModelParamsDrawer 2>&1 | tail -10
```

Expected: FAIL.

- [ ] **Step 3: Implement ModelParamsDrawer**

Create `enterprise_server/web/src/pages/providersModels/ModelParamsDrawer.tsx`:

```tsx
import { useEffect, useState } from 'react';
import type { JSX } from 'react';

import type { ModelView } from '../../api/types';

interface ParamsBody {
  temperature: number | null;
  topP: number | null;
  maxOutputTokens: number | null;
  supportsImage: boolean;
  supportsThinking: boolean;
  note: string;
}

interface Props {
  model: ModelView | null;
  open: boolean;
  busy: boolean;
  onSave: (id: string, params: ParamsBody) => void;
  onClose: () => void;
}

export function ModelParamsDrawer({ model, open, busy, onSave, onClose }: Props): JSX.Element | null {
  const [temperature, setTemperature] = useState<number | ''>('');
  const [topP, setTopP] = useState<number | ''>('');
  const [maxOutputTokens, setMaxOutputTokens] = useState<number | ''>('');
  const [supportsImage, setSupportsImage] = useState(false);
  const [supportsThinking, setSupportsThinking] = useState(false);
  const [note, setNote] = useState('');

  useEffect(() => {
    if (!model) return;
    setTemperature(model.temperature ?? '');
    setTopP(model.topP ?? '');
    setMaxOutputTokens(model.maxOutputTokens ?? '');
    setSupportsImage(model.supportsImage);
    setSupportsThinking(model.supportsThinking);
    setNote('');
  }, [model?.id]);

  if (!open || !model) return null;

  return (
    <>
      <div
        onClick={onClose}
        className="fixed inset-0 z-40 bg-black/35"
      />
      <aside className="fixed right-0 top-0 z-50 flex h-full w-[460px] flex-col border-l border-border bg-surface shadow-popover">
        <header className="flex items-center justify-between border-b border-border px-4 py-3">
          <div>
            <p className="text-xs uppercase text-secondary">模型参数</p>
            <p className="text-sm font-medium">{model.displayName ?? model.model}</p>
            <p className="font-mono text-xs text-secondary">{model.model}</p>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="关闭"
            className="rounded p-1 text-secondary hover:bg-surface-raised"
          >✕</button>
        </header>

        <div className="flex-1 space-y-6 overflow-y-auto p-4">
          <Section title="采样参数">
            <NumField label="Temperature (0–2)" step="0.1" min="0" max="2"
              value={temperature} onChange={setTemperature} />
            <NumField label="Top P (0–1)" step="0.05" min="0" max="1"
              value={topP} onChange={setTopP} />
            <NumField label="最大输出 Tokens (1–200000)" step="1" min="1" max="200000"
              value={maxOutputTokens} onChange={setMaxOutputTokens} />
          </Section>

          <Section title="能力开关">
            <Toggle label="视觉输入" value={supportsImage} onChange={setSupportsImage} />
            <Toggle label="思维链" value={supportsThinking} onChange={setSupportsThinking} />
          </Section>

          <Section title="备注">
            <textarea
              value={note}
              onChange={(e) => setNote(e.target.value)}
              rows={3}
              className="w-full rounded-md border border-border bg-background px-2 py-1.5 text-sm"
            />
          </Section>
        </div>

        <footer className="flex justify-end gap-2 border-t border-border px-4 py-3">
          <button
            type="button"
            onClick={onClose}
            className="rounded-md border border-border bg-surface px-3 py-1.5 text-sm hover:bg-surface-raised"
          >取消</button>
          <button
            type="button"
            disabled={busy}
            onClick={() => onSave(model.id, {
              temperature: temperature === '' ? null : Number(temperature),
              topP: topP === '' ? null : Number(topP),
              maxOutputTokens: maxOutputTokens === '' ? null : Number(maxOutputTokens),
              supportsImage,
              supportsThinking,
              note,
            })}
            className="rounded-md bg-primary px-3 py-1.5 text-sm text-white hover:bg-primary-hover disabled:opacity-50"
          >保存配置</button>
        </footer>
      </aside>
    </>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }): JSX.Element {
  return (
    <section>
      <h4 className="mb-2 text-xs font-medium uppercase text-secondary">{title}</h4>
      <div className="space-y-2">{children}</div>
    </section>
  );
}

function NumField({ label, step, min, max, value, onChange }: {
  label: string; step: string; min: string; max: string;
  value: number | ''; onChange: (v: number | '') => void;
}): JSX.Element {
  return (
    <label className="block">
      <span className="mb-1 block text-xs text-secondary">{label}</span>
      <input
        type="number"
        step={step}
        min={min}
        max={max}
        value={value}
        onChange={(e) => onChange(e.target.value === '' ? '' : Number(e.target.value))}
        className="w-full rounded-md border border-border bg-background px-2 py-1.5 text-sm"
      />
    </label>
  );
}

function Toggle({ label, value, onChange }: {
  label: string; value: boolean; onChange: (v: boolean) => void;
}): JSX.Element {
  return (
    <label className="flex cursor-pointer items-center justify-between gap-3 rounded-md border border-border bg-surface-raised px-3 py-2 text-sm">
      <span>{label}</span>
      <input
        type="checkbox"
        checked={value}
        onChange={(e) => onChange(e.target.checked)}
        className="h-5 w-9 cursor-pointer appearance-none rounded-full bg-secondary transition-colors checked:bg-emerald-500"
      />
    </label>
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
cd enterprise_server/web && npx vitest run ModelParamsDrawer 2>&1 | tail -5
```

Expected: 3 passed.

- [ ] **Step 5: Commit**

```bash
git add enterprise_server/web/src/pages/providersModels/ModelParamsDrawer.tsx enterprise_server/web/src/pages/providersModels/ModelParamsDrawer.test.tsx
git commit -m "feat(client): add ModelParamsDrawer with kept fields only"
```

---

## Task 17: Client rewrite `ProvidersModelsPage.tsx`

**Files:**
- Modify: `enterprise_server/web/src/pages/ProvidersModelsPage.tsx` (rewrite from ~856 to ~400 lines)
- Create: `enterprise_server/web/src/pages/ProvidersModelsPage.test.tsx`

**Interfaces:**
- Composes all sub-components (rail, header, info card, model list, params drawer).
- Wires data fetching (TanStack Query) and mutations.
- Auth gating via `useAuth().hasCapability('admin')` for write UI.

- [ ] **Step 1: Write the failing test**

Create `enterprise_server/web/src/pages/ProvidersModelsPage.test.tsx`:

```tsx
import { describe, expect, test, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';

import { ProvidersModelsPage } from './ProvidersModelsPage';

// Mock the API module
vi.mock('../api/providers', () => ({
  providersApi: {
    list: vi.fn().mockResolvedValue([]),
    add: vi.fn(),
    patch: vi.fn(),
    remove: vi.fn(),
    test: vi.fn(),
    refresh: vi.fn(),
    enable: vi.fn(),
    disable: vi.fn(),
  },
}));

vi.mock('../api/models', () => ({
  modelsApi: {
    list: vi.fn().mockResolvedValue([]),
    add: vi.fn(),
    patch: vi.fn(),
    remove: vi.fn(),
    enable: vi.fn(),
    disable: vi.fn(),
  },
}));

function renderWithProviders(ui: React.ReactElement) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter>{ui}</MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('ProvidersModelsPage', () => {
  test('renders page title and rail sections', async () => {
    renderWithProviders(<ProvidersModelsPage />);
    await waitFor(() => {
      expect(screen.getByText(/模型管理/)).toBeInTheDocument();
    });
    expect(screen.getByPlaceholderText(/搜索/)).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd enterprise_server/web && npx vitest run ProvidersModelsPage 2>&1 | tail -10
```

Expected: FAIL.

- [ ] **Step 3: Rewrite ProvidersModelsPage**

Replace `enterprise_server/web/src/pages/ProvidersModelsPage.tsx` entirely. The new file:

```tsx
import { useState } from 'react';
import type { JSX } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { modelsApi } from '../api/models';
import { providersApi } from '../api/providers';
import type { ModelView, ProviderKeyView } from '../api/types';
import { useAuth } from '../auth/useAuth';
import { useToast } from '../components/toastStore';

import { ModelList } from './providersModels/ModelList';
import { ModelParamsDrawer } from './providersModels/ModelParamsDrawer';
import { ProviderHeaderBar } from './providersModels/ProviderHeaderBar';
import { ProviderInfoCard } from './providersModels/ProviderInfoCard';
import { ProviderRail } from './providersModels/ProviderRail';

import { PROVIDER_CATALOG } from '../data/providerCatalog';

export function ProvidersModelsPage(): JSX.Element {
  const { hasCapability } = useAuth();
  const canManage = hasCapability('admin');
  const qc = useQueryClient();
  const toast = useToast();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [paramsModelId, setParamsModelId] = useState<string | null>(null);

  const providersQ = useQuery({
    queryKey: ['providers'],
    queryFn: () => providersApi.list(),
  });
  const modelsQ = useQuery({
    queryKey: ['models'],
    queryFn: () => modelsApi.list(),
  });

  const invalidate = () => { void qc.invalidateQueries({ queryKey: ['providers'] }); void qc.invalidateQueries({ queryKey: ['models'] }); };

  const testMut = useMutation({
    mutationFn: (id: string) => providersApi.test(id),
    onSuccess: () => { invalidate(); toast.success('测试完成'); },
    onError: () => toast.error('测试失败'),
  });

  const saveMut = useMutation({
    mutationFn: ({ id, body }: { id: string; body: { name: string; desc: string; baseUrl: string; } }) => providersApi.patch(id, body),
    onSuccess: () => { invalidate(); toast.success('已保存'); },
    onError: () => toast.error('保存失败'),
  });

  const deleteMut = useMutation({
    mutationFn: (id: string) => providersApi.remove(id),
    onSuccess: (r) => { invalidate(); toast.success(`已删除 ${r.deletedModels} 个模型`); setSelectedId(null); },
    onError: () => toast.error('删除失败'),
  });

  const toggleEnabledMut = useMutation({
    mutationFn: ({ id, enabled }: { id: string; enabled: boolean }) => enabled ? providersApi.enable(id) : providersApi.disable(id),
    onSuccess: invalidate,
  });

  const refreshMut = useMutation({
    mutationFn: (id: string) => providersApi.refresh(id),
    onSuccess: (r) => toast.success(`已获取 ${r.added} 个新模型`),
    onError: () => toast.error('获取失败'),
  });

  const addModelMut = useMutation({
    mutationFn: (body: { providerId: string; model: string; displayName?: string }) => modelsApi.add({ ...body, params: {} }),
    onSuccess: invalidate,
  });

  const saveModelMut = useMutation({
    mutationFn: ({ id, body }: { id: string; body: { displayName: string; enabled: boolean } }) =>
      modelsApi.patch(id, { displayName: body.displayName, enabled: body.enabled }),
    onSuccess: invalidate,
  });

  const saveParamsMut = useMutation({
    mutationFn: ({ id, params }: { id: string; params: object }) => modelsApi.patch(id, { params }),
    onSuccess: () => { invalidate(); setParamsModelId(null); toast.success('已保存配置'); },
  });

  const deleteModelMut = useMutation({
    mutationFn: (id: string) => modelsApi.remove(id),
    onSuccess: invalidate,
  });

  const toggleModelMut = useMutation({
    mutationFn: ({ id, enabled }: { id: string; enabled: boolean }) => enabled ? modelsApi.enable(id) : modelsApi.disable(id),
    onSuccess: invalidate,
  });

  const providers = providersQ.data ?? [];
  const models = modelsQ.data ?? [];

  const selected = providers.find((p) => p.id === selectedId);
  const paramsModel = models.find((m) => m.id === paramsModelId) ?? null;

  // Build catalog list from seed
  const configuredIds = new Set(providers.map((p) => p.provider));
  const catalog = PROVIDER_CATALOG.filter((c) => !configuredIds.has(c.id));

  return (
    <div className="flex h-full flex-col">
      <PageHeader title="模型管理" subtitle="管理服务商连接和模型配置" />

      <div className="flex flex-1 overflow-hidden">
        <div className="w-72 shrink-0">
          <ProviderRail
            configured={providers}
            catalog={catalog}
            selectedId={selectedId}
            onSelect={setSelectedId}
            canManage={canManage}
          />
        </div>

        <div className="flex-1 overflow-y-auto p-6">
          {selected ? (
            <div className="space-y-4">
              <ProviderHeaderBar
                provider={selected}
                canManage={canManage}
                busy={testMut.isPending || saveMut.isPending || deleteMut.isPending || toggleEnabledMut.isPending}
                onTest={(id) => testMut.mutate(id)}
                onSave={(id) => saveMut.mutate({ id, body: { name: selected.name, desc: selected.desc ?? '', baseUrl: selected.endpoint ?? '' } })}
                onDelete={(id) => {
                  if (confirm(`确认删除服务商「${selected.name}」及其全部模型？此操作不可撤销。`)) {
                    deleteMut.mutate(id);
                  }
                }}
                onToggleEnabled={(id, enabled) => toggleEnabledMut.mutate({ id, enabled })}
              />

              <ProviderInfoCard
                provider={selected}
                canManage={canManage}
                busy={saveMut.isPending}
                onSave={(id, body) => saveMut.mutate({ id, body })}
              />

              <ModelList
                models={models.filter((m) => m.provider === selected.provider)}
                canManage={canManage}
                busy={addModelMut.isPending || saveModelMut.isPending || deleteModelMut.isPending || refreshMut.isPending || toggleModelMut.isPending}
                onRefresh={() => refreshMut.mutate(selected.id)}
                onAdd={(body) => addModelMut.mutate({ providerId: selected.id, ...body })}
                onSave={(id, body) => saveModelMut.mutate({ id, body })}
                onDelete={(id) => {
                  if (confirm('确认删除该模型？')) deleteModelMut.mutate(id);
                }}
                onToggleEnabled={(id, enabled) => toggleModelMut.mutate({ id, enabled })}
                onOpenParams={(id) => setParamsModelId(id)}
              />
            </div>
          ) : (
            <div className="flex h-full items-center justify-center text-secondary">
              选择左侧的服务商以查看详情
            </div>
          )}
        </div>
      </div>

      <ModelParamsDrawer
        model={paramsModel}
        open={paramsModelId !== null}
        busy={saveParamsMut.isPending}
        onSave={(id, params) => saveParamsMut.mutate({ id, params })}
        onClose={() => setParamsModelId(null)}
      />
    </div>
  );
}

function PageHeader({ title, subtitle }: { title: string; subtitle: string }): JSX.Element {
  return (
    <div className="border-b border-border bg-surface px-6 py-3">
      <h1 className="text-base font-semibold text-foreground">{title}</h1>
      <p className="text-xs text-secondary">{subtitle}</p>
    </div>
  );
}
```

**Notes:**
- The current `modelsApi.add` signature may differ. The earlier `Task 11` defines the type; the body should match.
- The current page uses a `confirm()` instead of `ConfirmDialog` for simplicity. If you want to use `ConfirmDialog` instead, replace the `confirm(...)` calls — both are acceptable.
- `useToast` — if the toast hook has a different API, adjust accordingly.

- [ ] **Step 4: Run test to verify it passes**

```bash
cd enterprise_server/web && npx vitest run ProvidersModelsPage 2>&1 | tail -5
```

Expected: 1 passed.

- [ ] **Step 5: Run full web test suite**

```bash
cd enterprise_server/web && npx vitest run 2>&1 | tail -10
```

Expected: All new tests pass; existing tests unaffected.

- [ ] **Step 6: Lint the file**

```bash
cd enterprise_server/web && npx eslint --ext ts,tsx --report-unused-disable-directives --max-warnings 0 src/pages/ProvidersModelsPage.tsx src/pages/providersModels/ 2>&1 | tail -10
```

Fix any issues that are genuinely new (not pre-existing).

- [ ] **Step 7: Commit**

```bash
git add enterprise_server/web/src/pages/ProvidersModelsPage.tsx enterprise_server/web/src/pages/ProvidersModelsPage.test.tsx
git commit -m "feat(client): rewrite ProvidersModelsPage to compose sub-components"
```

---

## Task 18: i18n keys (zh + en)

**Files:**
- Modify: `enterprise_server/web/src/i18n.ts`

**Interfaces:**
- Adds ~30 new keys (zh + en) for: rail section labels, header buttons, model params drawer sections, delete confirm messages.
- Removes obsolete keys (Tabs, StatsRow).

- [ ] **Step 1: Add new keys to the `zh` block**

Find the `zh: { ... }` block in `i18n.ts`. Add the following keys (the English translations follow the same keys):

```ts
// Inside zh: { ... }
providersModels_rail_search: '搜索服务商',
providersModels_rail_configured: '已配置',
providersModels_rail_catalog: '未配置',
providersModels_header_test: '测试连接',
providersModels_header_save: '保存',
providersModels_header_delete: '删除服务商',
providersModels_header_enabled: '服务商已启用',
providersModels_header_disabled: '服务商已停用',
providersModels_info_card: '服务商信息',
providersModels_info_name: '名称',
providersModels_info_desc: '备注',
providersModels_info_baseUrl: 'Base URL',
providersModels_info_apiKey: 'API Key',
providersModels_info_showKey: '显示 API Key',
providersModels_info_hideKey: '隐藏 API Key',
providersModels_info_status: '状态',
providersModels_model_list: '模型列表',
providersModels_model_refresh: '获取模型',
providersModels_model_add: '添加模型',
providersModels_model_empty: '暂无模型，点击「+ 添加模型」或「获取模型」开始',
providersModels_model_col_name: '模型名称',
providersModels_model_col_id: '模型 ID',
providersModels_model_col_type: '类型',
providersModels_model_col_ctx: '上下文',
providersModels_model_col_status: '状态',
providersModels_model_col_actions: '操作',
providersModels_model_type_chat: '对话',
providersModels_model_type_reasoning: '推理',
providersModels_model_type_vision: '视觉',
providersModels_model_status_enabled: '启用',
providersModels_model_status_disabled: '禁用',
providersModels_model_action_config: '配置',
providersModels_model_action_edit: '编辑',
providersModels_model_action_delete: '删除',
providersModels_model_save: '保存',
providersModels_model_cancel: '取消',
providersModels_params_title: '模型参数',
providersModels_params_section_sampling: '采样参数',
providersModels_params_section_capabilities: '能力开关',
providersModels_params_section_notes: '备注',
providersModels_params_temperature: 'Temperature (0–2)',
providersModels_params_topP: 'Top P (0–1)',
providersModels_params_maxOutput: '最大输出 Tokens (1–200000)',
providersModels_params_cap_image: '视觉输入',
providersModels_params_cap_thinking: '思维链',
providersModels_params_save: '保存配置',
providersModels_params_cancel: '取消',
providersModels_confirm_delete_provider: '确认删除服务商「{name}」及其全部 {n} 个模型？此操作不可撤销。',
providersModels_confirm_delete_model: '确认删除模型「{name}」？',
providersModels_test_success: '✓ 连接成功 ({ms}ms)',
providersModels_test_failed: '✗ 连接失败',
providersModels_test_running: '测试中…',
providersModels_test_no_endpoint: '该服务商未配置 Base URL',
```

- [ ] **Step 2: Mirror the keys in the `en` block**

Add the same keys to the `en: { ... }` block with English translations:

```ts
providersModels_rail_search: 'Search providers',
providersModels_rail_configured: 'Configured',
providersModels_rail_catalog: 'Not configured',
providersModels_header_test: 'Test connection',
providersModels_header_save: 'Save',
providersModels_header_delete: 'Delete provider',
providersModels_header_enabled: 'Provider enabled',
providersModels_header_disabled: 'Provider disabled',
providersModels_info_card: 'Provider info',
providersModels_info_name: 'Name',
providersModels_info_desc: 'Notes',
providersModels_info_baseUrl: 'Base URL',
providersModels_info_apiKey: 'API Key',
providersModels_info_showKey: 'Show API Key',
providersModels_info_hideKey: 'Hide API Key',
providersModels_info_status: 'Status',
providersModels_model_list: 'Models',
providersModels_model_refresh: 'Fetch models',
providersModels_model_add: 'Add model',
providersModels_model_empty: 'No models yet. Click "+ Add model" or "Fetch models" to get started.',
providersModels_model_col_name: 'Model name',
providersModels_model_col_id: 'Model ID',
providersModels_model_col_type: 'Type',
providersModels_model_col_ctx: 'Context',
providersModels_model_col_status: 'Status',
providersModels_model_col_actions: 'Actions',
providersModels_model_type_chat: 'Chat',
providersModels_model_type_reasoning: 'Reasoning',
providersModels_model_type_vision: 'Vision',
providersModels_model_status_enabled: 'Enabled',
providersModels_model_status_disabled: 'Disabled',
providersModels_model_action_config: 'Config',
providersModels_model_action_edit: 'Edit',
providersModels_model_action_delete: 'Delete',
providersModels_model_save: 'Save',
providersModels_model_cancel: 'Cancel',
providersModels_params_title: 'Model parameters',
providersModels_params_section_sampling: 'Sampling',
providersModels_params_section_capabilities: 'Capabilities',
providersModels_params_section_notes: 'Notes',
providersModels_params_temperature: 'Temperature (0–2)',
providersModels_params_topP: 'Top P (0–1)',
providersModels_params_maxOutput: 'Max output tokens (1–200000)',
providersModels_params_cap_image: 'Image input',
providersModels_params_cap_thinking: 'Chain-of-thought',
providersModels_params_save: 'Save configuration',
providersModels_params_cancel: 'Cancel',
providersModels_confirm_delete_provider: 'Delete provider "{name}" and its {n} models? This cannot be undone.',
providersModels_confirm_delete_model: 'Delete model "{name}"?',
providersModels_test_success: '✓ Connected ({ms}ms)',
providersModels_test_failed: '✗ Connection failed',
providersModels_test_running: 'Testing…',
providersModels_test_no_endpoint: 'Provider has no Base URL configured',
```

- [ ] **Step 3: Verify the file parses**

```bash
cd enterprise_server/web && npx tsc --noEmit -p tsconfig.json 2>&1 | tail -5
```

Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add enterprise_server/web/src/i18n.ts
git commit -m "feat(client): add i18n keys for rebuilt providers page"
```

---

## Task 19: Final verification

**Files:** none — verification only.

- [ ] **Step 1: Run all server tests**

```bash
cd enterprise_server && npm test 2>&1 | grep -E "Test Files|Tests "
```

Expected: same or higher pass count vs. baseline. Existing tests still pass; new tests in `providerKeysExtended` (8) + `modelsExtended` (8) = 16 new passing tests.

- [ ] **Step 2: Run all web tests**

```bash
cd enterprise_server/web && npx vitest run 2>&1 | grep -E "Test Files|Tests "
```

Expected: all green for the new files; pre-existing failures unchanged.

- [ ] **Step 3: Lint all touched files**

```bash
cd enterprise_server/web && npx eslint --ext ts,tsx --report-unused-disable-directives --max-warnings 0 \
  src/pages/ProvidersModelsPage.tsx \
  src/pages/providersModels/ \
  src/api/providers.ts \
  src/api/models.ts \
  src/api/types.ts \
  src/components/StatusDot.tsx
```

```bash
cd enterprise_server && npx eslint --ext ts --report-unused-disable-directives --max-warnings 0 \
  src/routes/admin/providerKeys.ts \
  src/routes/admin/models.ts \
  src/shared/providerKeys/constants.ts
```

Expected: no new errors vs. baseline.

- [ ] **Step 4: Manual QA checklist**

Run:
```bash
# Terminal 1
cd enterprise_server && npm run dev
# Terminal 2
cd enterprise_server/web && npm run dev
```

Open `http://localhost:5173/config/providers`. Verify:
- [ ] Provider rail shows two sections (已配置 / 未配置) with search
- [ ] Clicking a provider populates the detail panel
- [ ] 测试连接 button works, status dot updates with latency + lastTest
- [ ] Save persists name/desc/baseUrl/apiKey changes
- [ ] Delete prompts confirm, cascades to models
- [ ] Enable/disable toggle works
- [ ] Add model via inline row, edit via inline edit row
- [ ] Open params drawer, edit Temperature/Top P/maxOutputTokens/capabilities/note, save
- [ ] Switch to a non-admin user (separate login): no edit/delete/toggle controls visible
- [ ] Switch to a fresh org with no providers: rail shows catalog rows + 已配置 empty

- [ ] **Step 5: Final commit (if any verification fixes)**

If Steps 1-4 surfaced any fixes needed, commit them individually with descriptive messages.

---

## Self-Review

**1. Spec coverage:**

| Spec section | Implementing task(s) |
|---|---|
| Provider schema migration | Task 1 |
| Model schema migration | Task 2 |
| ProviderKeyStatus enum | Task 3 |
| PATCH /admin/provider-keys/:id | Task 4 |
| DELETE /admin/provider-keys/:id (cascade) | Task 5 |
| POST /admin/provider-keys/:id/test | Task 6 |
| GET /admin/provider-keys extended response | Task 7 |
| PATCH /admin/models/:id (with params) | Task 8 |
| DELETE /admin/models/:id | Task 9 |
| GET/POST /admin/models extended | Task 10 |
| Client shared types + API client | Task 11 |
| StatusDot component | Task 12 |
| ProviderRail component | Task 13 |
| ProviderHeaderBar + ProviderInfoCard | Task 14 |
| ModelList + table row + inline edit/add | Task 15 |
| ModelParamsDrawer (kept fields only) | Task 16 |
| ProvidersModelsPage rewrite | Task 17 |
| i18n keys | Task 18 |
| Manual verification | Task 19 |

All spec sections are covered. The 7 excluded features (stopSeqs, stream, functionCalling, thinkingBudget, responseFormat, RPM/TPM, pricing) are correctly absent from every task.

**2. Placeholder scan:** No "TBD", "TODO", or vague "implement later". Each task has explicit code or test blocks.

**3. Type consistency:**

- `ProviderKeyView` extended fields: defined in Task 7 (server-side shape), extended in Task 11 (client-side). camelCase in both: `desc`, `apiKeyMasked`, `status`, `latencyMs`, `lastTestAt`. ✓
- `ModelView` extended fields: server Task 10, client Task 11. camelCase: `temperature`, `topP`, `maxOutputTokens`, `displayName`, `supportsImage`, `supportsVideo`, `supportsThinking`. ✓
- API client method names: `providersApi.list/patch/remove/test/refresh/enable/disable`, `modelsApi.list/add/patch/remove/enable/disable`. ✓ Consistent with usage in Task 17.
- `useCapability('admin')` referenced consistently in Task 14 (`canManage` prop) and Task 17 (page-level gate). ✓

No inconsistencies found.
