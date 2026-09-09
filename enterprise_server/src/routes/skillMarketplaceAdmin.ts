import { randomUUID } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { Hono } from 'hono';
import { z } from 'zod';

import { auditStore } from '../audit/auditStore';
import { requireAuth, requirePermission } from '../auth/middleware';
import { pool } from '../db/pool';
import { parseSkillZip, SkillZipError } from '../lib/skillZip';
import { skillStoreDir } from '../lib/stateDir';
import {
  ADMIN_SKILL_COLUMNS,
  mapAdminSkill,
  type SkillAdminRow,
  type SkillScope,
  UNCATEGORIZED,
} from '../models/skillMarketplaceView';
import { AuditAction } from '../shared/enterpriseServerConstants';
import { PermissionPoint as PP } from '../shared/permissionPoints';

const scopeSchema = z.object({
  allCompany: z.boolean().optional().default(false),
  deptIds: z.array(z.string()).optional().default([]),
  userIds: z.array(z.string()).optional().default([]),
});

const skillCreateSchema = z.object({
  tempToken: z.string().min(1),
  nameZh: z.string().optional(),
  author: z.string().optional(),
  category_id: z.string().min(1),
  desc: z.string().max(200).optional(),
  icon: z.string().optional(),
  scope: scopeSchema,
});

const skillPatchSchema = z.object({
  nameZh: z.string().optional(),
  author: z.string().optional(),
  desc: z.string().max(200).optional(),
  icon: z.string().optional(),
  category_id: z.string().min(1).optional(),
  scope: scopeSchema.optional(),
  enabled: z.boolean().optional(),
});

/** Drop dept/user ids that do not exist in the org; keep allCompany. */
export async function sanitizeScope(scope: SkillScope, orgId: string): Promise<SkillScope> {
  const deptR = scope.deptIds.length
    ? await pool.query<{ id: string }>(
      'SELECT id FROM departments WHERE org_id = $1 AND id = ANY($2)', [orgId, scope.deptIds])
    : { rows: [] as { id: string }[] };
  const userR = scope.userIds.length
    ? await pool.query<{ id: string }>(
      'SELECT id FROM users WHERE org_id = $1 AND id = ANY($2)', [orgId, scope.userIds])
    : { rows: [] as { id: string }[] };
  return {
    allCompany: scope.allCompany,
    deptIds: deptR.rows.map((r) => r.id),
    userIds: userR.rows.map((r) => r.id),
  };
}

/** Org-scoped category existence check (038 re-keyed the PK to (org_id, category_id)). */
async function categoryExists(categoryId: string, orgId: string): Promise<boolean> {
  const r = await pool.query<{ exists: boolean }>(
    'SELECT EXISTS(SELECT 1 FROM skill_marketplace_categories WHERE org_id = $1 AND category_id = $2) AS exists',
    [orgId, categoryId]);
  return r.rows[0]?.exists === true;
}

/** Map a SkillZipError to its HTTP status (too_large -> 413, everything else -> 400). */
function zipErrorStatus(code: SkillZipError['code']): 413 | 400 {
  return code === 'too_large' ? 413 : 400;
}

export const skillMarketplaceAdminRoutes = new Hono();
skillMarketplaceAdminRoutes.use('/api/admin/skill-marketplace/*', requireAuth);

// --- Two-stage create: parse the upload, then commit with metadata ---
skillMarketplaceAdminRoutes.post('/api/admin/skill-marketplace/skills/parse-zip', requirePermission(PP.SkillCreate), async (c) => {
  const claims = c.get('claims');
  const buf = Buffer.from(await c.req.arrayBuffer());
  let parsed;
  try {
    parsed = parseSkillZip(buf);
  } catch (e) {
    if (e instanceof SkillZipError) return c.json({ error: e.code }, zipErrorStatus(e.code));
    throw e;
  }
  const taken = await pool.query(
    'SELECT 1 FROM skill_marketplace_skills WHERE org_id = $1 AND skill_id = $2',
    [claims.orgId, parsed.name]);
  if (taken.rowCount > 0) return c.json({ error: 'name_conflict' }, 409);
  const tempToken = randomUUID();
  const tmpDir = skillStoreDir(`__tmp_${tempToken}`);
  mkdirSync(tmpDir, { recursive: true });
  writeFileSync(join(tmpDir, 'skill.zip'), buf);
  return c.json({ name: parsed.name, version: parsed.version, size: parsed.size, sha256: parsed.sha256, tempToken });
});

