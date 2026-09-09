import { pool } from '../db/pool';
import { providerKeyVault } from '../vault/providerKeyVault';

export interface EnterpriseModelEntry {
  id: string;
  provider: string;
  model: string;
  displayName: string | null;
  endpoint: string | null;
  capabilities: {
    supports_image: boolean;
    supports_video: boolean;
    supports_thinking: boolean;
    context_window: number | null;
    max_tokens: number | null;
  };
  quotaPerDay: number | null;
}

/**
 * Decrypted key — NEVER sent to renderer, NEVER logged. Main-process
 * memory only on desktop; transit only over `localhost` IPC.
 */
export interface DecryptedKey {
  modelId: string;
  apiKey: string;
}

/**
 * `enterpriseModels` is the per-org catalog accessor the desktop hits at
 * startup. It reuses `providerKeyVault` for key decryption and the same
 * `model_catalog` + `model_policies` filters as `modelCatalog.list` so the
 * two endpoints stay in lock-step about what is "available" for an org.
 */
const ENTERPRISE_MODEL_LIST_COLS = `c.id, c.provider, c.model, c.display_name,
  c.quota_per_user_per_day,
  c.supports_image, c.supports_video, c.supports_thinking,
  c.context_window, c.max_tokens,
  c.types,
  k.endpoint AS endpoint,
  c.provider_key_id`;

export const enterpriseModels = {
  async listEnabledForOrg(orgId: string): Promise<EnterpriseModelEntry[]> {
    const r = await pool.query<{
      id: string;
      provider: string;
      model: string;
      display_name: string | null;
      endpoint: string | null;
      quota_per_user_per_day: number | null;
      supports_image: boolean;
      supports_video: boolean;
      supports_thinking: boolean;
      context_window: number | null;
      max_tokens: number | null;
      types: string[] | null;
      provider_key_id: string;
    }>(
      `SELECT ${ENTERPRISE_MODEL_LIST_COLS}
       FROM model_catalog c
       JOIN provider_keys k ON k.id = c.provider_key_id
       LEFT JOIN model_policies p ON p.org_id = c.org_id AND p.model_id = c.id
       WHERE c.org_id = $1 AND c.enabled = true AND k.enabled = true
         AND COALESCE(p.disabled, false) = false
       ORDER BY c.model`,
      [orgId],
    );
    return r.rows.map(row => {
      // The admin UI expresses vision and reasoning capability exclusively
      // through the `types` chip grid (see ModelTypes in modelCatalog.ts);
      // the dedicated `supports_image` / `supports_thinking` columns are
      // legacy and are NOT editable from the drawer. The chip is the single
      // source of truth and overrides the column — a model with the vision
      // chip removed must show vision as disabled on the desktop even if the
      // legacy column is still true. The column is kept in the schema for
      // back-compat and is read here only as a fallback when the row's types
      // array is missing, but with migration 032 defaulting types to ['chat']
      // on every row that path is effectively dead. `supports_video` has no
      // chip equivalent and stays column-driven.
      const types = row.types ?? [];
      const supportsImage = types.includes('vision');
      const supportsThinking = types.includes('reasoning');
      return {
        id: row.id,
        provider: row.provider,
        model: row.model,
        displayName: row.display_name,
        endpoint: row.endpoint,
        capabilities: {
          supports_image: supportsImage,
          supports_video: row.supports_video,
          supports_thinking: supportsThinking,
          context_window: row.context_window,
          max_tokens: row.max_tokens,
        },
        quotaPerDay: row.quota_per_user_per_day,
      };
    });
  },

  /**
   * Decrypt every enabled model's provider key for the given org. Failures
   * (key missing, decrypt error) are silently skipped — the caller still gets
   * a partial map so a single corrupt row can't take down the whole sync.
   * The returned `modelId -> apiKey` map is consumed only by the
   * `/enterprise-models` route handler and never enters renderer memory.
   */
  async decryptKeysForOrg(orgId: string): Promise<Map<string, string>> {
    const r = await pool.query<{ id: string; provider_key_id: string }>(
      `SELECT c.id, c.provider_key_id
       FROM model_catalog c
       JOIN provider_keys k ON k.id = c.provider_key_id
       LEFT JOIN model_policies p ON p.org_id = c.org_id AND p.model_id = c.id
       WHERE c.org_id = $1 AND c.enabled = true AND k.enabled = true
         AND COALESCE(p.disabled, false) = false`,
      [orgId],
    );
    const out = new Map<string, string>();
    for (const row of r.rows) {
      try {
        const k = await providerKeyVault.getDecrypted(row.provider_key_id);
        out.set(row.id, k);
      } catch (err) {
        // Skip models whose key can't decrypt; the model entry still appears
        // in the catalog with `_k: null` (see /enterprise-models handler).
        // Log the failure explicitly — the silent skip above means a missing
        // or mismatched GENWORK_VAULT_MASTER_KEY surfaces downstream only as a
        // desktop "model unavailable" prompt with no server-side trace.
        console.error('[enterpriseModels] failed to decrypt provider key', {
          modelId: row.id,
          providerKeyId: row.provider_key_id,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
    return out;
  },
};
