CREATE TABLE IF NOT EXISTS audit_events (
  id BIGSERIAL PRIMARY KEY,
  org_id TEXT NOT NULL,
  user_id TEXT,
  target_user_id TEXT,
  action TEXT NOT NULL,
  target_type TEXT,
  target_id TEXT,
  payload JSONB,
  ts TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS user_archives (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  archive_blob BYTEA NOT NULL,
  size_bytes BIGINT NOT NULL,
  archived_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS token_usage (
  id BIGSERIAL PRIMARY KEY,
  org_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  model_id TEXT NOT NULL REFERENCES model_catalog(id),
  provider TEXT NOT NULL,
  token_in INTEGER NOT NULL,
  token_out INTEGER NOT NULL,
  total_tokens INTEGER NOT NULL,
  cost_usd NUMERIC(12, 6),
  duration_ms INTEGER,
  result_code INTEGER NOT NULL,
  quota_window_date DATE NOT NULL,
  ts TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS audit_events_org_ts ON audit_events(org_id, ts DESC);
CREATE INDEX IF NOT EXISTS audit_events_target_user ON audit_events(target_user_id, ts DESC);
CREATE INDEX IF NOT EXISTS token_usage_user_window ON token_usage(user_id, quota_window_date);
CREATE INDEX IF NOT EXISTS token_usage_org_window ON token_usage(org_id, quota_window_date);
CREATE INDEX IF NOT EXISTS token_usage_model_window ON token_usage(model_id, quota_window_date);
