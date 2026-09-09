import { type Context, Hono } from 'hono';
import { z, ZodError } from 'zod';

import { auditStore } from '../../audit/auditStore';
import { requirePermission } from '../../auth/middleware';
import { RoleError, RoleGuardError, RoleInUseError, roleService } from '../../org/roleService';
import { AuditAction } from '../../shared/enterpriseServerConstants';
import { DataScope, PermissionPoint } from '../../shared/permissionPoints';

const KNOWN_POINTS = Object.values(PermissionPoint) as [string, ...string[]];
const pointsArray = z.array(z.enum(KNOWN_POINTS));
const DATA_SCOPES = Object.values(DataScope) as [DataScope, ...DataScope[]];
const dataScopeEnum = z.enum(DATA_SCOPES);

// Local error-response helper — mirrors src/routes/admin/releases.ts (the
// 422-invalid-input idiom). Validation failures must return 422, not throw.
const httpError = (status: number, error: string, issues?: unknown): Response =>
  new Response(JSON.stringify({ error, ...(issues ? { issues } : {}) }), {
    status,
    headers: { 'content-type': 'application/json' },
  });

/** Map roleService guard/error classes to their HTTP responses. */
function handleRoleError(c: Context, e: unknown): Response {
  if (e instanceof RoleGuardError) return c.json({ error: e.code }, 409);
  if (e instanceof RoleInUseError) return c.json({ error: e.code }, 409);
  if (e instanceof RoleError) {
    switch (e.code) {
      case 'not_found':
        return c.json({ error: 'not_found' }, 404);
      case 'name_invalid':
      case 'data_scope_invalid':
        return c.json({ error: e.code }, 422);
      case 'duplicate':
        return c.json({ error: 'duplicate' }, 409);
    }
  }
  console.error('[roles] unexpected error', e);
  return c.json({ error: 'internal_error' }, 500);
}

export const roleAdminRoutes = new Hono();
// Per-verb fine-point gates (see PermissionPoint catalog). Each route
// carries its own gate so role viewers need only role:view while
// mutations require role:create / role:edit / role:delete. Cache
// invalidation is owned by roleService (T9-2); routes must not duplicate it.
roleAdminRoutes.get('/admin/roles', requirePermission(PermissionPoint.RoleView), async (c) => {
  const type = c.req.query('type');
  if (type !== undefined && type !== 'builtin' && type !== 'custom') {
    return httpError(422, 'invalid_type');
  }
  return c.json(await roleService.list(type ? { type } : undefined));
});

roleAdminRoutes.post('/admin/roles', requirePermission(PermissionPoint.RoleCreate), async (c) => {
  const claims = c.get('claims');
  const raw = await c.req.json().catch(() => ({}));
  const parsed = z
    .object({
      name: z.string().min(1),
      description: z.string().nullable().optional(),
      permissions: pointsArray.default([]),
      displayName: z.string().nullable().optional(),
      dataScope: dataScopeEnum.optional(),
      customDeptIds: z.array(z.string()).optional(),
    })
    .safeParse(raw);
  if (!parsed.success) {
    return httpError(422, 'invalid_input', (parsed.error as ZodError).issues);
  }
  const body = parsed.data;
  // `z.enum` output is typed `string`; the value was validated against the
  // catalog above, so the narrow cast is safe.
  const points = body.permissions as PermissionPoint[];
  const dataScope = body.dataScope as DataScope | undefined;
  try {
    const { id } = await roleService.create({
      name: body.name,
      description: body.description,
      permissions: points,
      displayName: body.displayName,
      dataScope,
      customDeptIds: body.customDeptIds,
    });
    await auditStore.write({
      orgId: claims.orgId,
      userId: claims.sub,
      action: AuditAction.RoleCreate,
      targetType: 'role',
      targetId: id,
      payload: {
        name: body.name,
        permissions: body.permissions,
        displayName: body.displayName,
        dataScope,
        customDeptIds: body.customDeptIds,
      },
    });
    return c.json({ id });
  } catch (e) {
    return handleRoleError(c, e);
  }
});

roleAdminRoutes.post('/admin/roles/:id/copy', requirePermission(PermissionPoint.RoleCreate), async (c) => {
  const claims = c.get('claims');
  const id = c.req.param('id');
  const raw = await c.req.json().catch(() => ({}));
  const parsed = z.object({ newCode: z.string().min(1) }).safeParse(raw);
  if (!parsed.success) {
    return httpError(422, 'invalid_input', (parsed.error as ZodError).issues);
  }
  const newCode = parsed.data.newCode;
  try {
    const { id: newId } = await roleService.copy(id, newCode);
    await auditStore.write({
      orgId: claims.orgId,
      userId: claims.sub,
      action: AuditAction.RoleCopy,
      targetType: 'role',
      targetId: newId,
      payload: { source: id, newCode },
    });
    return c.json({ id: newId });
  } catch (e) {
    return handleRoleError(c, e);
  }
});

roleAdminRoutes.patch('/admin/roles/:id', requirePermission(PermissionPoint.RoleEdit), async (c) => {
  const claims = c.get('claims');
  const id = c.req.param('id');
  const raw = await c.req.json().catch(() => ({}));
  const parsed = z
    .object({
      name: z.string().min(1).optional(),
      description: z.string().nullable().optional(),
      permissions: pointsArray.optional(),
      displayName: z.string().nullable().optional(),
      dataScope: dataScopeEnum.optional(),
      customDeptIds: z.array(z.string()).optional(),
    })
    .safeParse(raw);
  if (!parsed.success) {
    return httpError(422, 'invalid_input', (parsed.error as ZodError).issues);
  }
  const body = parsed.data;
  // `z.enum` output is typed `string`; validated against the catalog above.
  const points = body.permissions as PermissionPoint[] | undefined;
  const dataScope = body.dataScope as DataScope | undefined;
  try {
    await roleService.update(id, {
      name: body.name,
      description: body.description,
      permissions: points,
      displayName: body.displayName,
      dataScope,
      customDeptIds: body.customDeptIds,
    });
    await auditStore.write({
      orgId: claims.orgId,
      userId: claims.sub,
      action: AuditAction.RoleUpdate,
      targetType: 'role',
      targetId: id,
      payload: body,
    });
    return c.json({ ok: true });
  } catch (e) {
    return handleRoleError(c, e);
  }
});

roleAdminRoutes.delete('/admin/roles/:id', requirePermission(PermissionPoint.RoleDelete), async (c) => {
  const claims = c.get('claims');
  const id = c.req.param('id');
  try {
    await roleService.remove(id);
  } catch (e) {
    return handleRoleError(c, e);
  }
  await auditStore.write({
    orgId: claims.orgId,
    userId: claims.sub,
    action: AuditAction.RoleDelete,
    targetType: 'role',
    targetId: id,
  });
  return c.json({ ok: true });
});