skillMarketplaceAdminRoutes.post('/api/admin/skill-marketplace/skills', requirePermission(PP.SkillCreate), async (c) => {
  const claims = c.get('claims');
  const parsed = skillCreateSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: 'invalid_body', issues: parsed.error.issues }, 400);
  const b = parsed.data;
  // The name is recovered by re-parsing the staged zip (parse-zip stored only bytes).
  const tmpZip = join(skillStoreDir(`__tmp_${b.tempToken}`), 'skill.zip');
  if (!existsSync(tmpZip)) return c.json({ error: 'not_found' }, 404); // temp token expired/invalid
  const meta = parseSkillZip(readFileSync(tmpZip));
  if (!(await categoryExists(b.category_id, claims.orgId))) return c.json({ error: 'unknown_category' }, 400);
  const scope = await sanitizeScope(b.scope, claims.orgId);
  const desc = b.desc ?? meta.name;
  await pool.query(
    `INSERT INTO skill_marketplace_skills
       (skill_id, name_en, name_zh, description_en, description_zh, icon, version,
        category_id, source_json, org_id, scope, zip_file_name, zip_file_size, zip_sha256,
        enabled, created_by, updated_by)
     VALUES ($1,$1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,$10::jsonb,$11,$12,$13,TRUE,$14,$14)`,
    [meta.name, b.nameZh ?? null, desc, desc, b.icon ?? null, meta.version, b.category_id,
     JSON.stringify({ author: b.author ?? undefined }), claims.orgId, JSON.stringify(scope),
     meta.fileName, meta.size, meta.sha256, claims.sub],
  );
  const storeDir = skillStoreDir(meta.name);
  rmSync(storeDir, { recursive: true, force: true });
  mkdirSync(storeDir, { recursive: true });
  copyFileSync(tmpZip, join(storeDir, 'skill.zip'));
  rmSync(skillStoreDir(`__tmp_${b.tempToken}`), { recursive: true, force: true });
  await auditStore.write({
    orgId: claims.orgId, userId: claims.sub, action: AuditAction.SkillCreate,
    targetType: 'skill', targetId: meta.name, payload: { version: meta.version },
  });
  return c.json({ skill_id: meta.name });
});

// --- Edit / toggle ---
skillMarketplaceAdminRoutes.patch('/api/admin/skill-marketplace/skills/:id', requirePermission(PP.SkillEdit), async (c) => {
  const id = c.req.param('id');
  const claims = c.get('claims');
  const parsed = skillPatchSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: 'invalid_body', issues: parsed.error.issues }, 400);
  const b = parsed.data;

  const sets: string[] = [];
  const params: unknown[] = [id, claims.orgId]; // $1 = id, $2 = org_id
  const push = (col: string, val: unknown) => { params.push(val); sets.push(`${col} = $${params.length}`); };

  if (b.nameZh !== undefined) push('name_zh', b.nameZh);
  if (b.author !== undefined) {
    const cur = await pool.query<{ source_json: { from?: string; url?: string; author?: string } | null }>(
      'SELECT source_json FROM skill_marketplace_skills WHERE skill_id = $1 AND org_id = $2',
      [id, claims.orgId]);
    const existing = cur.rows[0]?.source_json ?? {};
    push('source_json', JSON.stringify({ ...existing, author: b.author }));
  }
  if (b.desc !== undefined) { push('description_en', b.desc); push('description_zh', b.desc); }
  if (b.icon !== undefined) push('icon', b.icon);
  if (b.category_id !== undefined) push('category_id', b.category_id);
  const nextScope = b.scope !== undefined ? await sanitizeScope(b.scope, claims.orgId) : undefined;
  if (nextScope !== undefined) push('scope', JSON.stringify(nextScope));
  if (b.enabled !== undefined) push('enabled', b.enabled);

  if (sets.length === 0) return c.json({ error: 'empty_patch' }, 400);
  if (b.category_id !== undefined && !(await categoryExists(b.category_id, claims.orgId))) {
    return c.json({ error: 'unknown_category' }, 400);
  }

  params.push(claims.sub);
  const updatedBy = params.length;
  const result = await pool.query(
    `UPDATE skill_marketplace_skills SET ${sets.join(', ')}, updated_by = $${updatedBy}, updated_at = NOW()
     WHERE skill_id = $1 AND org_id = $2`,
    params);
  if (result.rowCount === 0) return c.json({ error: 'not_found' }, 404);

  const changed: Record<string, unknown> = {};
  if (b.nameZh !== undefined) changed.nameZh = b.nameZh;
  if (b.author !== undefined) changed.author = b.author;
  if (b.desc !== undefined) changed.desc = b.desc;
  if (b.icon !== undefined) changed.icon = b.icon;
  if (b.category_id !== undefined) changed.category_id = b.category_id;
  if (nextScope !== undefined) changed.scope = nextScope;
  await auditStore.write({
    orgId: claims.orgId, userId: claims.sub, action: AuditAction.SkillUpdate,
    targetType: 'skill', targetId: id, payload: changed,
  });
  if (b.enabled !== undefined) {
    await auditStore.write({
      orgId: claims.orgId, userId: claims.sub, action: AuditAction.SkillToggle,
      targetType: 'skill', targetId: id, payload: { enabled: b.enabled },
    });
  }
  return c.body(null, 200);
});

