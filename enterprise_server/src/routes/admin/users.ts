import { type Context, Hono } from 'hono';
import { z } from 'zod';

import { auditStore } from '../../audit/auditStore';
import { requirePermission } from '../../auth/middleware';
import { scopeApi, scopeIncludesDept, type VisibleScope } from '../../auth/scopeResolver';
import { pool } from '../../db/pool';
import { parseCsv, toCsv } from '../../org/csv';
import { BATCH_ACTIONS, generateTempPassword, orgService, UserError } from '../../org/orgService';
import { AuditAction } from '../../shared/enterpriseServerConstants';
import { PermissionPoint as PP } from '../../shared/permissionPoints';

/** Map service conflict errors to HTTP statuses. */
function userErrorStatus(e: { code: string }): 409 | 404 | 400 {
  switch (e.code) {
    case 'email_duplicate':
      return 409;
    case 'dept_not_found':
    case 'not_found':
      return 404;
    default:
      return 400;
  }
}

function handleUserError(c: Context, e: unknown): Response {
  if (e instanceof UserError) return c.json({ error: e.code }, userErrorStatus(e));
  console.error('[users] unexpected error', e);
  return c.json({ error: 'internal_error' }, 500);
}

/** 403 for a user target outside the caller's data scope, with an audit
 * trail. `targetUserId` is null when the denied action would create a user
 * (no target exists yet); `deptId` names the offending department. */
async function denyOutsideScope(
  c: Context,
  claims: { sub: string; orgId: string },
  targetUserId: string | null,
  deptId?: string
): Promise<Response> {
  await auditStore.write({
    orgId: claims.orgId,
    userId: claims.sub,
    action: AuditAction.AdminAccessDenied,
    targetType: 'user',
    targetId: targetUserId,
    payload: { reason: 'outside_scope', deptId: deptId ?? null }
  });
  return c.json({ error: 'forbidden' }, 403);
}

/** True when `userId` is inside the caller's data scope: `all` scopes,
 * `self` for the caller themself, or a `dept` scope covering any of the
 * user's memberships (primary `department_id` or `user_departments`). */
function userInScope(
  scope: VisibleScope,
  callerId: string,
  userId: string,
  userDeptIds: string[]
): boolean {
  if (scope.kind === 'all') return true;
  if (scope.kind === 'self') return userId === callerId;
  return userDeptIds.some((d) => scope.deptIds.includes(d));
}

const userCreateSchema = z.object({
  orgId: z.string(),
  username: z.string().min(1),
  displayName: z.string().nullable().optional(),
  email: z.string().email().nullable().optional(),
  phone: z.string().nullable().optional(),
  position: z.string().nullable().optional(),
  level: z.string().nullable().optional(),
  primaryDeptId: z.string().nullable().optional(),
  departmentId: z.string().nullable().optional(),
  concurrentDeptIds: z.array(z.string()).optional(),
  roles: z.array(z.string()).optional(),
  extraRoles: z.array(z.string()).optional(),
  joinedAt: z.string().nullable().optional(),
  timezone: z.string().optional()
});

const userPatchSchema = z.object({
  displayName: z.string().nullable().optional(),
  email: z.string().email().nullable().optional(),
  phone: z.string().nullable().optional(),
  position: z.string().nullable().optional(),
  level: z.string().nullable().optional(),
  primaryDeptId: z.string().nullable().optional(),
  departmentId: z.string().nullable().optional(),
  concurrentDeptIds: z.array(z.string()).optional(),
  roles: z.array(z.string()).optional(),
  extraRoles: z.array(z.string()).optional(),
  joinedAt: z.string().nullable().optional(),
  timezone: z.string().optional(),
  status: z.enum(['active', 'disabled']).optional()
});

const userBatchSchema = z.object({
  action: z.enum(BATCH_ACTIONS),
  userIds: z.array(z.string()).min(1),
  roleCodes: z.array(z.string()).optional(),
  deptId: z.string().optional()
});

const userImportSchema = z.object({
  orgId: z.string(),
  csv: z.string()
});

/** Export column order (matches the import header). `roles` is joined with
 * `;` (not `,`) so the field survives a CSV round-trip unquoted. */
