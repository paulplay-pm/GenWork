import { randomUUID } from 'node:crypto';

import { type Context,Hono } from 'hono';
import { z } from 'zod';

import { auditStore } from '../audit/auditStore';
import { requireAuth, requirePermission } from '../auth/middleware';
import { pool } from '../db/pool';
import type { TxClient } from '../db/testDb';
import { COLUMNS, type ConnectorRow, type ConnectorScope, type ToolEntry, type VersionRow, mapAdminConnector, scopeSummary } from '../models/connectorView';
import { probeConnector } from '../mcp/handshake';
import { AuditAction } from '../shared/enterpriseServerConstants';
import { PermissionPoint as PP } from '../shared/permissionPoints';
import { decryptConnectorSecrets, encryptConnectorSecrets, hasStoredSecret, maskConnectorSecrets } from '../vault/connectorSecret';

const scopeSchema = z.object({
  allCompany: z.boolean().optional().default(false),
  deptIds: z.array(z.string()).optional().default([]),
  userIds: z.array(z.string()).optional().default([]),
});

const authModeEnum = z.enum(['none', 'shared-key', 'user-key', 'user-oauth', 'client-creds', 'sso']);
const transportEnum = z.enum(['http', 'sse']);

/** The connector body minus `orgId`. Shared by the admin create route and the
 * member submission queue: a submission's `cfg` is exactly this shape, so an
 * approved submission replays into a connector via the same logic. */
export const connectorCfgSchema = z.object({
  serverKey: z.string().min(1).regex(/^[a-z0-9-]+$/),
  url: z.string().min(1),
  nameEn: z.string().optional(),
  nameZh: z.string().optional(),
  version: z.string().optional().default('1.0.0'),
  categoryId: z.string().nullable().optional(),
  description: z.string().max(200).optional(),
  transport: transportEnum.optional().default('http'),
  authMode: authModeEnum.optional().default('none'),
  authConfig: z.record(z.unknown()).optional().default({}),
  scope: scopeSchema.optional(),
});
export type ConnectorCfg = z.infer<typeof connectorCfgSchema>;

const createSchema = connectorCfgSchema.extend({ orgId: z.string() });

const patchSchema = z.object({
  nameEn: z.string().nullable().optional(),
  nameZh: z.string().nullable().optional(),
  url: z.string().min(1).optional(),
  version: z.string().optional(),
  categoryId: z.string().nullable().optional(),
  description: z.string().max(200).nullable().optional(),
  transport: transportEnum.optional(),
  authMode: authModeEnum.optional(),
  authConfig: z.record(z.unknown()).optional(),
  scope: scopeSchema.optional(),
  enabled: z.boolean().optional(),
});

const categoryWriteSchema = z.object({ name: z.string().min(1) });
const settingsPatchSchema = z.object({ membersCanSubmit: z.boolean() });

/** A tool entry as carried by a working copy / version snapshot. */
const toolEntrySchema = z.object({
  name: z.string().min(1),
  desc: z.string().optional(),
  enabled: z.boolean(),
  syncedAt: z.string().optional(),
  removed: z.boolean().optional(),
});

/** The connector's full working copy — the body of save-draft and publish.
 * It is the live fields the drawer edits plus the per-tool toggles and the
 * per-mode authConfig (a blank secret on edit means "keep the stored value").
 * Optional fields absent mean "keep the live value"; explicit null clears. */
const workingCopySchema = z.object({
  serverKey: z.string().min(1).regex(/^[a-z0-9-]+$/).optional(),
  url: z.string().min(1),
  version: z.string().min(1),
  nameEn: z.string().nullable().optional(),
  nameZh: z.string().nullable().optional(),
  categoryId: z.string().nullable().optional(),
  description: z.string().max(200).nullable().optional(),
  transport: transportEnum.optional().default('http'),
  authMode: authModeEnum.optional().default('none'),
  authConfig: z.record(z.unknown()).optional().default({}),
  scope: scopeSchema.optional(),
  tools: z.array(toolEntrySchema).optional(),
});
type WorkingCopy = z.infer<typeof workingCopySchema>;

/** `mcp_connector_versions` row (DB shape). */
interface VersionDbRow {
  id: string;
  version: string;
  note: string | null;
  current: boolean;
  created_at: Date;
  created_by: string | null;
}

/** Row -> admin wire (camelCase). */
function mapVersionRow(v: VersionDbRow): VersionRow {
  return {
    id: v.id,
    version: v.version,
    note: v.note,
    current: v.current,
    createdAt: v.created_at.toISOString(),
    createdBy: v.created_by,
  };
}

/** `mcp_connector_versions` rows for a connector, newest first. */
async function listVersions(connectorId: string): Promise<VersionRow[]> {
  const r = await pool.query<VersionDbRow>(
    `SELECT id, version, note, current, created_at, created_by
     FROM mcp_connector_versions WHERE connector_id = $1
     ORDER BY created_at DESC, id DESC`,
    [connectorId],
  );
  return r.rows.map(mapVersionRow);
}

/** Parse a JSONB value into a plain object (defensive: legacy rows may be
 * anything). Returns null when the value is not a plain object. */
function asRecord(v: unknown): Record<string, unknown> | null {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : null;
}

/** Fields that hold a secret per auth mode. */
const SECRET_FIELDS: readonly string[] = ['apiKey', 'clientSecret'];

/** Max user-defined connector categories per org. */
const CATEGORY_CAP = 20;

/** Timeout for the light test-connection probe. */
const TEST_TIMEOUT_MS = 30_000;

/** Fetch the connector row iff it belongs to the caller's org (cross-org
 * guard: a foreign id 404s instead of leaking existence). */
