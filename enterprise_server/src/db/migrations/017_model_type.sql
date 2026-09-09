-- Add a model `type` column so the admin UI can render a "类型" (type)
-- column in the model table, matching the prototype (对话/推理/视觉/
-- Embedding/图像/音频). Existing rows default to 'chat'.
--
-- The admin UI is the only writer of this column today; the desktop proxy
-- does not consume it, so a plain TEXT check-constrained column (no JSONB)
-- is all that's needed. The value domain is intentionally small and closed.

ALTER TABLE model_catalog
  ADD COLUMN IF NOT EXISTS type TEXT NOT NULL DEFAULT 'chat'
    CHECK (type IN ('chat', 'reasoning', 'vision', 'embedding', 'image', 'audio'));
