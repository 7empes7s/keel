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
CREATE TABLE IF NOT EXISTS type_coverage_latest (
  tenant_ref     text NOT NULL,
  resource_type  text NOT NULL,
  coverage_entry jsonb,
  snapshot_id    uuid NOT NULL,
  started_at     timestamptz NOT NULL,
  completed_at   timestamptz NOT NULL,
  PRIMARY KEY (tenant_ref, resource_type)
);
CREATE INDEX IF NOT EXISTS type_coverage_latest_snapshot_idx ON type_coverage_latest (snapshot_id);

-- Any insert is a candidate: it replaces the stored row only when it is at
-- least as new, otherwise it is dropped. This keeps plain INSERTs safe too,
-- e.g. a recovery dump that carries this table's rows after its snapshot rows
-- have already filled it through the trigger below.
CREATE OR REPLACE FUNCTION type_coverage_latest_keep_newest() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  UPDATE type_coverage_latest t
     SET coverage_entry = NEW.coverage_entry, snapshot_id = NEW.snapshot_id,
         started_at = NEW.started_at, completed_at = NEW.completed_at
   WHERE t.tenant_ref = NEW.tenant_ref AND t.resource_type = NEW.resource_type
     AND (NEW.completed_at, NEW.started_at, NEW.snapshot_id) >= (t.completed_at, t.started_at, t.snapshot_id);
  IF EXISTS (SELECT 1 FROM type_coverage_latest t
              WHERE t.tenant_ref = NEW.tenant_ref AND t.resource_type = NEW.resource_type) THEN
    RETURN NULL;
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS type_coverage_latest_keep_newest ON type_coverage_latest;
CREATE TRIGGER type_coverage_latest_keep_newest
  BEFORE INSERT ON type_coverage_latest
  FOR EACH ROW EXECUTE FUNCTION type_coverage_latest_keep_newest();

-- Recomputes one (tenant, type) from snapshot, walking complete backups newest
-- first (snapshot_complete_time_idx) and stopping at the first mention.
CREATE OR REPLACE FUNCTION type_coverage_latest_recompute(p_tenant text, p_type text) RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
  DELETE FROM type_coverage_latest WHERE tenant_ref = p_tenant AND resource_type = p_type;
  INSERT INTO type_coverage_latest (tenant_ref, resource_type, coverage_entry, snapshot_id, started_at, completed_at)
  SELECT s.tenant_ref, p_type, s.coverage_digest -> p_type, s.id, s.started_at, s.completed_at
    FROM snapshot s
   WHERE s.tenant_ref = p_tenant AND s.status = 'complete' AND s.completed_at IS NOT NULL
     AND jsonb_typeof(s.coverage_digest) = 'object' AND s.coverage_digest ? p_type
     AND (s.coverage_digest -> p_type) ->> 'outcome' IS DISTINCT FROM 'not-requested'
   ORDER BY s.completed_at DESC, s.started_at DESC, s.id DESC
   LIMIT 1
  ON CONFLICT (tenant_ref, resource_type) DO NOTHING;
END $$;

CREATE OR REPLACE FUNCTION snapshot_type_coverage_sync() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  stale record;
BEGIN
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
     WHERE (EXCLUDED.completed_at, EXCLUDED.started_at, EXCLUDED.snapshot_id) >= (t.completed_at, t.started_at, t.snapshot_id);
  END IF;
  RETURN NULL;
END $$;
DROP TRIGGER IF EXISTS snapshot_type_coverage_sync ON snapshot;
CREATE TRIGGER snapshot_type_coverage_sync
  AFTER INSERT OR DELETE OR UPDATE OF id, tenant_ref, status, started_at, completed_at, coverage_digest ON snapshot
  FOR EACH ROW EXECUTE FUNCTION snapshot_type_coverage_sync();

CREATE OR REPLACE FUNCTION snapshot_type_coverage_truncate() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  DELETE FROM type_coverage_latest;
  RETURN NULL;
END $$;
DROP TRIGGER IF EXISTS snapshot_type_coverage_truncate ON snapshot;
CREATE TRIGGER snapshot_type_coverage_truncate
  AFTER TRUNCATE ON snapshot
  FOR EACH STATEMENT EXECUTE FUNCTION snapshot_type_coverage_truncate();

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