async function getOwn(connectorId: string, orgId: string): Promise<ConnectorRow | null> {
  const r = await pool.query<ConnectorRow>(
    `SELECT ${COLUMNS} FROM mcp_connectors WHERE id = $1 AND org_id = $2`,
    [connectorId, orgId],
  );
  return r.rowCount ? r.rows[0] : null;
}

function authStatusFor(authMode: string): 'configured' | 'pending' {
  return authMode === 'none' ? 'configured' : 'pending';
}

/** Per-mode required non-secret fields that must be present to publish. */
export function missingAuthField(authMode: string, authConfig: Record<string, unknown>): string | null {
  if (authMode === 'shared-key') return authConfig.apiKey ? null : 'apiKey';
  if (authMode === 'user-oauth' || authMode === 'client-creds') {
    if (!authConfig.clientId) return 'clientId';
    if (authMode === 'user-oauth') {
      // Public client + PKCE (desktop-driven): complete authorize/token endpoints
      // are enough — no client secret crosses the wire. Confidential client: a
      // clientSecret is still required (used by the server-side gateway, not the
      // desktop). The relaxation is additive — the existing confidential path is
      // preserved when endpoints are absent.
      const hasPublicEndpoints = Boolean(authConfig.authorizeUrl) && Boolean(authConfig.tokenUrl);
      if (authConfig.clientSecret || hasPublicEndpoints) return null;
      return 'clientSecret';
    }
    return authConfig.clientSecret ? null : 'clientSecret';
  }
  if (authMode === 'sso') {
    // Public client + PKCE (desktop-driven, same as user-oauth): the sso*
    // endpoints + clientId are enough — no ssoClientSecret crosses the wire.
    // A confidential SSO client (secret) is a gateway concern (M2), not the
    // desktop direct-link path, so it is not required here.
    if (!authConfig.ssoClientId) return 'ssoClientId';
    const hasSsoEndpoints = Boolean(authConfig.ssoAuthorizeUrl) && Boolean(authConfig.ssoTokenUrl);
    if (hasSsoEndpoints) return null;
    return 'ssoTokenUrl';
  }
  return null; // none / user-key have no admin-filled secret requirement
}

export function sseOauthCombination(transport: string, authMode: string): boolean {
  return transport === 'sse' && ['user-oauth', 'client-creds', 'sso'].includes(authMode);
}

/** Canonical JSON for scope equality checks (stable key order). */
function scopeKey(scope: ConnectorScope): string {
  return JSON.stringify({ allCompany: !!scope.allCompany, deptIds: scope.deptIds ?? [], userIds: scope.userIds ?? [] });
}

/**
 * Merge a PATCH's incoming `authConfig` over the stored config.
 *
 * The stored row already carries any old secret as `__enc__*` ciphertext
 * (every write path encrypts before storing), so the merge starts from the
 * stored object:
 *  - non-secret fields: the incoming value wins (may be '' or null);
 *  - secret fields (apiKey/clientSecret): a non-empty incoming string
 *    replaces the stored secret — `encryptConnectorSecrets` rewrites that
 *    field's `__enc__*` ciphertext; an empty or absent incoming value keeps
 *    the stored secret verbatim (existing ciphertext preserved, NOT
 *    re-encrypted — only fields the client actually sent a non-empty value
 *    for are re-encrypted);
 *  - client-supplied `__enc__*` keys are ignored (never trusted).
 *
 * The result is always run through `encryptConnectorSecrets`, so the stored
 * config never carries a plaintext secret. `secretChanged` is true only when
 * a secret field was replaced with a new non-empty value.
 */
function mergeAuthConfig(
  stored: Record<string, unknown>,
  incoming: Record<string, unknown>,
): { merged: Record<string, unknown>; secretChanged: boolean } {
  const merged: Record<string, unknown> = { ...stored };
  let secretChanged = false;
  for (const [k, v] of Object.entries(incoming)) {
    if (k.startsWith('__enc__')) continue; // never trust client-supplied ciphertext
    if (SECRET_FIELDS.includes(k)) {
      if (typeof v === 'string' && v.length > 0) {
        merged[k] = v; // plaintext; encryptConnectorSecrets stores it as __enc__k
        secretChanged = true;
      }
      // empty/absent → keep the stored secret
      continue;
    }
    merged[k] = v;
  }
  return { merged: encryptConnectorSecrets(merged), secretChanged };
}

/** Cross-tenant guard for org-level routes: `?orgId=` is required and must
 * match the caller's token. Returns the org id, or a Response to send. */
export function orgFromQuery(c: Context): string | Response {
  const orgId = c.req.query('orgId');
  if (!orgId) return c.json({ error: 'orgId required' }, 400);
  const claims = c.get('claims');
  if (orgId !== claims.orgId) return c.json({ error: 'org_mismatch' }, 400);
  return orgId;
}

/** Failure discriminants the create path can return. The caller maps them to
 * HTTP: `sse_oauth_not_supported`/`missing_auth_field` → 400,
 * `server_key_taken` → 409. */
export type CreateConnectorFailure =
  | { error: 'server_key_taken' }
  | { error: 'sse_oauth_not_supported' }
  | { error: 'missing_auth_field'; field: string };

/**
 * Build + insert a connector from a validated config. Shared by the admin
 * create route and submission approval, so both publish identical rows.
 *
 * Runs the create guards (sse+oauth combination, per-mode required secret),
 * resolves the server_key, encrypts the secret fields, INSERTs, and writes
 * the create audit row. `onKeyCollision`:
 *  - `'reject'` — a taken server_key fails with `server_key_taken` (admin
 *    create route: the observable 409 behavior is unchanged);
 *  - `'suffix'` — a taken server_key gets `-2`, `-3`, … appended until a
 *    unique key is found (submission approve: the member's config still
 *    publishes next to an existing connector).
 */
