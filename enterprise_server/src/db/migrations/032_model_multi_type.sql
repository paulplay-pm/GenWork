-- model_catalog multi-type: a model can carry several capability labels.
-- Legacy single `type` is kept (deprecated compat primary); `types` is the
-- new source of truth. No CHECK on the array (pure embedding/rerank models
-- may omit 'chat').

ALTER TABLE model_catalog
  ADD COLUMN IF NOT EXISTS types TEXT[] NOT NULL DEFAULT ARRAY['chat'];

-- One-off backfill: map the legacy single `type` to a 1-element `types` set.
-- image -> image-gen, audio -> asr, otherwise 1:1. Only touch rows still on
-- the default so a re-run can't clobber admin-set values.
UPDATE model_catalog
SET types = CASE type
  WHEN 'image' THEN ARRAY['image-gen']
  WHEN 'audio' THEN ARRAY['asr']
  ELSE ARRAY[type]
END
WHERE type IS NOT NULL AND types = ARRAY['chat'] AND type <> 'chat';
