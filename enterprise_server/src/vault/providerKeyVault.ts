import { pool } from '../db/pool';
import { decrypt, encrypt } from './crypto';

/** Region hint for grouping providers in the admin UI / desktop picker. */
export type ProviderRegion = 'china' | 'global';

/** Display mask for a secret: keep first 3 + last 4, mask the middle. Not a
 * secret — purely a UI aid. Never returns the plaintext. */
export function maskKey(key: string): string {
  if (!key || key.length <= 8) return '••••';
  const head = key.slice(0, 3);
  const tail = key.slice(-4);
  const mid = '•'.repeat(Math.min(key.length - 7, 12));
  return `${head}${mid}${tail}`;
}

export interface ProviderKeyView {
  id: string;
  org_id: string;
  provider: string;
  endpoint: string | null;
  label: string | null;
  enabled: boolean;
  region: ProviderRegion | null;
  default_base_url: string | null;
  website: string | null;
  description: string | null;
  api_key_masked: string | null;
  is_builtin: boolean;
  protocol: 'openai' | 'anthropic';
  /** "Coding Plan" (beta): when on the UI swaps the Base URL to the provider's
   * coding-specific endpoint. Persisted so it round-trips through the save. */
  coding_plan: boolean;
  status: 'unknown' | 'connected' | 'failed';
  latency_ms: number | null;
  last_test_at: string | null;
  created_at: string;
}

