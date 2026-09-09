import { Hono } from 'hono';

import { requirePermission } from '../auth/middleware';
import { pool } from '../db/pool';
import { PermissionPoint as PP } from '../shared/permissionPoints';

const CORE_ROLES = ['super_admin', 'org_admin', 'policy_admin', 'model_admin', 'auditor'];

export const roleVocabularyRoutes = new Hono();
roleVocabularyRoutes.use('/api/roles/vocabulary', requirePermission(PP.RoleView));

roleVocabularyRoutes.get('/api/roles/vocabulary', async (c) => {
  const u = await pool.query<{ roles: string[] }>(
    'SELECT extra_roles AS roles FROM users'
  );
  const p = await pool.query<{ name: string }>(
    'SELECT name FROM roles'
  );
  const set = new Set<string>(CORE_ROLES);
  for (const row of u.rows) for (const r of row.roles ?? []) set.add(r);
  for (const row of p.rows) set.add(row.name);
  return c.json({ roles: [...set].sort() });
});
