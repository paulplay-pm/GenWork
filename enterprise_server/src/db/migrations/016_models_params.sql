-- Extend model_catalog with sampling parameters (kept fields only).
-- 7 fields excluded by spec are NOT added here:
--   stop sequences, stream toggle, function calling toggle,
--   thinking budget, response format, RPM/TPM, pricing.
--
-- Table name is `model_catalog` (not `models`) per Ruling 2 in
-- .superpowers/sdd/2026-09-11-providers-models-page-rebuild/progress.md.
-- Existing supports_image / supports_video / supports_thinking columns
-- come from migration 006 and are reused.

ALTER TABLE model_catalog
  ADD COLUMN IF NOT EXISTS temperature REAL,
  ADD COLUMN IF NOT EXISTS top_p REAL,
  ADD COLUMN IF NOT EXISTS max_output_tokens INTEGER;