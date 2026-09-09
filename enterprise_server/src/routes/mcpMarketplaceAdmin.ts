import { Hono } from 'hono';
import { z } from 'zod';

import { requireAuth, requirePermission } from '../auth/middleware';
import { pool } from '../db/pool';
import {
  type AuthMethod,
  type CategoryRow,
  mapServer,
  SERVER_COLUMNS,
  type ServerRow,
  type TransportType,
  UNCATEGORIZED,
} from '../models/mcpMarketplaceView';
import { PermissionPoint as PP } from '../shared/permissionPoints';
import { decrypt, encrypt } from '../vault/crypto';

const transportEnum = z.enum(['stdio', 'sse', 'http']);
const authEnum = z.enum(['none', 'bearer', 'api-key', 'oauth']);

const serverWriteSchema = z.object({
  server_id: z.string().min(1),
  name: z.string().min(1),
  name_zh: z.string().optional(),
  description_en: z.string().min(1),
  description_zh: z.string().optional(),
  icon: z.string().optional(),
  category_id: z.string().min(1),
  transport_type: transportEnum,
  server_url: z.string().url().optional(),
  command: z.string().optional(),
  auth_method: authEnum.optional(),
  api_key_header: z.string().optional(),
  credential: z.string().optional(),
  timeout_seconds: z.number().int().min(1).max(600).optional(),
  allowed_roles: z.array(z.string().min(1)).min(1),
});

const serverPatch = z.object({
  name: z.string().min(1).optional(),
  name_zh: z.string().optional(),
  description_en: z.string().min(1).optional(),
  description_zh: z.string().optional(),
  icon: z.string().optional(),
  category_id: z.string().min(1).optional(),
  transport_type: transportEnum.optional(),
  server_url: z.string().url().optional(),
  command: z.string().optional(),
  auth_method: authEnum.optional(),
  api_key_header: z.string().optional(),
  credential: z.string().optional(),
  timeout_seconds: z.number().int().min(1).max(600).optional(),
  allowed_roles: z.array(z.string().min(1)).min(1).optional(),
  enabled: z.boolean().optional(),
});

async function categoryExists(categoryId: string): Promise<boolean> {
  const r = await pool.query<{ exists: boolean }>(
    'SELECT EXISTS(SELECT 1 FROM mcp_marketplace_categories WHERE category_id = $1) AS exists',
    [categoryId],
  );
  return r.rows[0]?.exists === true;
}

function badUrlForTransport(transport: TransportType, url: string | undefined): boolean {
  if (transport === 'stdio') return false; // url optional for stdio
  if (!url) return true;
  return !/^https?:\/\//.test(url);
}

export const mcpMarketplaceAdminRoutes = new Hono();
mcpMarketplaceAdminRoutes.use('/api/admin/mcp-marketplace/*', requireAuth);

mcpMarketplaceAdminRoutes.post('/api/admin/mcp-marketplace/servers', requirePermission(PP.McpCreate), async (c) => {
  const parsed = serverWriteSchema.safeParse(await c.req.json());
  if (!parsed.success) return c.json({ error: 'invalid_body', issues: parsed.error.issues }, 400);
  const b = parsed.data;
  if (!(await categoryExists(b.category_id))) return c.json({ error: 'unknown_category' }, 400);
  if (badUrlForTransport(b.transport_type, b.server_url)) return c.json({ error: 'bad_server_url' }, 400);
  if (b.allowed_roles.length === 0) return c.json({ error: 'no_roles' }, 400);
  const authMethod: AuthMethod = b.auth_method ?? 'none';
  const cipher = b.credential && b.credential.length > 0 ? encrypt(b.credential) : null;
  await pool.query(
    `INSERT INTO mcp_marketplace_servers
       (server_id, name, name_zh, description_en, description_zh, icon, category_id,
        transport_type, command, server_url, auth_method, credential_cipher, api_key_header,
        timeout_seconds, allowed_roles, enabled)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15::jsonb,TRUE)`,
    [b.server_id, b.name, b.name_zh ?? null, b.description_en, b.description_zh ?? null,
     b.icon ?? null, b.category_id, b.transport_type, b.command ?? null, b.server_url ?? null,
     authMethod, cipher, b.api_key_header ?? '', b.timeout_seconds ?? 30,
     JSON.stringify(b.allowed_roles)],
  );
  return c.json({ server_id: b.server_id });
});