const USER_CSV_COLUMNS = [
  'username',
  'display_name',
  'email',
  'phone',
  'position',
  'level',
  'primary_dept_code',
  'roles',
  'status',
  'timezone'
];

/** Max data rows (header excluded) accepted by POST /admin/users/import. */
const IMPORT_MAX_ROWS = 1000;

export const adminUserRoutes = new Hono();

adminUserRoutes.get('/admin/users', requirePermission(PP.UserView), async (c) => {
  const claims = c.get('claims');
  const orgId = c.req.query('orgId');
  if (!orgId) return c.json({ error: 'orgId required' }, 400);
  if (orgId !== claims.orgId) return c.json({ error: 'org_mismatch' }, 400);
  const status = c.req.query('status');
  if (status && status !== 'active' && status !== 'disabled') {
    return c.json({ error: 'invalid_status' }, 400);
  }
  const scope = await scopeApi.loadScope(claims);
  const rows = await orgService.listUsers(orgId, scope, c.req.query('q') || undefined, {
    callerId: claims.sub,
    deptId: c.req.query('deptId') || undefined,
    roleId: c.req.query('roleId') || undefined,
    status: status === 'active' || status === 'disabled' ? status : undefined
  });
  return c.json(rows);
});

adminUserRoutes.get('/admin/users/export', requirePermission(PP.UserExport), async (c) => {
  const claims = c.get('claims');
  const orgId = c.req.query('orgId');
  if (!orgId) return c.json({ error: 'orgId required' }, 400);
  if (orgId !== claims.orgId) return c.json({ error: 'org_mismatch' }, 400);
  const scope = await scopeApi.loadScope(claims);
  // Scope-filtered like the list route: a dept-scoped caller's export must
  // not leak other-dept users.
  const rows = await orgService.listUsers(orgId, scope, undefined, { callerId: claims.sub });
  const deptIds = [
    ...new Set(rows.map((r) => r.department_id).filter((d): d is string => d !== null))
  ];
  const codeById = new Map<string, string>();
  if (deptIds.length > 0) {
    const r = await pool.query<{ id: string; code: string | null }>(
      `SELECT id, code FROM departments WHERE id = ANY($1)`,
      [deptIds]
    );
    for (const d of r.rows) if (d.code) codeById.set(d.id, d.code);
  }
  const csv = toCsv(
    rows.map((r) => ({
      username: r.username,
      display_name: r.display_name ?? '',
      email: r.email ?? '',
      phone: r.phone ?? '',
      position: r.position ?? '',
      level: r.level ?? '',
      primary_dept_code: r.department_id ? (codeById.get(r.department_id) ?? '') : '',
      roles: (r.extra_roles ?? []).join(';'),
      status: r.status,
      timezone: r.timezone ?? ''
    })),
    USER_CSV_COLUMNS
  );
  return c.body(csv, 200, {
    'content-type': 'text/csv; charset=utf-8',
    'content-disposition': 'attachment; filename="users.csv"'
  });
});

adminUserRoutes.get('/admin/users/:id', requirePermission(PP.UserView), async (c) => {
  const claims = c.get('claims');
  const id = c.req.param('id');
  const detail = await orgService.getUserFull(id);
  if (!detail || detail.org_id !== claims.orgId) return c.json({ error: 'not_found' }, 404);
  const scope = await scopeApi.loadScope(claims);
  if (!userInScope(scope, claims.sub, detail.id, detail.deptIds)) {
    return denyOutsideScope(c, claims, detail.id);
  }
  return c.json(detail);
});

