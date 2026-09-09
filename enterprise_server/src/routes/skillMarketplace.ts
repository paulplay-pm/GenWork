import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { Hono } from 'hono';
import { z } from 'zod';

import { requireAuth } from '../auth/middleware';
import { descendantsOf, scopeApi } from '../auth/scopeResolver';
import { pool } from '../db/pool';
import { skillStoreDir } from '../lib/stateDir';
import {
  mapPublicSkill,
  PUBLIC_SKILL_COLUMNS,
  type SkillPublicRow,
} from '../models/skillMarketplaceView';
import { Role } from '../shared/enterpriseServerConstants';

const verifyBodySchema = z.object({ name: z.string().min(1) });
const eventsBodySchema = z.object({ name: z.string().min(1), event: z.string().min(1) });

/** Shared visibility re-check for download/verify: returns the row only when
 * it exists in the caller's org, is enabled, and the caller is a superadmin,
 * or the scope grants (allCompany ∨ userIds ∋ sub ∨ caller depts ∩
 * descendantsOf(granted deptIds)). Org only ever comes from the JWT. */
async function visibleSkill(id: string, orgId: string, sub: string, roles: string[]): Promise<SkillPublicRow | null> {
  const r = await pool.query<SkillPublicRow>(
    `SELECT ${PUBLIC_SKILL_COLUMNS}
       FROM skill_marketplace_skills WHERE skill_id = $1 AND org_id = $2 AND enabled = TRUE`,
    [id, orgId],
  );
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

export const skillMarketplaceRoutes = new Hono();
skillMarketplaceRoutes.use('/api/skill-marketplace/*', requireAuth);

skillMarketplaceRoutes.get('/api/skill-marketplace', async (c) => {
  const claims = c.get('claims');
  const orgId = claims.orgId;
  const isSuperAdmin = (claims.roles ?? []).includes(Role.SuperAdmin);

  // The caller's own (leaf) department memberships.
  const callerDepts = isSuperAdmin ? [] : await scopeApi.deptIdsFor(orgId, claims.sub);
  const callerSet = new Set(callerDepts);

  // All dept paths in the org, once, to expand a skill's granted depts to
  // their subtree.
  const deptRows = await pool.query<{ id: string; path: string }>(
    `SELECT id, path FROM departments WHERE org_id = $1`, [orgId]);
  const deptPath = new Map(deptRows.rows.map((r) => [r.id, r.path]));

  const r = await pool.query<SkillPublicRow>(
    `SELECT ${PUBLIC_SKILL_COLUMNS}
       FROM skill_marketplace_skills WHERE org_id = $1 AND enabled = TRUE
       ORDER BY updated_at DESC`,
    [orgId],
  );

  const visible = r.rows.filter((row) => {
    if (isSuperAdmin) return true;
    if (row.scope?.allCompany) return true;
    if ((row.scope?.userIds ?? []).includes(claims.sub)) return true;
    // A skill granted to a parent dept is visible to any user in that dept's
    // subtree: expand the GRANTED depts to their descendants and check whether
    // the caller's own depts intersect that subtree.
    const grantedSubtree = descendantsOf(row.scope?.deptIds ?? [], deptPath);
    for (const d of callerSet) if (grantedSubtree.has(d)) return true;
    return false;
  });

  const catIds = Array.from(new Set(visible.map((v) => v.category_id)));
  const cats = catIds.length === 0
    ? { rows: [] as { category_id: string; name_zh: string; name_en: string }[] }
    : await pool.query<{ category_id: string; name_zh: string; name_en: string }>(
        `SELECT category_id, name_zh, name_en
           FROM skill_marketplace_categories
          WHERE org_id = $1 AND category_id = ANY($2) ORDER BY category_id`,
        [orgId, catIds]);

  return c.json({
    categories: cats.rows.map((cat) => ({ id: cat.category_id, name_zh: cat.name_zh, name_en: cat.name_en })),
    skills: visible.map(mapPublicSkill),
  });
});

skillMarketplaceRoutes.get('/api/skill-marketplace/download/:id', async (c) => {
  const id = c.req.param('id');
  const claims = c.get('claims');

  const row = await visibleSkill(id, claims.orgId, claims.sub, claims.roles ?? []);
  if (!row) return c.json({ error: 'not_found' }, 404);

  const file = join(skillStoreDir(id), 'skill.zip');
  let buf: Buffer<ArrayBuffer>;
  try {
    buf = await readFile(file);
  } catch {
    return c.json({ error: 'not_found' }, 404);
  }
  return c.body(buf, 200, {
    'content-type': 'application/zip',
    'content-disposition': `attachment; filename="${id}.zip"`,
  });
});

skillMarketplaceRoutes.post('/api/skill-marketplace/verify', async (c) => {
  const parsed = verifyBodySchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: 'invalid_body', issues: parsed.error.issues }, 400);
  const claims = c.get('claims');
  const row = await visibleSkill(parsed.data.name, claims.orgId, claims.sub, claims.roles ?? []);
  return c.json({ allowed: row !== null });
});

skillMarketplaceRoutes.post('/api/skill-marketplace/events', async (c) => {
  const parsed = eventsBodySchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: 'invalid_body', issues: parsed.error.issues }, 400);
  const claims = c.get('claims');
  const { name, event } = parsed.data;
  if (event === 'install' || event === 'update' || event === 'invoke') {
    try {
      await pool.query(
        'UPDATE skill_marketplace_skills SET use_count_30d = use_count_30d + 1 WHERE skill_id = $1 AND org_id = $2',
        [name, claims.orgId],
      );
    } catch {
      // usage tracking is best-effort and must never block the caller
    }
  }
  return c.json({ ok: true });
});