export async function createConnectorFromCfg(
  orgId: string,
  cfg: ConnectorCfg,
  opts: { createdBy: string; onKeyCollision: 'reject' | 'suffix'; tx?: TxClient },
): Promise<{ id: string; serverKey: string } | CreateConnectorFailure> {
  // Optional tx client lets the caller run the whole insert inside a
  // transaction (submission approve). Defaults to the module pool so the
  // plain admin-create route is unchanged.
  const db = opts.tx ?? pool;
  if (sseOauthCombination(cfg.transport, cfg.authMode)) return { error: 'sse_oauth_not_supported' };
  const missing = missingAuthField(cfg.authMode, cfg.authConfig);
  if (missing) return { error: 'missing_auth_field', field: missing };

  let serverKey = cfg.serverKey;
  const keyTaken = (org: string, key: string) =>
    db.query('SELECT 1 FROM mcp_connectors WHERE org_id = $1 AND server_key = $2', [org, key])
      .then(r => !!r.rowCount);
  if (opts.onKeyCollision === 'suffix') {
    // Only suffix when the base key is actually taken: -2, -3, … until free.
    if (await keyTaken(orgId, cfg.serverKey)) {
      for (let n = 2; ; n++) {
        serverKey = `${cfg.serverKey}-${n}`;
        if (!(await keyTaken(orgId, serverKey))) break;
      }
    }
  } else {
    if (await keyTaken(orgId, cfg.serverKey)) return { error: 'server_key_taken' };
  }

  const scope: ConnectorScope = cfg.scope ?? { allCompany: false, deptIds: [], userIds: [] };
  const authConfig = encryptConnectorSecrets(cfg.authConfig);
  const id = randomUUID();
  await db.query(
    `INSERT INTO mcp_connectors
       (id, org_id, server_key, name_en, name_zh, version, category_id, description,
        connector_type, url, transport, auth_mode, auth_config, auth_status, enabled, scope, tools, draft)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'mcp',$9,$10,$11,$12,$13,TRUE,$14,$15,NULL)`,
    [
      id, orgId, serverKey, cfg.nameEn ?? null, cfg.nameZh ?? null, cfg.version,
      cfg.categoryId ?? null, cfg.description ?? null, cfg.url, cfg.transport,
      cfg.authMode, JSON.stringify(authConfig), authStatusFor(cfg.authMode),
      JSON.stringify(scope), JSON.stringify([]),
    ],
  );
  await auditStore.write({
    orgId, userId: opts.createdBy,
    action: AuditAction.McpConnectorCreate, targetType: 'connector', targetId: id,
    payload: { serverKey, authMode: cfg.authMode },
    tx: opts.tx,
  });
  return { id, serverKey };
}

export const mcpConnectorsRoutes = new Hono();
mcpConnectorsRoutes.use('/admin/mcp-connectors/*', requireAuth);

mcpConnectorsRoutes.post('/admin/mcp-connectors', requirePermission(PP.McpCreate), async c => {
  const claims = c.get('claims');
  const parsed = createSchema.safeParse(await c.req.json());
  if (!parsed.success) return c.json({ error: 'invalid_body', issues: parsed.error.issues }, 400);
  const b = parsed.data;
  if (b.orgId !== claims.orgId) return c.json({ error: 'org_mismatch' }, 400);
  const result = await createConnectorFromCfg(
    claims.orgId,
    {
      serverKey: b.serverKey, url: b.url, nameEn: b.nameEn, nameZh: b.nameZh,
      version: b.version, categoryId: b.categoryId, description: b.description,
      transport: b.transport, authMode: b.authMode, authConfig: b.authConfig, scope: b.scope,
    },
    { createdBy: claims.sub, onKeyCollision: 'reject' },
  );
  if ('error' in result) return c.json(result, result.error === 'server_key_taken' ? 409 : 400);
  return c.json({ id: result.id }, 201);
});

mcpConnectorsRoutes.get('/admin/mcp-connectors', requirePermission(PP.McpView), async c => {
  const org = orgFromQuery(c);
  if (typeof org !== 'string') return org;
  const r = await pool.query<ConnectorRow>(
    `SELECT ${COLUMNS} FROM mcp_connectors WHERE org_id = $1 ORDER BY created_at DESC`,
    [org],
  );
  return c.json(r.rows.map(mapAdminConnector));
});

mcpConnectorsRoutes.get('/admin/mcp-connectors/categories', requirePermission(PP.McpView), async c => {
  const org = orgFromQuery(c);
  if (typeof org !== 'string') return org;
  const r = await pool.query<{ id: string; name: string }>(
    'SELECT id, name FROM mcp_connector_categories WHERE org_id = $1 ORDER BY name',
    [org],
  );
  return c.json(r.rows);
});

mcpConnectorsRoutes.post('/admin/mcp-connectors/categories', requirePermission(PP.McpEdit), async c => {
  const claims = c.get('claims');
  const org = orgFromQuery(c);
  if (typeof org !== 'string') return org;
  const parsed = categoryWriteSchema.safeParse(await c.req.json());
  if (!parsed.success) return c.json({ error: 'invalid_body', issues: parsed.error.issues }, 400);
  const name = parsed.data.name;
  const count = await pool.query<{ n: number }>(
    'SELECT count(*)::int AS n FROM mcp_connector_categories WHERE org_id = $1',
    [org],
  );
  if (count.rows[0].n >= CATEGORY_CAP) return c.json({ error: 'category_cap' }, 409);
  const dup = await pool.query('SELECT 1 FROM mcp_connector_categories WHERE org_id = $1 AND name = $2', [
    org,
    name,
  ]);
  if (dup.rowCount) return c.json({ error: 'category_name_taken' }, 409);
  const id = randomUUID();
  await pool.query('INSERT INTO mcp_connector_categories (id, org_id, name) VALUES ($1, $2, $3)', [id, org, name]);
  await auditStore.write({
    orgId: org, userId: claims.sub,
    action: AuditAction.McpConnectorCategoryCreate, targetType: 'connector_category', targetId: id,
    payload: { name },
  });
  return c.json({ id }, 201);
});

