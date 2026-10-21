-- Wave 1 DISC: the discovery inventory (engine/discovery/, cli/keel-discover.mjs).
-- One discovery_run per `keel-discover run`; one discovery_item per Graph path or
-- PowerShell Get cmdlet it saw. Counts only: no object a type holds is stored.
CREATE TABLE IF NOT EXISTS discovery_run (
  id bigserial PRIMARY KEY,
  tenant_ref text NOT NULL CHECK (tenant_ref ~ '^sha256:\S+$'),
  started_at timestamptz NOT NULL,
  finished_at timestamptz NOT NULL,
  -- [{ source, status, error, metadataVersion, paths }]: a source that could not be
  -- read is 'unknown', never an empty success.
  sources jsonb NOT NULL,
  -- Totals per status, container counts and catalogue coverage counts.
  summary jsonb NOT NULL,
  -- [{ type, path, version, coverage, objects, reason, missingGrant }], one per catalogue entry.
  catalogue jsonb NOT NULL,
  recorded_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS discovery_run_tenant_idx ON discovery_run (tenant_ref, finished_at DESC);

CREATE TABLE IF NOT EXISTS discovery_item (
  run_id bigint NOT NULL REFERENCES discovery_run(id) ON DELETE CASCADE,
  -- 'graph:v1.0', 'graph:beta' or 'powershell:<module>'.
  source text NOT NULL,
  -- The Graph path (/deviceManagement/deviceConfigurations) or the cmdlet (Get-Mailbox).
  name text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('entitySet', 'singleton', 'navigation', 'cmdlet')),
  entity_type text,
  status text NOT NULL CHECK (status IN ('catalogued', 'uncatalogued', 'unreadable', 'not-listed')),
  catalog_types text[] NOT NULL DEFAULT '{}',
  objects integer CHECK (objects IS NULL OR objects >= 0),
  objects_exact boolean,
  http_status integer,
  reason text,
  message text,
  missing_grant text,
  grant_source text CHECK (grant_source IS NULL OR grant_source IN ('graph', 'documented')),
  PRIMARY KEY (run_id, source, name)
);
-- refused-with-grant: a 401/403 for a grant the app already holds. A CHECK cannot be
-- altered in place; dropping and re-adding it under the same name keeps this idempotent.
-- skipped: readable but not worth backing up (engine/discovery/notGaps.mjs), with the
-- reason not-configuration or microsoft-published.
ALTER TABLE discovery_item DROP CONSTRAINT IF EXISTS discovery_item_reason_check;
ALTER TABLE discovery_item ADD CONSTRAINT discovery_item_reason_check
  CHECK (reason IS NULL OR reason IN ('missing-grant', 'refused-with-grant', 'not-licensed', 'not-listable', 'error', 'too-large',
    'not-configuration', 'microsoft-published'));
ALTER TABLE discovery_item DROP CONSTRAINT IF EXISTS discovery_item_status_check;
ALTER TABLE discovery_item ADD CONSTRAINT discovery_item_status_check
  CHECK (status IN ('catalogued', 'uncatalogued', 'skipped', 'unreadable', 'not-listed'));
CREATE INDEX IF NOT EXISTS discovery_item_status_idx ON discovery_item (run_id, status);
