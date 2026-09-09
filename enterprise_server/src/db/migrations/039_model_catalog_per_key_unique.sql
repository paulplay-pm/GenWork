-- Re-scope model_catalog's "no duplicate model" rule to the provider key.
--
-- The original UNIQUE (org_id, provider, model) forbade two models with the
-- same name under one org+provider — even when they belong to DIFFERENT
-- provider keys (e.g. the seeded built-in `deepseek` key and a user's custom
-- `deepseek` key). That made a built-in provider and a custom provider of the
-- same vendor unable to coexist: a custom `deepseek` model with the same
-- upstream name as a built-in row (e.g. `deepseek-v4-pro`) collides and can't
-- be added, so the two can't both serve the same model.
--
-- provider_keys already allows same-vendor coexistence (partial unique index
-- `UNIQUE (org_id, provider) WHERE is_builtin` — only the built-in row is
-- unique per slug; a custom key may repeat it). The catalog must match: scope
-- the uniqueness to the provider_key so each provider key offers its models
-- independently.
--
-- `modelCatalog.add`'s app-level duplicate check is already
-- (org_id, provider_key_id, model), so the constraint now matches it exactly.
-- The two `ON CONFLICT (org_id, provider, model)` DO NOTHING clauses
-- (modelCatalog.upsertMany + builtinProviders seed) are updated to the new
-- column set — Postgres rejects an ON CONFLICT target that no index matches.
-- Re-seeding built-ins stays idempotent: the deterministic
-- `builtin:<org>:<slug>` key + model still conflict on the new target.

ALTER TABLE model_catalog
  DROP CONSTRAINT IF EXISTS model_catalog_org_id_provider_model_key;

CREATE UNIQUE INDEX IF NOT EXISTS model_catalog_org_key_model
  ON model_catalog (org_id, provider_key_id, model);