adminUserRoutes.post('/admin/users', requirePermission(PP.UserCreate), async (c) => {
  const claims = c.get('claims');
  const raw = await c.req.json().catch(() => ({}));
  const parsed = userCreateSchema.safeParse(raw);
  if (!parsed.success) {
    return c.json({ error: 'invalid_input', issues: parsed.error.issues }, 422);
  }
  const body = parsed.data;
  if (body.orgId !== claims.orgId) return c.json({ error: 'org_mismatch' }, 400);
  const scope = await scopeApi.loadScope(claims);
  const primaryDeptId = body.primaryDeptId ?? body.departmentId ?? null;
  const concurrentDeptIds = body.concurrentDeptIds ?? [];
  for (const d of [primaryDeptId, ...concurrentDeptIds]) {
    if (d && !scopeIncludesDept(scope, d)) return denyOutsideScope(c, claims, null, d);
  }
  if (body.email && (await orgService.emailInUse(body.orgId, body.email))) {
    return c.json({ error: 'email_duplicate' }, 409);
  }
  try {
    // Server-generated initial password: the caller supplies no password
    // (same policy as reset-password and CSV import); the SPA shows the
    // returned temp password once.
    const tempPassword = generateTempPassword();
    const { id } = await orgService.createUser({
      orgId: body.orgId,
      username: body.username,
      password: tempPassword,
      displayName: body.displayName ?? null,
      email: body.email ?? null,
      phone: body.phone ?? null,
      position: body.position ?? null,
      level: body.level ?? null,
      primaryDeptId,
      concurrentDeptIds,
      roles: body.roles ?? body.extraRoles,
      joinedAt: body.joinedAt ?? null,
      timezone: body.timezone
    });
    if (primaryDeptId !== null || concurrentDeptIds.length > 0) {
      // The new user carries dept memberships → clear the scope caches,
      // symmetric with the PATCH path's invalidate-on-mutation.
      await scopeApi.invalidate();
    }
    await auditStore.write({
      orgId: body.orgId,
      userId: claims.sub,
      targetUserId: id,
      action: AuditAction.UserCreate,
      targetType: 'user',
      targetId: id,
      payload: { username: body.username }
    });
    return c.json({ id, tempPassword });
  } catch (e) {
    return handleUserError(c, e);
  }
});

adminUserRoutes.patch('/admin/users/:id', requirePermission(PP.UserEdit), async (c) => {
  const claims = c.get('claims');
  const targetId = c.req.param('id');
  const target = await orgService.getUser(targetId);
  if (!target || target.org_id !== claims.orgId) return c.json({ error: 'not_found' }, 404);
  const raw = await c.req.json().catch(() => ({}));
  const parsed = userPatchSchema.safeParse(raw);
  if (!parsed.success) {
    return c.json({ error: 'invalid_input', issues: parsed.error.issues }, 422);
  }
  const body = parsed.data;
  const scope = await scopeApi.loadScope(claims);
  // Target-user data-scope guard (mirrors GET :id): the target must be
  // inside the caller's scope over their FULL membership set (primary +
  // concurrent), or a concurrent-only member would be wrongly denied.
  const targetDeptIds = await scopeApi.deptIdsFor(claims.orgId, targetId);
  if (!userInScope(scope, claims.sub, targetId, targetDeptIds)) {
    return denyOutsideScope(c, claims, targetId);
  }
  const hasDeptFields =
    body.primaryDeptId !== undefined ||
    body.departmentId !== undefined ||
    body.concurrentDeptIds !== undefined;
  const primaryDeptId = body.primaryDeptId ?? body.departmentId ?? null;
  const concurrentDeptIds = body.concurrentDeptIds ?? [];
  if (hasDeptFields) {
    for (const d of [primaryDeptId, ...concurrentDeptIds]) {
      if (d && !scopeIncludesDept(scope, d)) return denyOutsideScope(c, claims, targetId, d);
    }
  }
  if (body.email && (await orgService.emailInUse(claims.orgId, body.email, targetId))) {
    return c.json({ error: 'email_duplicate' }, 409);
  }
  try {
    if (hasDeptFields) {
      await orgService.setUserDepts(targetId, primaryDeptId, concurrentDeptIds);
      // Dept memberships changed → clear the scope caches, mirroring the
      // department routes' invalidate-on-mutation.
      await scopeApi.invalidate();
    }
    await orgService.patchUser(targetId, {
      displayName: body.displayName,
      email: body.email,
      phone: body.phone,
      position: body.position,
      level: body.level,
      joinedAt: body.joinedAt,
      timezone: body.timezone,
      status: body.status,
      roles: body.roles ?? body.extraRoles
    });
    await auditStore.write({
      orgId: claims.orgId,
      userId: claims.sub,
      targetUserId: targetId,
      action: AuditAction.UserPatch,
      targetType: 'user',
      targetId,
      payload: body
    });
    return c.json({ ok: true });
  } catch (e) {
    return handleUserError(c, e);
  }
});

