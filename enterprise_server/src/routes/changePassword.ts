import { Hono } from 'hono';
import { z, ZodError } from 'zod';
import { requireAuth } from '../auth/middleware';
import { pool } from '../db/pool';
import { verifyPassword, hashPassword } from '../auth/password';
import { auditStore } from '../audit/auditStore';
import { AuditAction } from '../shared/enterpriseServerConstants';

export const changePasswordRoutes = new Hono();
changePasswordRoutes.use('/auth/change-password', requireAuth);

const schema = z.object({
  currentPassword: z.string().min(1),
  newPassword: z.string().min(8),
});

changePasswordRoutes.post('/auth/change-password', async (c) => {
  const raw = await c.req.json().catch(() => ({}));
  const result = schema.safeParse(raw);
  if (!result.success) {
    return c.json({ error: 'invalid_input', issues: (result.error as ZodError).issues }, 422);
  }
  const body = result.data;
  const claims = c.get('claims');
  const r = await pool.query<{ password_hash: string }>(
    `SELECT password_hash FROM users WHERE id=$1`,
    [claims.sub]
  );
  if (r.rowCount === 0) return c.json({ error: 'user_not_found' }, 404);
  const ok = await verifyPassword(body.currentPassword, r.rows[0].password_hash);
  if (!ok) return c.json({ error: 'invalid_current' }, 401);
  const newHash = await hashPassword(body.newPassword);
  await pool.query(`UPDATE users SET password_hash=$1 WHERE id=$2`, [newHash, claims.sub]);
  await auditStore.write({
    orgId: claims.orgId,
    userId: claims.sub,
    action: AuditAction.PasswordChange,
  });
  return c.json({ ok: true });
});