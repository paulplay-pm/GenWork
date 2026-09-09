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

    const stillThere = await testPool.query<{ subagent_allow_agent_ids: string[] }>(
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

  test('update toggles enabled and it persists on the row', async () => {
    const tok = await admin();
    await seedAgent('a', ['org_admin']);

    const off = await app.request('/api/admin/agent-marketplace/agents/a', {
      method: 'PUT', headers: { ...auth(tok), ...json },
      body: JSON.stringify({ enabled: false }),
    });
    expect(off.status).toBe(204);
    const offRow = await testPool.query<{ enabled: boolean }>(
      `SELECT enabled FROM agent_marketplace_agents WHERE agent_id = $1`, ['a'],
    );
    expect(offRow.rows[0].enabled).toBe(false);

    const on = await app.request('/api/admin/agent-marketplace/agents/a', {
      method: 'PUT', headers: { ...auth(tok), ...json },
      body: JSON.stringify({ enabled: true }),
    });
    expect(on.status).toBe(204);
    const onRow = await testPool.query<{ enabled: boolean }>(
      `SELECT enabled FROM agent_marketplace_agents WHERE agent_id = $1`, ['a'],
    );
    expect(onRow.rows[0].enabled).toBe(true);
  });
});

describe('about_you and icon_color', () => {
  test('POST persists about_you and icon_color', async () => {
    const tok = await admin();
    const res = await app.request('/api/admin/agent-marketplace/agents', {
      method: 'POST', headers: { ...auth(tok), ...json },
      body: JSON.stringify({ name: 'N', allowed_roles: ['org_admin'], about_you: 'hi', icon_color: 2 }),
    });
    expect(res.status).toBe(200);
    const { rows } = await testPool.query<{ about_you: string; icon_color: number }>(
      'SELECT about_you, icon_color FROM agent_marketplace_agents WHERE name = $1', ['N']);
    expect(rows[0].about_you).toBe('hi');
    expect(rows[0].icon_color).toBe(2);
  });

  test('PUT partial update sets about_you', async () => {
    const tok = await admin();
    await app.request('/api/admin/agent-marketplace/agents', {
      method: 'POST', headers: { ...auth(tok), ...json },
      body: JSON.stringify({ name: 'N', allowed_roles: ['org_admin'] }),
    });
    const row = (await testPool.query<{ agent_id: string }>('SELECT agent_id FROM agent_marketplace_agents')).rows[0];
    const res = await app.request(`/api/admin/agent-marketplace/agents/${row.agent_id}`, {
      method: 'PUT', headers: { ...auth(tok), ...json },
      body: JSON.stringify({ about_you: 'updated', icon_color: 5 }),
    });
    expect(res.status).toBe(204);
    const after = (await testPool.query<{ about_you: string; icon_color: number }>(
      'SELECT about_you, icon_color FROM agent_marketplace_agents')).rows[0];
    expect(after.about_you).toBe('updated');
    expect(after.icon_color).toBe(5);
  });
});

describe('im_channels', () => {
  test('POST persists im_channels', async () => {
    const tok = await admin();
    const res = await app.request('/api/admin/agent-marketplace/agents', {
      method: 'POST', headers: { ...auth(tok), ...json },
      body: JSON.stringify({ name: 'IM', allowed_roles: ['org_admin'], im_channels: ['feishu', 'weixin'] }),
    });
    expect(res.status).toBe(200);
    const { rows } = await testPool.query<{ im_channels: string[] }>(
      'SELECT im_channels FROM agent_marketplace_agents WHERE name = $1', ['IM']);
    expect(rows[0].im_channels).toEqual(['feishu', 'weixin']);
  });

  test('POST defaults im_channels to empty array', async () => {
    const tok = await admin();
    const res = await app.request('/api/admin/agent-marketplace/agents', {
      method: 'POST', headers: { ...auth(tok), ...json },
      body: JSON.stringify({ name: 'NOIM', allowed_roles: ['org_admin'] }),
    });
    expect(res.status).toBe(200);
    const { rows } = await testPool.query<{ im_channels: string[] }>(
      'SELECT im_channels FROM agent_marketplace_agents WHERE name = $1', ['NOIM']);
    expect(rows[0].im_channels).toEqual([]);
  });

  test('PUT partial update sets im_channels (including clearing to [])', async () => {
    const tok = await admin();
    await app.request('/api/admin/agent-marketplace/agents', {
      method: 'POST', headers: { ...auth(tok), ...json },
      body: JSON.stringify({ name: 'IM', allowed_roles: ['org_admin'], im_channels: ['qq'] }),
    });
    const row = (await testPool.query<{ agent_id: string }>('SELECT agent_id FROM agent_marketplace_agents')).rows[0];
    // First set a second channel, then clear the whole list (all-off is valid).
    const r1 = await app.request(`/api/admin/agent-marketplace/agents/${row.agent_id}`, {
      method: 'PUT', headers: { ...auth(tok), ...json },
      body: JSON.stringify({ im_channels: ['qq', 'popo'] }),
    });
    expect(r1.status).toBe(204);
    let after = (await testPool.query<{ im_channels: string[] }>(
      'SELECT im_channels FROM agent_marketplace_agents')).rows[0];
    expect(after.im_channels).toEqual(['qq', 'popo']);

    const r2 = await app.request(`/api/admin/agent-marketplace/agents/${row.agent_id}`, {
      method: 'PUT', headers: { ...auth(tok), ...json },
      body: JSON.stringify({ im_channels: [] }),
    });
    expect(r2.status).toBe(204);
    after = (await testPool.query<{ im_channels: string[] }>(
      'SELECT im_channels FROM agent_marketplace_agents')).rows[0];
    expect(after.im_channels).toEqual([]);
  });
});
