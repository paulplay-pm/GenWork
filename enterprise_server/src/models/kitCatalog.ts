import { rmSync } from 'node:fs';

import { pool } from '../db/pool';
import { kitStoreDir } from '../lib/stateDir';

export type KitScope = { allCompany: boolean; deptIds: string[]; userIds: string[] };

export interface KitRow {
  slug: string;
  org_id: string;
  category_id: string | null;
  name_en: string | null;
  name_zh: string | null;
  description_en: string | null;
  description_zh: string | null;
  icon_url: string | null;
  author: string | null;
  version: string | null;
  try_asking: Array<{ en: string; zh: string }>;
  skill_list: Array<Record<string, unknown>>;
  scope: KitScope;
  enabled: boolean;
  is_builtin: boolean;
  zip_file_name: string | null;
  zip_file_size: number | null;
  zip_sha256: string | null;
  created_by: string | null;
  updated_by: string | null;
  created_at: Date;
  updated_at: Date;
}

export interface KitAddInput {
  slug: string;
  name_en?: string | null; name_zh?: string | null;
  description_en?: string | null; description_zh?: string | null;
  icon_url?: string | null; author?: string | null; version?: string | null;
  category_id?: string | null;
  try_asking?: Array<{ en: string; zh: string }>;
  skill_list?: Array<Record<string, unknown>>;
  scope: KitScope;
  zip: { size: number; sha256: string; fileName: string };
}

export type KitPatchFields = Partial<{
  name_en: string; name_zh: string; description_en: string; description_zh: string;
  icon_url: string; author: string; version: string; category_id: string;
  scope: KitScope; enabled: boolean;
}>;

/** Drop dept/user ids that do not exist in the org; keep allCompany. Mirrors
 * skillMarketplaceAdmin.sanitizeScope. */
export async function sanitizeKitScope(scope: KitScope, orgId: string): Promise<KitScope> {
  const deptR = scope.deptIds.length
    ? await pool.query<{ id: string }>('SELECT id FROM departments WHERE org_id = $1 AND id = ANY($2)', [orgId, scope.deptIds])
    : { rows: [] as { id: string }[] };
  const userR = scope.userIds.length
    ? await pool.query<{ id: string }>('SELECT id FROM users WHERE org_id = $1 AND id = ANY($2)', [orgId, scope.userIds])
    : { rows: [] as { id: string }[] };
  return { allCompany: scope.allCompany, deptIds: deptR.rows.map((r) => r.id), userIds: userR.rows.map((r) => r.id) };
}

export const kitCatalog = {
  async add(orgId: string, input: KitAddInput, createdBy: string): Promise<void> {
    const dup = await pool.query('SELECT 1 FROM kit_catalog WHERE org_id = $1 AND slug = $2', [orgId, input.slug]);
    if ((dup.rowCount ?? 0) > 0) throw new Error('kit_duplicate');
    const scope = await sanitizeKitScope(input.scope, orgId);
    await pool.query(
      `INSERT INTO kit_catalog
         (slug, org_id, category_id, name_en, name_zh, description_en, description_zh,
          icon_url, author, version, try_asking, skill_list, scope, enabled, is_builtin,
          zip_file_name, zip_file_size, zip_sha256, created_by, updated_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb,$12::jsonb,$13::jsonb,TRUE,FALSE,$14,$15,$16,$17,$17)`,
      [input.slug, orgId, input.category_id ?? null, input.name_en ?? null, input.name_zh ?? null,
       input.description_en ?? null, input.description_zh ?? null, input.icon_url ?? null, input.author ?? null,
       input.version ?? null, JSON.stringify(input.try_asking ?? []), JSON.stringify(input.skill_list ?? []),
       JSON.stringify(scope), input.zip.fileName, input.zip.size, input.zip.sha256, createdBy],
    );
  },

  async patch(orgId: string, slug: string, fields: KitPatchFields, updatedBy: string): Promise<boolean> {
    // Mirror the skill admin patch: $1 = slug, $2 = org_id, then dynamic sets,
    // then updated_by appended last.
    const sets: string[] = [];
    const params: unknown[] = [slug, orgId];
    const push = (col: string, val: unknown) => { params.push(val); sets.push(`${col} = $${params.length}`); };
    if (fields.name_en !== undefined) push('name_en', fields.name_en);
    if (fields.name_zh !== undefined) push('name_zh', fields.name_zh);
    if (fields.description_en !== undefined) push('description_en', fields.description_en);
    if (fields.description_zh !== undefined) push('description_zh', fields.description_zh);
    if (fields.icon_url !== undefined) push('icon_url', fields.icon_url);
    if (fields.author !== undefined) push('author', fields.author);
    if (fields.version !== undefined) push('version', fields.version);
    if (fields.category_id !== undefined) push('category_id', fields.category_id);
    if (fields.scope !== undefined) push('scope', JSON.stringify(await sanitizeKitScope(fields.scope, orgId)));
    if (fields.enabled !== undefined) push('enabled', fields.enabled);
    if (sets.length === 0) return false;
    params.push(updatedBy);
    const r = await pool.query(
      `UPDATE kit_catalog SET ${sets.join(', ')}, updated_by = $${params.length}, updated_at = NOW()
       WHERE slug = $1 AND org_id = $2`,
      params);
    return (r.rowCount ?? 0) > 0;
  },

  async setEnabled(orgId: string, slug: string, enabled: boolean, updatedBy: string): Promise<boolean> {
    const r = await pool.query(
      'UPDATE kit_catalog SET enabled = $3, updated_by = $4, updated_at = NOW() WHERE slug = $1 AND org_id = $2',
      [slug, orgId, enabled, updatedBy]);
    return (r.rowCount ?? 0) > 0;
  },

  async remove(orgId: string, slug: string): Promise<boolean> {
    const r = await pool.query('DELETE FROM kit_catalog WHERE slug = $1 AND org_id = $2', [slug, orgId]);
    const removed = (r.rowCount ?? 0) > 0;
    if (removed) rmSync(kitStoreDir(slug), { recursive: true, force: true });
    return removed;
  },

  async list(orgId: string): Promise<KitRow[]> {
    const r = await pool.query<KitRow>(
      'SELECT * FROM kit_catalog WHERE org_id = $1 AND enabled = TRUE ORDER BY updated_at DESC', [orgId]);
    return r.rows;
  },

  async listForAdmin(orgId: string): Promise<KitRow[]> {
    const r = await pool.query<KitRow>(
      'SELECT * FROM kit_catalog WHERE org_id = $1 ORDER BY updated_at DESC', [orgId]);
    return r.rows;
  },

  async getBySlug(orgId: string, slug: string): Promise<KitRow | null> {
    const r = await pool.query<KitRow>('SELECT * FROM kit_catalog WHERE org_id = $1 AND slug = $2', [orgId, slug]);
    return r.rows[0] ?? null;
  },
};
