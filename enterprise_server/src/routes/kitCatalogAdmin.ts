import { randomUUID } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { Hono } from 'hono';
import { z } from 'zod';

import { auditStore } from '../audit/auditStore';
import { requireAuth, requirePermission } from '../auth/middleware';
import { pool } from '../db/pool';
import { KitZipError, parseKitZip } from '../lib/kitZip';
import { SLUG_RE } from '../lib/skillZip';
import { kitStoreDir } from '../lib/stateDir';
import { type KitAddInput, kitCatalog, type KitPatchFields, type KitRow, sanitizeKitScope } from '../models/kitCatalog';
import { scopeSummary, UNCATEGORIZED } from '../models/skillMarketplaceView';
import { AuditAction } from '../shared/enterpriseServerConstants';
import { PermissionPoint as PP } from '../shared/permissionPoints';

const scopeSchema = z.object({
  allCompany: z.boolean().optional().default(false),
  deptIds: z.array(z.string()).optional().default([]),
  userIds: z.array(z.string()).optional().default([]),
});

const kitCreateSchema = z.object({
  tempToken: z.string().min(1),
  // Caller-supplied: kit zips are FLAT (no wrapping kit dir to infer a slug
  // from), so the slug is a required form field, not zip-derived.
  slug: z.string().regex(SLUG_RE),
  nameEn: z.string().optional(),
  nameZh: z.string().optional(),
  descriptionEn: z.string().optional(),
  descriptionZh: z.string().optional(),
  icon: z.string().optional(),
  author: z.string().optional(),
  version: z.string().optional(),
  category_id: z.string().min(1),
  tryAsking: z.array(z.object({ en: z.string(), zh: z.string() })).optional(),
  skillList: z.array(z.record(z.unknown())).optional(),
  scope: scopeSchema,
});

const kitPatchSchema = z.object({
  nameEn: z.string().optional(),
  nameZh: z.string().optional(),
  descriptionEn: z.string().optional(),
  descriptionZh: z.string().optional(),
  icon: z.string().optional(),
  author: z.string().optional(),
  version: z.string().optional(),
  category_id: z.string().min(1).optional(),
  scope: scopeSchema.optional(),
  enabled: z.boolean().optional(),
});

/** Org-scoped category existence check (040 re-keyed the PK to (org_id, category_id)). */
async function categoryExists(categoryId: string, orgId: string): Promise<boolean> {
  const r = await pool.query<{ exists: boolean }>(
    'SELECT EXISTS(SELECT 1 FROM kit_categories WHERE org_id = $1 AND category_id = $2) AS exists',
    [orgId, categoryId]);
  return r.rows[0]?.exists === true;
}

/** Map a KitZipError to its HTTP status (too_large -> 413, everything else -> 400). */
function zipErrorStatus(code: KitZipError['code']): 413 | 400 {
  return code === 'too_large' ? 413 : 400;
}

/** Map a kit row to the admin wire shape (the SPA's `KitAdmin`). `updatedAt`
 * is passed through as the driver's native value: real pg yields a Date,
 * pglite (tests) yields a string, and `c.json` serializes both to ISO-8601. */
function mapAdminKit(row: KitRow) {
  return {
    id: row.slug,
    name_en: row.name_en,
    name_zh: row.name_zh,
    description_en: row.description_en,
    description_zh: row.description_zh,
    icon: row.icon_url,
    author: row.author,
    version: row.version,
    category: row.category_id,
    tryAsking: row.try_asking,
    skillList: row.skill_list,
    scope: row.scope,
    scopeSummary: scopeSummary(row.scope),
    zip: { fileName: row.zip_file_name, fileSize: row.zip_file_size },
    enabled: row.enabled,
    isBuiltin: row.is_builtin,
    updatedAt: row.updated_at,
  };
}

export const kitCatalogAdminRoutes = new Hono();
kitCatalogAdminRoutes.use('/api/admin/kits/*', requireAuth);

