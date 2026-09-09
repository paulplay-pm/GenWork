import { Hono } from 'hono';
import { z } from 'zod';

import { requirePermission } from '../../auth/middleware';
import { modelCatalog, ModelType, ModelTypeValue, MODEL_TYPE_VALUES } from '../../models/modelCatalog';
import { PermissionPoint as PP } from '../../shared/permissionPoints';

/** Legacy 6-value single-type vocabulary (deprecated `type` field). Distinct
 * from the 8-value `MODEL_TYPE_VALUES` multi-type list in modelCatalog —
 * renamed to avoid a name collision with the new export. */
const LEGACY_TYPE_VALUES = Object.values(ModelType) as [ModelType, ...ModelType[]];

/** PATCH /admin/models/:id body. Typed so the `.catch(() => ({}))` fallback
 * (malformed/empty JSON) doesn't collapse every property access to `unknown`. */
interface ModelPatchBody {
  displayName?: string;
  type?: ModelType;
  types?: string[];
  enabled?: boolean;
  capabilities?: {
    supportsImage?: boolean;
    supportsVideo?: boolean;
    supportsThinking?: boolean;
    contextWindow?: number | null;
    maxTokens?: number | null;
    temperature?: number | null;
    topP?: number | null;
    maxOutputTokens?: number | null;
  };
}

export const adminModelRoutes = new Hono();

adminModelRoutes.get('/admin/models', requirePermission(PP.ModelView), async (c) => {
  const orgId = c.req.query('orgId');
  if (!orgId) return c.json({ error: 'orgId required' }, 400);
  // Cross-tenant guard: the orgId query param must match the caller's token.
  const claims = c.get('claims');
  if (orgId !== claims.orgId) return c.json({ error: 'org_mismatch' }, 400);
  return c.json(await modelCatalog.listForAdmin(orgId));
});

adminModelRoutes.post('/admin/models', requirePermission(PP.ModelCreate), async (c) => {
  const parsed = z
    .object({
      orgId: z.string(),
      providerKeyId: z.string(),
      provider: z.string(),
      model: z.string(),
      displayName: z.string().optional(),
      type: z.enum(LEGACY_TYPE_VALUES).optional(),
      types: z
        .array(z.enum(MODEL_TYPE_VALUES as [ModelTypeValue, ...ModelTypeValue[]]))
        .min(1)
        .optional(),
      quotaPerDay: z.number().int().nullable().optional(),
      capabilities: z
        .object({
          supportsImage: z.boolean().optional(),
          supportsVideo: z.boolean().optional(),
          supportsThinking: z.boolean().optional(),
          contextWindow: z.number().int().nullable().optional(),
          maxTokens: z.number().int().nullable().optional(),
          temperature: z.number().min(0).max(2).nullable().optional(),
          topP: z.number().min(0).max(1).nullable().optional(),
          maxOutputTokens: z.number().int().min(1).max(200000).nullable().optional(),
        })
        .optional(),
    })
    .safeParse(await c.req.json());
  if (!parsed.success) {
    const field = parsed.error.issues[0]?.path.join('.') ?? 'body';
    return c.json({ error: 'validation_error', field }, 400);
  }
  const body = parsed.data;
  // Cross-tenant guard: the body's orgId must match the caller's token.
  const claims = c.get('claims');
  if (body.orgId !== claims.orgId) return c.json({ error: 'org_mismatch' }, 400);
  try {
    const { id } = await modelCatalog.add({
      orgId: body.orgId,
      providerKeyId: body.providerKeyId,
      provider: body.provider,
      model: body.model,
      displayName: body.displayName,
      type: body.type,
      types: body.types,
      quotaPerDay: body.quotaPerDay,
      capabilities: body.capabilities
        ? {
            supports_image: body.capabilities.supportsImage ?? false,
            supports_video: body.capabilities.supportsVideo ?? false,
            supports_thinking: body.capabilities.supportsThinking ?? false,
            context_window: body.capabilities.contextWindow ?? null,
            max_tokens: body.capabilities.maxTokens ?? null,
            temperature: body.capabilities.temperature ?? null,
            top_p: body.capabilities.topP ?? null,
            max_output_tokens: body.capabilities.maxOutputTokens ?? null,
          }
        : undefined,
    });
    return c.json({ id });
  } catch (e) {
    if ((e as Error).message === 'model_duplicate') {
      return c.json({ error: 'model_duplicate' }, 409);
    }
    throw e;
  }
});