// --- Re-upload a skill's zip (top-level dir must match the existing id) ---
skillMarketplaceAdminRoutes.post('/api/admin/skill-marketplace/skills/:id/zip', requirePermission(PP.SkillEdit), async (c) => {
  const id = c.req.param('id');
  const claims = c.get('claims');
  const exists = await pool.query(
    'SELECT 1 FROM skill_marketplace_skills WHERE skill_id = $1 AND org_id = $2',
    [id, claims.orgId]);
  if (exists.rowCount === 0) return c.json({ error: 'not_found' }, 404);

  const buf = Buffer.from(await c.req.arrayBuffer());
  let parsed;
  try {
    parsed = parseSkillZip(buf);
  } catch (e) {
    if (e instanceof SkillZipError) return c.json({ error: e.code }, zipErrorStatus(e.code));
    throw e;
  }
  if (parsed.name !== id) return c.json({ error: 'name_mismatch' }, 409);

  const storeDir = skillStoreDir(id);
  rmSync(storeDir, { recursive: true, force: true });
  mkdirSync(storeDir, { recursive: true });
  writeFileSync(join(storeDir, 'skill.zip'), buf);
  await pool.query(
    `UPDATE skill_marketplace_skills
       SET version = $2, zip_file_name = $3, zip_file_size = $4, zip_sha256 = $5,
           updated_by = $6, updated_at = NOW()
     WHERE skill_id = $1 AND org_id = $7`,
    [id, parsed.version, parsed.fileName, parsed.size, parsed.sha256, claims.sub, claims.orgId]);
  await auditStore.write({
    orgId: claims.orgId, userId: claims.sub, action: AuditAction.SkillUpdate,
    targetType: 'skill', targetId: id, payload: { reupload: true, version: parsed.version },
  });
  return c.json({ status: 'uploaded', version: parsed.version, sha256: parsed.sha256 });
});

// --- Delete ---
skillMarketplaceAdminRoutes.delete('/api/admin/skill-marketplace/skills/:id', requirePermission(PP.SkillEdit), async (c) => {
  const id = c.req.param('id');
  const claims = c.get('claims');
  const result = await pool.query(
    'DELETE FROM skill_marketplace_skills WHERE skill_id = $1 AND org_id = $2', [id, claims.orgId]);
  if (result.rowCount === 0) return c.json({ error: 'not_found' }, 404);
  rmSync(skillStoreDir(id), { recursive: true, force: true });
  await auditStore.write({
    orgId: claims.orgId, userId: claims.sub, action: AuditAction.SkillDelete,
    targetType: 'skill', targetId: id,
  });
  return c.body(null, 204);
});