// --- Two-stage create: parse the upload, then commit with metadata ---
kitCatalogAdminRoutes.post('/api/admin/kits/parse-zip', requirePermission(PP.KitCreate), async (c) => {
  const buf = Buffer.from(await c.req.arrayBuffer());
  let parsed;
  try {
    parsed = parseKitZip(buf);
  } catch (e) {
    if (e instanceof KitZipError) return c.json({ error: e.code }, zipErrorStatus(e.code));
    throw e;
  }
  // No slug here (flat zips carry none) and no conflict check: the slug is
  // only known at commit, when the caller supplies it.
  const tempToken = randomUUID();
  const tmpDir = kitStoreDir(`__tmp_${tempToken}`);
  mkdirSync(tmpDir, { recursive: true });
  writeFileSync(join(tmpDir, 'kit.zip'), buf);
  return c.json({ size: parsed.size, sha256: parsed.sha256, tempToken });
});

kitCatalogAdminRoutes.post('/api/admin/kits', requirePermission(PP.KitCreate), async (c) => {
  const claims = c.get('claims');
  const parsed = kitCreateSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: 'invalid_body', issues: parsed.error.issues }, 400);
  const b = parsed.data;
  // The staged bytes are recovered by re-parsing the zip parse-zip stored.
  const tmpZip = join(kitStoreDir(`__tmp_${b.tempToken}`), 'kit.zip');
  if (!existsSync(tmpZip)) return c.json({ error: 'not_found' }, 404); // temp token expired/invalid
  let meta: { size: number; sha256: string };
  try {
    meta = parseKitZip(readFileSync(tmpZip));
  } catch (e) {
    if (e instanceof KitZipError) return c.json({ error: e.code }, zipErrorStatus(e.code));
    throw e;
  }
  if (!(await categoryExists(b.category_id, claims.orgId))) return c.json({ error: 'unknown_category' }, 400);
  const input: KitAddInput = {
    slug: b.slug,
    name_en: b.nameEn ?? null,
    name_zh: b.nameZh ?? null,
    description_en: b.descriptionEn ?? null,
    description_zh: b.descriptionZh ?? null,
    icon_url: b.icon ?? null,
    author: b.author ?? null,
    version: b.version ?? null,
    category_id: b.category_id,
    try_asking: b.tryAsking ?? [],
    skill_list: b.skillList ?? [],
    scope: b.scope,
    zip: { size: meta.size, sha256: meta.sha256, fileName: b.slug + '.zip' },
  };
  try {
    await kitCatalog.add(claims.orgId, input, claims.sub);
  } catch (e) {
    if (e instanceof Error && e.message === 'kit_duplicate') return c.json({ error: 'slug_conflict' }, 409);
    throw e;
  }
  const storeDir = kitStoreDir(b.slug);
  rmSync(storeDir, { recursive: true, force: true });
  mkdirSync(storeDir, { recursive: true });
  copyFileSync(tmpZip, join(storeDir, 'kit.zip'));
  rmSync(kitStoreDir(`__tmp_${b.tempToken}`), { recursive: true, force: true });
  await auditStore.write({
    orgId: claims.orgId, userId: claims.sub, action: AuditAction.KitCreate,
    targetType: 'kit', targetId: b.slug, payload: { version: b.version ?? null },
  });
  return c.json({ slug: b.slug });
});

