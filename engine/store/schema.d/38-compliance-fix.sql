-- CoreView gap 6, "Make it pass": a one-value restore planned from a failing
-- compliance control. The plan (control, object, setting, value now and after)
-- is bound into the dry run's digest and promoted through the normal approval.
ALTER TABLE restore_dry_run ADD COLUMN IF NOT EXISTS compliance_fix jsonb;
