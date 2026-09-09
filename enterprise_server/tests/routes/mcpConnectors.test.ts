// Route tests for the MCP connector admin routes (MCP 连接器管理, Task 4).
// Pins: authz gating (super_admin short-circuit vs a `member` caller 403ing),
// secret masking on the admin wire (masked form + no plaintext leak), the
// validation guards (org_mismatch, sse+oauth, missing_auth_field, dup
// server_key, empty_patch), cross-org isolation (foreign id 404s), the
// enabled toggle, delete, category CRUD + the 20-category cap, org settings,
// and the audit trail shapes written by each mutation.
// Task 16 adds: the real-handshake test route (probeConnector is mocked —
// the real handshake is tested in tests/mcp/handshake.test.ts), the tool
// merge on a connected probe, save-draft (staged, no live effect), publish
// (working copy applied + version row + destructiveAuthSwitch), and rollback.
//
// Auth is JWT-claim-only (requireAuth/requirePermission never look users up),
// and mcp_connectors has no FK to users/departments, so the seed is just two
// org rows.
import '../helpers/setupEnv';

import { beforeEach, describe, expect, test, vi } from 'vitest';

vi.mock('../../src/db/pool', async () => {
  const td = await import('../../src/db/testDb');
  return { pool: td.testPool };
});

// The route test does NOT perform a real MCP handshake (that is Task 15's
// own test file) — probeConnector is mocked so the tool-merge / persistence
// logic is what's under test.
vi.mock('../../src/mcp/handshake', () => ({
  probeConnector: vi.fn(),
}));

import { Hono } from 'hono';

import { signToken } from '../../src/auth/jwt';
import { resetSchema, runMigrations, testPool } from '../../src/db/testDb';
import { probeConnector } from '../../src/mcp/handshake';
import { mcpConnectorsRoutes } from '../../src/routes/mcpConnectors';

const PLAINTEXT_KEY = 'sk-live-1234';
/** '••••' + last 4 of the plaintext (maskConnectorSecrets contract). */
const MASKED_KEY = '••••1234';

const app = new Hono();
app.route('/', mcpConnectorsRoutes);

/** Minimal seed: two orgs. No user or dept rows are required for these
 * assertions (auth is claim-only; the scope-visibility test is Task 6). */
async function seedOrgs(): Promise<void> {
  await testPool.query(`INSERT INTO orgs(id, name) VALUES ('o1', 'T1'), ('o2', 'T2')`);
}

async function superAdminTok(orgId: string): Promise<string> {
  return signToken({ sub: 'admin', orgId, roles: ['super_admin'] });
}

/** The built-in `member` role carries only agent:view + skill:view — no mcp:* points. */
async function memberTok(): Promise<string> {
  return signToken({ sub: 'member', orgId: 'o1', roles: ['member'] });
}

function baseBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    orgId: 'o1',
    serverKey: 'jira-mcp',
    url: 'https://mcp.example.com/jira',
    authMode: 'shared-key',
    authConfig: { apiKey: PLAINTEXT_KEY },
    ...overrides,
  };
}

