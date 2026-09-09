import { pool } from '../db/pool';
import { legacyTypeFor } from '../org/builtinProviders';

/** Closed set of model type labels shown in the admin "类型" column. Matches
 * the `type` CHECK constraint added in migration 017. Kept as a const object
 * (value + type) so consumers import both, per the string-constants rule. */
export const ModelType = {
  Chat: 'chat',
  Reasoning: 'reasoning',
  Vision: 'vision',
  Embedding: 'embedding',
  Image: 'image',
  Audio: 'audio',
} as const;
export type ModelType = (typeof ModelType)[keyof typeof ModelType];

/** 8-value multi-type vocabulary (the `types` array). Distinct from the
 * deprecated single `ModelType` (6-value, legacy `type` column). */
export const ModelTypes = {
  Chat: 'chat', Vision: 'vision', Reasoning: 'reasoning', ImageGen: 'image-gen',
  Embedding: 'embedding', Rerank: 'rerank', Asr: 'asr', Tts: 'tts',
} as const;
export type ModelTypeValue = (typeof ModelTypes)[keyof typeof ModelTypes];
export const MODEL_TYPE_VALUES: ModelTypeValue[] = Object.values(ModelTypes);

/** Capability metadata for a single model. Optional on create; the desktop
 * reads them off `GET /admin/catalog` to render capability badges / pickers. */
export interface ModelCapabilities {
  supports_image: boolean;
  supports_video: boolean;
  supports_thinking: boolean;
  context_window: number | null;
  max_tokens: number | null;
  temperature: number | null;
  top_p: number | null;
  max_output_tokens: number | null;
}

export interface ModelView extends ModelCapabilities {
  id: string;
  provider: string;
  model: string;
  display_name: string | null;
  /** Deprecated compat primary (6-value legacy `type` column). Always kept in
   * sync as `legacyTypeFor(types)` when `types` is written. */
  type: ModelType;
  /** Multi-type labels (8-value `ModelTypes` vocabulary; migration 032). */
  types: ModelTypeValue[];
  quota_per_user_per_day: number | null;
  enabled: boolean;
  disabled_by_admin: boolean;
}

/**
 * Admin-only model view: carries `provider_key_id` so the admin console can
 * group a provider's models by the provider KEY rather than by slug. Two keys
 * may share a slug (a built-in `deepseek` key and a custom `deepseek` key), so
 * the key id is the only field that distinguishes a builtin row from a custom
 * one. This is admin-safe: admins already hold provider-key ids via
 * `GET /admin/provider-keys`, so surfacing it here does not cross the trust
 * boundary the user-facing `ModelView` keeps closed (see the note on
 * `MODEL_LIST_COLS` below).
 */
export interface AdminModelView extends ModelView {
  provider_key_id: string;
}

/** Columns we always SELECT for the USER-FACING list view. The
 * `provider_key_id` is intentionally NOT selected — it must never leave the
 * user-facing trust boundary (the desktop picker keys by model id only). The
 * admin view adds `c.provider_key_id` on top (see `ADMIN_MODEL_LIST_COLS`). */
const MODEL_LIST_COLS = `c.id, c.provider, c.model, c.display_name, c.type, c.types,
  c.quota_per_user_per_day, c.enabled,
  c.supports_image, c.supports_video, c.supports_thinking,
  c.context_window, c.max_tokens,
  c.temperature, c.top_p, c.max_output_tokens,
  COALESCE(p.disabled, false) AS disabled_by_admin`;

/** Admin list columns = user-facing columns + the provider key the row belongs
 * to. Keyed by the key so same-slug keys (builtin vs custom) stay distinct. */
const ADMIN_MODEL_LIST_COLS = `${MODEL_LIST_COLS}, c.provider_key_id`;