adminUserRoutes.post('/admin/users/:id/disable', requirePermission(PP.UserEdit), async (c) => {
  const claims = c.get('claims');
  const targetId = c.req.param('id');
  const target = await orgService.getUser(targetId);
  if (!target || target.org_id !== claims.orgId) return c.json({ error: 'not_found' }, 404);
  // Target-user data-scope guard (mirrors GET :id, full membership set).
  const scope = await scopeApi.loadScope(claims);
  const targetDeptIds = await scopeApi.deptIdsFor(claims.orgId, targetId);
  if (!userInScope(scope, claims.sub, targetId, targetDeptIds)) {
    return denyOutsideScope(c, claims, targetId);
  }
  await orgService.setUserStatus(targetId, 'disabled');
  await auditStore.write({
    orgId: claims.orgId,
    userId: claims.sub,
    targetUserId: targetId,
    action: AuditAction.UserDisable,
    targetType: 'user',
    targetId
  });
  return c.json({ ok: true });
});

adminUserRoutes.post('/admin/users/:id/enable', requirePermission(PP.UserEdit), async (c) => {
  const claims = c.get('claims');
  const targetId = c.req.param('id');
  const target = await orgService.getUser(targetId);
  if (!target || target.org_id !== claims.orgId) return c.json({ error: 'not_found' }, 404);
  // Target-user data-scope guard (mirrors GET :id, full membership set).
  const scope = await scopeApi.loadScope(claims);
  const targetDeptIds = await scopeApi.deptIdsFor(claims.orgId, targetId);
  if (!userInScope(scope, claims.sub, targetId, targetDeptIds)) {
    return denyOutsideScope(c, claims, targetId);
  }
  await orgService.setUserStatus(targetId, 'active');
  await auditStore.write({
    orgId: claims.orgId,
    userId: claims.sub,
    targetUserId: targetId,
    action: AuditAction.UserEnable,
    targetType: 'user',
    targetId
  });
  return c.json({ ok: true });
});

adminUserRoutes.post('/admin/users/:id/reset-password', requirePermission(PP.UserEdit), async (c) => {
  const claims = c.get('claims');
  const targetId = c.req.param('id');
  const target = await orgService.getUser(targetId);
  if (!target || target.org_id !== claims.orgId) return c.json({ error: 'not_found' }, 404);
  // Target-user data-scope guard (mirrors GET :id, full membership set).
  const scope = await scopeApi.loadScope(claims);
  const targetDeptIds = await scopeApi.deptIdsFor(claims.orgId, targetId);
  if (!userInScope(scope, claims.sub, targetId, targetDeptIds)) {
    return denyOutsideScope(c, claims, targetId);
  }
  // Server-generated: the caller supplies no password; the SPA shows the
  // returned temp password once.
  const tempPassword = generateTempPassword();
  const found = await orgService.resetPassword(targetId, tempPassword);
  if (!found) return c.json({ error: 'not_found' }, 404);
  await auditStore.write({
    orgId: claims.orgId,
    userId: claims.sub,
    targetUserId: targetId,
    action: AuditAction.UserResetPassword,
    targetType: 'user',
    targetId
  });
  return c.json({ tempPassword });
});

