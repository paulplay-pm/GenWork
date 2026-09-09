import '../helpers/setupEnv';

import { beforeEach, describe, expect, test, vi } from 'vitest';

vi.mock('../../src/db/pool', async () => {
  const td = await import('../../src/db/testDb');
  return { pool: td.testPool };
});

import { Hono } from 'hono';

import { signToken } from '../../src/auth/jwt';
import { resetSchema, runMigrations } from '../../src/db/testDb';
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
