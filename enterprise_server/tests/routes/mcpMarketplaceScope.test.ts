// Route tests for the re-pointed public `GET /api/mcp-marketplace` (Task 6).
//
// The route now reads `mcp_connectors` (org-scoped, scope-based) instead of the
// retired role-based `mcp_marketplace_servers`. Visibility is: super_admin sees
// every enabled connector; otherwise a connector is visible iff its scope is
// `allCompany`, the caller is a member exception (`userIds`), or the caller's
// OWN (leaf) dept intersects the GRANTED `scope.deptIds` expanded to its
// subtree (grant parent → child sees it). `enabled=false` is never served.
//
// Auth is JWT-claim-only (requireAuth never looks users up), but
// `scopeApi.deptIdsFor` DOES join `user_departments`→`users`, so the seed
// creates real org / department (with `path`) / user / membership rows.
// `mcp_connectors` has no FK to users/departments, so connector rows are
// inserted directly with a JSONB `scope`.
import '../helpers/setupEnv';

import { beforeEach, describe, expect, test, vi } from 'vitest';

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

interface Scope { allCompany: boolean; deptIds: string[]; userIds: string[] }

/** Insert a connector row directly (no FK to users/departments). `scope` is
 * stringified so pglite stores it as JSONB and returns it as an object. */
async function mkConnector(
  id: string,
  serverKey: string,
  scope: Scope,
  opts: { enabled?: boolean; categoryId?: string | null; description?: string | null } = {},
): Promise<void> {
  await testPool.query(
    `INSERT INTO mcp_connectors
       (id, org_id, server_key, name_en, category_id, description, url, enabled, scope)
     VALUES
       ($1, 'o1', $2, $2, $3, $4, 'https://mcp.example.com/$2', $5, $6)`,
    [
      id,
      serverKey,
      opts.categoryId ?? null,
      opts.description ?? `desc-${serverKey}`,
      opts.enabled ?? true,
      JSON.stringify(scope),
    ],
  );
}

/** Minimal org + dept tree + users + memberships.
 * Dept paths drive the subtree expansion:
 *   rd   -> /rd        (parent)
 *   fe   -> /rd/fe     (child of rd)
 *   sales-> /sales     (unrelated) */
async function seed(): Promise<void> {
  await testPool.query(`INSERT INTO orgs(id, name) VALUES ('o1', 'T1')`);
  await testPool.query(
    `INSERT INTO departments(id, org_id, name, parent_id, path) VALUES
       ('rd',    'o1', '研发', NULL, '/rd'),
       ('fe',    'o1', '前端', 'rd',   '/rd/fe'),
       ('sales', 'o1', '销售', NULL,   '/sales')`,
  );
  await testPool.query(
    `INSERT INTO users(id, org_id, username, password_hash, display_name) VALUES
       ('u2',    'o1', 'u2',    'x', 'U2'),
       ('u3',    'o1', 'u3',    'x', 'U3'),
       ('admin', 'o1', 'admin', 'x', 'Admin')`,
  );
  await testPool.query(
    `INSERT INTO user_departments(user_id, dept_id, is_primary) VALUES
       ('u2', 'fe', true),
       ('u3', 'sales', true)`,
  );

  // c-rd: granted to PARENT dept `rd` — the key subtree regression.
  await mkConnector('c-rd', 'rd-tool', { allCompany: false, deptIds: ['rd'], userIds: [] });
  // c-all: whole-company.
  await mkConnector('c-all', 'all-tool', { allCompany: true, deptIds: [], userIds: [] });
  // c-u2: member exception for u2 only.
  await mkConnector('c-u2', 'u2-tool', { allCompany: false, deptIds: [], userIds: ['u2'] });
  // c-sales: granted to a sibling dept — must NOT leak to u2 (in fe/rd).
  await mkConnector('c-sales', 'sales-tool', { allCompany: false, deptIds: ['sales'], userIds: [] });
  // c-disabled: allCompany but disabled — never served to anyone.
  await mkConnector('c-disabled', 'disabled-tool', { allCompany: true, deptIds: [], userIds: [] }, { enabled: false });
}

async function get(tok: string): Promise<{ categories: Array<{ id: string; name_zh: string; name_en: string }>; servers: Array<{ id: string; serverKey: string; category: string }> }> {
  const res = await app.request('/api/mcp-marketplace', {
    headers: { authorization: `Bearer ${tok}` },
  });
  expect(res.status).toBe(200);
  return res.json() as Promise<{ categories: Array<{ id: string; name_zh: string; name_en: string }>; servers: Array<{ id: string; serverKey: string; category: string }> }>;
}

const tok = (sub: string, roles: string[] = ['member']) =>
  signToken({ sub, orgId: 'o1', roles });

