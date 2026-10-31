-- A version put back from an earlier one (reinstateBaseline) names the version it
-- copies, so the Approved setup page can say so: it keeps that version's capture and can
-- read older than the version it replaced. Versions put back before this column existed
-- take it from their 'baseline-reinstate' audit record. Re-applying changes nothing.
ALTER TABLE baseline ADD COLUMN IF NOT EXISTS reinstated_from_id uuid REFERENCES baseline(id);
UPDATE baseline b
   SET reinstated_from_id = (e.subject->>'reinstatedBaselineId')::uuid
  FROM evidence e
 WHERE b.reinstated_from_id IS NULL
   AND e.tenant_ref = b.tenant_ref
   AND e.kind = 'baseline-reinstate'
   AND e.subject->>'baselineId' = b.id::text
   AND e.subject->>'reinstatedBaselineId' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
   AND EXISTS (SELECT 1 FROM baseline s WHERE s.id = (e.subject->>'reinstatedBaselineId')::uuid);
