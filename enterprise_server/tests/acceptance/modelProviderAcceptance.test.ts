import '../helpers/setupEnv';

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

vi.mock('../../src/db/pool', async () => {
  const td = await import('../../src/db/testDb');
  return { pool: td.testPool };
});

import { signToken } from '../../src/auth/jwt';
import { resetSchema, runMigrations, testPool } from '../../src/db/testDb';
import { seedBuiltinProviders } from '../../src/org/builtinProviders';
import { buildApp } from '../../src/server';

/**
 * Model & provider management — acceptance walkthrough (PRD V1.0 §7).
 *
 * This is NOT a unit test. It drives the REAL application (`buildApp()` from
 * `src/server`) at the HTTP boundary — `app.request(url, {...})` for every
 * check — against a throwaway in-process Postgres (the pglite shim in
 * `src/db/testDb`), seeded exactly like the live server seeds it
 * (`seedBuiltinProviders`). Real HS256 JWTs are signed via `signToken` with
 * the same `JWT_SECRET` the server loads. The dev `gwork` DB is never touched.
 *
 * The six checks mirror the PRD §7 acceptance items:
 *   1. 9 built-ins present + non-deletable (409 + audit row each)
 *   2. Custom add (keyless ok) + masked echo, never plaintext
 *   3. Inline enable/disable a builtin (enabled flips)
 *   4. Protocol-aware refresh wire format (anthropic → x-api-key, no Bearer)
 *   5. Model multi-type save + out-of-set rejection (400)
 *   6. Cross-org isolation → 404 (never 409/200/leak)
 *   7. (post-review) Model PATCH `types` round-trip + legacy `type` mapping +
 *      non-array `types` rejection (400)
 *   8. (post-review) Cross-tenant orgId mismatch → 400 (read/create routes
 *      cannot query or write into a foreign org)
 *
 * Each check logs its ✅/❌ + HTTP status so the durable acceptance doc can be
 * written from the real results. The `expect(...)` assertions below mean the
 * test genuinely fails if a check regresses.
 */

// The 9 built-in provider slugs — must stay in sync with BUILTIN_PROVIDERS in
// src/org/builtinProviders.ts.
const BUILTIN_SLUGS = [
  'openai', 'anthropic', 'deepseek', 'moonshot',
  'qwen', 'zhipu', 'minimax', 'xiaomi', 'volc',
];

// The real app. `buildApp()` is side-effect-free on import (the server only
// listens when run directly), so constructing it here is safe; the `vi.mock`
// on `src/db/pool` above redirects every route's pool access to pglite.
const app = buildApp();

async function orgAdmin(orgId: string, sub = 'u-admin'): Promise<string> {
  return signToken({ sub, orgId, roles: ['super_admin'] });
}

async function builtinId(orgId: string, provider: string): Promise<string> {
  const r = await testPool.query<{ id: string }>(
    `SELECT id FROM provider_keys WHERE org_id=$1 AND provider=$2 AND is_builtin`,
    [orgId, provider],
  );
  return r.rows[0].id;
}

