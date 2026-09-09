import { Hono } from 'hono';
import { requireAuth } from '../auth/middleware';
import { auditStore } from '../audit/auditStore';
import { enterpriseModels } from '../models/enterpriseModels';
import { AuditAction } from '../shared/enterpriseServerConstants';

/**
 * `GET /enterprise-models` — the per-org model catalog the desktop pulls at
 * startup. The response shape mirrors `EnterpriseModelEntry` plus a `_k`
 * field containing the decrypted API key for each enabled model. `_k` is
 * intentionally part of the server-side response so the desktop main process
 * can keep keys in memory; the desktop IPC layer is responsible for stripping
 * `_k` before any value reaches the renderer.
 *
 * Every successful call writes an audit row with `model_count` but never the
 * key bytes — the audit log is for security review, not key recovery.
 */
export const enterpriseModelsRoutes = new Hono();
enterpriseModelsRoutes.use('/enterprise-models', requireAuth);

enterpriseModelsRoutes.get('/enterprise-models', async (c) => {
  const claims = c.get('claims');
  const orgId = claims.orgId;
  const entries = await enterpriseModels.listEnabledForOrg(orgId);
  const keyMap = await enterpriseModels.decryptKeysForOrg(orgId);
  const remoteIp = c.req.header('x-forwarded-for') ?? null;
  await auditStore.write({
    orgId,
    userId: claims.sub,
    action: AuditAction.EnterpriseModelsSync,
    targetType: 'enterprise_models_sync',
    payload: { model_count: entries.length, remote_ip: remoteIp },
  });
  return c.json({
    models: entries.map((e) => ({
      ...e,
      // The `_k` field is intentionally part of the server-side response
      // so the desktop main process can decrypt-then-keep-in-memory,
      // but the desktop IPC layer MUST NOT forward `_k` to the renderer.
      _k: keyMap.get(e.id) ?? null,
    })),
  });
});
