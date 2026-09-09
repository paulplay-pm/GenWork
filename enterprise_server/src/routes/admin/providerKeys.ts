import { Hono } from 'hono';
import { z } from 'zod';

import { auditStore } from '../../audit/auditStore';
import { requirePermission } from '../../auth/middleware';
import { pool } from '../../db/pool';
import { modelCatalog } from '../../models/modelCatalog';
import { fetchProviderModels } from '../../models/providerModelFetcher';
import { AuditAction } from '../../shared/enterpriseServerConstants';
import { PermissionPoint as PP } from '../../shared/permissionPoints';
import { providerKeyVault } from '../../vault/providerKeyVault';

export const adminProviderKeyRoutes = new Hono();

adminProviderKeyRoutes.get('/admin/provider-keys', requirePermission(PP.ProviderView), async c => {
  const orgId = c.req.query('orgId');
  if (!orgId) return c.json({ error: 'orgId required' }, 400);
  // Cross-tenant guard: the orgId query param must match the caller's token.
  const claims = c.get('claims');
  if (orgId !== claims.orgId) return c.json({ error: 'org_mismatch' }, 400);
  return c.json(await providerKeyVault.list(orgId));
});

adminProviderKeyRoutes.post('/admin/provider-keys', requirePermission(PP.ProviderEdit), async c => {
  const claims = c.get('claims');
  const body = z
    .object({
      orgId: z.string(),
      provider: z.string(),
      apiKey: z.string().min(1).optional(),
      label: z.string().optional(),
      endpoint: z.string().optional(),
      region: z.enum(['china', 'global']).optional(),
      defaultBaseUrl: z.string().optional(),
      website: z.string().optional(),
      protocol: z.enum(['openai', 'anthropic']).optional(),
      codingPlan: z.boolean().optional(),
    })
    .parse(await c.req.json());
  // Cross-tenant guard: the body's orgId must match the caller's token.
  if (body.orgId !== claims.orgId) return c.json({ error: 'org_mismatch' }, 400);
  const { id } = await providerKeyVault.add({
    orgId: body.orgId,
    provider: body.provider,
    // A custom provider may be created keyless ("未填写时模型不可调用") and the
    // key added later via PATCH; `created_by` is only meaningful when a key is
    // provided at create time.
    plaintextKey: body.apiKey,
    label: body.label,
    endpoint: body.endpoint,
    region: body.region,
    defaultBaseUrl: body.defaultBaseUrl,
    website: body.website,
    createdBy: body.apiKey ? claims.sub : undefined,
    protocol: body.protocol,
    codingPlan: body.codingPlan,
  });
  await auditStore.write({
    orgId: body.orgId,
    userId: claims.sub,
    action: AuditAction.ProviderKeyAdd,
    targetType: 'provider_key',
    targetId: id,
    payload: { provider: body.provider, label: body.label, region: body.region },
  });
  return c.json({ id });
});

adminProviderKeyRoutes.post('/admin/provider-keys/:id/disable', requirePermission(PP.ProviderEdit), async c => {
  const claims = c.get('claims');
  const id = c.req.param('id');
  // Cross-org check: provider must exist AND belong to caller's org.
  // Scoped to claims.orgId so a request from org A trying to disable org B's
  // provider key gets 404, not 200.
  const exists = await pool.query<{ id: string }>(
    `SELECT id FROM provider_keys WHERE id = $1 AND org_id = $2`,
    [id, claims.orgId],
  );
  if (exists.rowCount === 0) return c.json({ error: 'provider_not_found' }, 404);
  await providerKeyVault.setEnabled(id, false);
  await auditStore.write({
    orgId: claims.orgId,
    userId: claims.sub,
    action: 'provider_key_disable',
    targetType: 'provider_key',
    targetId: id,
  });
  return c.json({ ok: true });
});

adminProviderKeyRoutes.post('/admin/provider-keys/:id/enable', requirePermission(PP.ProviderEdit), async c => {
  const claims = c.get('claims');
  const id = c.req.param('id');
  // Cross-org check: provider must exist AND belong to caller's org.
  // Scoped to claims.orgId so a request from org A trying to enable org B's
  // provider key gets 404, not 200.
  const exists = await pool.query<{ id: string }>(
    `SELECT id FROM provider_keys WHERE id = $1 AND org_id = $2`,
    [id, claims.orgId],
  );
  if (exists.rowCount === 0) return c.json({ error: 'provider_not_found' }, 404);
  await providerKeyVault.setEnabled(id, true);
  await auditStore.write({
    orgId: claims.orgId,
    userId: claims.sub,
    action: 'provider_key_enable',
    targetType: 'provider_key',
    targetId: id,
  });
  return c.json({ ok: true });
});

