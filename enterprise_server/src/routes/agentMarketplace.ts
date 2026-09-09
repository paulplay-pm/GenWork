import { Hono } from 'hono';

import { requireAuth } from '../auth/middleware';
import { pool } from '../db/pool';
import {
  AGENT_COLUMNS,
  type AgentRow,
  mapAgent,
} from '../models/agentMarketplaceView';
import { Role } from '../shared/enterpriseServerConstants';

const AGENT_CORE_ROLES = ['super_admin', 'org_admin', 'agent_admin'] as const;

export const agentMarketplaceRoutes = new Hono();
agentMarketplaceRoutes.use('/api/agent-marketplace/*', requireAuth);

agentMarketplaceRoutes.get('/api/agent-marketplace', async (c) => {
  const claims = c.get('claims');
  const userRoles = claims?.roles ?? [];
  const isSuperAdmin = userRoles.includes(Role.SuperAdmin);

  const rows = await pool.query<AgentRow>(
    `SELECT ${AGENT_COLUMNS} FROM agent_marketplace_agents WHERE enabled = TRUE ORDER BY agent_id`,
  );
  const userRoleSet = new Set(userRoles);
  const visible = rows.rows.filter(
    row => isSuperAdmin || row.allowed_roles.some(r => userRoleSet.has(r)),
  );
  return c.json({ agents: visible.map(mapAgent) });
});

// Picker source for the agent_admin form. The default agent_admin role
// lacks `roles.manage` (see spec §3.5), so /api/roles/vocabulary 403s for
// them; this endpoint is the dedicated replacement.
agentMarketplaceRoutes.get('/api/agent-marketplace/role-options', async (c) => {
  const claims = c.get('claims');
  const userRoles = claims?.roles ?? [];
  const set = new Set<string>(AGENT_CORE_ROLES);
  for (const r of userRoles) set.add(r);
  return c.json({ roles: [...set].sort() });
});
