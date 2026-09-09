import { randomUUID } from 'node:crypto';

import { Hono } from 'hono';

import { auditStore } from '../audit/auditStore';
import { requireAuth } from '../auth/middleware';
import { pool } from '../db/pool';
import { AuditAction } from '../shared/enterpriseServerConstants';

interface CreateHtmlShareBody {
  title: string;
  sourceType: string;
  sourceSha256: string;
  sourceFileName?: string;
  clientSourceKey: string;
  sessionId?: string;
  artifactId?: string;
  visibility?: string;
  accessMode?: string;
  expiresAt?: string | null;
}

/**
 * Access mode at create time. Only `org` (login-gated, org-only) or `public`
 * are meaningful to the page server — `code` is a legacy value that serves
 * identically to public, so it is never minted at create. `org` shares are
 * gated atomically: the login redirect / 401 the page server applies is based
 * on this column, not on a separate post-create PATCH.
 */
const accessModeForCreate = (raw: string | undefined): 'org' | 'public' =>
  raw === 'org' ? 'org' : 'public';

export const htmlSharesRoutes = new Hono();
htmlSharesRoutes.use('/api/html-shares/*', requireAuth);

const generatePublicUrl = (req: Request, shareId: string): string => {
  const u = new URL(req.url);
  return `${u.protocol}//${u.host}/api/pages/${shareId}`;
};

htmlSharesRoutes.post('/api/html-shares', async (c) => {
  const claims = c.get('claims');
  const body = await c.req.json<CreateHtmlShareBody>();
  if (!body.title || !body.sourceType || !body.sourceSha256 || !body.clientSourceKey) {
    return c.json({ error: 'invalid_body' }, 400);
  }
  const shareId = randomUUID();
  const accessMode = accessModeForCreate(body.accessMode);
  await pool.query(
    `INSERT INTO html_shares
       (share_id, org_id, user_id, title, source_type, source_sha256,
        source_filename, visibility, expires_at, client_source_key, access_mode)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
    [
      shareId,
      claims.orgId,
      claims.sub,
      body.title,
      body.sourceType,
      body.sourceSha256,
      body.sourceFileName ?? null,
      body.visibility ?? 'public',
      body.expiresAt ? new Date(body.expiresAt) : null,
      body.clientSourceKey,
      accessMode,
    ]
  );
  await auditStore.write({
    orgId: claims.orgId,
    userId: claims.sub,
    action: AuditAction.HtmlShareCreate,
    targetType: 'html_share',
    targetId: shareId,
    payload: { title: body.title, source_type: body.sourceType, remote_ip: c.req.header('x-forwarded-for') ?? null },
  });
  return c.json({
    shareId,
    publicUrl: generatePublicUrl(c.req.raw, shareId),
    expiresAt: body.expiresAt ?? null,
    accessMode,
  });
});

htmlSharesRoutes.get('/api/html-shares', async (c) => {
  const claims = c.get('claims');
  const sourceType = c.req.query('sourceType');
  const clientSourceKey = c.req.query('clientSourceKey');
  if (!sourceType || !clientSourceKey) {
    return c.json({ error: 'missing_query_params' }, 400);
  }
  const r = await pool.query<{
    share_id: string;
    org_id: string;
    user_id: string;
    source_type: string | null;
    client_source_key: string | null;
    access_mode: string;
    expires_at: Date | null;
    title: string;
  }>(
    `SELECT share_id, org_id, user_id, source_type, client_source_key, access_mode, expires_at, title
       FROM html_shares
       WHERE org_id = $1 AND source_type = $2 AND client_source_key = $3
       ORDER BY created_at DESC LIMIT 1`,
    [claims.orgId, sourceType, clientSourceKey]
  );
  return c.json({ shares: r.rows });
});

htmlSharesRoutes.get('/api/html-shares/quota', async (c) => {
  const claims = c.get('claims');
  const r = await pool.query<{ used: string }>(
    `SELECT COUNT(*)::text AS used FROM html_shares
      WHERE org_id = $1 AND user_id = $2 AND created_at >= NOW() - INTERVAL '1 day'`,
    [claims.orgId, claims.sub]
  );
  const used = Number(r.rows[0]?.used ?? 0);
  return c.json({ used, quota: 100 });
});

htmlSharesRoutes.get('/api/html-shares/:shareId', async (c) => {
  const claims = c.get('claims');
  const shareId = c.req.param('shareId');
  const r = await pool.query<{
    share_id: string;
    title: string;
    source_type: string;
    entry_file: string | null;
    total_files: number | null;
    total_bytes: string | null;
    created_at: Date;
    expires_at: Date | null;
  }>(
    `SELECT share_id, title, source_type, entry_file, total_files, total_bytes, created_at, expires_at
       FROM html_shares WHERE share_id = $1 AND org_id = $2`,
    [shareId, claims.orgId]
  );
  const row = r.rows[0];
  if (!row) return c.json({ error: 'not_found' }, 404);
  return c.json({
    shareId: row.share_id,
    title: row.title,
    sourceType: row.source_type,
    entryFile: row.entry_file,
    totalFiles: row.total_files,
    totalBytes: row.total_bytes === null ? null : Number(row.total_bytes),
    createdAt: row.created_at.toISOString(),
    expiresAt: row.expires_at ? row.expires_at.toISOString() : null,
  });
});

htmlSharesRoutes.delete('/api/html-shares/:shareId', async (c) => {
  const claims = c.get('claims');
  const shareId = c.req.param('shareId');
  const r = await pool.query<{ user_id: string }>(
    `SELECT user_id FROM html_shares WHERE share_id = $1 AND org_id = $2`,
    [shareId, claims.orgId]
  );
  const row = r.rows[0];
  if (!row) return c.json({ error: 'not_found' }, 404);
  if (row.user_id !== claims.sub) return c.json({ error: 'not_owner' }, 401);
  await pool.query(`DELETE FROM html_shares WHERE share_id = $1`, [shareId]);
  await auditStore.write({
    orgId: claims.orgId,
    userId: claims.sub,
    action: AuditAction.HtmlShareDelete,
    targetType: 'html_share',
    targetId: shareId,
  });
  return c.json({ deleted: true });
});
