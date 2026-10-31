-- A version put back from an earlier one (reinstateBaseline) names the version it
-- copies, so the Approved setup page can say so: it keeps that version's capture and can
-- read older than the version it replaced. Versions put back before this column existed
-- take it from their 'baseline-reinstate' audit record. Re-applying changes nothing.
ALTER TABLE baseline ADD COLUMN IF NOT EXISTS reinstated_from_id uuid REFERENCES baseline(id);
-- Compared as text, so a malformed id in an audit record is skipped, never cast.
UPDATE baseline b
   SET reinstated_from_id = s.id
  FROM evidence e, baseline s
 WHERE b.reinstated_from_id IS NULL
   AND e.tenant_ref = b.tenant_ref
   AND e.kind = 'baseline-reinstate'
   AND e.subject->>'baselineId' = b.id::text
   AND s.id::text = lower(e.subject->>'reinstatedBaselineId')
   AND s.tenant_ref = b.tenant_ref;