/**
 * Fetch the provider's current model list via the configured API key
 * and upsert the result into `model_catalog`. Only works for
 * OpenAI-compatible providers (OpenAI, DeepSeek, Moonshot, Qwen, Zhipu,
 * xAI). For other providers (Anthropic, Gemini) the endpoint returns
 * `skipped: 'unsupported_provider'` without touching the catalog.
 *
 * Response shape:
 *   { added: number, unchanged: number, skipped?: 'unsupported_provider',
 *     error?: 'invalid_api_key'|'upstream_error'|'upstream_timeout'|'empty_endpoint' }
 */
adminProviderKeyRoutes.post('/admin/provider-keys/:id/refresh-models', requirePermission(PP.ProviderEdit), async c => {
  const claims = c.get('claims');
  const id = c.req.param('id');
  const row = await providerKeyVault.getRow(id);
  if (!row || row.org_id !== claims.orgId) {
    return c.json({ error: 'not_found' }, 404);
  }
  if (!row.enabled) {
    return c.json({ error: 'provider_disabled' }, 409);
  }
  const endpoint = row.endpoint ?? '';
  if (!endpoint) {
    return c.json({ error: 'empty_endpoint' }, 400);
  }
  let apiKey: string;
  try {
    apiKey = await providerKeyVault.getDecrypted(id);
  } catch {
    return c.json({ error: 'decrypt_failed' }, 500);
  }
  // Dispatcher routes by explicit `protocol` when set, else by provider id
  // (anthropic, gemini, openai-compat), and falls back to
  // probeModelsEndpoint for unknown OpenAI-shaped providers (vllm, internal
  // gateways, etc).
  const fetched = await fetchProviderModels({
    provider: row.provider,
    endpoint,
    apiKey,
    protocol: row.protocol,
  });
  if (!fetched.ok) {
    await auditStore.write({
      orgId: claims.orgId,
      userId: claims.sub,
      action: AuditAction.ProviderCall,
      targetType: 'provider_key',
      targetId: id,
      payload: { refresh: 'failed', error: fetched.error, detail: fetched.detail },
    });
    const status = fetched.error === 'upstream_timeout' ? 504 : 502;
    return c.json({ error: fetched.error, detail: fetched.detail }, status);
  }
  const result = await modelCatalog.upsertMany({
    orgId: claims.orgId,
    providerKeyId: id,
    provider: row.provider,
    modelIds: fetched.models.map(m => m.id),
  });
  await auditStore.write({
    orgId: claims.orgId,
    userId: claims.sub,
    action: AuditAction.ProviderCall,
    targetType: 'provider_key',
    targetId: id,
    payload: {
      refresh: 'ok',
      added: result.added,
      unchanged: result.unchanged,
      upstreamCount: fetched.models.length,
    },
  });
  return c.json({
    added: result.added,
    unchanged: result.unchanged,
    upstreamCount: fetched.models.length,
  });
});

adminProviderKeyRoutes.patch('/admin/provider-keys/:id', requirePermission(PP.ProviderEdit), async c => {
  const claims = c.get('claims');
  const id = c.req.param('id');
  const body = await c.req
    .json<{
      description?: string | null;
      baseUrl?: string | null;
      label?: string | null;
      enabled?: boolean;
      protocol?: 'openai' | 'anthropic';
      codingPlan?: boolean;
      apiKey?: string;
    }>()
    .catch(() => ({}) as Record<string, unknown>);

  // Cross-org check: provider must exist and belong to caller's org
  const exists = await pool.query<{ id: string; org_id: string }>(
    `SELECT id, org_id FROM provider_keys WHERE id = $1`,
    [id],
  );
  if (exists.rowCount === 0 || exists.rows[0].org_id !== claims.orgId) {
    return c.json({ error: 'provider_not_found' }, 404);
  }

  const fields: {
    description?: string | null;
    endpoint?: string | null;
    label?: string | null;
    enabled?: boolean;
    protocol?: 'openai' | 'anthropic';
    codingPlan?: boolean;
  } = {};
  if ('description' in body) fields.description = body.description as string | null;
  if ('baseUrl' in body) fields.endpoint = body.baseUrl as string | null;
  if ('label' in body) fields.label = body.label as string | null;
  if ('enabled' in body) fields.enabled = body.enabled as boolean;
  if ('protocol' in body && body.protocol !== undefined && body.protocol !== 'openai' && body.protocol !== 'anthropic') {
    return c.json({ error: 'validation_error', field: 'protocol' }, 400);
  }
  if ('protocol' in body) fields.protocol = body.protocol as 'openai' | 'anthropic';
  if ('codingPlan' in body) fields.codingPlan = body.codingPlan as boolean;

  const ok = await providerKeyVault.patch(id, fields);
  // `apiKey` is write-only: when a non-empty key is supplied, re-encrypt and
  // store a fresh mask (the plaintext is never echoed back by the route).
  if (typeof body.apiKey === 'string' && body.apiKey.length > 0) {
    await providerKeyVault.setApiKey(id, body.apiKey);
  }
  // Only audit a real change: an empty (or malformed) PATCH body leaves
  // `fields` empty, and the vault returns `true` for a no-op update — without
  // this guard a no-op would be audited as an update that changed nothing.
  // A key change is a real change even when no other field is touched.
  if (ok && (Object.keys(fields).length > 0 || !!body.apiKey)) {
    await auditStore.write({
      orgId: claims.orgId,
      userId: claims.sub,
      action: AuditAction.ProviderKeyUpdate,
      targetType: 'provider_key',
      targetId: id,
      payload: { fields, changedKey: !!body.apiKey },
    });
  }
  return c.json({ ok });
});

