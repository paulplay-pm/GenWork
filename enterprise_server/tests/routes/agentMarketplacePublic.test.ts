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