mcpConnectorsRoutes.put('/admin/mcp-connectors/categories/:id', requirePermission(PP.McpEdit), async c => {
  const id = c.req.param('id');
  const org = orgFromQuery(c);
  if (typeof org !== 'string') return org;
  const parsed = categoryWriteSchema.safeParse(await c.req.json());
  if (!parsed.success) return c.json({ error: 'invalid_body', issues: parsed.error.issues }, 400);
  const name = parsed.data.name;
  const dup = await pool.query(
    'SELECT 1 FROM mcp_connector_categories WHERE org_id = $1 AND name = $2 AND id <> $3',
    [org, name, id],
  );
  if (dup.rowCount) return c.json({ error: 'category_name_taken' }, 409);
  const result = await pool.query(
    'UPDATE mcp_connector_categories SET name = $1 WHERE id = $2 AND org_id = $3',
    [name, id, org],
  );
  if (result.rowCount === 0) return c.json({ error: 'not_found' }, 404);
  return c.json({ ok: true });
});

mcpConnectorsRoutes.delete('/admin/mcp-connectors/categories/:id', requirePermission(PP.McpEdit), async c => {
  const claims = c.get('claims');
  const id = c.req.param('id');
  const org = orgFromQuery(c);
  if (typeof org !== 'string') return org;
  const existing = await pool.query<{ id: string; name: string }>(
    'SELECT id, name FROM mcp_connector_categories WHERE id = $1 AND org_id = $2',
    [id, org],
  );
  if (existing.rowCount === 0) return c.json({ error: 'not_found' }, 404);
  // Migrate-on-delete: un-categorize the org's connectors, then delete.
  const moved = await pool.query(
    'UPDATE mcp_connectors SET category_id = NULL WHERE org_id = $1 AND category_id = $2',
    [org, id],
  );
  await pool.query('DELETE FROM mcp_connector_categories WHERE id = $1 AND org_id = $2', [id, org]);
  await auditStore.write({
    orgId: org, userId: claims.sub,
    action: AuditAction.McpConnectorCategoryDelete, targetType: 'connector_category', targetId: id,
    payload: { name: existing.rows[0].name, movedConnectors: moved.rowCount ?? 0 },
  });
  return c.json({ ok: true });
});

mcpConnectorsRoutes.get('/admin/mcp-connectors/settings', requirePermission(PP.McpView), async c => {
  const org = orgFromQuery(c);
  if (typeof org !== 'string') return org;
  const r = await pool.query<{ members_can_submit_connectors: boolean }>(
    'SELECT members_can_submit_connectors FROM orgs WHERE id = $1',
    [org],
  );
  if (r.rowCount === 0) return c.json({ error: 'org_not_found' }, 404);
  return c.json({ membersCanSubmit: r.rows[0].members_can_submit_connectors });
});

mcpConnectorsRoutes.patch('/admin/mcp-connectors/settings', requirePermission(PP.McpEdit), async c => {
  const claims = c.get('claims');
  const org = orgFromQuery(c);
  if (typeof org !== 'string') return org;
  const parsed = settingsPatchSchema.safeParse(await c.req.json());
  if (!parsed.success) return c.json({ error: 'invalid_body', issues: parsed.error.issues }, 400);
  const r = await pool.query<{ members_can_submit_connectors: boolean }>(
    'SELECT members_can_submit_connectors FROM orgs WHERE id = $1',
    [org],
  );
  if (r.rowCount === 0) return c.json({ error: 'org_not_found' }, 404);
  const before = r.rows[0].members_can_submit_connectors;
  if (before === parsed.data.membersCanSubmit) return c.json({ ok: true, membersCanSubmit: before });
  await pool.query('UPDATE orgs SET members_can_submit_connectors = $1 WHERE id = $2', [
    parsed.data.membersCanSubmit,
    org,
  ]);
  await auditStore.write({
    orgId: org, userId: claims.sub,
    action: AuditAction.McpConnectorSettingUpdate, targetType: 'org', targetId: org,
    payload: { before, after: parsed.data.membersCanSubmit },
  });
  return c.json({ ok: true, membersCanSubmit: parsed.data.membersCanSubmit });
});

mcpConnectorsRoutes.get('/admin/mcp-connectors/:id', requirePermission(PP.McpView), async c => {
  const claims = c.get('claims');
  const row = await getOwn(c.req.param('id'), claims.orgId);
  if (!row) return c.json({ error: 'not_found' }, 404);
  // Detail carries the version history (metadata only — the `config`
  // snapshots stay server-side; rollback restores them).
  const versions = await listVersions(row.id);
  // The staged draft is exposed too, MASKED: its authConfig is stored as
  // `__enc__` ciphertext, so the nested secrets get the same masking as the
  // live row (no plaintext / `__enc__` key ever reaches the wire). The SPA
  // seeds the editor from it (finding B1).
  const draft = row.draft
    ? { ...row.draft, authConfig: maskConnectorSecrets(asRecord(row.draft.authConfig) ?? {}) }
    : null;
  return c.json({ ...mapAdminConnector(row), versions, draft });
});