adminProviderKeyRoutes.delete('/admin/provider-keys/:id', requirePermission(PP.ProviderEdit), async c => {
  const claims = c.get('claims');
  const id = c.req.param('id');

  // Cross-org check: provider must exist AND belong to caller's org.
  // Scoped to claims.orgId so a request from org A trying to delete org B's
  // provider key gets 404, not 200.
  const exists = await pool.query<{ id: string; provider: string; is_builtin: boolean }>(
    `SELECT id, provider, is_builtin FROM provider_keys WHERE id = $1 AND org_id = $2`,
    [id, claims.orgId],
  );
  if (exists.rowCount === 0) return c.json({ error: 'provider_not_found' }, 404);

  // Built-in providers are non-deletable: refuse with 409 and leave an audit
  // trail of the attempt. The check runs after the cross-org guard so a
  // foreign org's builtin still 404s rather than leaking the 409.
  if (exists.rows[0].is_builtin) {
    await auditStore.write({
      orgId: claims.orgId,
      userId: claims.sub,
      action: AuditAction.ProviderKeyBuiltinDelete,
      targetType: 'provider_key',
      targetId: id,
      payload: { provider: exists.rows[0].provider },
    });
    return c.json({ error: 'builtin_provider' }, 409);
  }

  // Cascade: remove all models for this provider_key first, then the
  // provider_key row itself. If the cascade fails the provider_key stays
  // intact, so this is not a partial-state risk in the common case.
  const deletedModels = await modelCatalog.deleteByProviderKey(claims.orgId, id);
  await providerKeyVault.remove(claims.orgId, id);
  await auditStore.write({
    orgId: claims.orgId,
    userId: claims.sub,
    action: AuditAction.ProviderKeyDelete,
    targetType: 'provider_key',
    targetId: id,
    payload: { provider: exists.rows[0].provider, deletedModels },
  });
  return c.json({ ok: true, deletedModels });
});

/**
 * Connection probe using the provider's real Base URL + stored API Key. Hits
 * the protocol-appropriate model-list endpoint (`fetchProviderModels`): openai
 * → `Bearer`, anthropic → `x-api-key` + `anthropic-version`. A stored key
 * authenticates the request (the real "can this key reach this endpoint"
 * check); a keyless provider falls back to an unauthenticated `GET {base}/v1/
 * models` (5s cap). 2xx from the models endpoint → `connected`, else
 * `failed`. Writes `status/latency_ms/last_test_at` back to the row.
 *
 * Returns 200 with `{ status, latencyMs, lastTestAt }` — a failed probe is a
 * normal resolved result, not an HTTP error (only a missing Base URL 400s).
 * Gated by `provider:edit`, like the rest of this file.
 */
adminProviderKeyRoutes.post('/admin/provider-keys/:id/test', requirePermission(PP.ProviderEdit), async c => {
  const claims = c.get('claims');
  const id = c.req.param('id');
  const r = await pool.query<{
    provider: string;
    endpoint: string | null;
    protocol: 'openai' | 'anthropic';
  }>(`SELECT provider, endpoint, protocol FROM provider_keys WHERE id = $1 AND org_id = $2`, [
    id,
    claims.orgId,
  ]);
  if (r.rowCount === 0) return c.json({ error: 'provider_not_found' }, 404);
  const { provider, endpoint, protocol } = r.rows[0];
  if (!endpoint) {
    const lastTestAt = new Date().toISOString();
    return c.json(
      { status: 'failed', latencyMs: 0, lastTestAt, error: 'no_endpoint' },
      400,
    );
  }
  const base = endpoint.replace(/\/$/, '');

  // A missing (keyless or disabled) key → unauthenticated models probe.
  const key = await providerKeyVault.getDecrypted(id).catch(() => null);

  const start = Date.now();
  let ok = false;
  if (key) {
    const fetched = await fetchProviderModels({ provider, endpoint: base, apiKey: key, protocol });
    ok = fetched.ok;
  } else {
    try {
      const ac = new AbortController();
      const timer = setTimeout(() => ac.abort(), 5000);
      const res = await fetch(`${base}/v1/models`, { method: 'GET', signal: ac.signal });
      clearTimeout(timer);
      ok = res.ok;
    } catch {
      ok = false;
    }
  }
  const latencyMs = Date.now() - start;
  const status: 'connected' | 'failed' = ok ? 'connected' : 'failed';
  const lastTestAt = new Date().toISOString();
  await providerKeyVault.updateStatus(id, claims.orgId, {
    status,
    latencyMs,
    lastTestAt,
  });
  return c.json({ status, latencyMs, lastTestAt });
});
