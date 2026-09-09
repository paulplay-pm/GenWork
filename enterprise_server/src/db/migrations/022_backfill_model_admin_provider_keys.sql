-- v1
-- provider-keys routes now gate on provider_keys.manage (previously models.manage).
-- Backfill the seeded model_admin so it keeps provider-key access. Only roles
-- that still carry models.manage (i.e. not manually re-scoped) are updated, and
-- the row is a no-op once provider_keys.manage is present, so this is idempotent.
UPDATE roles SET permissions = permissions || '["provider_keys.manage"]'
WHERE name = 'model_admin'
  AND permissions ? 'models.manage'
  AND NOT (permissions ? 'provider_keys.manage');
