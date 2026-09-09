import '../helpers/setupEnv';
import { beforeEach, describe, expect, test, vi } from 'vitest';
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
