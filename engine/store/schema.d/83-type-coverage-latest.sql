-- The newest coverage-digest mention of each resource type per tenant
-- (engine/coverage/snapshots.mjs TYPE_COVERAGE_CTES). Reading it used to mean
-- expanding the digest of every complete backup ever taken, which grows every
-- hour. This table keeps one row per (tenant, type) instead, maintained by
-- triggers on snapshot so every writer (collection, bundles, retention prune,
-- tests that insert rows directly) keeps it right without code changes.
--
-- Same rule as before: a complete snapshot with completed_at set; the newest
-- by (completed_at, started_at, id); a 'not-requested' entry is never an
-- observation and never shadows an older one.
--
-- A row counts only while its snapshot still exists: a row whose type has no
-- mention left is cleared (snapshot_id NULL) rather than removed, and readers
-- join snapshot, so a row left behind by a bulk wipe of snapshot is ignored
-- and replaced by the next mention. (Nothing here removes rows, so the live
-- deploy's destructive-schema guard stays meaningful for this file.)
CREATE TABLE IF NOT EXISTS type_coverage_latest (
  tenant_ref     text NOT NULL,
  resource_type  text NOT NULL,
  coverage_entry jsonb,
  snapshot_id    uuid,
  started_at     timestamptz,
  completed_at   timestamptz,
  PRIMARY KEY (tenant_ref, resource_type)
);
CREATE INDEX IF NOT EXISTS type_coverage_latest_snapshot_idx ON type_coverage_latest (snapshot_id);

-- Any insert is a candidate: it replaces the stored row when that row is
-- cleared, points at a snapshot that no longer exists, or is not newer;
-- otherwise the insert is skipped. This keeps plain INSERTs safe too,
-- e.g. a recovery dump that carries this table's rows after its snapshot rows
-- have already filled it through the trigger below.
CREATE OR REPLACE FUNCTION type_coverage_latest_replaceable(
  t type_coverage_latest, p_completed timestamptz, p_started timestamptz, p_snapshot uuid) RETURNS boolean
LANGUAGE sql STABLE AS $$
  SELECT t.snapshot_id IS NULL
      OR (p_completed, p_started, p_snapshot) >= (t.completed_at, t.started_at, t.snapshot_id)
      OR NOT EXISTS (SELECT 1 FROM snapshot s WHERE s.id = t.snapshot_id)
$$;

CREATE OR REPLACE FUNCTION type_coverage_latest_keep_newest() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  UPDATE type_coverage_latest t
     SET coverage_entry = NEW.coverage_entry, snapshot_id = NEW.snapshot_id,
         started_at = NEW.started_at, completed_at = NEW.completed_at
   WHERE t.tenant_ref = NEW.tenant_ref AND t.resource_type = NEW.resource_type
     AND type_coverage_latest_replaceable(t, NEW.completed_at, NEW.started_at, NEW.snapshot_id);
  IF EXISTS (SELECT 1 FROM type_coverage_latest t
              WHERE t.tenant_ref = NEW.tenant_ref AND t.resource_type = NEW.resource_type) THEN
    RETURN NULL;
  END IF;
  RETURN NEW;
END $$;
CREATE OR REPLACE TRIGGER type_coverage_latest_keep_newest
  BEFORE INSERT ON type_coverage_latest
  FOR EACH ROW EXECUTE FUNCTION type_coverage_latest_keep_newest();

-- Triggers use CREATE OR REPLACE (not drop then create) so re-applying the
-- schema never leaves a moment where a finishing backup goes unrecorded.

-- Recomputes one (tenant, type) from snapshot, walking complete backups newest
-- first (snapshot_complete_time_idx) and stopping at the first mention; with
-- no mention left the row is cleared.
CREATE OR REPLACE FUNCTION type_coverage_latest_recompute(p_tenant text, p_type text) RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
  UPDATE type_coverage_latest t
     SET (coverage_entry, snapshot_id, started_at, completed_at) = (
       SELECT s.coverage_digest -> p_type, s.id, s.started_at, s.completed_at
         FROM snapshot s
        WHERE s.tenant_ref = p_tenant AND s.status = 'complete' AND s.completed_at IS NOT NULL
          AND jsonb_typeof(s.coverage_digest) = 'object' AND s.coverage_digest ? p_type
          AND (s.coverage_digest -> p_type) ->> 'outcome' IS DISTINCT FROM 'not-requested'
        ORDER BY s.completed_at DESC, s.started_at DESC, s.id DESC
        LIMIT 1)
   WHERE t.tenant_ref = p_tenant AND t.resource_type = p_type;
END $$;

CREATE OR REPLACE FUNCTION snapshot_type_coverage_sync() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  stale record;
  tenant text;
BEGIN
  -- One writer per tenant at a time, so a recompute (delete or update of the
  -- newest backup) and a concurrent newer backup cannot lose each other's row.
  -- Locks are taken in a fixed order when a row moves between tenants.
  FOR tenant IN SELECT DISTINCT t FROM unnest(ARRAY[
      CASE WHEN TG_OP <> 'INSERT' THEN OLD.tenant_ref END,
      CASE WHEN TG_OP <> 'DELETE' THEN NEW.tenant_ref END]) t
    WHERE t IS NOT NULL ORDER BY t LOOP
    PERFORM pg_advisory_xact_lock(hashtextextended('type-coverage-latest:' || tenant || ':' || current_schema(), 0));
  END LOOP;
  -- Rows that pointed at the old version of this snapshot may no longer hold
  -- (deleted, no longer complete, digest or times changed): recompute them.
  -- An AFTER trigger already sees the new row, so the recompute includes it.
  IF TG_OP IN ('UPDATE', 'DELETE') THEN
    FOR stale IN SELECT tenant_ref, resource_type FROM type_coverage_latest WHERE snapshot_id = OLD.id LOOP
      PERFORM type_coverage_latest_recompute(stale.tenant_ref, stale.resource_type);
    END LOOP;
  END IF;
  IF TG_OP IN ('INSERT', 'UPDATE') AND NEW.status = 'complete' AND NEW.completed_at IS NOT NULL
     AND jsonb_typeof(NEW.coverage_digest) = 'object' THEN
    INSERT INTO type_coverage_latest AS t (tenant_ref, resource_type, coverage_entry, snapshot_id, started_at, completed_at)
    SELECT NEW.tenant_ref, entry.key, entry.value, NEW.id, NEW.started_at, NEW.completed_at
      FROM jsonb_each(NEW.coverage_digest) entry
     WHERE entry.value ->> 'outcome' IS DISTINCT FROM 'not-requested'
    ON CONFLICT (tenant_ref, resource_type) DO UPDATE
       SET coverage_entry = EXCLUDED.coverage_entry, snapshot_id = EXCLUDED.snapshot_id,
           started_at = EXCLUDED.started_at, completed_at = EXCLUDED.completed_at
     WHERE type_coverage_latest_replaceable(t, EXCLUDED.completed_at, EXCLUDED.started_at, EXCLUDED.snapshot_id);
  END IF;
  RETURN NULL;
END $$;
CREATE OR REPLACE TRIGGER snapshot_type_coverage_sync
  AFTER INSERT OR DELETE OR UPDATE OF id, tenant_ref, status, started_at, completed_at, coverage_digest ON snapshot
  FOR EACH ROW EXECUTE FUNCTION snapshot_type_coverage_sync();

-- One-time fill for a database that already has backups: runs only while the
-- table is still empty, so re-applying the schema stays cheap.
INSERT INTO type_coverage_latest (tenant_ref, resource_type, coverage_entry, snapshot_id, started_at, completed_at)
SELECT DISTINCT ON (s.tenant_ref, entry.key)
       s.tenant_ref, entry.key, entry.value, s.id, s.started_at, s.completed_at
  FROM snapshot s
 CROSS JOIN LATERAL jsonb_each(s.coverage_digest) entry
 WHERE s.status = 'complete' AND s.completed_at IS NOT NULL
   AND jsonb_typeof(s.coverage_digest) = 'object'
   AND entry.value ->> 'outcome' IS DISTINCT FROM 'not-requested'
   AND NOT EXISTS (SELECT 1 FROM type_coverage_latest)
 ORDER BY s.tenant_ref, entry.key, s.completed_at DESC, s.started_at DESC, s.id DESC;

-- The status page reads coverage as the read-only keel_status role
-- (status/setupRole.sql), which only exists on the live host.
DO $$
BEGIN
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'keel_status') THEN
    GRANT SELECT ON type_coverage_latest TO keel_status;
  END IF;
END
$$;