adminModelRoutes.patch('/admin/models/:id', requirePermission(PP.ModelEdit), async (c) => {
  const body: ModelPatchBody = (await c.req.json().catch(() => ({}))) as ModelPatchBody;

  const orgId = c.req.query('orgId');
  if (!orgId) return c.json({ error: 'orgId required' }, 400);
  // Cross-tenant guard: the orgId query param must match the caller's token.
  const claims = c.get('claims');
  if (orgId !== claims.orgId) return c.json({ error: 'org_mismatch' }, 400);
  const id = c.req.param('id');

  if (body.capabilities) {
    const { temperature, topP, maxOutputTokens } = body.capabilities;
    if (temperature != null && (temperature < 0 || temperature > 2)) {
      return c.json({ error: 'validation_error', field: 'temperature' }, 400);
    }
    if (topP != null && (topP < 0 || topP > 1)) {
      return c.json({ error: 'validation_error', field: 'topP' }, 400);
    }
    if (maxOutputTokens != null && (maxOutputTokens < 1 || maxOutputTokens > 200000)) {
      return c.json({ error: 'validation_error', field: 'maxOutputTokens' }, 400);
    }
  }

  if (body.type !== undefined && !LEGACY_TYPE_VALUES.includes(body.type)) {
    return c.json({ error: 'validation_error', field: 'type' }, 400);
  }

  if (body.types !== undefined && (!Array.isArray(body.types) || body.types.length === 0 || body.types.some((t) => !MODEL_TYPE_VALUES.includes(t as ModelTypeValue)))) {
    return c.json({ error: 'validation_error', field: 'types' }, 400);
  }

  const ok = await modelCatalog.patch(orgId, id, {
    display_name: body.displayName ?? null,
    type: body.type,
    // Validated against the 8-value set above.
    types: body.types as ModelTypeValue[] | undefined,
    enabled: body.enabled,
    capabilities: body.capabilities
      ? {
          supports_image: body.capabilities.supportsImage,
          supports_video: body.capabilities.supportsVideo,
          supports_thinking: body.capabilities.supportsThinking,
          context_window: body.capabilities.contextWindow,
          max_tokens: body.capabilities.maxTokens,
          temperature: body.capabilities.temperature,
          top_p: body.capabilities.topP,
          max_output_tokens: body.capabilities.maxOutputTokens,
        }
      : undefined,
  });
  if (!ok) return c.json({ error: 'model_not_found' }, 404);
  return c.json({ ok: true });
});

adminModelRoutes.delete('/admin/models/:id', requirePermission(PP.ModelDelete), async (c) => {
  const orgId = c.req.query('orgId');
  if (!orgId) return c.json({ error: 'orgId required' }, 400);
  // Cross-tenant guard: the orgId query param must match the caller's token.
  const claims = c.get('claims');
  if (orgId !== claims.orgId) return c.json({ error: 'org_mismatch' }, 400);
  const id = c.req.param('id');
  const ok = await modelCatalog.remove(orgId, id);
  if (!ok) return c.json({ error: 'model_not_found' }, 404);
  return c.json({ ok: true });
});

adminModelRoutes.patch('/admin/models/:id/quota', requirePermission(PP.ModelEdit), async (c) => {
  const body = z
    .object({ quotaPerDay: z.number().int().nullable() })
    .parse(await c.req.json());
  await modelCatalog.setQuota(c.req.param('id'), body.quotaPerDay);
  return c.json({ ok: true });
});

adminModelRoutes.post('/admin/models/:id/disable', requirePermission(PP.ModelEdit), async (c) => {
  const claims = c.get('claims');
  const modelId = c.req.param('id');
  await modelCatalog.setModelDisabled(claims.orgId, modelId, true, claims.sub);
  return c.json({ ok: true });
});

adminModelRoutes.post('/admin/models/:id/enable', requirePermission(PP.ModelEdit), async (c) => {
  const claims = c.get('claims');
  const modelId = c.req.param('id');
  await modelCatalog.setModelDisabled(claims.orgId, modelId, false, claims.sub);
  return c.json({ ok: true });
});