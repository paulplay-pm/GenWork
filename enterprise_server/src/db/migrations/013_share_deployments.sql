-- Migration 013: share deployments.
-- The desktop uploads zipped deployments tied to existing html_shares via the
-- shareDeployment feature. Server stores the archive + manifest blob; a future
-- deployment-provider sub-project will execute manifests against Node/static runtimes.
-- Also extends html_shares with columns the html-share runtime needs.

CREATE TABLE IF NOT EXISTS share_deployments (
  deployment_id       UUID PRIMARY KEY,
  org_id              TEXT NOT NULL,
  user_id             TEXT NOT NULL,
  share_id            UUID NOT NULL REFERENCES html_shares(share_id),
  source_sha256       TEXT NOT NULL,
  manifest_json       JSONB NOT NULL,
  storage_path        TEXT NOT NULL,
  status              TEXT NOT NULL DEFAULT 'queued'
                        CHECK (status IN ('queued','deploying','live','deploy_failed','expired','stopped')),
  deployment_kind     TEXT NOT NULL
                        CHECK (deployment_kind IN ('node_service','static_site')),
  failure_code        TEXT,
  failure_message     TEXT,
  persistence_json    JSONB,
  events_json         JSONB NOT NULL DEFAULT '[]'::jsonb,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at          TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS share_deployments_share_idx
  ON share_deployments (share_id);
CREATE INDEX IF NOT EXISTS share_deployments_org_idx
  ON share_deployments (org_id, user_id, created_at DESC);

ALTER TABLE html_shares ADD COLUMN IF NOT EXISTS access_mode TEXT NOT NULL DEFAULT 'code';
ALTER TABLE html_shares ADD COLUMN IF NOT EXISTS client_source_key TEXT;
ALTER TABLE html_shares ADD COLUMN IF NOT EXISTS source_type TEXT;
CREATE INDEX IF NOT EXISTS html_shares_source_idx
  ON html_shares (source_type, client_source_key);
