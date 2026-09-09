import { Hono } from 'hono';

import { archiveService } from '../../archives/archiveService';
import { auditStore } from '../../audit/auditStore';
import { requirePermission } from '../../auth/middleware';
import { AuditAction } from '../../shared/enterpriseServerConstants';
import { PermissionPoint as PP } from '../../shared/permissionPoints';

export const archiveRoutes = new Hono();
// Archive/impersonate are user-admin operations: gate on user:edit.
archiveRoutes.use('/admin/users/*', requirePermission(PP.UserEdit));

archiveRoutes.post('/admin/users/:id/archive', async (c) => {
  const claims = c.get('claims');
  const targetUserId = c.req.param('id');
  const blob = Buffer.from(await c.req.arrayBuffer());
  const { archiveId, size } = await archiveService.store(claims.orgId, targetUserId, blob);
  await auditStore.write({
    orgId: claims.orgId,
    userId: claims.sub,
    targetUserId,
    action: AuditAction.UserArchive,
    targetType: 'archive',
    targetId: archiveId,
    payload: { size },
  });
  return c.json({ archiveId, size });
});

archiveRoutes.get('/admin/users/:id/archives', async (c) => {
  const claims = c.get('claims');
  const targetUserId = c.req.param('id');
  return c.json(await archiveService.list(claims.orgId, targetUserId));
});

archiveRoutes.post('/admin/users/:id/impersonate', async (c) => {
  const claims = c.get('claims');
  const targetUserId = c.req.param('id');
  // v1.1: actual data access lives in a separate `GET /admin/users/:id/workspace` route.
  // Here we only record the audit event so an audit trail exists when an
  // admin uses the impersonation surface.
  await auditStore.write({
    orgId: claims.orgId,
    userId: claims.sub,
    targetUserId,
    action: AuditAction.ReadUserWorkspace,
    targetType: 'user',
    targetId: targetUserId,
  });
  return c.json({
    ok: true,
    note: 'audit recorded; data access surfaces land in v1.1',
  });
});