mcpMarketplaceAdminRoutes.put('/api/admin/mcp-marketplace/servers/:serverId', requirePermission(PP.McpEdit), async (c) => {
  const id = c.req.param('serverId');
  const parsed = serverPatch.safeParse(await c.req.json());
  if (!parsed.success) return c.json({ error: 'invalid_body', issues: parsed.error.issues }, 400);
  const b = parsed.data;
  if (b.category_id && !(await categoryExists(b.category_id))) return c.json({ error: 'unknown_category' }, 400);

  // Determine the final credential: re-encrypt if a non-empty credential was sent.
  const wantNewCredential = typeof b.credential === 'string' && b.credential.length > 0;
  const sets: string[] = [];
  const params: unknown[] = [id];
  const push = (col: string, val: unknown) => { params.push(val); sets.push(`${col} = $${params.length}`); };

  if (b.name !== undefined) push('name', b.name);
  if (b.name_zh !== undefined) push('name_zh', b.name_zh);
  if (b.description_en !== undefined) push('description_en', b.description_en);
  if (b.description_zh !== undefined) push('description_zh', b.description_zh);
  if (b.icon !== undefined) push('icon', b.icon);
  if (b.category_id !== undefined) push('category_id', b.category_id);
  if (b.transport_type !== undefined) push('transport_type', b.transport_type);
  if (b.server_url !== undefined) push('server_url', b.server_url);
  if (b.command !== undefined) push('command', b.command);
  if (b.auth_method !== undefined) push('auth_method', b.auth_method);
  if (b.api_key_header !== undefined) push('api_key_header', b.api_key_header);
  if (b.timeout_seconds !== undefined) push('timeout_seconds', b.timeout_seconds);
  if (b.enabled !== undefined) push('enabled', b.enabled);
  if (b.allowed_roles !== undefined) { if (b.allowed_roles.length === 0) return c.json({ error: 'no_roles' }, 400); push('allowed_roles', JSON.stringify(b.allowed_roles)); }
  if (wantNewCredential) push('credential_cipher', encrypt(b.credential!));

  if (sets.length === 0) return c.json({ error: 'empty_patch' }, 400);
  const result = await pool.query(
    `UPDATE mcp_marketplace_servers SET ${sets.join(', ')}, updated_at = NOW() WHERE server_id = $1`,
    params,
  );
  if (result.rowCount === 0) return c.json({ error: 'not_found' }, 404);
  return c.body(null, 204);
});

mcpMarketplaceAdminRoutes.delete('/api/admin/mcp-marketplace/servers/:serverId', requirePermission(PP.McpDelete), async (c) => {
  const id = c.req.param('serverId');
  const result = await pool.query('DELETE FROM mcp_marketplace_servers WHERE server_id = $1', [id]);
  if (result.rowCount === 0) return c.json({ error: 'not_found' }, 404);
  return c.body(null, 204);
});

mcpMarketplaceAdminRoutes.get('/api/admin/mcp-marketplace/servers', requirePermission(PP.McpView), async (c) => {
  const r = await pool.query<ServerRow>(`SELECT ${SERVER_COLUMNS} FROM mcp_marketplace_servers ORDER BY server_id`);
  return c.json(r.rows.map(mapServer));
});

mcpMarketplaceAdminRoutes.get('/api/admin/mcp-marketplace/categories', requirePermission(PP.McpView), async (c) => {
  const r = await pool.query<CategoryRow>(
    'SELECT category_id, name_zh, name_en, display_order FROM mcp_marketplace_categories ORDER BY display_order, category_id',
  );
  return c.json(r.rows.map((row) => ({ id: row.category_id, name_zh: row.name_zh, name_en: row.name_en, display_order: row.display_order })));
});

const categoryWriteSchema = z.object({
  category_id: z.string().min(1),
  name_zh: z.string().min(1),
  name_en: z.string().min(1),
  display_order: z.number().int().optional(),
});
const categoryPatchSchema = categoryWriteSchema.partial();

