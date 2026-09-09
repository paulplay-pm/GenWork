-- enterprise_server/src/db/migrations/037_grant_sso_points_to_org_admin.sql
-- Idempotently add the new sso:* PermissionPoints to built-in admin roles.
-- Roles.permissions is JSONB; jsonb_set with || is idempotent.

UPDATE roles
SET permissions = permissions || '["sso:view","sso:create","sso:edit"]'::jsonb
WHERE name IN ('org_admin','super_admin')
  AND NOT (permissions @> '["sso:view"]'::jsonb);
