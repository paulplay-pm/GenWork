-- Migration 041: replace external-URL downloads with server-side installers.
-- Admins now upload installer binaries to the enterprise server; the
-- `downloads` column (pasted external URLs) is removed and replaced by
-- `installers`, which stores per-platform metadata (no macOS Intel).
--
-- Backward-compat note: rows created before this migration keep
-- `installers = '{}'` (default), so previously-published versions have no
-- installer until re-uploaded; /updates/latest then omits their platform URLs
-- and clients treat them as "no update" (safe).

ALTER TABLE app_releases DROP COLUMN IF EXISTS downloads;
ALTER TABLE app_releases ADD COLUMN IF NOT EXISTS installers JSONB NOT NULL DEFAULT '{}'::jsonb;