mcpMarketplaceAdminRoutes.post('/api/admin/mcp-marketplace/categories', requirePermission(PP.McpEdit), async (c) => {
  const parsed = categoryWriteSchema.safeParse(await c.req.json());
  if (!parsed.success) return c.json({ error: 'invalid_body', issues: parsed.error.issues }, 400);
  await pool.query(
    `INSERT INTO mcp_marketplace_categories (category_id, name_zh, name_en, display_order)
     VALUES ($1,$2,$3,COALESCE($4,0)) ON CONFLICT (category_id) DO NOTHING`,
    [parsed.data.category_id, parsed.data.name_zh, parsed.data.name_en, parsed.data.display_order ?? null],
  );
  return c.json({ category_id: parsed.data.category_id });
});

mcpMarketplaceAdminRoutes.put('/api/admin/mcp-marketplace/categories/:categoryId', requirePermission(PP.McpEdit), async (c) => {
  const id = c.req.param('categoryId');
  const parsed = categoryPatchSchema.safeParse(await c.req.json());
  if (!parsed.success) return c.json({ error: 'invalid_body', issues: parsed.error.issues }, 400);
  const result = await pool.query(
    `UPDATE mcp_marketplace_categories SET
       name_zh = COALESCE($2, name_zh), name_en = COALESCE($3, name_en),
       display_order = COALESCE($4, display_order) WHERE category_id = $1`,
    [id, parsed.data.name_zh ?? null, parsed.data.name_en ?? null, parsed.data.display_order ?? null],
  );
  if (result.rowCount === 0) return c.json({ error: 'not_found' }, 404);
  return c.body(null, 204);
});

// Migrate-on-delete: move the category's servers into 未分类, then delete it.
mcpMarketplaceAdminRoutes.delete('/api/admin/mcp-marketplace/categories/:categoryId', requirePermission(PP.McpEdit), async (c) => {
  const id = c.req.param('categoryId');
  if (id === UNCATEGORIZED) return c.json({ error: 'reserved_category' }, 409);
  await pool.query('UPDATE mcp_marketplace_servers SET category_id = $1 WHERE category_id = $2', [UNCATEGORIZED, id]);
  const result = await pool.query('DELETE FROM mcp_marketplace_categories WHERE category_id = $1', [id]);
  if (result.rowCount === 0) return c.json({ error: 'not_found' }, 404);
  return c.body(null, 204);
});

mcpMarketplaceAdminRoutes.post('/api/admin/mcp-marketplace/servers/:serverId/test', requirePermission(PP.McpEdit), async (c) => {
  const id = c.req.param('serverId');
  const r = await pool.query<{
    transport_type: TransportType; server_url: string | null; auth_method: AuthMethod;
    credential_cipher: string | null; api_key_header: string;
  }>(
    `SELECT transport_type, server_url, auth_method, credential_cipher, api_key_header
     FROM mcp_marketplace_servers WHERE server_id = $1`, [id],
  );
  if (r.rowCount === 0) return c.json({ error: 'not_found' }, 404);
  const row = r.rows[0];

  const persist = (status: string, latencyMs: number | null) =>
    pool.query('UPDATE mcp_marketplace_servers SET last_status=$2, last_latency_ms=$3, last_tested_at=NOW() WHERE server_id=$1',
      [id, status, latencyMs]);

  if (row.transport_type === 'stdio') {
    await persist('unknown', null);
    return c.json({ status: 'unknown', error: 'stdio_not_probeable' });
  }
  if (!row.server_url) { await persist('failed', null); return c.json({ status: 'failed', error: 'no_url' }); }

  let cred: string | null = null;
  if (row.credential_cipher) { try { cred = decrypt(row.credential_cipher); } catch { cred = null; } }
  const headers: Record<string, string> = {};
  if (row.auth_method === 'bearer') headers['Authorization'] = `Bearer ${cred ?? ''}`;
  else if (row.auth_method === 'api-key' && cred && row.api_key_header) headers[row.api_key_header] = cred;

  const started = Date.now();
  let status: string; let error: string | undefined; let latencyMs = Date.now() - started;
  try {
    const resp = await fetch(row.server_url, { headers, signal: AbortSignal.timeout(10_000) });
    latencyMs = Date.now() - started;
    if (resp.status >= 200 && resp.status < 400) { status = 'connected'; }
    else { status = 'failed'; error = `http_${resp.status}`; }
  } catch {
    status = 'failed'; error = 'network_error';
  }
  await persist(status, status === 'connected' ? latencyMs : null);
  return c.json({ status, latencyMs: status === 'connected' ? latencyMs : undefined, ...(error ? { error } : {}) });
});
