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
ALTER TABLE resource_version ADD COLUMN IF NOT EXISTS hash_version int NOT NULL DEFAULT 1;

CREATE TABLE IF NOT EXISTS resource_reference (
  from_version uuid NOT NULL REFERENCES resource_version(id),
  field_path   text NOT NULL,
  to_symbol    text,
  required     boolean NOT NULL,
  PRIMARY KEY (from_version, field_path)
);

CREATE INDEX IF NOT EXISTS resource_version_key_idx ON resource_version (natural_key, snapshot_id);
CREATE INDEX IF NOT EXISTS resource_reference_symbol_idx ON resource_reference (to_symbol);

CREATE TABLE IF NOT EXISTS rollback_entry (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id       text NOT NULL,
  natural_key  text NOT NULL,
  prior_state  jsonb,
  recorded_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS rollback_entry_run_idx ON rollback_entry (run_id);

CREATE TABLE IF NOT EXISTS plan (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source_snapshot  uuid NOT NULL REFERENCES snapshot(id),
  target_tenant    text NOT NULL,
  created_at       timestamptz NOT NULL DEFAULT now(),
  preflight        jsonb NOT NULL,
  clean            boolean NOT NULL
);

CREATE TABLE IF NOT EXISTS baseline (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_ref text NOT NULL,
  set_at     timestamptz NOT NULL DEFAULT now(),
  set_by     text NOT NULL,
  active     boolean NOT NULL DEFAULT true
);
CREATE UNIQUE INDEX IF NOT EXISTS baseline_one_active_idx
  ON baseline (tenant_ref) WHERE active;
ALTER TABLE baseline ADD COLUMN IF NOT EXISTS label text;
ALTER TABLE baseline ADD COLUMN IF NOT EXISTS description text;
CREATE UNIQUE INDEX IF NOT EXISTS baseline_tenant_label_idx
  ON baseline (tenant_ref, label) WHERE label IS NOT NULL;

CREATE TABLE IF NOT EXISTS baseline_resource (
  baseline_id         uuid NOT NULL REFERENCES baseline(id) ON DELETE CASCADE,
  natural_key         text NOT NULL,
  resource_version_id uuid NOT NULL REFERENCES resource_version(id),
  PRIMARY KEY (baseline_id, natural_key)
);

CREATE TABLE IF NOT EXISTS drift (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_ref        text NOT NULL,
  baseline_id       uuid NOT NULL REFERENCES baseline(id),
  observed_snapshot uuid NOT NULL REFERENCES snapshot(id),
  natural_key       text NOT NULL,
  resource_type     text NOT NULL,
  change_type       text NOT NULL CHECK (change_type IN ('added','modified','removed')),
  before_hash       text,
  after_hash        text,
  before_payload    jsonb,
  after_payload     jsonb,
  blast_radius      text NOT NULL,
  detected_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (baseline_id, observed_snapshot, natural_key)
);

CREATE TABLE IF NOT EXISTS disposition (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  drift_id   uuid NOT NULL REFERENCES drift(id),
  action     text NOT NULL CHECK (action IN ('accept','rollback','ignore')),
  actor      text NOT NULL,
  reason     text NOT NULL,
  decided_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz,
  plan_id    uuid REFERENCES plan(id)
);

CREATE TABLE IF NOT EXISTS evidence (
  seq         bigserial PRIMARY KEY,
  tenant_ref  text NOT NULL,
  occurred_at timestamptz NOT NULL DEFAULT now(),
  kind        text NOT NULL,
  subject     jsonb NOT NULL,
  actor       text NOT NULL,
  prev_hash   text,
  record_hash text NOT NULL
);

CREATE TABLE IF NOT EXISTS evidence_head (
  tenant_ref  text PRIMARY KEY,
  head_seq    bigint NOT NULL,
  head_hash   text NOT NULL,
  record_count bigint NOT NULL,
  updated_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS job (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind         text NOT NULL CHECK (kind IN ('collect','prune','drift-detect')),
  params       jsonb NOT NULL DEFAULT '{}'::jsonb,
  status       text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','running','succeeded','failed','cancelled')),
  requested_by text NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  started_at   timestamptz,
  finished_at  timestamptz,
  result       jsonb,
  error        text,
  worker_id    text
);
ALTER TABLE job ADD COLUMN IF NOT EXISTS heartbeat_at timestamptz;
CREATE INDEX IF NOT EXISTS job_status_created_idx ON job (status, created_at);
CREATE INDEX IF NOT EXISTS job_running_heartbeat_idx ON job (heartbeat_at) WHERE status = 'running';
