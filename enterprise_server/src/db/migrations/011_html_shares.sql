-- Migration 011: html-shares lifecycle.
-- The desktop publishes user-generated HTML to enterprise_server, which
-- stores the bundled zip on disk and serves a public page link back.
-- Every row is owned by (org_id, user_id); cross-org reads are 404.

CREATE TABLE IF NOT EXISTS html_shares (
  share_id        UUID PRIMARY KEY,
  org_id          TEXT NOT NULL,
  user_id         TEXT NOT NULL,
  title           TEXT NOT NULL,
  source_type     TEXT NOT NULL,
  source_sha256   TEXT NOT NULL,
  source_filename TEXT,
  entry_file      TEXT,
  total_files     INTEGER,
  total_bytes     BIGINT,
  warnings_json   TEXT,
  visibility      TEXT NOT NULL DEFAULT 'public',
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at      TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS html_shares_owner_idx
  ON html_shares (org_id, user_id, created_at DESC);