// --- List (org full, incl. disabled) ---
skillMarketplaceAdminRoutes.get('/api/admin/skill-marketplace/skills', requirePermission(PP.SkillView), async (c) => {
  const claims = c.get('claims');
  const r = await pool.query<SkillAdminRow>(
    `SELECT ${ADMIN_SKILL_COLUMNS} FROM skill_marketplace_skills WHERE org_id = $1 ORDER BY updated_at DESC`,
    [claims.orgId]);
  return c.json(r.rows.map(mapAdminSkill));
});

// --- Categories (org-scoped; server-generated slug; reserved bucket) ---
const categoryWriteSchema = z.object({
  name_zh: z.string().min(1),
  name_en: z.string().min(1),
  display_order: z.number().int().optional(),
});
const categoryPatchSchema = z.object({
  name_zh: z.string().min(1).optional(),
  name_en: z.string().min(1).optional(),
});

/**
 * Guarantee the org's reserved `uncategorized` bucket exists before a
 * re-home (T1 carry-forward: a legacy org with zero categories would
 * otherwise have no bucket for re-homed skills). Migration 038 seeds it via
 * an org-creation trigger; this is the belt-and-braces guarantee on the
 * delete path.
 */
async function ensureUncategorized(orgId: string): Promise<void> {
  await pool.query(
    `INSERT INTO skill_marketplace_categories (category_id, name_zh, name_en, display_order, org_id)
     VALUES ($1, '未分类', 'Uncategorized', 0, $2)
     ON CONFLICT (org_id, category_id) DO NOTHING`,
    [UNCATEGORIZED, orgId]);
}

skillMarketplaceAdminRoutes.get('/api/admin/skill-marketplace/categories', requirePermission(PP.SkillView), async (c) => {
  const claims = c.get('claims');
  const r = await pool.query<{ category_id: string; name_zh: string; name_en: string; display_order: number }>(
    'SELECT category_id, name_zh, name_en, display_order FROM skill_marketplace_categories WHERE org_id = $1 ORDER BY display_order, category_id',
    [claims.orgId]);
  return c.json(r.rows.map((row) => ({ id: row.category_id, name_zh: row.name_zh, name_en: row.name_en, display_order: row.display_order })));
});

skillMarketplaceAdminRoutes.post('/api/admin/skill-marketplace/categories', requirePermission(PP.SkillEdit), async (c) => {
  const claims = c.get('claims');
  const parsed = categoryWriteSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: 'invalid_body', issues: parsed.error.issues }, 400);
  const b = parsed.data;
  // Server-generated slug: the client never supplies category_id. A
  // Chinese-only name_en yields a non-ASCII slug — acceptable (category_id is
  // not a filesystem path), and the reserved slug collides with the seeded
  // bucket, which the conflict check below turns into name_conflict.
  const slug = b.name_en.toLowerCase().replace(/\s+/g, '-');
  if (await categoryExists(slug, claims.orgId)) return c.json({ error: 'name_conflict' }, 409);
  await pool.query(
    `INSERT INTO skill_marketplace_categories (category_id, name_zh, name_en, display_order, org_id)
     VALUES ($1,$2,$3,COALESCE($4,0),$5) ON CONFLICT (org_id, category_id) DO NOTHING`,
    [slug, b.name_zh, b.name_en, b.display_order ?? null, claims.orgId]);
  await auditStore.write({
    orgId: claims.orgId, userId: claims.sub, action: AuditAction.SkillCategoryCreate,
    targetType: 'skill_category', targetId: slug,
    payload: { name_zh: b.name_zh, name_en: b.name_en, display_order: b.display_order ?? 0 },
  });
  return c.json({ category_id: slug });
});

