-- Migration 010: enterprise model sync audit.
-- Every successful GET /enterprise-models call records (who, when, how many
-- models) for security review. The key bytes themselves never cross this
-- boundary; only the count is recorded.
--
-- Idempotent for pglite test replay.

CREATE TABLE IF NOT EXISTS enterprise_model_sync_audit (
  id UUID PRIMARY KEY,
  org_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  fetched_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  model_count INTEGER NOT NULL,
  remote_ip INET
);
CREATE INDEX IF NOT EXISTS enterprise_model_sync_audit_org_id_idx
  ON enterprise_model_sync_audit(org_id, fetched_at DESC);
