-- Complete backups of a tenant newest first (query/execute.mjs, Ask's change windows).
-- A change's window opens at the last complete backup that read its kind before the
-- change was seen; this lets that lookup walk back from the sighting and stop at the
-- first match instead of reading every backup's coverage digest.
CREATE INDEX IF NOT EXISTS snapshot_complete_time_idx
  ON snapshot (tenant_ref, completed_at DESC) WHERE status = 'complete';
