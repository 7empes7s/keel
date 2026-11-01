-- Automatic rules can be deleted from the portal (engine/policy/evaluate.mjs deletePolicy).
-- A deleted rule is kept, off, with who deleted it and when, so its past evaluations,
-- automatic actions and activation previews (which reference policy.id) stay readable
-- as history. Every reader of current rules skips rows with deleted_at set.
ALTER TABLE policy ADD COLUMN IF NOT EXISTS deleted_at timestamptz;
ALTER TABLE policy ADD COLUMN IF NOT EXISTS deleted_by text;
