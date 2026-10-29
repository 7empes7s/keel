-- Issue #683: what the dry run planned to do to each resource (create, update,
-- delete, restore, or nothing). Execution plans again from a fresh read and
-- refuses when it would write a resource the approved plan left alone, or
-- write one differently, so a change that lands after the dry run needs a new
-- dry run and approval.
ALTER TABLE restore_dry_run ADD COLUMN IF NOT EXISTS planned_verbs jsonb;
