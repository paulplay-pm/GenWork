import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { Hono } from 'hono';

import { requireAuth } from '../auth/middleware';
import { descendantsOf, scopeApi } from '../auth/scopeResolver';
import { pool } from '../db/pool';
import { kitStoreDir } from '../lib/stateDir';
import type { KitRow } from '../models/kitCatalog';
import { Role } from '../shared/enterpriseServerConstants';

/** Reshape a DB row to the desktop MarketplaceKit wire shape. `skills.bundle`
 * is a RELATIVE path — the desktop main process absolutizes it against
 * ENTERPRISE_SERVER_URL before downloading (and installs authed). */
function mapPublicKit(row: KitRow) {
  return {
    id: row.slug,
    name: { en: row.name_en ?? '', zh: row.name_zh ?? '' },
    description: { en: row.description_en ?? '', zh: row.description_zh ?? '' },
    icon: row.icon_url ?? undefined,
    author: row.author ?? undefined,
    version: row.version ?? undefined,
    tryAsking: row.try_asking,
    skills: { bundle: `/api/kits/download/${row.slug}`, list: row.skill_list },
  };
}

/** Shared visibility re-check for download: the row must exist in the caller's
 * org, be enabled, and the caller be a super_admin, or the scope grant applies
 * (allCompany ∨ userIds ∋ sub ∨ caller depts ∩ descendantsOf(granted deptIds)).
 * Org only ever comes from the JWT. */
async function visibleKit(slug: string, orgId: string, sub: string, roles: string[]): Promise<KitRow | null> {
  const r = await pool.query<KitRow>(
    'SELECT * FROM kit_catalog WHERE slug = $1 AND org_id = $2 AND enabled = TRUE', [slug, orgId]);
  const row = r.rows[0];
  if (!row) return null;
  if (roles.includes(Role.SuperAdmin)) return row;
  if (row.scope?.allCompany) return row;
  if ((row.scope?.userIds ?? []).includes(sub)) return row;
  const callerDepts = await scopeApi.deptIdsFor(orgId, sub);
  const deptRows = await pool.query<{ id: string; path: string }>(
    `SELECT id, path FROM departments WHERE org_id = $1`, [orgId]);
  const deptPath = new Map(deptRows.rows.map((x) => [x.id, x.path]));
  const grantedSubtree = descendantsOf(row.scope?.deptIds ?? [], deptPath);
  return callerDepts.some((d) => grantedSubtree.has(d)) ? row : null;
}

export const kitCatalogRoutes = new Hono();
kitCatalogRoutes.use('/api/kits/*', requireAuth);

kitCatalogRoutes.get('/api/kits', async (c) => {
  const claims = c.get('claims');
  const orgId = claims.orgId;
  const isSuperAdmin = (claims.roles ?? []).includes(Role.SuperAdmin);
  const callerDepts = isSuperAdmin ? [] : await scopeApi.deptIdsFor(orgId, claims.sub);
  const callerSet = new Set(callerDepts);
  const deptRows = await pool.query<{ id: string; path: string }>(
    `SELECT id, path FROM departments WHERE org_id = $1`, [orgId]);
  const deptPath = new Map(deptRows.rows.map((r) => [r.id, r.path]));

  const r = await pool.query<KitRow>(
    `SELECT * FROM kit_catalog WHERE org_id = $1 AND enabled = TRUE ORDER BY updated_at DESC`, [orgId]);

  const visible = r.rows.filter((row) => {
    if (isSuperAdmin) return true;
    if (row.scope?.allCompany) return true;
    if ((row.scope?.userIds ?? []).includes(claims.sub)) return true;
    // A kit granted to a parent dept is visible to any user in that dept's
    // subtree: expand the GRANTED depts to their descendants and check whether
    // the caller's own depts intersect that subtree.
    const grantedSubtree = descendantsOf(row.scope?.deptIds ?? [], deptPath);
    for (const d of callerSet) if (grantedSubtree.has(d)) return true;
    return false;
  });

  return c.json({ kits: visible.map(mapPublicKit) });
});

kitCatalogRoutes.get('/api/kits/download/:slug', async (c) => {
  const slug = c.req.param('slug');
  const claims = c.get('claims');

  const row = await visibleKit(slug, claims.orgId, claims.sub, claims.roles ?? []);
  if (!row) return c.json({ error: 'not_found' }, 404);

  const file = join(kitStoreDir(slug), 'kit.zip');
  let buf: Buffer<ArrayBuffer>;
  try {
    buf = await readFile(file);
  } catch {
    return c.json({ error: 'not_found' }, 404);
  }
  return c.body(buf, 200, {
    'content-type': 'application/zip',
    'content-disposition': `attachment; filename="${slug}.zip"`,
  });
});