export const providerKeyVault = {
  async add(input: {
    orgId: string;
    provider: string;
    plaintextKey?: string;
    label?: string;
    endpoint?: string;
    region?: ProviderRegion;
    defaultBaseUrl?: string;
    website?: string;
    createdBy?: string;
    isBuiltin?: boolean;
    protocol?: 'openai' | 'anthropic';
    /** "Coding Plan" flag (beta coding endpoint). Defaults to off. */
    codingPlan?: boolean;
    /** Whether the row starts enabled. Defaults to "a key was provided": a
     * keyless provider is created disabled (未启用) — it can't authenticate —
     * and is enabled later once a key is set. Pass `false` explicitly to force
     * disabled even with a key. */
    enabled?: boolean;
  }): Promise<{ id: string }> {
    const id = crypto.randomUUID();
    const enabled = input.enabled ?? input.plaintextKey != null;
    await pool.query(
      `INSERT INTO provider_keys(
         id, org_id, provider, api_key_encrypted, api_key_masked,
         endpoint, label, region, default_base_url, website, created_by,
         is_builtin, protocol, coding_plan, enabled
       )
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,
      [
        id,
        input.orgId,
        input.provider,
        input.plaintextKey ? encrypt(input.plaintextKey) : null,
        input.plaintextKey ? maskKey(input.plaintextKey) : null,
        input.endpoint ?? null,
        input.label ?? null,
        input.region ?? null,
        input.defaultBaseUrl ?? null,
        input.website ?? null,
        input.createdBy ?? null,
        input.isBuiltin ?? false,
        input.protocol ?? 'openai',
        input.codingPlan ?? false,
        enabled,
      ],
    );
    return { id };
  },

  async list(orgId: string): Promise<ProviderKeyView[]> {
    // `last_test_at` is a `timestamptz`; pglite/pg return it as a `Date`, so
    // query it as such and normalize to an ISO string for the wire shape.
    const r = await pool.query<
      Omit<ProviderKeyView, 'last_test_at'> & {
        last_test_at: Date | null;
        api_key_encrypted: string | null;
      }
    >(
      `SELECT id, org_id, provider, endpoint, label, enabled,
              region, default_base_url, website,
              description, api_key_masked, api_key_encrypted,
              is_builtin, protocol, coding_plan, status, latency_ms, last_test_at, created_at
       FROM provider_keys WHERE org_id=$1 ORDER BY created_at DESC`,
      [orgId],
    );
    return Promise.all(
      r.rows.map(async (row) => {
        const { api_key_encrypted, ...rest } = row;
        let masked = row.api_key_masked;
        if (!masked && api_key_encrypted) {
          masked = maskKey(decrypt(api_key_encrypted)); // legacy row without a stored mask
        }
        return {
          ...rest,
          api_key_masked: masked,
          last_test_at: row.last_test_at ? row.last_test_at.toISOString() : null,
        };
      }),
    );
  },

  async getDecrypted(id: string): Promise<string> {
    const r = await pool.query<{ api_key_encrypted: string }>(
      `SELECT api_key_encrypted FROM provider_keys WHERE id=$1 AND enabled=true`,
      [id],
    );
    if (r.rowCount === 0) throw new Error('provider key not found or disabled');
    return decrypt(r.rows[0].api_key_encrypted);
  },

  async getRow(id: string): Promise<{
    id: string;
    org_id: string;
    provider: string;
    endpoint: string | null;
    region: ProviderRegion | null;
    enabled: boolean;
    protocol: 'openai' | 'anthropic';
  } | null> {
    const r = await pool.query(
      `SELECT id, org_id, provider, endpoint, region, enabled, protocol FROM provider_keys WHERE id=$1`,
      [id],
    );
    return (r.rows[0] as never) ?? null;
  },

  async setEnabled(id: string, enabled: boolean): Promise<void> {
    await pool.query(`UPDATE provider_keys SET enabled=$1 WHERE id=$2`, [enabled, id]);
  },

  /**
   * Write back the result of a connection probe: `status` (connected|failed),
   * `latencyMs` (round-trip ms), and `lastTestAt` (ISO timestamp).
   * Scoped to `orgId` so callers cannot update rows from another tenant.
   * Returns true when a row was actually updated.
   */
  async updateStatus(
    id: string,
    orgId: string,
    fields: {
      status: 'connected' | 'failed';
      latencyMs: number;
      lastTestAt: string;
    },
  ): Promise<boolean> {
    const r = await pool.query(
      `UPDATE provider_keys SET status = $1, latency_ms = $2, last_test_at = $3
        WHERE id = $4 AND org_id = $5`,
      [fields.status, fields.latencyMs, fields.lastTestAt, id, orgId],
    );
    return (r.rowCount ?? 0) > 0;
  },

  /**
   * Replace the stored API key for a provider row: re-encrypts the plaintext
   * and writes a fresh display mask. The plaintext is never returned by any
   * method; only the `•`-masked form is persisted for display.
   */
  async setApiKey(id: string, plaintextKey: string): Promise<void> {
    await pool.query(
      `UPDATE provider_keys SET api_key_encrypted = $1, api_key_masked = $2 WHERE id = $3`,
      [encrypt(plaintextKey), maskKey(plaintextKey), id],
    );
  },

  async patch(
    id: string,
    fields: {
      description?: string | null;
      endpoint?: string | null;
      label?: string | null;
      enabled?: boolean;
      protocol?: 'openai' | 'anthropic';
      codingPlan?: boolean;
    },
  ): Promise<boolean> {
    const sets: string[] = [];
    const params: unknown[] = [];
    let i = 1;
    if (fields.description !== undefined) {
      sets.push(`description = $${i++}`);
      params.push(fields.description);
    }
    if (fields.endpoint !== undefined) {
      sets.push(`endpoint = $${i++}`);
      params.push(fields.endpoint);
    }
    if (fields.label !== undefined) {
      sets.push(`label = $${i++}`);
      params.push(fields.label);
    }
    if (fields.enabled !== undefined) {
      sets.push(`enabled = $${i++}`);
      params.push(fields.enabled);
    }
    if (fields.protocol !== undefined) {
      sets.push(`protocol = $${i++}`);
      params.push(fields.protocol);
    }
    if (fields.codingPlan !== undefined) {
      sets.push(`coding_plan = $${i++}`);
      params.push(fields.codingPlan);
    }
    if (sets.length === 0) return true;
    params.push(id);
    const r = await pool.query(
      `UPDATE provider_keys SET ${sets.join(', ')} WHERE id = $${i}`,
      params,
    );
    return (r.rowCount ?? 0) > 0;
  },

  /**
   * Hard-delete a provider_key row, scoped to the caller's org. Returns
   * true when a row was actually removed; false if the row did not exist
   * or belonged to a different org (the route handler turns that into a
   * 404 before it ever gets here, but the abstraction still respects org).
   *
   * Callers are responsible for cascading dependent tables (model_catalog
   * via modelCatalog.deleteByProviderKey) BEFORE invoking remove().
   */
  async remove(orgId: string, id: string): Promise<boolean> {
    const r = await pool.query(
      `DELETE FROM provider_keys WHERE id = $1 AND org_id = $2`,
      [id, orgId],
    );
    return (r.rowCount ?? 0) > 0;
  },
};