mcpConnectorsRoutes.patch('/admin/mcp-connectors/:id', requirePermission(PP.McpEdit), async c => {
  const claims = c.get('claims');
  const id = c.req.param('id');
  const parsed = patchSchema.safeParse(await c.req.json());
  if (!parsed.success) return c.json({ error: 'invalid_body', issues: parsed.error.issues }, 400);
  const b = parsed.data;

  // Cross-org guard: the connector must exist AND belong to the caller's org.
  const row = await getOwn(id, claims.orgId);
  if (!row) return c.json({ error: 'not_found' }, 404);

  // The resulting transport + auth mode must be a supported combination.
  if (sseOauthCombination(b.transport ?? row.transport, b.authMode ?? row.auth_mode)) {
    return c.json({ error: 'sse_oauth_not_supported' }, 400);
  }

  const sets: string[] = [];
  const params: unknown[] = [id, claims.orgId];
  const push = (col: string, val: unknown): void => {
    params.push(val);
    sets.push(`${col} = $${params.length}`);
  };

  if (b.nameEn !== undefined) push('name_en', b.nameEn ?? null);
  if (b.nameZh !== undefined) push('name_zh', b.nameZh ?? null);
  if (b.url !== undefined) push('url', b.url);
  if (b.version !== undefined) push('version', b.version);
  if (b.categoryId !== undefined) push('category_id', b.categoryId ?? null);
  if (b.description !== undefined) push('description', b.description ?? null);
  if (b.transport !== undefined) push('transport', b.transport);
  if (b.authMode !== undefined) push('auth_mode', b.authMode);
  if (b.scope !== undefined) push('scope', JSON.stringify(b.scope));
  if (b.enabled !== undefined) push('enabled', b.enabled);

  // Secret merge: blank-on-edit keeps the stored secret (see mergeAuthConfig).
  let secretChanged = false;
  let mergedConfig: Record<string, unknown> | null = null;
  if (b.authConfig !== undefined) {
    const merged = mergeAuthConfig(row.auth_config, b.authConfig);
    secretChanged = merged.secretChanged;
    mergedConfig = merged.merged;
    push('auth_config', JSON.stringify(merged.merged));
    if (secretChanged) {
      push('secret_meta', JSON.stringify({ lastUpdatedAt: new Date().toISOString(), lastUpdatedBy: claims.sub }));
    }
  }
  // A PATCH that flips auth_mode re-arms auth: the new mode's credentials are
  // unverified until the connector is re-tested/published.
  if (b.authMode !== undefined && b.authMode !== row.auth_mode) {
    push('auth_status', 'pending');
  }

  if (sets.length === 0) return c.json({ error: 'empty_patch' }, 400);
  const result = await pool.query(
    `UPDATE mcp_connectors SET ${sets.join(', ')}, updated_at = NOW() WHERE id = $1 AND org_id = $2`,
    params,
  );
  if (result.rowCount === 0) return c.json({ error: 'not_found' }, 404);

  // Audit payload: the changed keys only (values are non-secret fields; the
  // authConfig value itself is never echoed — it may carry ciphertext).
  const fields: Record<string, unknown> = {};
  if (b.nameEn !== undefined && (b.nameEn ?? null) !== row.name_en) fields.nameEn = b.nameEn ?? null;
  if (b.nameZh !== undefined && (b.nameZh ?? null) !== row.name_zh) fields.nameZh = b.nameZh ?? null;
  if (b.url !== undefined && b.url !== row.url) fields.url = b.url;
  if (b.version !== undefined && b.version !== row.version) fields.version = b.version;
  if (b.categoryId !== undefined && (b.categoryId ?? null) !== row.category_id) fields.categoryId = b.categoryId ?? null;
  if (b.description !== undefined && (b.description ?? null) !== row.description) fields.description = b.description ?? null;
  if (b.transport !== undefined && b.transport !== row.transport) fields.transport = b.transport;
  if (b.authMode !== undefined && b.authMode !== row.auth_mode) fields.authMode = b.authMode;
  if (b.scope !== undefined && scopeKey(b.scope) !== scopeKey(row.scope)) fields.scope = b.scope;
  if (b.enabled !== undefined && b.enabled !== row.enabled) fields.enabled = b.enabled;
  if (mergedConfig && JSON.stringify(mergedConfig) !== JSON.stringify(row.auth_config)) fields.authConfig = true;

  if (b.enabled !== undefined && b.enabled !== row.enabled) {
    await auditStore.write({
      orgId: claims.orgId, userId: claims.sub,
      action: AuditAction.McpConnectorToggle, targetType: 'connector', targetId: id,
      payload: { serverKey: row.server_key, enabled: b.enabled },
    });
  }
  if (Object.keys(fields).length > 0) {
    await auditStore.write({
      orgId: claims.orgId, userId: claims.sub,
      action: AuditAction.McpConnectorUpdate, targetType: 'connector', targetId: id,
      payload: { fields, secretRotated: secretChanged },
    });
  }
  return c.json({ ok: true });
});

mcpConnectorsRoutes.delete('/admin/mcp-connectors/:id', requirePermission(PP.McpDelete), async c => {
  const claims = c.get('claims');
  const id = c.req.param('id');
  const row = await getOwn(id, claims.orgId);
  if (!row) return c.json({ error: 'not_found' }, 404);
  await pool.query('DELETE FROM mcp_connectors WHERE id = $1 AND org_id = $2', [id, claims.orgId]);
  await auditStore.write({
    orgId: claims.orgId, userId: claims.sub,
    action: AuditAction.McpConnectorDelete, targetType: 'connector', targetId: id,
    payload: { serverKey: row.server_key, scopeSummary: scopeSummary(row.scope) },
  });
  // V1: no agent/skill bindings exist yet, so the dependent list is empty.
  return c.json({ ok: true, impact: { scopeSummary: scopeSummary(row.scope), draftRemoved: !!row.draft } });
});

