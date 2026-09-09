-- Migration 042: SSO connection logo URL.
-- The login pages (enterprise web + desktop) render SSO entry points as
-- circular icon buttons showing each IdP's logo. Per connection the admin
-- can pin a `logo_url` (any reachable HTTPS image); when unset, the
-- server resolves a built-in default for known provider types
-- (azure-ad / feishu / dingtalk / wecom). Generic types (generic-oidc,
-- generic-oauth2, saml2) have no built-in and render with no logo.
--
-- Adding a nullable column is a non-breaking, idempotent change — no
-- existing rows are touched and no default backfill is required.

ALTER TABLE sso_connections ADD COLUMN IF NOT EXISTS logo_url TEXT;