export const modelCatalog = {
  async add(input: {
    orgId: string;
    providerKeyId: string;
    provider: string;
    model: string;
    displayName?: string;
    type?: ModelType;
    types?: ModelTypeValue[];
    quotaPerDay?: number | null;
    capabilities?: Partial<ModelCapabilities>;
  }): Promise<{ id: string }> {
    const dup = await pool.query(
      `SELECT 1 FROM model_catalog WHERE org_id = $1 AND provider_key_id = $2 AND model = $3`,
      [input.orgId, input.providerKeyId, input.model]
    );
    if (dup.rowCount && dup.rowCount > 0) {
      throw new Error('model_duplicate');
    }
    const id = crypto.randomUUID();
    const cap = input.capabilities ?? {};
    const types = input.types ?? [ModelType.Chat];
    // Legacy `type` column stays in sync: when `types` is given it is the
    // mapped OLD-6 value; with only the deprecated legacy `type`, keep the
    // existing behavior (input.type ?? 'chat').
    const legacy = input.types ? legacyTypeFor(input.types) : (input.type ?? ModelType.Chat);
    await pool.query(
      `INSERT INTO model_catalog(
         id, org_id, provider_key_id, provider, model, display_name, type, types,
         quota_per_user_per_day,
         supports_image, supports_video, supports_thinking,
         context_window, max_tokens,
         temperature, top_p, max_output_tokens
       )
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)`,
      [
        id,
        input.orgId,
        input.providerKeyId,
        input.provider,
        input.model,
        input.displayName ?? null,
        legacy,
        types,
        input.quotaPerDay ?? null,
        cap.supports_image ?? false,
        cap.supports_video ?? false,
        cap.supports_thinking ?? false,
        cap.context_window ?? null,
        cap.max_tokens ?? null,
        cap.temperature ?? null,
        cap.top_p ?? null,
        cap.max_output_tokens ?? null,
      ]
    );
    return { id };
  },

  async patch(orgId: string, id: string, fields: {
    display_name?: string | null;
    type?: ModelType;
    types?: ModelTypeValue[];
    enabled?: boolean;
    capabilities?: Partial<ModelCapabilities>;
  }): Promise<boolean> {
    const sets: string[] = [];
    const params: unknown[] = [];
    let i = 1;
    if (fields.display_name !== undefined) { sets.push(`display_name = $${i++}`); params.push(fields.display_name); }
    // `types` wins over the deprecated legacy `type` when both are provided —
    // and we must only emit one `type =` set clause or Postgres rejects the
    // duplicate column. Legacy-only keeps the existing behavior.
    if (fields.types !== undefined) {
      sets.push(`types = $${i++}`);
      params.push(fields.types);
      sets.push(`type = $${i++}`);
      params.push(legacyTypeFor(fields.types));
    } else if (fields.type !== undefined) {
      sets.push(`type = $${i++}`);
      params.push(fields.type);
    }
    if (fields.enabled !== undefined)      { sets.push(`enabled = $${i++}`);      params.push(fields.enabled); }
    if (fields.capabilities) {
      const c = fields.capabilities;
      if (c.supports_image !== undefined)        { sets.push(`supports_image = $${i++}`);        params.push(c.supports_image); }
      if (c.supports_video !== undefined)        { sets.push(`supports_video = $${i++}`);        params.push(c.supports_video); }
      if (c.supports_thinking !== undefined)     { sets.push(`supports_thinking = $${i++}`);     params.push(c.supports_thinking); }
      if (c.context_window !== undefined)        { sets.push(`context_window = $${i++}`);        params.push(c.context_window); }
      if (c.max_tokens !== undefined)            { sets.push(`max_tokens = $${i++}`);            params.push(c.max_tokens); }
      if (c.temperature !== undefined)           { sets.push(`temperature = $${i++}`);           params.push(c.temperature); }
      if (c.top_p !== undefined)                 { sets.push(`top_p = $${i++}`);                 params.push(c.top_p); }
      if (c.max_output_tokens !== undefined)     { sets.push(`max_output_tokens = $${i++}`);     params.push(c.max_output_tokens); }
    }
    if (sets.length === 0) return true;
    params.push(id, orgId);
    const r = await pool.query(
      `UPDATE model_catalog SET ${sets.join(', ')} WHERE id = $${i++} AND org_id = $${i}`,
      params
    );
    return (r.rowCount ?? 0) > 0;
  },

  async remove(orgId: string, id: string): Promise<boolean> {
    const r = await pool.query(
      `DELETE FROM model_catalog WHERE id = $1 AND org_id = $2`,
      [id, orgId]
    );
    return (r.rowCount ?? 0) > 0;
  },

  async list(orgId: string): Promise<ModelView[]> {
    // User-facing picker: only models that are enabled AND not policy-disabled
    // by an admin. A policy-disabled model is blocked at the proxy, so it must
    // not be advertised as available here.
    const r = await pool.query<ModelView>(
      `SELECT ${MODEL_LIST_COLS}
       FROM model_catalog c
       LEFT JOIN model_policies p ON p.org_id = c.org_id AND p.model_id = c.id
       WHERE c.org_id = $1 AND c.enabled = true AND COALESCE(p.disabled, false) = false
       ORDER BY c.model`,
      [orgId]
    );
    return r.rows;
  },

  async listForAdmin(orgId: string): Promise<AdminModelView[]> {
    // Admin view: include catalog-disabled (enabled=false) models too so an
    // admin can re-enable them — they render as a disabled row the admin can
    // flip back on. Also include policy-disabled models (flagged). This is the
    // ONLY admin listing; the user-facing `list` / enterprise picker still
    // filter `c.enabled = true`.
    //
    // Selects the provider key id (ADMIN_MODEL_LIST_COLS) so the console can
    // group by key, not slug — two keys may share a slug (builtin vs custom).
    //
    // Ordered by model name, then provider_key_id (never `enabled`): the admin
    // enable/disable switch flips `c.enabled`, and sorting on it would re-order
    // the whole list on every refetch after a toggle — making a toggled row
    // physically jump. The `provider_key_id` tiebreaker keeps two same-named
    // models (one per key) in a stable, deterministic order.
    const r = await pool.query<AdminModelView>(
      `SELECT ${ADMIN_MODEL_LIST_COLS}
       FROM model_catalog c
       LEFT JOIN model_policies p ON p.org_id = c.org_id AND p.model_id = c.id
       WHERE c.org_id = $1
       ORDER BY c.model, c.provider_key_id`,
      [orgId]
    );
    return r.rows;
  },

  async getById(id: string): Promise<{
    id: string;
    org_id: string;
    provider_key_id: string;
    provider: string;
    model: string;
    display_name: string | null;
    quota_per_user_per_day: number | null;
    enabled: boolean;
    supports_image: boolean;
    supports_video: boolean;
    supports_thinking: boolean;
    context_window: number | null;
    max_tokens: number | null;
    temperature: number | null;
    top_p: number | null;
    max_output_tokens: number | null;
  } | null> {
    const r = await pool.query(
      `SELECT id, org_id, provider_key_id, provider, model, display_name,
              quota_per_user_per_day, enabled,
              supports_image, supports_video, supports_thinking,
              context_window, max_tokens,
              temperature, top_p, max_output_tokens
       FROM model_catalog WHERE id=$1`,
      [id]
    );
    return (r.rows[0] as never) ?? null;
  },

  /**
   * Resolve the catalog row by the upstream-facing model name. The desktop's
   * OpenClaw gateway uses the `model` field on the wire (e.g. "Qwen3.8-27B"),
   * but the proxy's internal `model_id` is the catalog row's UUID PK. This
   * lookup is scoped to the user's org so a different org's model of the same
   * upstream name can't be mistaken for the current request's.
   *
   * Match priority: `display_name`, then `model`, both case-insensitive.
   * The `provider` filter matches the API protocol column, but the catalog
   * may store the upstream type (e.g. "vllm" for an OpenAI-compatible vllm
   * server). Pass `provider: null` to skip the provider filter entirely.
   */
  async getByUpstreamModel(orgId: string, provider: string | null, upstreamName: string): Promise<{
    id: string;
    org_id: string;
    provider_key_id: string;
    provider: string;
    model: string;
    display_name: string | null;
    quota_per_user_per_day: number | null;
    enabled: boolean;
    supports_image: boolean;
    supports_video: boolean;
    supports_thinking: boolean;
    context_window: number | null;
    max_tokens: number | null;
  } | null> {
    const trimmed = upstreamName.trim();
    const r = await pool.query<{
      id: string; org_id: string; provider_key_id: string; provider: string;
      model: string; display_name: string | null; quota_per_user_per_day: number | null;
      enabled: boolean; supports_image: boolean; supports_video: boolean;
      supports_thinking: boolean; context_window: number | null; max_tokens: number | null;
    }>(
      `SELECT id, org_id, provider_key_id, provider, model, display_name,
              quota_per_user_per_day, enabled,
              supports_image, supports_video, supports_thinking,
              context_window, max_tokens
       FROM model_catalog
       WHERE org_id = $1
         AND enabled = true
         AND ($2::text IS NULL OR provider = $2)
         AND (LOWER(TRIM(model)) = LOWER($3) OR LOWER(TRIM(COALESCE(display_name, ''))) = LOWER($3))
       ORDER BY (LOWER(TRIM(model)) = LOWER($3)) DESC, (LOWER(TRIM(COALESCE(display_name, ''))) = LOWER($3)) DESC
       LIMIT 1`,
      [orgId, provider, trimmed]
    );
    return (r.rows[0] as never) ?? null;
  },

  async setQuota(id: string, quotaPerDay: number | null): Promise<void> {
    await pool.query(`UPDATE model_catalog SET quota_per_user_per_day=$1 WHERE id=$2`, [
      quotaPerDay,
      id,
    ]);
  },

  async setEnabled(id: string, enabled: boolean): Promise<void> {
    await pool.query(`UPDATE model_catalog SET enabled=$1 WHERE id=$2`, [enabled, id]);
  },

  /**
   * Bulk-insert models from a provider's remote catalog. Existing rows
   * (matched by `(org_id, provider, model)`) are left alone — preserves
   * admin-set quota / capabilities / enabled flag. New rows are inserted
   * with sensible defaults (enabled=true, no capabilities claimed).
   *
   * Returns the counts so the route handler can surface "added N,
   * unchanged M" in the UI.
   */
  async upsertMany(input: {
    orgId: string;
    providerKeyId: string;
    provider: string;
    modelIds: string[];
  }): Promise<{ added: number; unchanged: number; addedIds: string[] }> {
    if (input.modelIds.length === 0) return { added: 0, unchanged: 0, addedIds: [] };
    // Dedupe within the input set; preserve order of first appearance.
    const seen = new Set<string>();
    const ids: string[] = [];
    for (const m of input.modelIds) {
      if (typeof m === 'string' && m.length > 0 && !seen.has(m)) {
        seen.add(m);
        ids.push(m);
      }
    }
    if (ids.length === 0) return { added: 0, unchanged: 0, addedIds: [] };

    const addedIds: string[] = [];
    for (const modelId of ids) {
      const newId = crypto.randomUUID();
      const r = await pool.query<{ id: string }>(
        `INSERT INTO model_catalog(
           id, org_id, provider_key_id, provider, model, enabled
         )
         VALUES ($1, $2, $3, $4, $5, true)
         ON CONFLICT (org_id, provider_key_id, model) DO NOTHING
         RETURNING id`,
        [newId, input.orgId, input.providerKeyId, input.provider, modelId]
      );
      if (r.rowCount && r.rowCount > 0) addedIds.push(newId);
    }
    return {
      added: addedIds.length,
      unchanged: ids.length - addedIds.length,
      addedIds,
    };
  },

  async addPolicy(input: {
    orgId: string;
    modelId: string;
    scope: string;
    createdBy: string;
  }): Promise<{ id: string }> {
    const id = crypto.randomUUID();
    await pool.query(
      `INSERT INTO model_policies(id, org_id, model_id, scope, created_by)
       VALUES ($1,$2,$3,$4::jsonb,$5)`,
      [id, input.orgId, input.modelId, JSON.stringify(input.scope), input.createdBy]
    );
    return { id };
  },

  async getModelPolicy(orgId: string, modelId: string): Promise<{ disabled: boolean } | null> {
    const r = await pool.query<{ disabled: boolean }>(
      `SELECT disabled FROM model_policies WHERE org_id=$1 AND model_id=$2`,
      [orgId, modelId]
    );
    return r.rows[0] ?? null;
  },

  async setModelDisabled(orgId: string, modelId: string, disabled: boolean, createdBy: string): Promise<void> {
    await pool.query(
      `INSERT INTO model_policies(id, org_id, model_id, disabled, created_by)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (org_id, model_id) DO UPDATE SET disabled=$4`,
      [crypto.randomUUID(), orgId, modelId, disabled, createdBy]
    );
  },

  /**
   * Cascade-delete every model_catalog row that points at a given provider_key,
   * scoped to a single org. Returns the number of rows actually removed.
   *
   * Used by the DELETE /admin/provider-keys/:id route so the route handler
   * does not have to talk to `pool` directly. Both filters are required:
   * `provider_key_id` to scope to the cascade target, `org_id` so a
   * mis-routed call can't cross org boundaries even if the wrong id is passed.
   */
  async deleteByProviderKey(orgId: string, providerKeyId: string): Promise<number> {
    const r = await pool.query<{ count: string }>(
      `WITH d AS (
         DELETE FROM model_catalog WHERE provider_key_id = $1 AND org_id = $2
         RETURNING 1
       )
       SELECT count(*)::text AS count FROM d`,
      [providerKeyId, orgId]
    );
    return Number(r.rows[0]?.count ?? 0);
  },
};