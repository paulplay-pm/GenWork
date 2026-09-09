-- enterprise_server/src/db/migrations/036_sso_connections.sql
-- Migration 036: enterprise SSO member-login federation.
-- sso_connections: per-org OIDC/OAuth2 IdP configuration (one row per IdP
--   the org federates with; SAML2 may be stored but is disabled in v1).
-- user_idp_identities: durable link from an internal user to an external
--   IdP identity (one row per (sso_connection_id, external_id); cross-IdP
--   dedup is by (org_id, email) on the users table).
-- sso_login_states: one-shot state for the OAuth dance (authorize → callback),
--   short TTL, deleted on consumption. Re-run safe.

CREATE TABLE IF NOT EXISTS sso_connections (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES orgs(id),
  name TEXT NOT NULL,
  provider_type TEXT NOT NULL,
  protocol TEXT NOT NULL,
  authorize_url TEXT,
  token_url TEXT,
  userinfo_url TEXT,
  client_id TEXT,
  client_secret_encrypted TEXT,
  client_secret_masked TEXT,
  scopes TEXT,
  identity_id_field TEXT NOT NULL DEFAULT 'sub',
  login_name_field TEXT,
  email_field TEXT NOT NULL DEFAULT 'email',
  email_domain_whitelist JSONB NOT NULL DEFAULT '[]',
  enabled BOOLEAN NOT NULL DEFAULT true,
  sort_order INT NOT NULL DEFAULT 0,
  created_by TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (org_id, name)
);
CREATE INDEX IF NOT EXISTS sso_connections_org_enabled
  ON sso_connections (org_id, enabled, sort_order);

CREATE TABLE IF NOT EXISTS user_idp_identities (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  user_id TEXT NOT NULL REFERENCES users(id),
  sso_connection_id TEXT NOT NULL REFERENCES sso_connections(id),
  external_id TEXT NOT NULL,
  first_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (sso_connection_id, external_id),
  UNIQUE (org_id, user_id, sso_connection_id)
);
CREATE INDEX IF NOT EXISTS user_idp_identities_user
  ON user_idp_identities (user_id);

CREATE TABLE IF NOT EXISTS sso_login_states (
  state TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  sso_connection_id TEXT NOT NULL REFERENCES sso_connections(id),
  return_target TEXT NOT NULL,
  code_verifier TEXT,
  redirect_uri TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL
);
CREATE INDEX IF NOT EXISTS sso_login_states_expires
  ON sso_login_states (expires_at);
