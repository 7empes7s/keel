-- The newest drift row per resource for a baseline (store/governance.mjs listLatestOpenDrift).
-- Every drift-detect run adds a row per difference it still sees, so the table grows by
-- thousands of rows a day; this keeps picking the newest one an index walk.
CREATE INDEX IF NOT EXISTS drift_baseline_key_latest_idx
  ON drift (tenant_ref, baseline_id, natural_key, detected_at DESC, id DESC);