// --- Edit / toggle ---
kitCatalogAdminRoutes.patch('/api/admin/kits/:slug', requirePermission(PP.KitEdit), async (c) => {
  const slug = c.req.param('slug');
  const claims = c.get('claims');
  const parsed = kitPatchSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: 'invalid_body', issues: parsed.error.issues }, 400);
  const b = parsed.data;

  const fields: KitPatchFields = {};
  if (b.nameEn !== undefined) fields.name_en = b.nameEn;
  if (b.nameZh !== undefined) fields.name_zh = b.nameZh;
  if (b.descriptionEn !== undefined) fields.description_en = b.descriptionEn;
  if (b.descriptionZh !== undefined) fields.description_zh = b.descriptionZh;
  if (b.icon !== undefined) fields.icon_url = b.icon;
  if (b.author !== undefined) fields.author = b.author;
  if (b.version !== undefined) fields.version = b.version;
  if (b.category_id !== undefined) fields.category_id = b.category_id;
  const nextScope = b.scope !== undefined ? await sanitizeKitScope(b.scope, claims.orgId) : undefined;
  if (nextScope !== undefined) fields.scope = nextScope;
  if (b.enabled !== undefined) fields.enabled = b.enabled;

  if (Object.keys(fields).length === 0) return c.json({ error: 'empty_patch' }, 400);
  if (b.category_id !== undefined && !(await categoryExists(b.category_id, claims.orgId))) {
    return c.json({ error: 'unknown_category' }, 400);
  }

  const updated = await kitCatalog.patch(claims.orgId, slug, fields, claims.sub);
  if (!updated) return c.json({ error: 'not_found' }, 404);

  const changed: Record<string, unknown> = {};
  if (b.nameEn !== undefined) changed.nameEn = b.nameEn;
  if (b.nameZh !== undefined) changed.nameZh = b.nameZh;
  if (b.descriptionEn !== undefined) changed.descriptionEn = b.descriptionEn;
  if (b.descriptionZh !== undefined) changed.descriptionZh = b.descriptionZh;
  if (b.icon !== undefined) changed.icon = b.icon;
  if (b.author !== undefined) changed.author = b.author;
  if (b.version !== undefined) changed.version = b.version;
  if (b.category_id !== undefined) changed.category_id = b.category_id;
  if (nextScope !== undefined) changed.scope = nextScope;
  await auditStore.write({
    orgId: claims.orgId, userId: claims.sub, action: AuditAction.KitUpdate,
    targetType: 'kit', targetId: slug, payload: changed,
  });
  if (b.enabled !== undefined) {
    await auditStore.write({
      orgId: claims.orgId, userId: claims.sub, action: AuditAction.KitToggle,
      targetType: 'kit', targetId: slug, payload: { enabled: b.enabled },
    });
  }
  return c.body(null, 200);
});

// --- Re-upload a kit's zip (flat: no slug inside the archive to compare) ---
kitCatalogAdminRoutes.post('/api/admin/kits/:slug/zip', requirePermission(PP.KitEdit), async (c) => {
  const slug = c.req.param('slug');
  const claims = c.get('claims');
  const exists = await pool.query(
    'SELECT 1 FROM kit_catalog WHERE slug = $1 AND org_id = $2',
    [slug, claims.orgId]);
  if (exists.rowCount === 0) return c.json({ error: 'not_found' }, 404);

  const buf = Buffer.from(await c.req.arrayBuffer());
  let parsed;
  try {
    parsed = parseKitZip(buf);
  } catch (e) {
    if (e instanceof KitZipError) return c.json({ error: e.code }, zipErrorStatus(e.code));
    throw e;
  }

  const storeDir = kitStoreDir(slug);
  rmSync(storeDir, { recursive: true, force: true });
  mkdirSync(storeDir, { recursive: true });
  writeFileSync(join(storeDir, 'kit.zip'), buf);
  await pool.query(
    `UPDATE kit_catalog
       SET zip_file_name = $2, zip_file_size = $3, zip_sha256 = $4,
           updated_by = $5, updated_at = NOW()
     WHERE slug = $1 AND org_id = $6`,
    [slug, `${slug}.zip`, parsed.size, parsed.sha256, claims.sub, claims.orgId]);
  await auditStore.write({
    orgId: claims.orgId, userId: claims.sub, action: AuditAction.KitUpdate,
    targetType: 'kit', targetId: slug, payload: { reupload: true, sha256: parsed.sha256 },
  });
  return c.json({ status: 'uploaded', sha256: parsed.sha256 });
});

// --- Delete ---
kitCatalogAdminRoutes.delete('/api/admin/kits/:slug', requirePermission(PP.KitDelete), async (c) => {
  const slug = c.req.param('slug');
  const claims = c.get('claims');
  const removed = await kitCatalog.remove(claims.orgId, slug);
  if (!removed) return c.json({ error: 'not_found' }, 404);
  await auditStore.write({
    orgId: claims.orgId, userId: claims.sub, action: AuditAction.KitDelete,
    targetType: 'kit', targetId: slug,
  });
  return c.body(null, 204);
});