describe('model & provider management — acceptance walkthrough (PRD §7)', () => {
  beforeEach(async () => {
    await resetSchema();
    await runMigrations();
    // provider_keys.org_id is a NOT NULL FK to orgs(id); the org must exist
    // before seedBuiltinProviders can insert its rows.
    await testPool.query(`INSERT INTO orgs(id,name) VALUES ('o1','A') ON CONFLICT DO NOTHING`);
    await seedBuiltinProviders('o1');
  });

  afterEach(() => {
    // Restore any stubbed global (the fetch stub in check 4).
    vi.unstubAllGlobals();
  });

  test('1. 9 built-ins present + non-deletable (409 + audit row each)', async () => {
    const tok = await orgAdmin('o1');

    const listRes = await app.request('/admin/provider-keys?orgId=o1', {
      headers: { authorization: `Bearer ${tok}` },
    });
    expect(listRes.status).toBe(200);
    const rows = (await listRes.json()) as Array<{ provider: string; is_builtin: boolean }>;
    const builtins = rows.filter((r) => r.is_builtin);
    console.log(`check1: GET /admin/provider-keys → ${listRes.status}; ${builtins.length}/9 built-ins listed`);
    expect(builtins.length).toBe(9);
    for (const slug of BUILTIN_SLUGS) {
      expect(builtins.some((r) => r.provider === slug)).toBe(true);
    }

    // Each of the 9 built-ins is non-deletable: 409 { error: 'builtin_provider' }
    // and an audit row (action='provider_key_builtin_delete').
    const statuses: number[] = [];
    for (const slug of BUILTIN_SLUGS) {
      const id = await builtinId('o1', slug);
      const delRes = await app.request(`/admin/provider-keys/${id}`, {
        method: 'DELETE',
        headers: { authorization: `Bearer ${tok}` },
      });
      statuses.push(delRes.status);
      expect(delRes.status).toBe(409);
      expect(await delRes.json()).toEqual({ error: 'builtin_provider' });
    }
    const audit = await testPool.query<{ n: number }>(
      `SELECT count(*)::int n FROM audit_events WHERE action='provider_key_builtin_delete'`,
    );
    expect(audit.rows[0].n).toBe(9);
    console.log(
      `check1: all 9 DELETEs → ${statuses.join(',')} (all 409); audit 'provider_key_builtin_delete' rows = ${audit.rows[0].n}`,
    );
  });

  test('2. custom add (keyless ok) + masked echo, never plaintext', async () => {
    const tok = await orgAdmin('o1');
    const plaintext = 'sk-real-secret-123456';

    // Keyless custom provider is allowed (200); the key is added later.
    const addRes = await app.request('/admin/provider-keys', {
      method: 'POST',
      headers: { authorization: `Bearer ${tok}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        orgId: 'o1', provider: 'vllm-custom', protocol: 'openai', endpoint: 'https://x/v1',
      }),
    });
    expect(addRes.status).toBe(200);
    const { id } = (await addRes.json()) as { id: string };
    console.log(`check2a: POST keyless custom (no apiKey) → ${addRes.status}; id=${id}`);

    // PATCH sets the protocol + a real key (write-only).
    const patchRes = await app.request(`/admin/provider-keys/${id}`, {
      method: 'PATCH',
      headers: { authorization: `Bearer ${tok}`, 'content-type': 'application/json' },
      body: JSON.stringify({ protocol: 'anthropic', apiKey: plaintext }),
    });
    expect(patchRes.status).toBe(200);
    console.log(`check2b: PATCH {protocol:'anthropic', apiKey:<redacted>} → ${patchRes.status}`);

    // GET shows a •-masked key and NEVER the plaintext.
    const getRes = await app.request('/admin/provider-keys?orgId=o1', {
      headers: { authorization: `Bearer ${tok}` },
    });
    expect(getRes.status).toBe(200);
    const rows = (await getRes.json()) as Array<{
      id: string; api_key_masked: string | null;
    }>;
    const row = rows.find((r) => r.id === id);
    expect(row?.api_key_masked).toContain('•');
    const raw = JSON.stringify(rows);
    expect(raw).not.toContain(plaintext);
    console.log(
      `check2c: GET → api_key_masked=${row?.api_key_masked} (contains •, plaintext absent from body)`,
    );
  });

  test('3. enable/disable a builtin inline (enabled flips)', async () => {
    const tok = await orgAdmin('o1');
    const id = await builtinId('o1', 'openai');

    const beforeRes = await app.request('/admin/provider-keys?orgId=o1', {
      headers: { authorization: `Bearer ${tok}` },
    });
    const beforeRow = ((await beforeRes.json()) as Array<{ id: string; enabled: boolean }>)
      .find((r) => r.id === id);
    // Built-ins seed without an API Key, so they start DISABLED (未启用).
    expect(beforeRow?.enabled).toBe(false); // keyless seed default

    // Inline PATCH toggles the enabled flag (the raw route sets it; the UI
    // separately guards enabling-without-a-key).
    const patchRes = await app.request(`/admin/provider-keys/${id}`, {
      method: 'PATCH',
      headers: { authorization: `Bearer ${tok}`, 'content-type': 'application/json' },
      body: JSON.stringify({ enabled: true }),
    });
    expect(patchRes.status).toBe(200);

    const afterRes = await app.request('/admin/provider-keys?orgId=o1', {
      headers: { authorization: `Bearer ${tok}` },
    });
    const afterRow = ((await afterRes.json()) as Array<{ id: string; enabled: boolean }>)
      .find((r) => r.id === id);
    expect(afterRow?.enabled).toBe(true);
    console.log(
      `check3: PATCH {enabled:true} → ${patchRes.status}; enabled ${beforeRow?.enabled} → ${afterRow?.enabled} (keyless builtins start disabled)`,
    );
  });

  test('4. protocol-aware refresh wire format (anthropic → x-api-key, no Bearer)', async () => {
    // Stub global fetch to capture the wire headers and return a minimal
    // OpenAI-style `models` payload. Restored in afterEach.
    const fetchSpy = vi.fn(async (_url: string, _init?: RequestInit) => ({
      status: 200,
      ok: true,
      json: async () => ({ data: [{ id: 'claude-sonnet-4' }] }),
    }));
    vi.stubGlobal('fetch', fetchSpy);

    const tok = await orgAdmin('o1');
    // Seed a custom anthropic-protocol row: keyless POST (no created_by FK)
    // then PATCH in the key + enable — the same workflow an operator uses.
    // (Since keyless providers now seed disabled, the key PATCH is paired with
    // `enabled: true`; a keyless, key-set-but-disabled row would 409 provider_disabled.)
    const addRes = await app.request('/admin/provider-keys', {
      method: 'POST',
      headers: { authorization: `Bearer ${tok}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        orgId: 'o1', provider: 'vllm-anthropic', protocol: 'anthropic',
        endpoint: 'http://localhost:9999/v1',
      }),
    });
    expect(addRes.status).toBe(200);
    const { id } = (await addRes.json()) as { id: string };
    const keyRes = await app.request(`/admin/provider-keys/${id}`, {
      method: 'PATCH',
      headers: { authorization: `Bearer ${tok}`, 'content-type': 'application/json' },
      body: JSON.stringify({ apiKey: 'sk-ant-wire-123', enabled: true }),
    });
    expect(keyRes.status).toBe(200);

    const refreshRes = await app.request(`/admin/provider-keys/${id}/refresh-models`, {
      method: 'POST',
      headers: { authorization: `Bearer ${tok}` },
    });
    expect(refreshRes.status).toBe(200);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const headers = (fetchSpy.mock.calls[0]![1] as RequestInit).headers as Record<string, string>;
    expect(headers['x-api-key']).toBe('sk-ant-wire-123');
    expect(headers['anthropic-version']).toBe('2023-06-01');
    expect(headers['authorization']).toBeUndefined();
    console.log(
      `check4: refresh-models → ${refreshRes.status}; wire headers: x-api-key + anthropic-version present, Authorization/Bearer absent`,
    );
  });

  test('5. model multi-type save + out-of-set rejection (400)', async () => {
    const tok = await orgAdmin('o1');
    const pkId = await builtinId('o1', 'openai');

    // Save a model with a multi-type set → 200.
    const okRes = await app.request('/admin/models', {
      method: 'POST',
      headers: { authorization: `Bearer ${tok}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        orgId: 'o1', providerKeyId: pkId, provider: 'openai',
        model: 'acceptance-multi-type', types: ['chat', 'vision', 'reasoning'],
      }),
    });
    expect(okRes.status).toBe(200);

    // The GET returns the row with that exact types set.
    const listRes = await app.request('/admin/models?orgId=o1', {
      headers: { authorization: `Bearer ${tok}` },
    });
    expect(listRes.status).toBe(200);
    const rows = (await listRes.json()) as Array<{ model: string; types: string[] }>;
    const row = rows.find((r) => r.model === 'acceptance-multi-type');
    expect(row?.types).toEqual(['chat', 'vision', 'reasoning']);
    console.log(
      `check5a: POST types[chat,vision,reasoning] → ${okRes.status}; GET returns types=${JSON.stringify(row?.types)}`,
    );

    // An out-of-set type is rejected with 400.
    const badRes = await app.request('/admin/models', {
      method: 'POST',
      headers: { authorization: `Bearer ${tok}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        orgId: 'o1', providerKeyId: pkId, provider: 'openai',
        model: 'acceptance-bad-type', types: ['chat', 'bogus'],
      }),
    });
    expect(badRes.status).toBe(400);
    const badBody = (await badRes.json()) as { error: string; field: string };
    expect(badBody.error).toBe('validation_error');
    // zod reports the offending array index (e.g. "types.1").
    expect(badBody.field).toContain('types');
    console.log(`check5b: POST types[chat,bogus] → ${badRes.status} (out-of-set rejected)`);
  });

  test('6. cross-org isolation → 404 (never 409/200/leak)', async () => {
    // A SECOND org, with its own token, targeting a provider-key id owned by o1.
    await testPool.query(`INSERT INTO orgs(id,name) VALUES ('o2','B') ON CONFLICT DO NOTHING`);
    const o2Tok = await orgAdmin('o2', 'u-o2');
    const o1BuiltinId = await builtinId('o1', 'openai');

    // DELETE: the cross-org guard fires before the builtin 409, so a foreign
    // org gets 404 (it cannot even learn the target is a builtin).
    const delRes = await app.request(`/admin/provider-keys/${o1BuiltinId}`, {
      method: 'DELETE',
      headers: { authorization: `Bearer ${o2Tok}` },
    });
    expect(delRes.status).toBe(404);
    expect(await delRes.json()).toEqual({ error: 'provider_not_found' });

    // PATCH: same fail-closed cross-org 404 (no mutation, no leak).
    const patchRes = await app.request(`/admin/provider-keys/${o1BuiltinId}`, {
      method: 'PATCH',
      headers: { authorization: `Bearer ${o2Tok}`, 'content-type': 'application/json' },
      body: JSON.stringify({ label: 'leak' }),
    });
    expect(patchRes.status).toBe(404);

    // Enable/disable: the cross-org guard on these write paths (added in the
    // final-review fix) also fails closed — org A cannot flip `enabled` on
    // org B's row. No body is required; the guard 404s before any mutation.
    const enRes = await app.request(`/admin/provider-keys/${o1BuiltinId}/enable`, {
      method: 'POST',
      headers: { authorization: `Bearer ${o2Tok}` },
    });
    expect(enRes.status).toBe(404);
    expect(await enRes.json()).toEqual({ error: 'provider_not_found' });
    const disRes = await app.request(`/admin/provider-keys/${o1BuiltinId}/disable`, {
      method: 'POST',
      headers: { authorization: `Bearer ${o2Tok}` },
    });
    expect(disRes.status).toBe(404);
    console.log(
      `check6: o2 DELETE/PATCH/enable/disable o1 builtin → ${delRes.status}/${patchRes.status}/${enRes.status}/${disRes.status} (all 404, never 409/200)`,
    );
  });

  test('7. model PATCH types round-trip + legacy type mapping + non-array rejection (400)', async () => {
    const tok = await orgAdmin('o1');
    // Look up a real model id from the seeded built-ins (beforeEach).
    const model = (await testPool.query<{ id: string; model: string }>(
      `SELECT id, model FROM model_catalog WHERE org_id='o1' LIMIT 1`,
    )).rows[0];

    // The EDIT path stores `types` and writes the legacy `type` via the
    // mapping (asr/tts both map to the legacy 'audio').
    const patchRes = await app.request(`/admin/models/${model.id}?orgId=o1`, {
      method: 'PATCH',
      headers: { authorization: `Bearer ${tok}`, 'content-type': 'application/json' },
      body: JSON.stringify({ types: ['asr', 'tts'] }),
    });
    expect(patchRes.status).toBe(200);

    // The GET returns the row with the exact types set + the mapped legacy type.
    const listRes = await app.request('/admin/models?orgId=o1', {
      headers: { authorization: `Bearer ${tok}` },
    });
    expect(listRes.status).toBe(200);
    const rows = (await listRes.json()) as Array<{ id: string; model: string; type: string; types: string[] }>;
    const row = rows.find((r) => r.id === model.id);
    expect(row?.types).toEqual(['asr', 'tts']);
    expect(row?.type).toBe('audio');
    console.log(
      `check7a: PATCH types[asr,tts] → ${patchRes.status}; GET returns types=${JSON.stringify(row?.types)}, type=${row?.type} (legacy mapping)`,
    );

    // A non-array `types` (a string, NOT an array) is a 400, not a 500
    // (pins the route-level Array.isArray guard).
    const badRes = await app.request(`/admin/models/${model.id}?orgId=o1`, {
      method: 'PATCH',
      headers: { authorization: `Bearer ${tok}`, 'content-type': 'application/json' },
      body: JSON.stringify({ types: 'bogus' }),
    });
    expect(badRes.status).toBe(400);
    const badBody = (await badRes.json()) as { error: string; field: string };
    expect(badBody).toEqual({ error: 'validation_error', field: 'types' });
    console.log(`check7b: PATCH types:'bogus' (string) → ${badRes.status} ${JSON.stringify(badBody)}`);
  });

  test('8. cross-tenant orgId mismatch → 400 (read/create routes cannot query a foreign org)', async () => {
    // A caller whose token is for org o2 must not be able to read (or create
    // into) org o1's data via a spoofed orgId. The route guards the
    // client-supplied orgId against the token's claims.orgId → 400 org_mismatch.
    await testPool.query(`INSERT INTO orgs(id,name) VALUES ('o2','B') ON CONFLICT DO NOTHING`);
    const o2Tok = await orgAdmin('o2', 'u-o2');

    // GET provider list for a foreign org → 400 (not a leaked o1 listing).
    const pks = await app.request('/admin/provider-keys?orgId=o1', {
      headers: { authorization: `Bearer ${o2Tok}` },
    });
    expect(pks.status).toBe(400);
    expect(await pks.json()).toEqual({ error: 'org_mismatch' });

    // GET model list for a foreign org → 400 (the read-leak route that is now
    // closed).
    const models = await app.request('/admin/models?orgId=o1', {
      headers: { authorization: `Bearer ${o2Tok}` },
    });
    expect(models.status).toBe(400);
    expect(await models.json()).toEqual({ error: 'org_mismatch' });

    // CREATE a provider key into a foreign org via the body → 400.
    const create = await app.request('/admin/provider-keys', {
      method: 'POST',
      headers: { authorization: `Bearer ${o2Tok}`, 'content-type': 'application/json' },
      body: JSON.stringify({ orgId: 'o1', provider: 'should-not-land' }),
    });
    expect(create.status).toBe(400);
    expect(await create.json()).toEqual({ error: 'org_mismatch' });

    // Nothing was created in o1 as a result of the failed create.
    const landed = await testPool.query<{ n: number }>(
      `SELECT count(*)::int n FROM provider_keys WHERE org_id='o1' AND provider='should-not-land'`,
    );
    expect(landed.rows[0].n).toBe(0);
    console.log(
      `check8: o2 GET/POST o1 data → ${pks.status}/${models.status}/${create.status} (all 400 org_mismatch; no o1 row created)`,
    );
  });
});