/**
 * Test connection: a genuine MCP `initialize` + `tools/list` handshake
 * (see mcp/handshake — pure; it never throws). The stored secret is decrypted
 * only to build the Authorization header (internal use; the plaintext is
 * never echoed in a response). On success the server's tool list is merged
 * into `tools` — a new tool is enabled, a tool the server no longer lists is
 * marked `removed` (its toggle kept), a tool still listed keeps its toggle —
 * and `tools` + `last_test_*` are persisted. A failed probe is a resolved
 * result, not an HTTP error (only a missing URL 400s); `tools` is untouched.
 */
mcpConnectorsRoutes.post('/admin/mcp-connectors/:id/test', requirePermission(PP.McpEdit), async c => {
  const claims = c.get('claims');
  const id = c.req.param('id');
  const row = await getOwn(id, claims.orgId);
  if (!row) return c.json({ error: 'not_found' }, 404);
  if (!row.url) return c.json({ error: 'no_url' }, 400);

  // Build the auth header from the decrypted stored secret: shared-key ->
  // Bearer <apiKey>; other modes -> a stored token, if any. The P0/P1 admin
  // model only fills apiKey/clientId/clientSecret, so shared-key is the
  // primary bearer path.
  const plain = decryptConnectorSecrets(row.auth_config);
  const headers: Record<string, string> = {};
  const bearer = row.auth_mode === 'shared-key' ? plain.apiKey : plain.accessToken;
  if (typeof bearer === 'string' && bearer.length > 0) {
    headers.Authorization = `Bearer ${bearer}`;
  }

  const probe = await probeConnector({
    url: row.url,
    transport: row.transport,
    headers,
    timeoutMs: TEST_TIMEOUT_MS,
  });
  const lastTestAt = new Date().toISOString();

  if (probe.status === 'connected') {
    // Merge the server's tool list into the stored tools (upsert by name).
    const serverTools = probe.tools ?? [];
    const merged: ToolEntry[] = row.tools.map((t) => {
      const s = serverTools.find((x) => x.name === t.name);
      if (s) {
        // Still listed: keep the admin's toggle, refresh desc/syncedAt.
        return { ...t, desc: s.desc ?? t.desc, removed: false, syncedAt: lastTestAt };
      }
      // No longer listed: gray it out (toggle kept), mark removed.
      return { ...t, removed: true };
    });
    for (const s of serverTools) {
      if (!row.tools.some((t) => t.name === s.name)) {
        merged.push({ name: s.name, desc: s.desc, enabled: true, syncedAt: lastTestAt });
      }
    }
    const toolCount = merged.filter((t) => !t.removed).length;
    await pool.query(
      `UPDATE mcp_connectors
       SET tools = $3, last_test_at = $4, last_test_status = 'connected', last_latency_ms = $5,
           updated_at = NOW()
       WHERE id = $1 AND org_id = $2`,
      [id, claims.orgId, JSON.stringify(merged), lastTestAt, probe.latencyMs],
    );
    await auditStore.write({
      orgId: claims.orgId, userId: claims.sub,
      action: AuditAction.McpConnectorTest, targetType: 'connector', targetId: id,
      payload: { status: 'connected', latencyMs: probe.latencyMs, toolCount },
    });
    return c.json({ status: 'connected', latencyMs: probe.latencyMs, lastTestAt, toolCount });
  }

  // A failed probe persists the result (never an HTTP error) and leaves
  // `tools` untouched.
  await pool.query(
    `UPDATE mcp_connectors
     SET last_test_at = $3, last_test_status = 'failed', last_latency_ms = $4,
         updated_at = NOW()
     WHERE id = $1 AND org_id = $2`,
    [id, claims.orgId, lastTestAt, probe.latencyMs],
  );
  await auditStore.write({
    orgId: claims.orgId, userId: claims.sub,
    action: AuditAction.McpConnectorTest, targetType: 'connector', targetId: id,
    payload: { status: 'failed', latencyMs: probe.latencyMs, error: probe.error ?? null },
  });
  return c.json({ status: 'failed', error: probe.error, latencyMs: probe.latencyMs, lastTestAt });
});

/**
 * Save the working copy as a draft: staged with NO live effect (live fields,
 * tools, and versions are untouched). The draft's authConfig is merged over
 * the stored config and encrypted (blank-on-edit keeps the stored
 * ciphertext), so the draft itself never carries a plaintext secret.
 */
mcpConnectorsRoutes.post('/admin/mcp-connectors/:id/save-draft', requirePermission(PP.McpEdit), async c => {
  const claims = c.get('claims');
  const id = c.req.param('id');
  const row = await getOwn(id, claims.orgId);
  if (!row) return c.json({ error: 'not_found' }, 404);
  const parsed = workingCopySchema.safeParse(await c.req.json());
  if (!parsed.success) return c.json({ error: 'invalid_body', issues: parsed.error.issues }, 400);
  const b = parsed.data;
  const merged = mergeAuthConfig(row.auth_config, b.authConfig);
  const draft: Record<string, unknown> = { ...b, authConfig: merged.merged };
  await pool.query(
    'UPDATE mcp_connectors SET draft = $3, updated_at = NOW() WHERE id = $1 AND org_id = $2',
    [id, claims.orgId, JSON.stringify(draft)],
  );
  await auditStore.write({
    orgId: claims.orgId, userId: claims.sub,
    action: AuditAction.McpConnectorUpdate, targetType: 'connector', targetId: id,
    payload: { serverKey: row.server_key, drafted: true },
  });
  return c.json({ ok: true });
});

/**
 * Publish the working copy: apply it to the live row, clear the draft, and —
 * when the version changed — record a `mcp_connector_versions` snapshot (the
 * canonical ENCRYPTED config that rollback restores). Guards mirror the
 * create path (sse+oauth combination, per-mode secret computed against the
 * MERGED config so blank-on-edit passes; a changed server_key must stay
 * unique). Returns the live version plus `destructiveAuthSwitch` when auth
 * changed on a connector that has a stored secret / `auth_status='configured'`
 * (members must re-authorize).
 */
