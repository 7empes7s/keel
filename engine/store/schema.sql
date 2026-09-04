CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE TABLE IF NOT EXISTS snapshot (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_ref      text NOT NULL,
  started_at      timestamptz NOT NULL DEFAULT now(),
  completed_at    timestamptz,
  status          text NOT NULL DEFAULT 'running',
  coverage_digest jsonb
);

CREATE TABLE IF NOT EXISTS resource_version (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  snapshot_id   uuid NOT NULL REFERENCES snapshot(id),
  natural_key   text NOT NULL,
  resource_type text NOT NULL,
  payload       jsonb NOT NULL,
  payload_hash  text NOT NULL,
  criticality   text NOT NULL,
  blast_radius  text NOT NULL,
  fidelity      text NOT NULL,
  provenance    jsonb NOT NULL,
  UNIQUE (snapshot_id, natural_key)
);

CREATE TABLE IF NOT EXISTS resource_reference (
  from_version uuid NOT NULL REFERENCES resource_version(id),
  field_path   text NOT NULL,
  to_symbol    text,
  required     boolean NOT NULL,
  PRIMARY KEY (from_version, field_path)
);

CREATE INDEX IF NOT EXISTS resource_version_key_idx ON resource_version (natural_key, snapshot_id);
CREATE INDEX IF NOT EXISTS resource_reference_symbol_idx ON resource_reference (to_symbol);