async function createConnector(tok: string, body: Record<string, unknown>) {
  return app.request('/admin/mcp-connectors', {
    method: 'POST',
    headers: { authorization: `Bearer ${tok}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

async function countConnectors(orgId?: string): Promise<number> {
  const r = await testPool.query<{ n: number }>(
    orgId
      ? `SELECT count(*)::int AS n FROM mcp_connectors WHERE org_id = $1`
      : `SELECT count(*)::int AS n FROM mcp_connectors`,
    orgId ? [orgId] : undefined,
  );
  return r.rows[0].n;
}

/** Raw row for Task-16 assertions (jsonb arrives parsed from pglite). */
interface RawRow {
  version: string;
  name_zh: string | null;
  auth_config: Record<string, unknown>;
  draft: unknown;
  tools: unknown;
  last_test_at: unknown;
  last_test_status: string | null;
  last_latency_ms: number | null;
}

async function getRawRow(id: string): Promise<RawRow> {
  const r = await testPool.query<RawRow>(
    `SELECT version, name_zh, auth_config, draft, tools, last_test_at,
            last_test_status, last_latency_ms
     FROM mcp_connectors WHERE id = $1`,
    [id],
  );
  return r.rows[0];
}

async function postConnector(
  tok: string,
  path: string,
  body: Record<string, unknown> = {},
): Promise<Response> {
  return app.request(path, {
    method: 'POST',
    headers: { authorization: `Bearer ${tok}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

/** A full working copy (save-draft / publish body) for the test connector. */
function workingCopy(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    url: 'https://mcp.example.com/jira',
    version: '2.0.0',
    nameZh: 'V2',
    transport: 'http',
    authMode: 'shared-key',
    authConfig: {}, // blank secret on edit → keep the stored ciphertext
    scope: { allCompany: false, deptIds: [], userIds: [] },
    ...overrides,
  };
}

describe('mcp connector admin routes', () => {
  beforeEach(async () => {
    await resetSchema();
    await runMigrations();
  });

  test('create: 201 {id}; list + detail reflect the row; secret is masked; no plaintext leaks; audit row written', async () => {
    await seedOrgs();
    const tok = await superAdminTok('o1');

    const res = await createConnector(tok, baseBody());
    expect(res.status).toBe(201);
    const created = (await res.json()) as { id: string };
    expect(typeof created.id).toBe('string');
    expect(created.id.length).toBeGreaterThan(0);

    // The list reflects the created connector (masked like the detail).
    const listRes = await app.request('/admin/mcp-connectors?orgId=o1', {
      headers: { authorization: `Bearer ${tok}` },
    });
    expect(listRes.status).toBe(200);
    const list = (await listRes.json()) as Array<Record<string, unknown>>;
    expect(list).toHaveLength(1);
    expect(list[0].id).toBe(created.id);
    expect(list[0].serverKey).toBe('jira-mcp');
    expect(JSON.stringify(list)).not.toContain(PLAINTEXT_KEY);

    // The detail masks the secret and never echoes the plaintext.
    const detailRes = await app.request(`/admin/mcp-connectors/${created.id}`, {
      headers: { authorization: `Bearer ${tok}` },
    });
    expect(detailRes.status).toBe(200);
    const detail = (await detailRes.json()) as {
      serverKey: string;
      version: string;
      transport: string;
      enabled: boolean;
      scopeSummary: string;
      hasDraft: boolean;
      draft: Record<string, unknown> | null;
      authConfig: Record<string, unknown>;
    };
    expect(detail.serverKey).toBe('jira-mcp');
    expect(detail.version).toBe('1.0.0'); // schema default
    expect(detail.transport).toBe('http'); // schema default
    expect(detail.enabled).toBe(true);
    expect(detail.scopeSummary).toBe('none');
    expect(detail.hasDraft).toBe(false);
    expect(detail.draft).toBeNull(); // no draft staged yet
    expect(detail.authConfig.apiKey).toBe(MASKED_KEY);
    expect(String(detail.authConfig.apiKey)).toMatch(/^••••/);
    expect(detail.authConfig).not.toHaveProperty('__enc__apiKey');
    expect(JSON.stringify(detail)).not.toContain(PLAINTEXT_KEY);

    // Create audit: payload is {serverKey, authMode} (NOT {before, after}).
    const audit = await testPool.query<{ payload: unknown; user_id: string | null; target_id: string | null }>(
      `SELECT payload, user_id, target_id FROM audit_events
       WHERE action = 'mcp_connector_create' AND target_type = 'connector'`,
    );
    expect(audit.rowCount).toBe(1);
    expect(audit.rows[0].target_id).toBe(created.id);
    expect(audit.rows[0].user_id).toBe('admin');
    expect(audit.rows[0].payload).toEqual({ serverKey: 'jira-mcp', authMode: 'shared-key' });
  });

  test('duplicate server_key in the same org → 409 server_key_taken', async () => {
    await seedOrgs();
    const tok = await superAdminTok('o1');
    expect((await createConnector(tok, baseBody())).status).toBe(201);
    const dup = await createConnector(tok, baseBody({ url: 'https://other.example.com' }));
    expect(dup.status).toBe(409);
    expect(await dup.json()).toEqual({ error: 'server_key_taken' });
    expect(await countConnectors('o1')).toBe(1);
  });

  test('sse transport + an oauth-family auth mode → 400 sse_oauth_not_supported, nothing written', async () => {
    await seedOrgs();
    const tok = await superAdminTok('o1');
    for (const authMode of ['user-oauth', 'client-creds', 'sso']) {
      const res = await createConnector(tok, baseBody({
        serverKey: `sse-${authMode}`,
        transport: 'sse',
        authMode,
        authConfig: { clientId: 'cid', clientSecret: 'cs' },
      }));
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: 'sse_oauth_not_supported' });
    }
    expect(await countConnectors('o1')).toBe(0);
  });

  test('missing per-mode secret → 400 missing_auth_field with the field name; authMode none needs no secret', async () => {
    await seedOrgs();
    const tok = await superAdminTok('o1');

    const sk = await createConnector(tok, baseBody({ authConfig: {} }));
    expect(sk.status).toBe(400);
    expect(await sk.json()).toEqual({ error: 'missing_auth_field', field: 'apiKey' });

    const cc = await createConnector(tok, baseBody({
      serverKey: 'cc-mcp',
      authMode: 'client-creds',
      authConfig: { clientSecret: 's' },
    }));
    expect(cc.status).toBe(400);
    expect(await cc.json()).toEqual({ error: 'missing_auth_field', field: 'clientId' });

    // 'none' has no admin-filled secret requirement, so it passes the guard.
    const none = await createConnector(tok, baseBody({ serverKey: 'open-mcp', authMode: 'none', authConfig: {} }));
    expect(none.status).toBe(201);
  });

  test('user-oauth public-client form (authorizeUrl+tokenUrl+clientId, no secret) passes the guard; confidential form (no endpoints) still needs clientSecret', async () => {
    await seedOrgs();
    const tok = await superAdminTok('o1');

    // Public client + PKCE: no secret, but complete endpoints → accepted.
    const pub = await createConnector(tok, baseBody({
      serverKey: 'fxsk-oauth',
      authMode: 'user-oauth',
      authConfig: {
        clientId: 'public-cid',
        authorizeUrl: 'https://idp.example.com/oauth/authorize',
        tokenUrl: 'https://idp.example.com/oauth/token',
      },
    }));
    expect(pub.status).toBe(201);

    // user-oauth with endpoints but no clientId → still needs clientId.
    const noCid = await createConnector(tok, baseBody({
      serverKey: 'fxsk-no-cid',
      authMode: 'user-oauth',
      authConfig: {
        authorizeUrl: 'https://idp.example.com/oauth/authorize',
        tokenUrl: 'https://idp.example.com/oauth/token',
      },
    }));
    expect(noCid.status).toBe(400);
    expect(await noCid.json()).toEqual({ error: 'missing_auth_field', field: 'clientId' });

    // user-oauth WITHOUT endpoints → confidential-client path → needs clientSecret.
    const noEndpoints = await createConnector(tok, baseBody({
      serverKey: 'fxsk-no-endpoints',
      authMode: 'user-oauth',
      authConfig: { clientId: 'cid' },
    }));
    expect(noEndpoints.status).toBe(400);
    expect(await noEndpoints.json()).toEqual({ error: 'missing_auth_field', field: 'clientSecret' });
  });

  test('sso public-client form (ssoClientId + sso endpoints, no secret) passes the guard; missing endpoints → ssoTokenUrl', async () => {
    await seedOrgs();
    const tok = await superAdminTok('o1');

    // Public client + PKCE: ssoClientId + complete sso endpoints → accepted.
    const pub = await createConnector(tok, baseBody({
      serverKey: 'sso-feishu',
      authMode: 'sso',
      authConfig: {
        ssoApp: 'feishu',
        ssoClientId: 'sso-cid',
        ssoAuthorizeUrl: 'https://idp.example.com/sso/authorize',
        ssoTokenUrl: 'https://idp.example.com/sso/token',
      },
    }));
    expect(pub.status).toBe(201);

    // sso with endpoints but no clientId → needs ssoClientId.
    const noCid = await createConnector(tok, baseBody({
      serverKey: 'sso-no-cid',
      authMode: 'sso',
      authConfig: {
        ssoApp: 'feishu',
        ssoAuthorizeUrl: 'https://idp.example.com/sso/authorize',
        ssoTokenUrl: 'https://idp.example.com/sso/token',
      },
    }));
    expect(noCid.status).toBe(400);
    expect(await noCid.json()).toEqual({ error: 'missing_auth_field', field: 'ssoClientId' });

    // sso with clientId but incomplete endpoints → needs the token endpoint.
    const noToken = await createConnector(tok, baseBody({
      serverKey: 'sso-no-token',
      authMode: 'sso',
      authConfig: {
        ssoApp: 'feishu',
        ssoClientId: 'sso-cid',
        ssoAuthorizeUrl: 'https://idp.example.com/sso/authorize',
      },
    }));
    expect(noToken.status).toBe(400);
    expect(await noToken.json()).toEqual({ error: 'missing_auth_field', field: 'ssoTokenUrl' });
  });

  test('create with a body orgId that does not match the token → 400 org_mismatch', async () => {
    await seedOrgs();
    const tok = await superAdminTok('o1');
    const res = await createConnector(tok, baseBody({ orgId: 'o2' }));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'org_mismatch' });
  });

  test('cross-org: an o2 admin gets 404 on an o1 connector id and 400 org_mismatch listing o1; o1 row untouched', async () => {
    await seedOrgs();
    const o1Tok = await superAdminTok('o1');
    const o2Tok = await superAdminTok('o2');
    const created = (await (await createConnector(o1Tok, baseBody())).json()) as { id: string };

    const detail = await app.request(`/admin/mcp-connectors/${created.id}`, {
      headers: { authorization: `Bearer ${o2Tok}` },
    });
    expect(detail.status).toBe(404);
    expect(await detail.json()).toEqual({ error: 'not_found' });

    const list = await app.request('/admin/mcp-connectors?orgId=o1', {
      headers: { authorization: `Bearer ${o2Tok}` },
    });
    expect(list.status).toBe(400);
    expect(await list.json()).toEqual({ error: 'org_mismatch' });

    // Writes are cross-org guarded too.
    const patch = await app.request(`/admin/mcp-connectors/${created.id}`, {
      method: 'PATCH',
      headers: { authorization: `Bearer ${o2Tok}`, 'content-type': 'application/json' },
      body: JSON.stringify({ enabled: false }),
    });
    expect(patch.status).toBe(404);
    const del = await app.request(`/admin/mcp-connectors/${created.id}`, {
      method: 'DELETE',
      headers: { authorization: `Bearer ${o2Tok}` },
    });
    expect(del.status).toBe(404);

    const still = await app.request(`/admin/mcp-connectors/${created.id}`, {
      headers: { authorization: `Bearer ${o1Tok}` },
    });
    expect(still.status).toBe(200);
  });

  test('PATCH enabled:false → 200 and the list reflects it; update audit is {fields, secretRotated}; empty patch → 400', async () => {
    await seedOrgs();
    const tok = await superAdminTok('o1');
    const created = (await (await createConnector(tok, baseBody())).json()) as { id: string };

    const patch = await app.request(`/admin/mcp-connectors/${created.id}`, {
      method: 'PATCH',
      headers: { authorization: `Bearer ${tok}`, 'content-type': 'application/json' },
      body: JSON.stringify({ enabled: false }),
    });
    expect(patch.status).toBe(200);
    expect(await patch.json()).toEqual({ ok: true });

    const listRes = await app.request('/admin/mcp-connectors?orgId=o1', {
      headers: { authorization: `Bearer ${tok}` },
    });
    const list = (await listRes.json()) as Array<{ enabled: boolean }>;
    expect(list).toHaveLength(1);
    expect(list[0].enabled).toBe(false);

    // Update audit payload shape: { fields, secretRotated } — changed keys only.
    const upd = await testPool.query<{ payload: unknown }>(
      `SELECT payload FROM audit_events
       WHERE action = 'mcp_connector_update' AND target_type = 'connector' AND target_id = $1`,
      [created.id],
    );
    expect(upd.rowCount).toBe(1);
    expect(upd.rows[0].payload).toEqual({ fields: { enabled: false }, secretRotated: false });

    // The toggle also writes its own audit row.
    const tog = await testPool.query<{ payload: unknown }>(
      `SELECT payload FROM audit_events WHERE action = 'mcp_connector_toggle' AND target_id = $1`,
      [created.id],
    );
    expect(tog.rowCount).toBe(1);
    expect(tog.rows[0].payload).toEqual({ serverKey: 'jira-mcp', enabled: false });

    const empty = await app.request(`/admin/mcp-connectors/${created.id}`, {
      method: 'PATCH',
      headers: { authorization: `Bearer ${tok}`, 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(empty.status).toBe(400);
    expect(await empty.json()).toEqual({ error: 'empty_patch' });
  });

  test('DELETE → 200 {ok, impact}; the detail then 404s and the row is gone', async () => {
    await seedOrgs();
    const tok = await superAdminTok('o1');
    const created = (await (await createConnector(tok, baseBody())).json()) as { id: string };

    const del = await app.request(`/admin/mcp-connectors/${created.id}`, {
      method: 'DELETE',
      headers: { authorization: `Bearer ${tok}` },
    });
    expect(del.status).toBe(200);
    expect(await del.json()).toEqual({ ok: true, impact: { scopeSummary: 'none', draftRemoved: false } });

    const detail = await app.request(`/admin/mcp-connectors/${created.id}`, {
      headers: { authorization: `Bearer ${tok}` },
    });
    expect(detail.status).toBe(404);
    expect(await countConnectors('o1')).toBe(0);
  });

  test('categories: static route wins over /:id; create 201; dup name 409; the 21st → 409 category_cap', async () => {
    await seedOrgs();
    const tok = await superAdminTok('o1');
    const hdrs = { authorization: `Bearer ${tok}`, 'content-type': 'application/json' };
    const url = '/admin/mcp-connectors/categories?orgId=o1';

    // The static /categories segment must beat the /:id pattern — if it lost,
    // this would 404 as "connector id 'categories'".
    const emptyList = await app.request(url, { headers: { authorization: `Bearer ${tok}` } });
    expect(emptyList.status).toBe(200);
    expect(await emptyList.json()).toEqual([]);

    const first = await app.request(url, { method: 'POST', headers: hdrs, body: JSON.stringify({ name: 'Dev' }) });
    expect(first.status).toBe(201);
    const firstId = ((await first.json()) as { id: string }).id;
    expect(firstId.length).toBeGreaterThan(0);

    const dup = await app.request(url, { method: 'POST', headers: hdrs, body: JSON.stringify({ name: 'Dev' }) });
    expect(dup.status).toBe(409);
    expect(await dup.json()).toEqual({ error: 'category_name_taken' });

    // Fill the org up to the cap (20 total).
    for (let i = 2; i <= 20; i++) {
      const r = await app.request(url, {
        method: 'POST',
        headers: hdrs,
        body: JSON.stringify({ name: `cat-${String(i).padStart(2, '0')}` }),
      });
      expect(r.status).toBe(201);
    }

    const over = await app.request(url, { method: 'POST', headers: hdrs, body: JSON.stringify({ name: 'cat-21' }) });
    expect(over.status).toBe(409);
    expect(await over.json()).toEqual({ error: 'category_cap' });

    const list = (await (await app.request(url, { headers: { authorization: `Bearer ${tok}` } })).json()) as Array<{ id: string }>;
    expect(list).toHaveLength(20);
    expect(list.some((c) => c.id === firstId)).toBe(true);
  });

  test('categories: PUT renames; DELETE un-categorizes the org\'s connectors', async () => {
    await seedOrgs();
    const tok = await superAdminTok('o1');
    const hdrs = { authorization: `Bearer ${tok}`, 'content-type': 'application/json' };
    const url = '/admin/mcp-connectors/categories?orgId=o1';

    const cat = (await (await app.request(url, {
      method: 'POST',
      headers: hdrs,
      body: JSON.stringify({ name: 'Data' }),
    })).json()) as { id: string };

    const created = (await (await createConnector(tok, baseBody({ categoryId: cat.id }))).json()) as { id: string };
    expect(created.id.length).toBeGreaterThan(0);

    const rename = await app.request(`/admin/mcp-connectors/categories/${cat.id}?orgId=o1`, {
      method: 'PUT',
      headers: hdrs,
      body: JSON.stringify({ name: 'Data & Tools' }),
    });
    expect(rename.status).toBe(200);
    expect(await rename.json()).toEqual({ ok: true });
    // The wire shape is {id, name}; renaming keeps the same row id.
    const names = (await (await app.request(url, { headers: { authorization: `Bearer ${tok}` } })).json()) as Array<{ id: string; name: string }>;
    expect(names).toEqual([{ id: cat.id, name: 'Data & Tools' }]);

    const del = await app.request(`/admin/mcp-connectors/categories/${cat.id}?orgId=o1`, {
      method: 'DELETE',
      headers: { authorization: `Bearer ${tok}` },
    });
    expect(del.status).toBe(200);
    expect(await del.json()).toEqual({ ok: true });

    // Migrate-on-delete: the connector's category_id is cleared, not the connector.
    const list = (await (await app.request('/admin/mcp-connectors?orgId=o1', {
      headers: { authorization: `Bearer ${tok}` },
    })).json()) as Array<{ categoryId: string | null }>;
    expect(list).toHaveLength(1);
    expect(list[0].categoryId).toBe(null);

    const delAgain = await app.request(`/admin/mcp-connectors/categories/${cat.id}?orgId=o1`, {
      method: 'DELETE',
      headers: { authorization: `Bearer ${tok}` },
    });
    expect(delAgain.status).toBe(404);
  });

  test('settings: default true; PATCH false → 200; GET false; audit payload is {before, after}', async () => {
    await seedOrgs();
    const tok = await superAdminTok('o1');
    const hdrs = { authorization: `Bearer ${tok}`, 'content-type': 'application/json' };
    const url = '/admin/mcp-connectors/settings?orgId=o1';

    const before = await app.request(url, { headers: { authorization: `Bearer ${tok}` } });
    expect(before.status).toBe(200);
    expect(await before.json()).toEqual({ membersCanSubmit: true });

    const patch = await app.request(url, { method: 'PATCH', headers: hdrs, body: JSON.stringify({ membersCanSubmit: false }) });
    expect(patch.status).toBe(200);
    expect(await patch.json()).toEqual({ ok: true, membersCanSubmit: false });

    const after = await app.request(url, { headers: { authorization: `Bearer ${tok}` } });
    expect(after.status).toBe(200);
    expect(await after.json()).toEqual({ membersCanSubmit: false });

    const audit = await testPool.query<{ payload: unknown }>(
      `SELECT payload FROM audit_events WHERE action = 'mcp_connector_setting_update' AND org_id = 'o1'`,
    );
    expect(audit.rowCount).toBe(1);
    expect(audit.rows[0].payload).toEqual({ before: true, after: false });
  });

  test('authz: a caller without mcp points (member role) → 403 on POST and GET; no token → 401', async () => {
    await seedOrgs();
    const tok = await memberTok();

    const post = await app.request('/admin/mcp-connectors', {
      method: 'POST',
      headers: { authorization: `Bearer ${tok}`, 'content-type': 'application/json' },
      body: JSON.stringify(baseBody()),
    });
    expect(post.status).toBe(403);
    expect(await post.json()).toEqual({ error: 'forbidden' });
    // The gate must reject before anything is written.
    expect(await countConnectors()).toBe(0);

    const list = await app.request('/admin/mcp-connectors?orgId=o1', {
      headers: { authorization: `Bearer ${tok}` },
    });
    expect(list.status).toBe(403);

    const anon = await app.request('/admin/mcp-connectors?orgId=o1');
    expect(anon.status).toBe(401);
    expect(await anon.json()).toEqual({ error: 'unauthorized' });
  });

  test('POST /:id/test (mocked handshake) merges tools: new→enabled, server-absent→removed, existing toggle kept; persists last_test_*', async () => {
    await seedOrgs();
    const tok = await superAdminTok('o1');
    const created = (await (await createConnector(tok, baseBody())).json()) as { id: string };

    // Pre-seed two known tools: one the server still lists, one it dropped.
    await testPool.query(
      `UPDATE mcp_connectors SET tools = $1 WHERE id = $2`,
      [
        JSON.stringify([
          { name: 'survivor', desc: 'Old desc', enabled: true, syncedAt: '2026-01-01T00:00:00.000Z' },
          { name: 'gone', desc: 'Gone tool', enabled: false },
        ]),
        created.id,
      ],
    );

    const probe = vi.mocked(probeConnector);
    probe.mockResolvedValue({
      ok: true,
      status: 'connected',
      tools: [
        { name: 'survivor', desc: 'New desc', enabled: true },
        { name: 'fresh', desc: 'Fresh tool', enabled: true },
      ],
      latencyMs: 42,
    });

    const res = await postConnector(tok, `/admin/mcp-connectors/${created.id}/test`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.status).toBe('connected');
    expect(body.latencyMs).toBe(42);
    expect(body.toolCount).toBe(2); // survivor + fresh (gone is removed)
    expect(typeof body.lastTestAt).toBe('string');

    // The route built the bearer header from the decrypted stored secret.
    expect(probe).toHaveBeenCalledTimes(1);
    const args = probe.mock.calls[0][0];
    expect(args.url).toBe('https://mcp.example.com/jira');
    expect(args.headers).toEqual({ Authorization: `Bearer ${PLAINTEXT_KEY}` });

    // The persisted merge.
    const row = await getRawRow(created.id);
    const tools = row.tools as Array<{
      name: string;
      desc?: string;
      enabled: boolean;
      removed?: boolean;
      syncedAt?: string;
    }>;
    const byName = Object.fromEntries(tools.map((t) => [t.name, t]));
    expect(byName.fresh.enabled).toBe(true); // new tool → enabled
    expect(byName.fresh.removed).toBeUndefined();
    expect(byName.survivor.enabled).toBe(true); // existing toggle kept
    expect(byName.survivor.desc).toBe('New desc'); // desc refreshed
    expect(byName.survivor.removed).toBe(false);
    expect(byName.gone.removed).toBe(true); // server-absent → removed
    expect(byName.gone.enabled).toBe(false); // its toggle is kept
    expect(row.last_test_status).toBe('connected');
    expect(row.last_latency_ms).toBe(42);
    expect(row.last_test_at).toBeTruthy();
  });

  test('POST /:id/test failure is a resolved result (tools untouched, last_test_status=failed)', async () => {
    await seedOrgs();
    const tok = await superAdminTok('o1');
    const created = (await (await createConnector(tok, baseBody())).json()) as { id: string };
    await testPool.query(
      `UPDATE mcp_connectors SET tools = $1 WHERE id = $2`,
      [JSON.stringify([{ name: 'keep', enabled: true }]), created.id],
    );

    vi.mocked(probeConnector).mockResolvedValue({
      ok: false,
      status: 'failed',
      error: 'unauthorized',
      latencyMs: 7,
    });

    const res = await postConnector(tok, `/admin/mcp-connectors/${created.id}/test`);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ status: 'failed', error: 'unauthorized', latencyMs: 7 });

    const row = await getRawRow(created.id);
    expect(row.last_test_status).toBe('failed');
    expect(row.last_latency_ms).toBe(7);
    expect(row.tools).toEqual([{ name: 'keep', enabled: true }]); // untouched
  });

  test('POST /:id/save-draft stages the working copy (encrypted authConfig) without touching the live fields', async () => {
    await seedOrgs();
    const tok = await superAdminTok('o1');
    const created = (await (await createConnector(tok, baseBody())).json()) as { id: string };

    const res = await postConnector(tok, `/admin/mcp-connectors/${created.id}/save-draft`, workingCopy({
      url: 'https://mcp.example.com/jira-v2',
      nameZh: '草稿名',
    }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });

    const row = await getRawRow(created.id);
    expect(row.version).toBe('1.0.0'); // live version unchanged
    expect(row.name_zh).toBe(null); // live name unchanged

    const draft = row.draft as Record<string, unknown>;
    expect(draft).not.toBeNull();
    expect(draft.version).toBe('2.0.0');
    expect(draft.nameZh).toBe('草稿名');
    expect(draft.url).toBe('https://mcp.example.com/jira-v2');
    // The draft's authConfig never carries the plaintext — the stored
    // ciphertext is kept (blank-on-edit).
    const draftAuth = draft.authConfig as Record<string, unknown>;
    expect(typeof draftAuth['__enc__apiKey']).toBe('string');
    expect(JSON.stringify(draftAuth)).not.toContain(PLAINTEXT_KEY);

    // The detail route exposes the staged draft, MASKED: non-secret fields
    // match what save-draft stored, the secret is in masked form, and no
    // `__enc__` key or plaintext ever reaches the wire.
    const detailRes = await app.request(`/admin/mcp-connectors/${created.id}`, {
      headers: { authorization: `Bearer ${tok}` },
    });
    expect(detailRes.status).toBe(200);
    const detail = (await detailRes.json()) as { hasDraft: boolean; draft: Record<string, unknown> | null };
    expect(detail.hasDraft).toBe(true);
    expect(detail.draft).not.toBeNull();
    const wireDraft = detail.draft as Record<string, unknown>;
    expect(wireDraft.url).toBe('https://mcp.example.com/jira-v2');
    expect(wireDraft.version).toBe('2.0.0');
    expect(wireDraft.nameZh).toBe('草稿名');
    expect(wireDraft.authMode).toBe('shared-key');
    const wireAuth = wireDraft.authConfig as Record<string, unknown>;
    expect(wireAuth.apiKey).toBe(MASKED_KEY);
    expect(String(wireAuth.apiKey)).toMatch(/^••••/);
    expect(wireAuth).not.toHaveProperty('__enc__apiKey');
    expect(JSON.stringify(wireAuth)).not.toContain(PLAINTEXT_KEY);
    expect(JSON.stringify(wireDraft)).not.toContain(PLAINTEXT_KEY);
  });

  test('POST /:id/publish with a genuinely missing secret → 400 missing_auth_field (guard runs on the decrypted merged view)', async () => {
    // A `none`-auth connector has no stored secret. Publishing it as
    // shared-key with a blank authConfig has no secret to fall back to, so
    // the guard (run against the decrypted merged config) must 400 — the
    // publish-path analogue of the create-path missing_secret test.
    await seedOrgs();
    const tok = await superAdminTok('o1');
    const created = (await (await createConnector(tok, {
      orgId: 'o1',
      serverKey: 'jira-noauth',
      url: 'https://mcp.example.com/jira',
      authMode: 'none',
      authConfig: {},
    })).json()) as { id: string };

    const res = await postConnector(tok, `/admin/mcp-connectors/${created.id}/publish`, {
      url: 'https://mcp.example.com/jira',
      version: '2.0.0',
      transport: 'http',
      authMode: 'shared-key',
      authConfig: {},
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'missing_auth_field', field: 'apiKey' });
    // Nothing applied: the live row is still `none` with no version bump.
    const row = await getRawRow(created.id);
    expect(row.version).toBe('1.0.0');
    const mode = await testPool.query<{ auth_mode: string }>(
      'SELECT auth_mode FROM mcp_connectors WHERE id = $1',
      [created.id],
    );
    expect(mode.rows[0].auth_mode).toBe('none');
  });

  test('POST /:id/publish applies the working copy, clears the draft, records a current version row (ciphertext only); an auth-mode change flags destructiveAuthSwitch', async () => {
    await seedOrgs();
    const tok = await superAdminTok('o1');
    const created = (await (await createConnector(tok, baseBody())).json()) as { id: string };

    const copy = workingCopy({
      tools: [{ name: 't1', enabled: true }, { name: 't2', enabled: false }],
    });

    // Stage a draft, then publish the same working copy (version bump).
    expect((await postConnector(tok, `/admin/mcp-connectors/${created.id}/save-draft`, copy)).status).toBe(200);
    const pub = await postConnector(tok, `/admin/mcp-connectors/${created.id}/publish`, copy);
    expect(pub.status).toBe(200);
    // No auth change → no destructiveAuthSwitch flag at all.
    expect(await pub.json()).toEqual({ ok: true, version: '2.0.0' });

    const row = await getRawRow(created.id);
    expect(row.version).toBe('2.0.0');
    expect(row.name_zh).toBe('V2');
    expect(row.draft).toBeNull();
    const liveTools = row.tools as Array<{ name: string; enabled: boolean }>;
    expect(liveTools).toEqual(
      expect.arrayContaining([
        { name: 't1', enabled: true },
        { name: 't2', enabled: false },
      ]),
    );

    // A current version row exists; its config snapshot is ciphertext only.
    const vrows = await testPool.query<{ version: string; current: boolean; config: unknown }>(
      `SELECT version, current, config FROM mcp_connector_versions WHERE connector_id = $1`,
      [created.id],
    );
    expect(vrows.rowCount).toBe(1);
    expect(vrows.rows[0].version).toBe('2.0.0');
    expect(vrows.rows[0].current).toBe(true);
    expect(JSON.stringify(vrows.rows[0].config)).not.toContain(PLAINTEXT_KEY);
    const cfg = vrows.rows[0].config as Record<string, unknown>;
    expect(cfg.version).toBe('2.0.0');
    expect(cfg.nameZh).toBe('V2');
    expect(typeof (cfg.authConfig as Record<string, unknown>)['__enc__apiKey']).toBe('string');

    // The live auth_config is ciphertext too (no plaintext anywhere).
    expect(typeof row.auth_config['__enc__apiKey']).toBe('string');
    expect(JSON.stringify(row.auth_config)).not.toContain(PLAINTEXT_KEY);

    // The detail now exposes the versions list.
    const detail = (await (await app.request(`/admin/mcp-connectors/${created.id}`, {
      headers: { authorization: `Bearer ${tok}` },
    })).json()) as { versions: Array<{ version: string; current: boolean }> };
    expect(detail.versions).toHaveLength(1);
    expect(detail.versions[0].version).toBe('2.0.0');
    expect(detail.versions[0].current).toBe(true);

    // Publishing a changed auth mode on a connector with a stored secret flags it.
    const pub2 = await postConnector(tok, `/admin/mcp-connectors/${created.id}/publish`, {
      ...copy,
      authMode: 'none',
    });
    expect(pub2.status).toBe(200);
    const body2 = (await pub2.json()) as Record<string, unknown>;
    expect(body2.ok).toBe(true);
    expect(body2.version).toBe('2.0.0'); // unchanged version → no new version row
    expect(body2.destructiveAuthSwitch).toBe(true);
    const after = await testPool.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM mcp_connector_versions WHERE connector_id = $1`,
      [created.id],
    );
    expect(after.rows[0].n).toBe(1);
  });

  test('POST /:id/rollback restores the target snapshot, flips current, writes a rollback row; an unknown version 404s', async () => {
    await seedOrgs();
    const tok = await superAdminTok('o1');
    const created = (await (await createConnector(tok, baseBody())).json()) as { id: string };

    // Publish v2, then v3 (two version rows; v3 is current).
    for (const v of [workingCopy(), workingCopy({ version: '3.0.0', nameZh: 'V3' })]) {
      const pub = await postConnector(tok, `/admin/mcp-connectors/${created.id}/publish`, v);
      expect(pub.status).toBe(200);
    }

    const missing = await postConnector(tok, `/admin/mcp-connectors/${created.id}/rollback`, {
      version: '9.9.9',
    });
    expect(missing.status).toBe(404);
    expect(await missing.json()).toEqual({ error: 'version_not_found' });

    const res = await postConnector(tok, `/admin/mcp-connectors/${created.id}/rollback`, {
      version: '2.0.0',
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, version: '2.0.0' });

    // The live row matches the v2 snapshot.
    const row = await getRawRow(created.id);
    expect(row.version).toBe('2.0.0');
    expect(row.name_zh).toBe('V2');
    expect(typeof row.auth_config['__enc__apiKey']).toBe('string');
    expect(JSON.stringify(row.auth_config)).not.toContain(PLAINTEXT_KEY);

    // v2 + v3 + the new rollback row; the rollback row's note carries the
    // target version, current is flipped (v3 no longer current).
    const rows = await testPool.query<{ version: string; note: string | null; current: boolean; config: unknown }>(
      `SELECT version, note, current, config FROM mcp_connector_versions
       WHERE connector_id = $1 ORDER BY created_at DESC, id DESC`,
      [created.id],
    );
    expect(rows.rowCount).toBe(3);
    const v2rows = rows.rows.filter((r) => r.version === '2.0.0');
    expect(v2rows.length).toBe(2); // original + rollback row
    const rollbackRow = v2rows.find((r) => r.note !== null && r.note.includes('2.0.0'));
    expect(rollbackRow, 'the rollback row for v2').toBeDefined();
    // The rollback row is an AUDIT record (note carries the target version),
    // NOT the live-state marker: the restored target row is `current`, so the
    // rollback row must not be — the at-most-one-current invariant the publish
    // path maintains.
    expect(rollbackRow?.current).toBe(false);
    expect(JSON.stringify(rollbackRow?.config)).not.toContain(PLAINTEXT_KEY);
    expect((rollbackRow?.config as Record<string, unknown>).nameZh).toBe('V2');
    // The ORIGINAL v2 row (note null, from the v2 publish) is the sole marker.
    const targetRow = v2rows.find((r) => r.note === null);
    expect(targetRow?.current).toBe(true);
    // At-most-one-current: exactly one current row across all versions.
    expect(rows.rows.filter((r) => r.current).length).toBe(1);
    expect(rows.rows.find((r) => r.version === '3.0.0')?.current).toBe(false);
  });

  test('draft/publish/rollback/test are cross-org guarded (a foreign id 404s; nothing written)', async () => {
    await seedOrgs();
    const o1Tok = await superAdminTok('o1');
    const o2Tok = await superAdminTok('o2');
    const created = (await (await createConnector(o1Tok, baseBody())).json()) as { id: string };

    for (const path of ['/save-draft', '/publish', '/rollback', '/test']) {
      const res = await postConnector(o2Tok, `/admin/mcp-connectors/${created.id}${path}`, {
        version: '1',
        url: 'https://mcp.example.com/jira',
      });
      expect(res.status).toBe(404);
      expect(await res.json()).toEqual({ error: 'not_found' });
    }
    // The o1 row is untouched (no draft written by the foreign attempts).
    const row = await getRawRow(created.id);
    expect(row.draft).toBeNull();
  });
});