mcpConnectorsRoutes.post('/admin/mcp-connectors/:id/publish', requirePermission(PP.McpEdit), async c => {
  const claims = c.get('claims');
  const id = c.req.param('id');
  const row = await getOwn(id, claims.orgId);
  if (!row) return c.json({ error: 'not_found' }, 404);
  const parsed = workingCopySchema.safeParse(await c.req.json());
  if (!parsed.success) return c.json({ error: 'invalid_body', issues: parsed.error.issues }, 400);
  const b = parsed.data;

  // Guards mirror the create path, run against the merged (blank-on-edit)
  // auth config. The merge is already encrypted, so the per-mode secret guard
  // runs on the DECRYPTED view (a kept stored secret passes; a blank-on-edit
  // with no stored secret still fails).
  if (sseOauthCombination(b.transport, b.authMode)) {
    return c.json({ error: 'sse_oauth_not_supported' }, 400);
  }
  const merged = mergeAuthConfig(row.auth_config, b.authConfig);
  const missing = missingAuthField(b.authMode, decryptConnectorSecrets(merged.merged));
  if (missing) return c.json({ error: 'missing_auth_field', field: missing }, 400);
  if (b.serverKey !== undefined && b.serverKey !== row.server_key) {
    const taken = await pool.query(
      'SELECT 1 FROM mcp_connectors WHERE org_id = $1 AND server_key = $2 AND id <> $3',
      [claims.orgId, b.serverKey, id],
    );
    if (taken.rowCount) return c.json({ error: 'server_key_taken' }, 409);
  }

  const newVersion = b.version;
  const scope = b.scope ?? row.scope;
  const tools = b.tools ?? row.tools;
  // Canonical snapshot of the applied config: every field at the value the
  // live row will take, with the merged (already-encrypted) authConfig. This
  // is exactly what rollback restores.
  const snapshot: Record<string, unknown> = {
    serverKey: b.serverKey ?? row.server_key,
    url: b.url,
    version: newVersion,
    nameEn: b.nameEn !== undefined ? b.nameEn : row.name_en,
    nameZh: b.nameZh !== undefined ? b.nameZh : row.name_zh,
    categoryId: b.categoryId !== undefined ? b.categoryId : row.category_id,
    description: b.description !== undefined ? b.description : row.description,
    transport: b.transport,
    authMode: b.authMode,
    authConfig: merged.merged,
    scope,
    tools,
  };
  const versionBumped = newVersion !== row.version;
  const authChanged = b.authMode !== row.auth_mode || merged.secretChanged;
  const destructiveAuthSwitch =
    authChanged && (hasStoredSecret(row.auth_config) || row.auth_status === 'configured');

  // Multi-write in one transaction: un-mark old current + versions insert +
  // connectors update + draft clear.
  await pool.transaction(async (tx) => {
    if (versionBumped) {
      await tx.query(
        'UPDATE mcp_connector_versions SET current = FALSE WHERE connector_id = $1 AND current = TRUE',
        [id],
      );
      await tx.query(
        `INSERT INTO mcp_connector_versions
           (id, connector_id, version, note, current, config, created_by)
         VALUES ($1, $2, $3, NULL, TRUE, $4, $5)`,
        [randomUUID(), id, newVersion, JSON.stringify(snapshot), claims.sub],
      );
    }
    const sets: string[] = [
      'url = $3', 'version = $4', 'name_en = $5', 'name_zh = $6', 'category_id = $7',
      'description = $8', 'transport = $9', 'auth_mode = $10', 'auth_config = $11',
      'scope = $12', 'tools = $13', 'auth_status = $14', 'draft = NULL',
    ];
    const params: unknown[] = [
      id, claims.orgId, b.url, newVersion,
      b.nameEn !== undefined ? b.nameEn : row.name_en,
      b.nameZh !== undefined ? b.nameZh : row.name_zh,
      b.categoryId !== undefined ? b.categoryId : row.category_id,
      b.description !== undefined ? b.description : row.description,
      b.transport, b.authMode, JSON.stringify(merged.merged),
      JSON.stringify(scope), JSON.stringify(tools),
      authStatusFor(b.authMode),
    ];
    if (b.serverKey !== undefined && b.serverKey !== row.server_key) {
      params.push(b.serverKey);
      sets.push(`server_key = $${params.length}`);
    }
    await tx.query(
      `UPDATE mcp_connectors SET ${sets.join(', ')}, updated_at = NOW() WHERE id = $1 AND org_id = $2`,
      params,
    );
  });

  // Audit: the changed keys only (authConfig values are never echoed).
  const fields: Record<string, unknown> = {};
  if (b.nameEn !== undefined && (b.nameEn ?? null) !== row.name_en) fields.nameEn = b.nameEn ?? null;
  if (b.nameZh !== undefined && (b.nameZh ?? null) !== row.name_zh) fields.nameZh = b.nameZh ?? null;
  if (b.url !== row.url) fields.url = b.url;
  if (newVersion !== row.version) fields.version = newVersion;
  if (b.categoryId !== undefined && (b.categoryId ?? null) !== row.category_id) {
    fields.categoryId = b.categoryId ?? null;
  }
  if (b.description !== undefined && (b.description ?? null) !== row.description) {
    fields.description = b.description ?? null;
  }
  if (b.transport !== row.transport) fields.transport = b.transport;
  if (b.authMode !== row.auth_mode) fields.authMode = b.authMode;
  if (b.scope !== undefined && scopeKey(b.scope) !== scopeKey(row.scope)) fields.scope = b.scope;
  if (JSON.stringify(merged.merged) !== JSON.stringify(row.auth_config)) fields.authConfig = true;
  if (Object.keys(fields).length > 0) {
    await auditStore.write({
      orgId: claims.orgId, userId: claims.sub,
      action: AuditAction.McpConnectorUpdate, targetType: 'connector', targetId: id,
      payload: { fields, secretRotated: merged.secretChanged, published: true },
    });
  }
  return c.json({ ok: true, version: newVersion, ...(destructiveAuthSwitch ? { destructiveAuthSwitch: true } : {}) });
});

