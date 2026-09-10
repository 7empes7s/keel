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

-- A CHECK constraint cannot be altered in place; dropping and re-adding it under the same
-- name keeps this idempotent without rewriting any rows.
ALTER TABLE job DROP CONSTRAINT IF EXISTS job_kind_check;
ALTER TABLE job ADD CONSTRAINT job_kind_check
  CHECK (kind IN ('collect','prune','drift-detect','restore','remediate','baseline-create','baseline-activate','backup','policy-evaluate','notify'));
ALTER TABLE job ADD COLUMN IF NOT EXISTS idempotency_key text;
CREATE UNIQUE INDEX IF NOT EXISTS job_kind_idempotency_key_idx
  ON job (kind, idempotency_key) WHERE idempotency_key IS NOT NULL;

-- §3.2 authorisation model: who is allowed to do what. The role -> capability mapping is
-- code (engine/authz/permissions.mjs), deny-by-default; these tables are only data.
-- scope is reserved for later per-tenant or per-resource narrowing and is '*' for now.
CREATE TABLE IF NOT EXISTS principal (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  external_id  text,
  email        text NOT NULL,
  display_name text,
  disabled_at  timestamptz
);
CREATE UNIQUE INDEX IF NOT EXISTS principal_email_idx ON principal (lower(email));

CREATE TABLE IF NOT EXISTS role_grant (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  principal_id uuid NOT NULL REFERENCES principal(id),
  role         text NOT NULL CHECK (role IN ('viewer','operator','approver','restorer','admin')),
  scope        text NOT NULL DEFAULT '*',
  active_from  timestamptz NOT NULL DEFAULT now(),
  active_until timestamptz,
  granted_by   text,
  reason       text
);
CREATE INDEX IF NOT EXISTS role_grant_principal_idx ON role_grant (principal_id);

-- §3.3 approvals (plan task 14): requesting a requiresApproval action creates an
-- approval_request, never a job. Only an approve decision by a principal other than
-- the requester mints the job; reject closes the request. expires_at enforces the
-- configurable TTL: a stale request expires *closed* so an approval can never be
-- granted against stale parameters.
CREATE TABLE IF NOT EXISTS approval_request (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  action        text NOT NULL,
  params        jsonb NOT NULL DEFAULT '{}'::jsonb,
  requested_by  text NOT NULL,
  justification text,
  status        text NOT NULL DEFAULT 'pending'
                CHECK (status IN ('pending','approved','rejected','expired')),
  decided_by    text,
  decided_at    timestamptz,
  reason        text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  expires_at    timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS approval_request_status_idx
  ON approval_request (status, created_at);

-- §3.4 automation model (plan task 18): a policy is a rule evaluated against each
-- newly detected drift row. match narrows which drift rows the policy applies to
-- (a null match column means "any"); action is what a match recommends; limits are
-- structural guardrails enforced by engine/policy/evaluate.mjs itself, never
-- bypassable by a policy's own match configuration — max_blast_radius in particular
-- caps auto_remediate regardless of what the policy matched.
CREATE TABLE IF NOT EXISTS policy (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_ref             text NOT NULL,
  name                   text NOT NULL,
  enabled                boolean NOT NULL DEFAULT true,
  resource_type          text,
  blast_radius           text CHECK (blast_radius IS NULL OR blast_radius IN ('cosmetic','access-affecting','tenant-lockout')),
  natural_key_glob       text,
  change_type            text CHECK (change_type IS NULL OR change_type IN ('added','modified','removed')),
  action                 text NOT NULL CHECK (action IN ('alert','require_approval','auto_remediate')),
  max_blast_radius       text NOT NULL CHECK (max_blast_radius IN ('cosmetic','access-affecting','tenant-lockout')),
  max_actions_per_window int,
  window_seconds         int,
  created_at             timestamptz NOT NULL DEFAULT now(),
  created_by             text NOT NULL
);
CREATE INDEX IF NOT EXISTS policy_tenant_enabled_idx ON policy (tenant_ref) WHERE enabled;

-- Plan task 19: a rate limit that pauses the policy when max_actions_per_window is
-- exceeded, rather than dropping the action that tipped it over. paused_at is separate
-- from enabled — enabled is operator-controlled, paused_at is the automatic circuit
-- breaker engine/policy/execute.mjs trips itself. A paused policy takes no further
-- automatic action until an operator clears it.
ALTER TABLE policy ADD COLUMN IF NOT EXISTS paused_at timestamptz;
