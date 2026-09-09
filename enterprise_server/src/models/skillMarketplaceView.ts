export const UNCATEGORIZED = 'uncategorized' as const;

/** DB row shape for a marketplace category (same as MCP). */
export interface CategoryRow {
  category_id: string;
  name_zh: string;
  name_en: string;
  display_order: number;
}

export interface SkillScope {
  allCompany: boolean;
  deptIds: string[];
  userIds: string[];
}

/** A skill's scope grants a caller access iff allCompany, or the caller is a
 * member exception (userIds), or any granted dept id is present in the caller's
 * (already-subtree-expanded) dept set. Pure — no DB. Mirrors connectorView. */
export function scopeMatches(
  scope: SkillScope,
  callerDeptIds: string[],
  callerId: string,
): boolean {
  if (scope.allCompany) return true;
  if (scope.userIds.includes(callerId)) return true;
  return (scope.deptIds ?? []).some((d) => callerDeptIds.includes(d));
}

/** Compact display string for a scope. */
export function scopeSummary(scope: SkillScope): string {
  if (scope.allCompany) return 'all';
  const d = scope.deptIds?.length ?? 0;
  const u = scope.userIds?.length ?? 0;
  if (d === 0 && u === 0) return 'none';
  return `depts:${d}` + (u ? `,users:${u}` : '');
}

/** Columns for the public (desktop) list. No `allowed_roles`/`enabled` — the
 * public list only returns enabled rows for the caller's org/scope. */
export const PUBLIC_SKILL_COLUMNS = `skill_id, name_en, name_zh, description_en, description_zh,
  icon, version, category_id, source_json, org_id, scope, zip_file_size, zip_sha256, updated_at`;

/** Columns for the admin list (adds the write/scope/usage fields). */
export const ADMIN_SKILL_COLUMNS = `skill_id, name_en, name_zh, description_en, description_zh,
  icon, version, category_id, source_json, org_id, scope,
  zip_file_name, zip_file_size, zip_sha256, enabled, use_count_30d,
  created_by, updated_by, updated_at`;

export interface SkillPublicRow {
  skill_id: string;
  name_en: string;
  name_zh: string | null;
  description_en: string;
  description_zh: string | null;
  icon: string | null;
  version: string | null;
  category_id: string;
  source_json: { from?: string; url?: string; author?: string } | null;
  org_id: string;
  scope: SkillScope;
  zip_file_size: number | null;
  zip_sha256: string | null;
  updated_at: Date;
}

export interface SkillAdminRow {
  skill_id: string;
  name_en: string;
  name_zh: string | null;
  description_en: string;
  description_zh: string | null;
  icon: string | null;
  version: string | null;
  category_id: string;
  source_json: { from?: string; url?: string; author?: string } | null;
  org_id: string;
  scope: SkillScope;
  zip_file_name: string | null;
  zip_file_size: number | null;
  zip_sha256: string | null;
  enabled: boolean;
  use_count_30d: number;
  created_by: string | null;
  updated_by: string | null;
  updated_at: Date;
}

/** Public (desktop) wire shape. `id` == name == skill_id. `category` is the
 * category_id (desktop resolves the label from the categories list). */
export interface SkillPublicView {
  id: string;
  name: string;
  name_zh: string | null;
  description: string;
  category: string;
  version: string | null;
  icon: string | null;
  source: { from?: string; url?: string; author?: string } | null;
  zipSize: number | null;
  sha256: string | null;
  updatedAt: string;
}

/** Admin wire shape (7-column table + drawer). `👥N` in the UI = useCount30d. */
export interface SkillAdminView {
  id: string;
  name: string;
  name_zh: string | null;
  description: string;
  category: string;
  version: string | null;
  icon: string | null;
  scope: SkillScope;
  scopeSummary: string;
  zip: { fileName: string | null; fileSize: number | null };
  enabled: boolean;
  useCount30d: number;
  updatedAt: string;
  createdBy: string | null;
  updatedBy: string | null;
}

export function mapPublicSkill(row: SkillPublicRow): SkillPublicView {
  return {
    id: row.skill_id,
    name: row.name_en,
    name_zh: row.name_zh,
    description: row.description_zh ?? row.description_en,
    category: row.category_id,
    version: row.version,
    icon: row.icon,
    source: row.source_json ?? null,
    zipSize: row.zip_file_size,
    sha256: row.zip_sha256,
    updatedAt: row.updated_at.toISOString(),
  };
}

export function mapAdminSkill(row: SkillAdminRow): SkillAdminView {
  return {
    id: row.skill_id,
    name: row.name_en,
    name_zh: row.name_zh,
    description: row.description_zh ?? row.description_en,
    category: row.category_id,
    version: row.version,
    icon: row.icon,
    scope: row.scope,
    scopeSummary: scopeSummary(row.scope),
    zip: { fileName: row.zip_file_name, fileSize: row.zip_file_size },
    enabled: row.enabled,
    useCount30d: row.use_count_30d,
    updatedAt: row.updated_at.toISOString(),
    createdBy: row.created_by,
    updatedBy: row.updated_by,
  };
}
