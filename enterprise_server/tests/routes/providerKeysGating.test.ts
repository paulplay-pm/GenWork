// Regression guard for the provider-key admin route (two-axis permission
// rebuild, Task 15). Pins the already-secure, fail-closed behavior:
//   - GET /admin/provider-keys is gated on provider:view (403 without it);
//   - the list response is masked-only: no plaintext key field exists in the
//     wire shape (ProviderKeyView);
//   - POST /admin/provider-keys needs provider:edit, so a view-only caller
//     cannot write keys.
//
// Note: this suite is GREEN-by-design. The route already gates correctly and
// the vault list shape already excludes plaintext — no stripping happens in
// the route because a caller without provider:view never gets a response.
import '../helpers/setupEnv';

import { beforeEach, describe, expect, test, vi } from 'vitest';

vi.mock('../../src/db/pool', async () => {
  const td = await import('../../src/db/testDb');
  return { pool: td.testPool };
});

import { Hono } from 'hono';

import { authService } from '../../src/auth/authService';
import { signToken } from '../../src/auth/jwt';
import { resetSchema, runMigrations, testPool } from '../../src/db/testDb';
import { roleService } from '../../src/org/roleService';
import { adminProviderKeyRoutes } from '../../src/routes/admin/providerKeys';
import { PermissionPoint } from '../../src/shared/permissionPoints';
import { providerKeyVault } from '../../src/vault/providerKeyVault';

const PLAINTEXT = 'sk-SECRET-PLAINTEXT';
const MASKED = 'sk-••••••••ETXT';

// Exact wire fields a list row may carry (mirrors ProviderKeyView). Any
// additional field — e.g. `api_key`, `value`, `plaintext`, `secret` — would
// be a secret-leak regression and fails the key-set assertion below.
const VIEW_FIELDS: readonly string[] = [
  'id',
  'org_id',
  'provider',
  'endpoint',
  'label',
  'enabled',
  'region',
  'default_base_url',
  'website',
  'description',
  'api_key_masked',
  'is_builtin',
  'protocol',
  'coding_plan',
  'status',
  'latency_ms',
  'last_test_at',
  'created_at',
];

const app = new Hono();
app.route('/', adminProviderKeyRoutes);

/** Seed org o1, a real user (provider_keys.created_by is an FK to users),
 * and a provider key whose plaintext is a known throwaway test string. */
async function seed(): Promise<{ keyId: string }> {
  await testPool.query(`INSERT INTO orgs(id, name) VALUES ('o1', 'T')`);
  const u = await authService.createUser({
    orgId: 'o1',
    username: 'admin',
    password: 'pw12345678',
  });
  const { id } = await providerKeyVault.add({
    orgId: 'o1',
    provider: 'openai',
    plaintextKey: PLAINTEXT,
    endpoint: 'https://api.openai.com/v1',
    createdBy: u.id,
  });
  // add() now writes a mask derived from the plaintext; overwrite it with a
  // fixed display value so the assertion below can pin the exact wire shape.
  await testPool.query(`UPDATE provider_keys SET api_key_masked = $1 WHERE id = $2`, [MASKED, id]);
  return { keyId: id };
}

describe('provider-key list gating and masked-only wire shape', () => {
  beforeEach(async () => {
    await resetSchema();
    await runMigrations();
  });

  test('provider:view-only caller gets 200 with masked-only rows', async () => {
    const { keyId } = await seed();
    await roleService.create({
      name: 'provider_viewer',
      permissions: [PermissionPoint.ProviderView],
    });
    const tok = await signToken({ sub: 'viewer', orgId: 'o1', roles: ['provider_viewer'] });
    const res = await app.request('/admin/provider-keys?orgId=o1', {
      headers: { authorization: `Bearer ${tok}` },
    });
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(Array.isArray(body)).toBe(true);
    const rows = body as Array<Record<string, unknown>>;
    const row = rows.find((r) => r.id === keyId);
    expect(row).toBeDefined();
    // The created key reports a masked value (string, not null, not the secret).
    expect(typeof row!.api_key_masked).toBe('string');
    expect(row!.api_key_masked).toBe(MASKED);
    expect(row!.api_key_masked).not.toBe(PLAINTEXT);

    // No wire field may equal the plaintext, and the key set of every row
    // must be a subset of ProviderKeyView's fields.
    for (const r of rows) {
      for (const v of Object.values(r)) {
        expect(v).not.toBe(PLAINTEXT);
      }
      for (const k of Object.keys(r)) {
        expect(VIEW_FIELDS).toContain(k);
      }
    }
    expect(JSON.stringify(body)).not.toContain(PLAINTEXT);
  });

  test('caller without provider:view gets 403 on GET', async () => {
    await seed();
    // model_admin would NOT work here: it carries provider:* points
    // (migration 029 seed), so use a role with only an unrelated point.
    await roleService.create({
      name: 'models_only',
      permissions: [PermissionPoint.ModelView],
    });
    const tok = await signToken({ sub: 'nonviewer', orgId: 'o1', roles: ['models_only'] });
    const res = await app.request('/admin/provider-keys?orgId=o1', {
      headers: { authorization: `Bearer ${tok}` },
    });
    expect(res.status).toBe(403);
  });

  test('provider:view-only caller cannot POST (writes need provider:edit)', async () => {
    await seed();
    await roleService.create({
      name: 'provider_viewer',
      permissions: [PermissionPoint.ProviderView],
    });
    const tok = await signToken({ sub: 'viewer', orgId: 'o1', roles: ['provider_viewer'] });
    const res = await app.request('/admin/provider-keys', {
      method: 'POST',
      headers: { authorization: `Bearer ${tok}`, 'content-type': 'application/json' },
      body: JSON.stringify({ orgId: 'o1', provider: 'anthropic', apiKey: 'sk-other' }),
    });
    expect(res.status).toBe(403);
    // The gate must reject before any key is written.
    const r = await testPool.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM provider_keys WHERE org_id = 'o1' AND provider = 'anthropic'`,
    );
    expect(r.rows[0].n).toBe(0);
  });
});