// --- List (org full, incl. disabled) ---
kitCatalogAdminRoutes.get('/api/admin/kits', requirePermission(PP.KitView), async (c) => {
  const claims = c.get('claims');
  const rows = await kitCatalog.listForAdmin(claims.orgId);
  return c.json(rows.map(mapAdminKit));
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
 * re-home (a legacy org with zero categories would otherwise have no bucket
 * for re-homed kits). Migration 040 seeds it via an org-creation trigger;
 * this is the belt-and-braces guarantee on the delete path.
 */
async function ensureUncategorized(orgId: string): Promise<void> {
  await pool.query(
    `INSERT INTO kit_categories (category_id, name_zh, name_en, display_order, is_reserved, org_id)
     VALUES ($1, '未分类', 'Uncategorized', 0, true, $2)
     ON CONFLICT (org_id, category_id) DO NOTHING`,
    [UNCATEGORIZED, orgId]);
}

kitCatalogAdminRoutes.get('/api/admin/kits/categories', requirePermission(PP.KitView), async (c) => {
  const claims = c.get('claims');
  const r = await pool.query<{ category_id: string; name_zh: string; name_en: string; display_order: number }>(
    'SELECT category_id, name_zh, name_en, display_order FROM kit_categories WHERE org_id = $1 ORDER BY display_order, category_id',
    [claims.orgId]);
  return c.json(r.rows.map((row) => ({ id: row.category_id, name_zh: row.name_zh, name_en: row.name_en, display_order: row.display_order })));
});

kitCatalogAdminRoutes.post('/api/admin/kits/categories', requirePermission(PP.KitEdit), async (c) => {
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
    `INSERT INTO kit_categories (category_id, name_zh, name_en, display_order, org_id)
     VALUES ($1,$2,$3,COALESCE($4,0),$5) ON CONFLICT (org_id, category_id) DO NOTHING`,
    [slug, b.name_zh, b.name_en, b.display_order ?? null, claims.orgId]);
  await auditStore.write({
    orgId: claims.orgId, userId: claims.sub, action: AuditAction.KitCategoryCreate,
    targetType: 'kit_category', targetId: slug,
    payload: { name_zh: b.name_zh, name_en: b.name_en, display_order: b.display_order ?? 0 },
  });
  return c.json({ category_id: slug });
});

kitCatalogAdminRoutes.put('/api/admin/kits/categories/:categoryId', requirePermission(PP.KitEdit), async (c) => {
  const claims = c.get('claims');
  const id = c.req.param('categoryId');
  // Reserved check is global and runs first; the org check applies to real
  // categories.
  if (id === UNCATEGORIZED) return c.json({ error: 'reserved_category' }, 409);
  const parsed = categoryPatchSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: 'invalid_body', issues: parsed.error.issues }, 400);
  const b = parsed.data;
  if (b.name_zh === undefined && b.name_en === undefined) return c.json({ error: 'empty_patch' }, 400);

  const result = await pool.query(
    `UPDATE kit_categories SET
       name_zh = COALESCE($2, name_zh), name_en = COALESCE($3, name_en)
     WHERE category_id = $1 AND org_id = $4`,
    [id, b.name_zh ?? null, b.name_en ?? null, claims.orgId]);
  if (result.rowCount === 0) return c.json({ error: 'not_found' }, 404);

  const changed: Record<string, unknown> = {};
  if (b.name_zh !== undefined) changed.name_zh = b.name_zh;
  if (b.name_en !== undefined) changed.name_en = b.name_en;
  await auditStore.write({
    orgId: claims.orgId, userId: claims.sub, action: AuditAction.KitCategoryUpdate,
    targetType: 'kit_category', targetId: id, payload: changed,
  });
  return c.body(null, 204);
});

// Delete: reserved bucket -> 409; guarantee the org's reserved bucket exists,
// re-home the org's kits in this category into it, then delete the category
// row (org-scoped: a foreign id 404s without touching the owner org).
kitCatalogAdminRoutes.delete('/api/admin/kits/categories/:categoryId', requirePermission(PP.KitEdit), async (c) => {
  const claims = c.get('claims');
  const id = c.req.param('categoryId');
  if (id === UNCATEGORIZED) return c.json({ error: 'reserved_category' }, 409);
  await ensureUncategorized(claims.orgId);
  await pool.query(
    `UPDATE kit_catalog SET category_id = $1 WHERE category_id = $2 AND org_id = $3`,
    [UNCATEGORIZED, id, claims.orgId]);
  const result = await pool.query(
    'DELETE FROM kit_categories WHERE category_id = $1 AND org_id = $2', [id, claims.orgId]);
  if (result.rowCount === 0) return c.json({ error: 'not_found' }, 404);
  await auditStore.write({
    orgId: claims.orgId, userId: claims.sub, action: AuditAction.KitCategoryDelete,
    targetType: 'kit_category', targetId: id,
  });
  return c.body(null, 204);
});
