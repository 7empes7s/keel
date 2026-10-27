-- A 'modified' drift row whose before and after payloads hold the same content
-- recorded no change: only its stored hashes differed. That happened when a field was
-- later classified server-owned (roleAssignmentSchedule and permissionGrantPolicy,
-- 2026-10-15): the baseline's hash still counted the field, the new one did not.
-- Drift detection no longer records such rows (cir/canonicalHash.mjs sameContent).
-- Rows recorded before that are kept as evidence and marked here; every list of
-- changes leaves marked rows out (store/openDrift.mjs RECORDED_CHANGE_PREDICATE).
--   NULL  not checked yet (or not a 'modified' row with both payloads)
--   true  same content: not a change
--   false a change in content
-- Equal payloads are marked here at once; the rest are checked under the current
-- field rules by drift detection and open-drift evaluation (store/openDrift.mjs
-- markSameContentDrift).
ALTER TABLE drift ADD COLUMN IF NOT EXISTS same_content boolean;
UPDATE drift SET same_content = true
 WHERE same_content IS NULL AND change_type = 'modified'
   AND before_payload IS NOT NULL AND before_payload = after_payload;
-- The rows detection still has to check, so finding them never scans the whole table.
CREATE INDEX IF NOT EXISTS drift_unchecked_idx ON drift (tenant_ref, id)
  WHERE same_content IS NULL AND change_type = 'modified';