adminUserRoutes.post('/admin/users/batch', requirePermission(PP.UserEdit), async (c) => {
  const claims = c.get('claims');
  const raw = await c.req.json().catch(() => ({}));
  const parsed = userBatchSchema.safeParse(raw);
  if (!parsed.success) {
    return c.json({ error: 'invalid_input', issues: parsed.error.issues }, 422);
  }
  const body = parsed.data;
  if (body.action === 'assign_role' && (body.roleCodes ?? []).length === 0) {
    return c.json({ error: 'roleCodes required' }, 422);
  }
  const scope = await scopeApi.loadScope(claims);
  if (body.action === 'adjust_dept') {
    const deptId = body.deptId;
    if (!deptId) return c.json({ error: 'deptId required' }, 422);
    // The destination dept must be inside the caller's scope. The denied
    // entity is the destination DEPT (target_type 'dept', consistent with
    // the department routes), not a user.
    if (!scopeIncludesDept(scope, deptId)) {
      await auditStore.write({
        orgId: claims.orgId,
        userId: claims.sub,
        action: AuditAction.AdminAccessDenied,
        targetType: 'dept',
        targetId: deptId,
        payload: { reason: 'outside_scope', action: body.action }
      });
      return c.json({ error: 'forbidden' }, 403);
    }
    if (!(await orgService.deptInOrg(deptId, claims.orgId))) {
      return c.json({ error: 'dept_not_found' }, 404);
    }
  }
  // Fail-closed, checked BEFORE any write: every target must be visible to
  // the caller (the same rule as the per-user guards, so batch-allowed ⊆
  // per-user-allowed). Cross-org ids fail this too — 403 rather than 404,
  // which is not a leak: the caller must already know the ids.
  const visible = await orgService.visibleUserIds(claims.orgId, scope, claims.sub);
  if (body.userIds.some((id) => !visible.has(id))) {
    await auditStore.write({
      orgId: claims.orgId,
      userId: claims.sub,
      action: AuditAction.AdminAccessDenied,
      targetType: 'route',
      targetId: c.req.path,
      payload: { reason: 'outside_scope', action: body.action, userIds: body.userIds }
    });
    return c.json({ error: 'forbidden' }, 403);
  }
  // Visibility guarantees every id exists, so only duplicates can make the
  // applied count differ from userIds.length (applyBatch dedupes).
  const uniqueIds = [...new Set(body.userIds)];
  try {
    const tempPasswords = await orgService.applyBatch({
      orgId: claims.orgId,
      action: body.action,
      userIds: uniqueIds,
      roleCodes: body.roleCodes,
      deptId: body.deptId
    });
    await auditStore.write({
      orgId: claims.orgId,
      userId: claims.sub,
      action: AuditAction.UserBatch,
      targetType: 'user',
      targetId: body.userIds[0] ?? null,
      payload: { action: body.action, userIds: body.userIds }
    });
    // adjust_dept changes dept memberships → clear the scope caches,
    // mirroring the per-user mutation path.
    await scopeApi.invalidate();
    if (body.action === 'reset_password') {
      // Bulk reset is useless without the passwords: surface them so the
      // admin can distribute them.
      return c.json({ ok: true, affected: uniqueIds.length, tempPasswords });
    }
    return c.json({ ok: true, affected: uniqueIds.length });
  } catch (e) {
    return handleUserError(c, e);
  }
});

