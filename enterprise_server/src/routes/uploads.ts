import { Buffer } from 'node:buffer';
import { mkdirSync, rmSync,writeFileSync } from 'node:fs';
import { join } from 'node:path';

import AdmZip from 'adm-zip';
import { Hono } from 'hono';

import { requireAuth } from '../auth/middleware';
import { pool } from '../db/pool';
import { htmlShareDir } from '../lib/stateDir';

const MAX_BYTES = 50 * 1024 * 1024;

export const uploadRoutes = new Hono();
uploadRoutes.use('/api/uploads/*', requireAuth);

uploadRoutes.post('/api/uploads/:shareId', async (c) => {
  const claims = c.get('claims');
  const shareId = c.req.param('shareId');

  const r = await pool.query<{ user_id: string }>(
    `SELECT user_id FROM html_shares WHERE share_id = $1 AND org_id = $2`,
    [shareId, claims.orgId]
  );
  const row = r.rows[0];
  if (!row) return c.json({ error: 'not_found' }, 404);
  if (row.user_id !== claims.sub) return c.json({ error: 'not_owner' }, 401);

  const buf = Buffer.from(await c.req.arrayBuffer());
  if (buf.byteLength === 0) return c.json({ error: 'empty' }, 400);
  if (buf.byteLength > MAX_BYTES) return c.json({ error: 'too_large' }, 413);

  const dir = htmlShareDir(shareId);
  // Wipe any prior contents so a re-upload is a clean replacement.
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  const zipPath = join(dir, 'archive.zip');
  writeFileSync(zipPath, buf);

  let entryFile: string | null = null;
  let totalFiles = 0;
  let totalBytes = 0;
  const warnings: string[] = [];
  try {
    const zip = new AdmZip(buf);
    const entries = zip.getEntries();
    totalFiles = entries.length;
    totalBytes = entries.reduce((sum, e) => sum + e.header.size, 0);
    entryFile = entries.find((e) => !e.isDirectory && /\.html?$/i.test(e.entryName))?.entryName ?? null;
    if (!entryFile) warnings.push('no html entry found');
    // Extract every entry to disk so the public-page route can serve files
    // without re-parsing the zip on every request. adm-zip sanitizes paths
    // against zip-slip by default; double-check by resolving the final
    // absolute path and rejecting anything outside the share directory.
    const absoluteRoot = dir + '/';
    for (const e of entries) {
      const outPath = join(dir, e.entryName);
      const resolved = outPath;
      if (!resolved.startsWith(absoluteRoot)) {
        warnings.push(`skipped unsafe entry: ${e.entryName}`);
        continue;
      }
      if (e.isDirectory) {
        mkdirSync(resolved, { recursive: true });
      } else {
        mkdirSync(join(resolved, '..'), { recursive: true });
        writeFileSync(resolved, e.getData());
      }
    }
  } catch (e) {
    warnings.push(`zip parse failed: ${(e as Error).message}`);
  }

  await pool.query(
    `UPDATE html_shares
       SET entry_file = $1, total_files = $2, total_bytes = $3, warnings_json = $4
       WHERE share_id = $5`,
    [entryFile, totalFiles, totalBytes, JSON.stringify(warnings), shareId]
  );

  return c.json({ status: 'uploaded', entryFile, totalFiles, totalBytes, warnings });
});
