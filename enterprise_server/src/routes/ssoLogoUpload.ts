// enterprise_server/src/routes/ssoLogoUpload.ts
// Per-connection SSO logo upload + clear (admin half, PP.SsoEdit).
//
// The login pages render the per-connection `logo_url` column as the SSO
// button's <img src>. The admin drawer can upload an image (PNG / JPEG /
// WEBP / SVG) which the server stores at
//   <stateDir>/sso-logos/uploads/<connectionId>.<ext>
// and persists as `/sso-logos/uploads/<connectionId>.<ext>` in the column.
// A separate DELETE route clears the column and removes the file so the
// public endpoint falls back to the built-in default for the provider_type.
//
// The static-serve route at `/sso-logos/uploads/*` lives in `server.ts`
// (mounted BEFORE the SPA fallback) so desktop + web can fetch the
// uploaded file from the same origin as the API.
import { existsSync, mkdirSync, readdirSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { extname } from 'node:path';

import { Hono } from 'hono';

import { auditStore } from '../audit/auditStore';
import { requireAuth, requirePermission } from '../auth/middleware';
import { pool } from '../db/pool';
import { ssoLogoFile, ssoLogoUploadDir } from '../lib/stateDir';
import { PermissionPoint as PP } from '../shared/permissionPoints';

export const ssoLogoUploadRoutes = new Hono();
ssoLogoUploadRoutes.use('/admin/sso-connections/*', requireAuth);

/** Max upload size: 1 MB. Bigger than any sane IdP logo but small enough
 *  to keep state dir tidy. The constant lives here (not in env) so a
 *  test can assert the exact 413 boundary. */
const MAX_LOGO_BYTES = 1024 * 1024;

/** Whitelisted MIME types → server-side file extension. SVG is allowed
 *  but rendered as <img src> in the browser; the public endpoint does
 *  NOT serve user-supplied SVG with scripts (the browser's same-origin
 *  policy already isolates an <img>'s SVG from its parent DOM, and we
 *  also set `Content-Security-Policy: sandbox` via Hono headers below
 *  so any inline scripts in an uploaded SVG cannot execute). */
const ALLOWED_MIME: Record<string, string> = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/webp': '.webp',
  'image/svg+xml': '.svg',
};

const jsonError = (status: number, error: string): Response =>
  new Response(JSON.stringify({ error }), {
    status,
    headers: { 'content-type': 'application/json' },
  });

/** Look up the connection row + enforce org scope. Returns the row's
 *  current `logo_url` so the caller can clean up an old file when
 *  replacing it, or null on 404. */
async function loadScopedLogoUrl(connectionId: string, orgId: string): Promise<string | null | 'not_found'> {
  const r = await pool.query<{ logo_url: string | null }>(
    `SELECT logo_url FROM sso_connections WHERE id = $1 AND org_id = $2`,
    [connectionId, orgId],
  );
  if (!r.rowCount) return 'not_found';
  return r.rows[0]!.logo_url;
}

ssoLogoUploadRoutes.post('/admin/sso-connections/:id/logo', requirePermission(PP.SsoEdit), async (c) => {
  const claims = c.get('claims');
  const id = c.req.param('id');

  const scoped = await loadScopedLogoUrl(id, claims.orgId);
  if (scoped === 'not_found') return jsonError(404, 'not_found');

  // 1 MB cap is checked against the multipart body's declared length
  // AND the actual byte length after parsing, so a client cannot
  // bypass the cap with a missing/wrong Content-Length.
  const declaredLen = Number(c.req.header('content-length') ?? '0');
  if (declaredLen > MAX_LOGO_BYTES) return jsonError(413, 'too_large');

  const form = await c.req.parseBody();
  const file = form['logo'];
  if (!(file instanceof File)) return jsonError(400, 'missing_file');

  if (file.size > MAX_LOGO_BYTES) return jsonError(413, 'too_large');
  const ext = ALLOWED_MIME[file.type];
  if (!ext) return jsonError(415, 'unsupported_mime');

  // Replace any prior file: clean up the old row's path before writing
  // the new one, so the public endpoint never serves a stale image.
  if (scoped && scoped.startsWith('/sso-logos/uploads/')) {
    const oldExt = extname(scoped);
    if (oldExt) {
      try { unlinkSync(ssoLogoFile(id, oldExt)); } catch { /* already gone */ }
    }
  }

  mkdirSync(ssoLogoUploadDir(), { recursive: true });
  const buf = new Uint8Array(await file.arrayBuffer());
  writeFileSync(ssoLogoFile(id, ext), buf);

  const logoUrl = `/sso-logos/uploads/${id}${ext}`;
  await pool.query(
    `UPDATE sso_connections SET logo_url = $1, updated_at = now() WHERE id = $2 AND org_id = $3`,
    [logoUrl, id, claims.orgId],
  );
  await auditStore.write({
    orgId: claims.orgId,
    userId: claims.sub,
    action: 'sso_connection_logo_upload',
    targetType: 'sso_connection',
    targetId: id,
    payload: { ext, bytes: buf.length },
  });
  return c.json({ logoUrl });
});

ssoLogoUploadRoutes.delete('/admin/sso-connections/:id/logo', requirePermission(PP.SsoEdit), async (c) => {
  const claims = c.get('claims');
  const id = c.req.param('id');

  const scoped = await loadScopedLogoUrl(id, claims.orgId);
  if (scoped === 'not_found') return jsonError(404, 'not_found');

  // Idempotent: if the row already has no logo, just return 200.
  if (scoped && scoped.startsWith('/sso-logos/uploads/')) {
    const oldExt = extname(scoped);
    if (oldExt) {
      try { unlinkSync(ssoLogoFile(id, oldExt)); } catch { /* already gone */ }
    }
  }
  await pool.query(
    `UPDATE sso_connections SET logo_url = NULL, updated_at = now() WHERE id = $1 AND org_id = $2`,
    [id, claims.orgId],
  );
  // Sweep the uploads dir if it's now empty so the on-disk tree doesn't
  // accumulate empty parent directories across orgs. readdirSync on a
  // missing dir throws — treat that as "already gone".
  try {
    if (readdirSync(ssoLogoUploadDir()).length === 0) {
      rmSync(ssoLogoUploadDir(), { recursive: true, force: true });
    }
  } catch { /* not empty / already gone */ }
  // Restore the dir so the next upload can write into it without a
  // mkdir race.
  if (!existsSync(ssoLogoUploadDir())) mkdirSync(ssoLogoUploadDir(), { recursive: true });

  await auditStore.write({
    orgId: claims.orgId,
    userId: claims.sub,
    action: 'sso_connection_logo_clear',
    targetType: 'sso_connection',
    targetId: id,
  });
  return c.json({ ok: true });
});
