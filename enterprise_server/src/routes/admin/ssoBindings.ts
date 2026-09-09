// enterprise_server/src/routes/admin/ssoBindings.ts
// Admin read + unbind for user-driven SSO self-bindings. Admins can SEE
// any user's binding and UNBIND it (audit-tracked), but cannot WRITE
// a binding — that's reserved for the user self-flow (POST /me/sso-binding/start
// + the two-stage /auth/sso/bind).
import { Hono } from 'hono';

import { auditStore } from '../../audit/auditStore';
import { requirePermission } from '../../auth/middleware';
import { pool } from '../../db/pool';
import { PermissionPoint as PP } from '../../shared/permissionPoints';

export const adminSsoBindingRoutes = new Hono();
adminSsoBindingRoutes.use('/admin/*', requirePermission(PP.SsoView));

interface UserBindingRow {
  sso_connection_id: string | null;
  sso_external_id: string | null;
  connection_name: string | null;
  provider_type: string | null;
}

adminSsoBindingRoutes.get('/admin/users/:id/sso-binding', async (c) => {
  const claims = c.get('claims');
  const r = await pool.query<UserBindingRow>(
    `SELECT u.sso_connection_id, u.sso_external_id,
            sc.name AS connection_name, sc.provider_type
       FROM users u
       LEFT JOIN sso_connections sc ON sc.id = u.sso_connection_id
      WHERE u.id = $1 AND u.org_id = $2`,
    [c.req.param('id'), claims.orgId]
  );
  const row = r.rows[0];
  if (!row) return c.json({ error: 'not_found' }, 404);
  if (!row.sso_connection_id || !row.sso_external_id) return c.json(null);
  return c.json({
    connectionId: row.sso_connection_id,
    connectionName: row.connection_name,
    providerType: row.provider_type,
    externalId: row.sso_external_id,
  });
});

adminSsoBindingRoutes.get('/admin/sso-connections/:id/bindings', async (c) => {
  const claims = c.get('claims');
  // Ensure the connection belongs to this org (404 if not).
  const conn = await pool.query(`SELECT 1 FROM sso_connections WHERE id = $1 AND org_id = $2`, [c.req.param('id'), claims.orgId]);
  if (!conn.rowCount) return c.json({ error: 'not_found' }, 404);
  const r = await pool.query<{ id: string; username: string; display_name: string | null; sso_external_id: string }>(
    `SELECT u.id, u.username, u.display_name, u.sso_external_id
       FROM users u
      WHERE u.org_id = $1 AND u.sso_connection_id = $2 AND u.sso_external_id IS NOT NULL
      ORDER BY u.username ASC`,
    [claims.orgId, c.req.param('id')]
  );
  return c.json(r.rows.map(row => ({
    userId: row.id,
    username: row.username,
    displayName: row.display_name,
    externalId: row.sso_external_id,
  })));
});

adminSsoBindingRoutes.delete('/admin/users/:id/sso-binding', requirePermission(PP.SsoEdit), async (c) => {
  const claims = c.get('claims');
  const before = await pool.query<{ sso_connection_id: string | null; sso_external_id: string | null }>(
    `SELECT sso_connection_id, sso_external_id FROM users WHERE id = $1 AND org_id = $2`,
    [c.req.param('id'), claims.orgId]
  );
  const row = before.rows[0];
  if (!row) return c.json({ error: 'not_found' }, 404);
  await pool.query(
    `UPDATE users SET sso_connection_id = NULL, sso_external_id = NULL
      WHERE id = $1 AND org_id = $2`,
    [c.req.param('id'), claims.orgId]
  );
  if (row.sso_connection_id && row.sso_external_id) {
    await auditStore.write({
      orgId: claims.orgId, userId: claims.sub, action: 'sso_user_admin_unbound',
      targetUserId: c.req.param('id'),
      payload: { ssoConnectionId: row.sso_connection_id, externalId: row.sso_external_id },
    });
  }
  return c.json({ ok: true });
});