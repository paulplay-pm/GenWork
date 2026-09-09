import type { MiddlewareHandler } from 'hono';

import { auditStore } from '../audit/auditStore';
import { AuditAction, Role } from '../shared/enterpriseServerConstants';
import type { PermissionPoint } from '../shared/permissionPoints';
import { type Claims,verifyToken } from './jwt';
import { roleResolver } from './roleResolver';

declare module 'hono' {
  interface ContextVariableMap {
    claims: Claims;
  }
}

export const requireAuth: MiddlewareHandler = async (c, next) => {
  const h = c.req.header('authorization');
  if (!h?.startsWith('Bearer ')) {
    return c.json({ error: 'unauthorized' }, 401);
  }
  try {
    const claims = await verifyToken(h.slice(7));
    c.set('claims', claims);
    await next();
  } catch {
    return c.json({ error: 'unauthorized' }, 401);
  }
};

/**
 * Capability gate: accepts the request if the caller is `super_admin` OR
 * has the named role in their `extra_roles`. `super_admin` short-circuits
 * every capability check (spec §3.4).
 *
 * On 403 we audit `admin_access_denied` so the audit trail explains why
 * the request was refused.
 */
export function requireCapability(role: string): MiddlewareHandler {
  return async (c, next) => {
    const h = c.req.header('authorization');
    if (!h?.startsWith('Bearer ')) {
      return c.json({ error: 'unauthorized' }, 401);
    }
    let claims: Claims;
    try {
      claims = await verifyToken(h.slice(7));
    } catch {
      return c.json({ error: 'unauthorized' }, 401);
    }
    c.set('claims', claims);
    if (!claims.roles.includes(Role.SuperAdmin) && !claims.roles.includes(role)) {
      await auditStore.write({
        orgId: claims.orgId,
        userId: claims.sub,
        action: 'admin_access_denied',
        targetType: 'route',
        targetId: c.req.path,
        payload: { roles: claims.roles, required: role },
      });
      return c.json({ error: 'forbidden' }, 403);
    }
    await next();
  };
}

/**
 * Permission-point gate. Passes if the caller is `super_admin` OR any of the
 * caller's roles (resolved via `roleResolver` against the live `roles` table)
 * grants the named fine point (`PermissionPoint`, e.g. `user:edit`). Audits
 * `admin_access_denied` on 403, mirroring `requireCapability`.
 */
export function requirePermission(code: PermissionPoint): MiddlewareHandler {
  return async (c, next) => {
    const h = c.req.header('authorization');
    if (!h?.startsWith('Bearer ')) {
      return c.json({ error: 'unauthorized' }, 401);
    }
    let claims: Claims;
    try {
      claims = await verifyToken(h.slice(7));
    } catch {
      return c.json({ error: 'unauthorized' }, 401);
    }
    c.set('claims', claims);
    if (claims.roles.includes(Role.SuperAdmin)) {
      await next();
      return;
    }
    const points = await roleResolver.pointsFor(claims.roles);
    if (points.has(code)) {
      await next();
      return;
    }
    await auditStore.write({
      orgId: claims.orgId,
      userId: claims.sub,
      action: AuditAction.AdminAccessDenied,
      targetType: 'route',
      targetId: c.req.path,
      payload: { roles: claims.roles, required: code },
    });
    return c.json({ error: 'forbidden' }, 403);
  };
}

/** Strict super-admin gate. Used for service-internal mutations. */
export function requireSuperAdmin(): MiddlewareHandler {
  return async (c, next) => {
    const h = c.req.header('authorization');
    if (!h?.startsWith('Bearer ')) {
      return c.json({ error: 'unauthorized' }, 401);
    }
    let claims: Claims;
    try {
      claims = await verifyToken(h.slice(7));
    } catch {
      return c.json({ error: 'unauthorized' }, 401);
    }
    c.set('claims', claims);
    if (!claims.roles.includes(Role.SuperAdmin)) {
      return c.json({ error: 'forbidden' }, 403);
    }
    await next();
  };
}

/**
 * Backward-compat alias. The legacy `requireAdmin` accepted either `admin`
 * or `super_admin`. New code should call `requireCapability('org_admin')`
 * (or whichever role they need). Existing route files keep using
 * `requireAdmin` and continue to work because `'admin'` is a valid string
 * that can appear in `extra_roles`.
 */
export const requireAdmin: MiddlewareHandler = requireCapability('admin');