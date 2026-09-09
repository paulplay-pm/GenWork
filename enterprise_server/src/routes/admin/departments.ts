import { type Context, Hono } from 'hono';
import { z } from 'zod';

import { auditStore } from '../../audit/auditStore';
import { requirePermission } from '../../auth/middleware';
import { scopeApi, scopeIncludesDept } from '../../auth/scopeResolver';
import { DeptError, DeptGuardError, orgService } from '../../org/orgService';
import { AuditAction } from '../../shared/enterpriseServerConstants';
import { PermissionPoint as PP } from '../../shared/permissionPoints';

/** Map service conflict errors to HTTP statuses. */
function deptErrorStatus(e: { code: string }): 409 | 422 | 404 | 400 {
  switch (e.code) {
    case 'duplicate_code':
      return 409;
    case 'code_immutable':
      return 422;
    case 'parent_not_found':
    case 'not_found':
      return 404;
    case 'circular_parent':
    default:
      return 400;
  }
}

function handleDeptError(c: Context, e: unknown): Response {
  if (e instanceof DeptGuardError) return c.json({ error: e.code }, 409);
  if (e instanceof DeptError) return c.json({ error: e.code }, deptErrorStatus(e));
  console.error('[departments] unexpected error', e);
  return c.json({ error: 'internal_error' }, 500);
}

/** 403 for a dept outside the caller's data scope, with an audit trail.
 *  `deptId` is null when the denied action targets no existing dept (e.g.
 *  creating a root dept under a non-`all` scope). */
async function denyOutsideScope(
  c: Context,
  claims: { sub: string; orgId: string },
  deptId: string | null
): Promise<Response> {
  await auditStore.write({
    orgId: claims.orgId,
    userId: claims.sub,
    action: AuditAction.AdminAccessDenied,
    targetType: 'dept',
    targetId: deptId,
    payload: { reason: 'outside_scope' },
  });
  return c.json({ error: 'forbidden' }, 403);
}

export const deptRoutes = new Hono();

deptRoutes.get('/admin/departments', requirePermission(PP.DeptView), async (c) => {
  const orgId = c.req.query('orgId');
  if (!orgId) return c.json({ error: 'orgId required' }, 400);
  const claims = c.get('claims');
  if (orgId !== claims.orgId) return c.json({ error: 'org_mismatch' }, 400);
  const scope = await scopeApi.loadScope(claims);
  return c.json(await orgService.listDeptTree(orgId, scope));
});

deptRoutes.get('/admin/departments/:id', requirePermission(PP.DeptView), async (c) => {
  const claims = c.get('claims');
  const id = c.req.param('id');
  const scope = await scopeApi.loadScope(claims);
  const detail = await orgService.getDeptDetail(claims.orgId, id, scope);
  if (!detail) return c.json({ error: 'not_found' }, 404);
  if (!scopeIncludesDept(scope, id)) return denyOutsideScope(c, claims, id);
  return c.json(detail);
});

deptRoutes.post('/admin/departments', requirePermission(PP.DeptCreate), async (c) => {
  const claims = c.get('claims');
  const raw = await c.req.json().catch(() => ({}));
  const parsed = z
    .object({
      orgId: z.string(),
      name: z.string().min(1),
      code: z.string().min(1).optional(),
      parentId: z.string().nullable().default(null),
      leaderId: z.string().nullable().optional(),
      sort: z.number().int().optional(),
      description: z.string().nullable().optional(),
    })
    .safeParse(raw);
  if (!parsed.success) {
    return c.json({ error: 'invalid_input', issues: parsed.error.issues }, 422);
  }
  const body = parsed.data;
  if (body.orgId !== claims.orgId) return c.json({ error: 'org_mismatch' }, 400);
  const scope = await scopeApi.loadScope(claims);
  // Same parent guard as PATCH: creating under an invisible parent would place
  // the new dept outside the caller's data scope (and the returned path would
  // disclose the out-of-scope ancestor). A non-`all` caller may not create a
  // root/top-level dept either.
  if (body.parentId === null) {
    if (scope.kind !== 'all') return denyOutsideScope(c, claims, null);
  } else if (!scopeIncludesDept(scope, body.parentId)) {
    return denyOutsideScope(c, claims, body.parentId);
  }
  try {
    const { id, path } = await orgService.createDept({
      orgId: body.orgId,
      name: body.name,
      code: body.code ?? null,
      parentId: body.parentId,
      leaderId: body.leaderId ?? null,
      sort: body.sort,
      description: body.description ?? null
    });
    await scopeApi.invalidate();
    await auditStore.write({
      orgId: body.orgId,
      userId: claims.sub,
      action: AuditAction.DeptCreate,
      targetType: 'dept',
      targetId: id,
      payload: {
        before: null,
        after: {
          name: body.name,
          code: body.code ?? null,
          parent_id: body.parentId,
          leader_id: body.leaderId ?? null,
          sort: body.sort ?? 100,
          description: body.description ?? null,
          path
        }
      }
    });
    return c.json({ id, path });
  } catch (e) {
    return handleDeptError(c, e);
  }
});

