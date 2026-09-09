import { Hono } from 'hono';

import { type AuditEventRow,auditStore } from '../../audit/auditStore';
import { requirePermission } from '../../auth/middleware';
import { pool } from '../../db/pool';
import { AuditAction } from '../../shared/enterpriseServerConstants';
import { PermissionPoint as PP } from '../../shared/permissionPoints';

export const adminAuditRoutes = new Hono();
adminAuditRoutes.use('/admin/audit', requirePermission(PP.AuditView));

adminAuditRoutes.get('/admin/audit', async (c) => {
  const claims = c.get('claims');
  const userId = c.req.query('userId');
  const limit = Number(c.req.query('limit') ?? '100');
  const format = c.req.query('format');
  const include = c.req.query('include');

  let events = await auditStore.query({ orgId: claims.orgId, userId, limit });

  if (include === 'login') {
    // `login_events` is the richer, per-attempt record of login activity
    // (it also covers failed attempts). Union it into the feed and drop the
    // plain audit_events rows with action=login so a successful login is
    // not listed twice.
    const where: string[] = ['org_id=$1'];
    const params: unknown[] = [claims.orgId];
    if (userId) {
      params.push(userId);
      where.push(`user_id=$${params.length}`);
    }
    params.push(limit);
    const r = await pool.query<{
      id: string;
      org_id: string;
      user_id: string | null;
      ts: Date;
      ip: string | null;
      device: string | null;
      result: string;
    }>(
      `SELECT * FROM login_events WHERE ${where.join(' AND ')} ORDER BY ts DESC LIMIT $${params.length}`,
      params
    );
    const loginRows: AuditEventRow[] = r.rows.map((row) => ({
      id: row.id,
      org_id: row.org_id,
      user_id: row.user_id,
      target_user_id: null,
      action: AuditAction.Login,
      target_type: 'login',
      target_id: null,
      payload: { ip: row.ip, device: row.device, result: row.result },
      ts: new Date(row.ts),
    }));
    events = [
      ...events.filter((e) => e.action !== AuditAction.Login),
      ...loginRows,
    ]
      .sort((a, b) => b.ts.getTime() - a.ts.getTime())
      .slice(0, limit);
  }

  if (format === 'csv') {
    const header = 'id,ts,user_id,target_user_id,action,target_type,target_id,payload';
    const rows = events.map((e) =>
      [
        e.id,
        e.ts.toISOString(),
        e.user_id ?? '',
        e.target_user_id ?? '',
        e.action,
        e.target_type ?? '',
        e.target_id ?? '',
        (JSON.stringify(e.payload ?? '') ?? '').replace(/,/g, '\\,'),
      ].join(',')
    );
    return c.text([header, ...rows].join('\n'), 200, {
      'content-type': 'text/csv',
    });
  }
  return c.json(events);
});