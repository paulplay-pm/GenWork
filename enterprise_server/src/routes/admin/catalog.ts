import { Hono } from 'hono';

import { requireAuth } from '../../auth/middleware';
import { modelCatalog } from '../../models/modelCatalog';
import { providerKeyVault } from '../../vault/providerKeyVault';

/**
 * Read-only endpoint that surfaces the catalog the desktop needs to render
 * its model picker at startup. The desktop no longer carries its own
 * hardcoded provider/model catalog — it consumes whatever the admin
 * configured here.
 *
 * Security: `requireAuth` (any logged-in user). The response intentionally
 * omits `api_key_encrypted`, `provider_key_id` mapping details, audit
 * metadata, etc. The desktop only needs what it needs to render + call the
 * proxy (which carries the user's JWT).
 *
 * Filtering: only enabled providers and enabled+non-policy-disabled models
 * are returned, mirroring `modelCatalog.list()` semantics.
 */
export const catalogRoutes = new Hono();
catalogRoutes.use('/admin/catalog', requireAuth);

catalogRoutes.get('/admin/catalog', async c => {
  const claims = c.get('claims');

  const [providers, models] = await Promise.all([
    providerKeyVault.list(claims.orgId),
    modelCatalog.list(claims.orgId),
  ]);

  // Strip to the minimal shape and filter disabled entries.
  const providerOut = providers
    .filter(p => p.enabled)
    .map(p => ({
      id: p.id,
      provider: p.provider,
      label: p.label,
      endpoint: p.endpoint,
      region: p.region,
      defaultBaseUrl: p.default_base_url,
      website: p.website,
      enabled: true,
    }));

  // The admin UI expresses vision and reasoning capability exclusively
  // through the `types` chip grid; the dedicated boolean columns are
  // legacy and not editable from the drawer. The chip is the single
  // source of truth and overrides the column — a model with the vision
  // chip removed must show vision as disabled downstream even if the
  // legacy column is still true. `supports_video` has no chip equivalent
  // and stays column-driven. See enterpriseModels.listEnabledForOrg for
  // the parallel implementation on the desktop sync path.
  const modelsOut = models.map(m => {
    const types = m.types ?? [];
    const supportsImage = types.includes('vision');
    const supportsThinking = types.includes('reasoning');
    return {
      id: m.id,
      provider: m.provider,
      model: m.model,
      displayName: m.display_name,
      quotaPerUserPerDay: m.quota_per_user_per_day,
      enabled: true,
      supportsImage,
      supportsVideo: m.supports_video,
      supportsThinking,
      contextWindow: m.context_window,
      maxTokens: m.max_tokens,
    };
  });

  return c.json({ providers: providerOut, models: modelsOut });
});
