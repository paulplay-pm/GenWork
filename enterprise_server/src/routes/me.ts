import { Hono } from 'hono';
import { z, ZodError } from 'zod';

import { auditStore } from '../audit/auditStore';
import { requireAuth } from '../auth/middleware';
import { roleResolver } from '../auth/roleResolver';
import { scopeApi } from '../auth/scopeResolver';
import { pool } from '../db/pool';
import { AuditAction } from '../shared/enterpriseServerConstants';

interface MeRow {
  id: string;
  username: string;
  display_name: string | null;
  timezone: string | null;
  extra_roles: string[];
  dept_path: string | null;
}

export const meRoutes = new Hono();
meRoutes.use('/me', requireAuth);

async function fetchMe(userId: string): Promise<MeRow | null> {
  const r = await pool.query<MeRow>(
    `SELECT u.id, u.username, u.display_name, u.timezone, u.extra_roles,
            d.path AS dept_path
     FROM users u LEFT JOIN departments d ON d.id = u.department_id
     WHERE u.id=$1`,
    [userId]
  );
  return r.rowCount === 0 ? null : r.rows[0];
}

meRoutes.get('/me', async (c) => {
  const claims = c.get('claims');
  const row = await fetchMe(claims.sub);
  if (!row) return c.json({ error: 'not found' }, 404);
  // Two-axis additions (backward-compatible: existing fields unchanged).
  // `permissions` = the union of the caller's fine permission points;
  // `effectiveDataScope` = coarse axis (all/self/dept) for the SPA to gate
  // lists; `concurrentDeptPaths` = non-primary department path labels.
  const points = [...(await roleResolver.pointsFor(row.extra_roles ?? []))];
  const scope = await scopeApi.loadScope(claims);
  const concurrent = await pool.query<{ path: string }>(
    `SELECT d.path FROM user_departments ud JOIN departments d ON d.id = ud.dept_id WHERE ud.user_id = $1 AND NOT ud.is_primary`,
    [claims.sub],
  );
  // The org's member self-service toggles: a plain member cannot read
  // GET /admin/mcp-connectors/settings (PP.McpView) or the skill-marketplace
  // settings, so expose both flags here for the desktop to gate its
  // 「申请连接器」and「提交技能」entries. Each defaults to false when the
  // org row is missing (backward-compatible additive fields).
  const org = await pool.query<{
    members_can_submit_connectors: boolean;
    members_can_submit_skills: boolean;
  }>(
    `SELECT members_can_submit_connectors, members_can_submit_skills FROM orgs WHERE id = $1`,
    [claims.orgId],
  );
  const membersCanSubmitConnectors =
    org.rowCount > 0 ? org.rows[0].members_can_submit_connectors : false;
  const membersCanSubmitSkills =
    org.rowCount > 0 ? org.rows[0].members_can_submit_skills : false;
  return c.json({
    ...row,
    effective_roles: row.extra_roles ?? [],
    org_id: claims.orgId,
    permissions: points,
    effectiveDataScope: scope.kind === 'all' ? 'all' : scope.kind === 'self' ? 'self' : 'dept',
    concurrentDeptPaths: concurrent.rows.map((x) => x.path),
    membersCanSubmitConnectors,
    membersCanSubmitSkills,
  });
});

const patchSchema = z.object({
  displayName: z.string().min(1).max(120).optional(),
});

meRoutes.patch('/me', async (c) => {
  const raw = await c.req.json().catch(() => ({}));
  const result = patchSchema.safeParse(raw);
  if (!result.success) {
    return c.json(
      { error: 'invalid_input', issues: (result.error as ZodError).issues },
      422
    );
  }
  const claims = c.get('claims');
  const existing = await fetchMe(claims.sub);
  if (!existing) return c.json({ error: 'not found' }, 404);

  const displayName = result.data.displayName;
  if (displayName !== undefined) {
    await pool.query(`UPDATE users SET display_name=$1 WHERE id=$2`, [
      displayName,
      claims.sub,
    ]);
    await auditStore.write({
      orgId: claims.orgId,
      userId: claims.sub,
      action: AuditAction.ProfileUpdate,
      payload: { field: 'display_name' },
    });
  }

  const updated = await fetchMe(claims.sub);
  if (!updated) return c.json({ error: 'not found' }, 404);
  return c.json({
    ...updated,
    effective_roles: updated.extra_roles ?? [],
    org_id: claims.orgId,
  });
});
