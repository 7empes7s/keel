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
  reason text CHECK (reason IS NULL OR reason IN ('missing-grant', 'not-licensed', 'not-listable', 'error', 'too-large')),
  message text,
  missing_grant text,
  grant_source text CHECK (grant_source IS NULL OR grant_source IN ('graph', 'documented')),
  PRIMARY KEY (run_id, source, name)
);
CREATE INDEX IF NOT EXISTS discovery_item_status_idx ON discovery_item (run_id, status);