skillMarketplaceAdminRoutes.put('/api/admin/skill-marketplace/categories/:categoryId', requirePermission(PP.SkillEdit), async (c) => {
  const claims = c.get('claims');
  const id = c.req.param('categoryId');
  // Reserved check is global and runs first; the org check applies to real
  // categories (R20).
  if (id === UNCATEGORIZED) return c.json({ error: 'reserved_category' }, 409);
  const parsed = categoryPatchSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: 'invalid_body', issues: parsed.error.issues }, 400);
  const b = parsed.data;
  if (b.name_zh === undefined && b.name_en === undefined) return c.json({ error: 'empty_patch' }, 400);

  const result = await pool.query(
    `UPDATE skill_marketplace_categories SET
       name_zh = COALESCE($2, name_zh), name_en = COALESCE($3, name_en)
     WHERE category_id = $1 AND org_id = $4`,
    [id, b.name_zh ?? null, b.name_en ?? null, claims.orgId]);
  if (result.rowCount === 0) return c.json({ error: 'not_found' }, 404);

  const changed: Record<string, unknown> = {};
  if (b.name_zh !== undefined) changed.name_zh = b.name_zh;
  if (b.name_en !== undefined) changed.name_en = b.name_en;
  await auditStore.write({
    orgId: claims.orgId, userId: claims.sub, action: AuditAction.SkillCategoryUpdate,
    targetType: 'skill_category', targetId: id, payload: changed,
  });
  return c.body(null, 204);
});

// Delete: reserved bucket -> 409; guarantee the org's reserved bucket exists,
// re-home the org's skills in this category into it, then delete the category
// row (org-scoped: a foreign id 404s without touching the owner org).
skillMarketplaceAdminRoutes.delete('/api/admin/skill-marketplace/categories/:categoryId', requirePermission(PP.SkillEdit), async (c) => {
  const claims = c.get('claims');
  const id = c.req.param('categoryId');
  if (id === UNCATEGORIZED) return c.json({ error: 'reserved_category' }, 409);
  await ensureUncategorized(claims.orgId);
  await pool.query(
    `UPDATE skill_marketplace_skills SET category_id = $1 WHERE category_id = $2 AND org_id = $3`,
    [UNCATEGORIZED, id, claims.orgId]);
  const result = await pool.query(
    'DELETE FROM skill_marketplace_categories WHERE category_id = $1 AND org_id = $2', [id, claims.orgId]);
  if (result.rowCount === 0) return c.json({ error: 'not_found' }, 404);
  await auditStore.write({
    orgId: claims.orgId, userId: claims.sub, action: AuditAction.SkillCategoryDelete,
    targetType: 'skill_category', targetId: id,
  });
  return c.body(null, 204);
});

// --- Org settings: whether members may submit skills (orgs.members_can_submit_skills) ---
const settingsPatchSchema = z.object({ membersCanSubmit: z.boolean() });

skillMarketplaceAdminRoutes.get('/api/admin/skill-marketplace/settings', requirePermission(PP.SkillView), async (c) => {
  const claims = c.get('claims');
  const r = await pool.query<{ members_can_submit_skills: boolean }>(
    'SELECT members_can_submit_skills FROM orgs WHERE id = $1',
    [claims.orgId],
  );
  if (r.rowCount === 0) return c.json({ error: 'org_not_found' }, 404);
  return c.json({ membersCanSubmit: r.rows[0].members_can_submit_skills });
});

skillMarketplaceAdminRoutes.patch('/api/admin/skill-marketplace/settings', requirePermission(PP.SkillEdit), async (c) => {
  const claims = c.get('claims');
  const parsed = settingsPatchSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: 'invalid_body', issues: parsed.error.issues }, 400);
  const r = await pool.query<{ members_can_submit_skills: boolean }>(
    'SELECT members_can_submit_skills FROM orgs WHERE id = $1',
    [claims.orgId],
  );
  if (r.rowCount === 0) return c.json({ error: 'org_not_found' }, 404);
  const before = r.rows[0].members_can_submit_skills;
  if (before === parsed.data.membersCanSubmit) return c.json({ ok: true, membersCanSubmit: before });
  await pool.query('UPDATE orgs SET members_can_submit_skills = $1 WHERE id = $2', [
    parsed.data.membersCanSubmit,
    claims.orgId,
  ]);
  await auditStore.write({
    orgId: claims.orgId, userId: claims.sub, action: AuditAction.SkillUpdate,
    targetType: 'org', targetId: claims.orgId,
    payload: { before, after: parsed.data.membersCanSubmit },
  });
  return c.json({ ok: true, membersCanSubmit: parsed.data.membersCanSubmit });
});