deptRoutes.patch('/admin/departments/:id', requirePermission(PP.DeptEdit), async (c) => {
  const claims = c.get('claims');
  const id = c.req.param('id');
  if (!(await orgService.deptInOrg(id, claims.orgId))) {
    return c.json({ error: 'not_found' }, 404);
  }
  const scope = await scopeApi.loadScope(claims);
  if (!scopeIncludesDept(scope, id)) return denyOutsideScope(c, claims, id);
  const raw = await c.req.json().catch(() => ({}));
  const parsed = z
    .object({
      name: z.string().min(1).optional(),
      code: z.string().min(1).optional(),
      parentId: z.string().nullable().optional(),
      leaderId: z.string().nullable().optional(),
      sort: z.number().int().optional(),
      description: z.string().nullable().optional(),
    })
    .safeParse(raw);
  if (!parsed.success) {
    return c.json({ error: 'invalid_input', issues: parsed.error.issues }, 422);
  }
  const body = parsed.data;
  // Re-parenting under an out-of-scope dept would smuggle the subtree across
  // the caller's data scope, so the new parent must be visible too.
  if (body.parentId && !scopeIncludesDept(scope, body.parentId)) {
    return denyOutsideScope(c, claims, body.parentId);
  }
  try {
    const { before, after } = await orgService.updateDept(id, body);
    await scopeApi.invalidate();
    const isMove = body.parentId !== undefined && body.parentId !== before.parent_id;
    await auditStore.write({
      orgId: claims.orgId,
      userId: claims.sub,
      action: isMove ? AuditAction.DeptMove : AuditAction.DeptUpdate,
      targetType: 'dept',
      targetId: id,
      payload: { before, after }
    });
    return c.json({ ok: true });
  } catch (e) {
    return handleDeptError(c, e);
  }
});

deptRoutes.delete('/admin/departments/:id', requirePermission(PP.DeptDelete), async (c) => {
  const claims = c.get('claims');
  const id = c.req.param('id');
  if (!(await orgService.deptInOrg(id, claims.orgId))) {
    return c.json({ error: 'not_found' }, 404);
  }
  const scope = await scopeApi.loadScope(claims);
  if (!scopeIncludesDept(scope, id)) return denyOutsideScope(c, claims, id);
  try {
    const before = await orgService.deleteDept(id);
    if (!before) return c.json({ error: 'not_found' }, 404);
    await scopeApi.invalidate();
    await auditStore.write({
      orgId: claims.orgId,
      userId: claims.sub,
      action: AuditAction.DeptDelete,
      targetType: 'dept',
      targetId: id,
      payload: { before, after: null }
    });
    return c.json({ ok: true });
  } catch (e) {
    return handleDeptError(c, e);
  }
});

deptRoutes.post('/admin/departments/reorder', requirePermission(PP.DeptEdit), async (c) => {
  const claims = c.get('claims');
  const raw = await c.req.json().catch(() => ({}));
  const parsed = z
    .object({
      orgId: z.string(),
      parentId: z.string().nullable(),
      orderedIds: z.array(z.string())
    })
    .safeParse(raw);
  if (!parsed.success) {
    return c.json({ error: 'invalid_input', issues: parsed.error.issues }, 422);
  }
  const body = parsed.data;
  if (body.orgId !== claims.orgId) return c.json({ error: 'org_mismatch' }, 400);
  const scope = await scopeApi.loadScope(claims);
  if (body.parentId) {
    // Reordering siblings under a parent: the parent itself must be visible.
    if (!scopeIncludesDept(scope, body.parentId)) {
      return denyOutsideScope(c, claims, body.parentId);
    }
  } else {
    // Reordering top-level (root) depts: every ordered id must be visible to
    // the caller — a non-`all` scope cannot reorder roots it does not include.
    const outOfScope = body.orderedIds.find((id) => !scopeIncludesDept(scope, id));
    if (outOfScope) return denyOutsideScope(c, claims, outOfScope);
  }
  try {
    const items = await orgService.reorderSiblings(body.orgId, body.parentId, body.orderedIds);
    await scopeApi.invalidate();
    await auditStore.write({
      orgId: body.orgId,
      userId: claims.sub,
      action: AuditAction.DeptReorder,
      targetType: 'dept',
      targetId: body.parentId,
      payload: { parentId: body.parentId, items }
    });
    return c.json({ ok: true });
  } catch (e) {
    return handleDeptError(c, e);
  }
});