/**
 * Roll the live connector back to a recorded version: restore that snapshot's
 * fields + auth_config (decrypt-then-re-encrypt — idempotent for ciphertext,
 * self-healing for a legacy plaintext snapshot), recompute auth_status,
 * mark the restored row `current` (un-marking the others), and record a new
 * rollback version row. The snapshot's `server_key` identity is deliberately
 * NOT restored: restoring a stale key could collide with another connector's
 * key (UNIQUE org_id+server_key) — rollback restores config, not identity.
 */
mcpConnectorsRoutes.post('/admin/mcp-connectors/:id/rollback', requirePermission(PP.McpEdit), async c => {
  const claims = c.get('claims');
  const id = c.req.param('id');
  const row = await getOwn(id, claims.orgId);
  if (!row) return c.json({ error: 'not_found' }, 404);
  const body = (await c.req.json().catch(() => ({}))) as { version?: unknown };
  const targetVersion = typeof body.version === 'string' ? body.version : '';
  if (!targetVersion) return c.json({ error: 'invalid_body' }, 400);

  // Cross-org safe: the connector was loaded via getOwn; the versions row is
  // matched by connector_id only.
  const vres = await pool.query<VersionDbRow & { config: Record<string, unknown> | null }>(
    `SELECT id, version, note, current, created_at, created_by, config
     FROM mcp_connector_versions WHERE connector_id = $1 AND version = $2`,
    [id, targetVersion],
  );
  if (vres.rowCount === 0) return c.json({ error: 'version_not_found' }, 404);
  const target = vres.rows[0];
  const snap = asRecord(target.config) ?? {};

  // Canonicalize the snapshot's authConfig: decrypt (recovers any plaintext a
  // legacy row may carry) then re-encrypt (idempotent for ciphertext) so the
  // live row and the rollback row both end up with `__enc__` keys only.
  const authConfig = encryptConnectorSecrets(decryptConnectorSecrets(asRecord(snap.authConfig) ?? {}));
  const authMode = typeof snap.authMode === 'string' ? snap.authMode : row.auth_mode;
  const url = typeof snap.url === 'string' && snap.url.length > 0 ? snap.url : row.url;
  const nameEn = typeof snap.nameEn === 'string' ? snap.nameEn : null;
  const nameZh = typeof snap.nameZh === 'string' ? snap.nameZh : null;
  const categoryId = typeof snap.categoryId === 'string' ? snap.categoryId : null;
  const description = typeof snap.description === 'string' ? snap.description : null;
  const transport: 'http' | 'sse' = snap.transport === 'sse' ? 'sse' : 'http';
  const scope: ConnectorScope = (asRecord(snap.scope) as ConnectorScope | null) ?? row.scope;
  const tools: ToolEntry[] = Array.isArray(snap.tools)
    ? (snap.tools as ToolEntry[])
        .filter((t) => t && typeof t.name === 'string')
        .map((t) => ({ ...t, enabled: typeof t.enabled === 'boolean' ? t.enabled : true }))
    : row.tools;

  // The rollback row's config: the same snapshot in canonical (encrypted)
  // form — never plaintext.
  const restoredConfig: Record<string, unknown> = {
    ...snap,
    url,
    version: target.version,
    nameEn,
    nameZh,
    categoryId,
    description,
    transport,
    authMode,
    authConfig,
    scope,
    tools,
  };

  await pool.transaction(async (tx) => {
    await tx.query(
      'UPDATE mcp_connector_versions SET current = FALSE WHERE connector_id = $1 AND current = TRUE',
      [id],
    );
    await tx.query(
      'UPDATE mcp_connector_versions SET current = TRUE WHERE id = $1 AND connector_id = $2',
      [target.id, id],
    );
    // The rollback row is an AUDIT record of the action (note `回滚到 <v>`),
    // not the live-state marker — the restored target row above is `current`,
    // so the rollback row must NOT also be current (the at-most-one-current
    // invariant the publish path maintains).
    await tx.query(
      `INSERT INTO mcp_connector_versions
         (id, connector_id, version, note, current, config, created_by)
       VALUES ($1, $2, $3, $4, FALSE, $5, $6)`,
      [randomUUID(), id, target.version, `回滚到 ${target.version}`, JSON.stringify(restoredConfig), claims.sub],
    );
    await tx.query(
      `UPDATE mcp_connectors
       SET url = $3, version = $4, name_en = $5, name_zh = $6, category_id = $7, description = $8,
           transport = $9, auth_mode = $10, auth_config = $11, scope = $12, tools = $13,
           auth_status = $14, updated_at = NOW()
       WHERE id = $1 AND org_id = $2`,
      [
        id, claims.orgId, url, target.version, nameEn, nameZh, categoryId, description,
        transport, authMode, JSON.stringify(authConfig), JSON.stringify(scope),
        JSON.stringify(tools), authStatusFor(authMode),
      ],
    );
  });

  await auditStore.write({
    orgId: claims.orgId, userId: claims.sub,
    action: AuditAction.McpConnectorUpdate, targetType: 'connector', targetId: id,
    payload: { fields: { version: target.version }, rolledBackTo: target.version },
  });
  return c.json({ ok: true, version: target.version });
});
