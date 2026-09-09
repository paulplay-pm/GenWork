-- Migration 014: html_shares status column.
-- Task 2's PATCH /api/html-shares/:shareId/status needs a column to write to.
-- Migration 013 added access_mode, client_source_key, source_type but not status.
-- Default 'live' matches every existing row's implicit state (the share is
-- publishable until someone disables it).

ALTER TABLE html_shares ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'live';