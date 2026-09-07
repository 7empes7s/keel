-- status/setupRole.sql
-- Idempotent. Safe to run against both the production `keel` database and the `keel_test`
-- database used by tests. Does not set a password — that is done separately with
-- ALTER ROLE ... WITH PASSWORD, so no credential ever lives in a file this repo tracks.
DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'keel_status') THEN
    CREATE ROLE keel_status LOGIN;
  END IF;
END
$$;

GRANT USAGE ON SCHEMA public TO keel_status;
GRANT SELECT ON snapshot, resource_version, baseline, drift, disposition, evidence, evidence_head
  TO keel_status;
