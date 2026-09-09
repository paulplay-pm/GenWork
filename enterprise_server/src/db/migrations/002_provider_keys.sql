CREATE TABLE IF NOT EXISTS provider_keys (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES orgs(id),
  provider TEXT NOT NULL,
  api_key_encrypted TEXT NOT NULL,
  endpoint TEXT,
  label TEXT,
  enabled BOOLEAN NOT NULL DEFAULT true,
  created_by TEXT NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS model_catalog (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES orgs(id),
  provider_key_id TEXT NOT NULL REFERENCES provider_keys(id),
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  display_name TEXT,
  quota_per_user_per_day INTEGER,
  enabled BOOLEAN NOT NULL DEFAULT true,
  UNIQUE (org_id, provider, model)
);

CREATE TABLE IF NOT EXISTS model_policies (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES orgs(id),
  model_id TEXT NOT NULL REFERENCES model_catalog(id),
  scope JSONB NOT NULL DEFAULT '"org-wide"',
  disabled BOOLEAN NOT NULL DEFAULT false,
  created_by TEXT NOT NULL REFERENCES users(id),
  UNIQUE (org_id, model_id)
);