describe('GET /api/mcp-marketplace (scope-based, mcp_connectors)', () => {
  beforeEach(async () => {
    await resetSchema();
    await runMigrations();
    await seed();
  });

  test('returns 401 without a token', async () => {
    const res = await app.request('/api/mcp-marketplace');
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'unauthorized' });
  });

  test('a member in fe (under rd) sees the subtree-granted connector (grant rd -> child fe)', async () => {
    // THE key regression: c-rd is granted to the PARENT dept `rd`; a user whose
    // only dept is the CHILD `fe` must still see it.
    const body = await get(await tok('u2'));
    const keys = body.servers.map((s) => s.serverKey).sort();
    // Sees: rd-tool (subtree), all-tool (allCompany), u2-tool (member exception).
    expect(keys).toEqual(['all-tool', 'rd-tool', 'u2-tool']);
  });

  test('a member in fe does NOT see a connector granted to a sibling dept (sales)', async () => {
    const body = await get(await tok('u2'));
    const keys = body.servers.map((s) => s.serverKey);
    expect(keys).not.toContain('sales-tool');
    expect(keys).not.toContain('disabled-tool');
  });

  test('a user whose only dept is sales does NOT see the rd-granted connector', async () => {
    const body = await get(await tok('u3'));
    const keys = body.servers.map((s) => s.serverKey);
    // u3 (in sales) sees sales-tool + all-tool, but NOT rd-tool (fe/rd subtree)
    // nor u2-tool (u2-only exception).
    expect(keys).toEqual(['all-tool', 'sales-tool']);
    expect(keys).not.toContain('rd-tool');
    expect(keys).not.toContain('u2-tool');
  });

  test('super_admin sees every ENABLED connector regardless of scope, never the disabled one', async () => {
    const body = await get(await tok('admin', ['super_admin']));
    const keys = body.servers.map((s) => s.serverKey).sort();
    // Four enabled connectors; c-disabled is excluded even for super_admin.
    expect(keys).toEqual(['all-tool', 'rd-tool', 'sales-tool', 'u2-tool']);
  });

  test('enabled=false connectors never appear for anyone (incl. super_admin)', async () => {
    for (const sub of ['u2', 'u3', 'admin']) {
      const body = await get(await tok(sub, sub === 'admin' ? ['super_admin'] : ['member']));
      expect(body.servers.map((s) => s.id)).not.toContain('c-disabled');
    }
  });

  test('categories = the distinct category_id of the visible set (id -> name lookup)', async () => {
    // Tag the connectors u2 can see with two categories; assert the response
    // returns exactly those (id, name_zh, name_en) and no others.
    await testPool.query(
      `INSERT INTO mcp_connector_categories(id, org_id, name) VALUES
         ('cat-a', 'o1', 'Alpha'), ('cat-b', 'o1', 'Beta')`,
    );
    await testPool.query(`UPDATE mcp_connectors SET category_id = 'cat-a' WHERE id IN ('c-rd','c-all')`);
    await testPool.query(`UPDATE mcp_connectors SET category_id = 'cat-b' WHERE id = 'c-u2'`);

    const body = await get(await tok('u2'));
    // u2 sees c-rd, c-all (cat-a) and c-u2 (cat-b).
    const catIds = body.categories.map((c) => c.id).sort();
    expect(catIds).toEqual(['cat-a', 'cat-b']);
    const byId = Object.fromEntries(body.categories.map((c) => [c.id, c]));
    expect(byId['cat-a']).toEqual({ id: 'cat-a', name_zh: 'Alpha', name_en: 'Alpha' });
    expect(byId['cat-b']).toEqual({ id: 'cat-b', name_zh: 'Beta', name_en: 'Beta' });
    // The server wire carries the raw category_id (row id), not the name.
    const byKey = Object.fromEntries(body.servers.map((s) => [s.serverKey, s.category]));
    expect(byKey['rd-tool']).toBe('cat-a');
    expect(byKey['all-tool']).toBe('cat-a');
    expect(byKey['u2-tool']).toBe('cat-b');
  });

  test('a category with zero visible servers is omitted for a restricted caller', async () => {
    await testPool.query(
      `INSERT INTO mcp_connector_categories(id, org_id, name) VALUES
         ('cat-s', 'o1', 'Sales Only'), ('cat-r', 'o1', 'Rd Only')`,
    );
    // Put the sales-granted connector in cat-s (invisible to u2) and the
    // rd-granted one in cat-r (visible to u2).
    await testPool.query(`UPDATE mcp_connectors SET category_id = 'cat-s' WHERE id = 'c-sales'`);
    await testPool.query(`UPDATE mcp_connectors SET category_id = 'cat-r' WHERE id = 'c-rd'`);

    const body = await get(await tok('u2'));
    const catIds = body.categories.map((c) => c.id);
    expect(catIds).toEqual(['cat-r']);
    expect(catIds).not.toContain('cat-s');
  });
});