adminUserRoutes.post('/admin/users/import', requirePermission(PP.UserCreate), async (c) => {
  const claims = c.get('claims');
  const raw = await c.req.json().catch(() => ({}));
  const parsed = userImportSchema.safeParse(raw);
  if (!parsed.success) {
    return c.json({ error: 'invalid_input', issues: parsed.error.issues }, 422);
  }
  const body = parsed.data;
  if (body.orgId !== claims.orgId) return c.json({ error: 'org_mismatch' }, 400);
  const rows = parseCsv(body.csv);
  // Bound the work: per-row validation is query-heavy, so cap the import at
  // IMPORT_MAX_ROWS data rows (header excluded), before creating anything.
  if (rows.length - 1 > IMPORT_MAX_ROWS) {
    return c.json({ error: 'too_many_rows', limit: IMPORT_MAX_ROWS }, 422);
  }
  const errors: { row: number; reason: string }[] = [];
  const tempPasswords: { username: string; tempPassword: string }[] = [];
  let created = 0;
  if (rows.length === 0) {
    return c.json({ created: 0, skipped: 0, errors, tempPasswords });
  }
  // First row is the header: column name → index (trimmed; unknown/extra
  // columns are simply never looked up).
  const header = rows[0]!;
  const col = new Map<string, number>();
  header.forEach((name, i) => {
    const key = name.trim();
    if (key && !col.has(key)) col.set(key, i);
  });
  const cell = (row: string[], name: string): string => {
    const i = col.get(name);
    return i === undefined ? '' : (row[i] ?? '').trim();
  };
  const depts = await pool.query<{ id: string; code: string | null }>(
    `SELECT id, code FROM departments WHERE org_id=$1`,
    [claims.orgId]
  );
  const deptByCode = new Map<string, string>();
  for (const d of depts.rows) if (d.code) deptByCode.set(d.code, d.id);
  const roleRows = await pool.query<{ name: string }>(`SELECT name FROM roles`);
  const roleNames = new Set(roleRows.rows.map((r) => r.name));
  const seenUsernames = new Set<string>();
  for (let i = 1; i < rows.length; i += 1) {
    const row = rows[i]!;
    const lineNo = i + 1; // 1-based over the CSV, header = row 1
    const username = cell(row, 'username');
    if (!username) {
      errors.push({ row: lineNo, reason: 'username required' });
      continue;
    }
    if (seenUsernames.has(username)) {
      errors.push({ row: lineNo, reason: `duplicate username "${username}" in batch` });
      continue;
    }
    const existing = await pool.query(`SELECT 1 FROM users WHERE org_id=$1 AND username=$2`, [
      claims.orgId,
      username
    ]);
    if ((existing.rowCount ?? 0) > 0) {
      errors.push({ row: lineNo, reason: `username "${username}" already exists in org` });
      continue;
    }
    const email = cell(row, 'email');
    if (email) {
      if (!z.string().email().safeParse(email).success) {
        errors.push({ row: lineNo, reason: `invalid email "${email}"` });
        continue;
      }
      if (await orgService.emailInUse(claims.orgId, email)) {
        errors.push({ row: lineNo, reason: `email "${email}" already in use` });
        continue;
      }
    }
    const deptCode = cell(row, 'primary_dept_code');
    let primaryDeptId: string | null = null;
    if (deptCode) {
      const resolved = deptByCode.get(deptCode);
      if (resolved === undefined) {
        errors.push({ row: lineNo, reason: `unknown department code "${deptCode}"` });
        continue;
      }
      primaryDeptId = resolved;
    }
    const csvRoles = cell(row, 'roles')
      .split(';')
      .map((s) => s.trim())
      .filter((s) => s !== '');
    const unknownRole = csvRoles.find((rc) => !roleNames.has(rc));
    if (unknownRole) {
      errors.push({ row: lineNo, reason: `unknown role "${unknownRole}"` });
      continue;
    }
    // CSV roles land on top of the default 'member' (the service defaults to
    // ['member'] when roles is omitted; keep it when the CSV lists roles).
    let roles: string[] | undefined;
    if (csvRoles.length > 0) {
      roles = csvRoles.includes('member') ? csvRoles : [...csvRoles, 'member'];
    }
    seenUsernames.add(username);
    // Server-generated temp password: the CSV carries no password column.
    const tempPassword = generateTempPassword();
    try {
      const createdUser = await orgService.createUser({
        orgId: claims.orgId,
        username,
        password: tempPassword,
        displayName: cell(row, 'display_name') || null,
        email: email || null,
        phone: cell(row, 'phone') || null,
        position: cell(row, 'position') || null,
        level: cell(row, 'level') || null,
        primaryDeptId,
        roles,
        timezone: cell(row, 'timezone') || undefined
      });
      // Audit like the single-create path: one user_create row per imported
      // user, so "user X created by admin Y" holds whether users were
      // created one-by-one or in bulk (the bulk path hands out a temp
      // password per user and must not leave zero trace).
      await auditStore.write({
        orgId: claims.orgId,
        userId: claims.sub,
        targetUserId: createdUser.id,
        action: AuditAction.UserCreate,
        targetType: 'user',
        targetId: createdUser.id,
        payload: { username, source: 'csv_import' }
      });
    } catch (e) {
      if (e instanceof UserError) {
        // Race backstops (email/username/dept) — report as a row error.
        errors.push({ row: lineNo, reason: e.code });
        continue;
      }
      // createUser commits per row (import is intentionally partial-success),
      // so surface the partial result: the client learns how many users
      // landed — and their temp passwords — despite the failure.
      console.error('[users] import row create failed', e);
      return c.json(
        { error: 'partial_import_failed', created, skipped: errors.length, errors, tempPasswords },
        500
      );
    }
    created += 1;
    tempPasswords.push({ username, tempPassword });
  }
  // New users may carry dept memberships → clear the scope caches.
  await scopeApi.invalidate();
  return c.json({ created, skipped: errors.length, errors, tempPasswords });
});
