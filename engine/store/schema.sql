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
  kind         text NOT NULL CHECK (kind IN ('collect','prune','drift-detect','offsite')),
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
  CHECK (kind IN ('collect','prune','drift-detect','offsite','restore','remediate','baseline-create','baseline-activate','backup','policy-evaluate','notify','api-drift'));
ALTER TABLE job ADD COLUMN IF NOT EXISTS idempotency_key text;
CREATE UNIQUE INDEX IF NOT EXISTS job_kind_idempotency_key_idx
  ON job (kind, idempotency_key) WHERE idempotency_key IS NOT NULL;

-- A retry must stay queued until its backoff expires. Keeping the time on the job
-- makes the wait durable and visible instead of hiding it in a worker sleep.
ALTER TABLE job ADD COLUMN IF NOT EXISTS not_before timestamptz NOT NULL DEFAULT now();
CREATE INDEX IF NOT EXISTS job_status_not_before_created_idx
  ON job (status, not_before, created_at);

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
  created_by             text NOT NULL,
  run_as_principal_id    uuid REFERENCES principal(id),
  run_as_repair_required boolean NOT NULL DEFAULT false
);
CREATE INDEX IF NOT EXISTS policy_tenant_enabled_idx ON policy (tenant_ref) WHERE enabled;

-- Plan task 19: a rate limit that pauses the policy when max_actions_per_window is
-- exceeded, rather than dropping the action that tipped it over. paused_at is separate
-- from enabled — enabled is operator-controlled, paused_at is the automatic circuit
-- breaker engine/policy/execute.mjs trips itself. A paused policy takes no further
-- automatic action until an operator clears it.
ALTER TABLE policy ADD COLUMN IF NOT EXISTS paused_at timestamptz;

-- Task 9: `created_by` remains immutable audit provenance. An auto-remediation
-- policy instead runs under this separately registered principal, which is checked
-- for the remediate capability when configured and again by keel-worker at execution.
-- The nullable column is deliberate: it makes this migration additive for existing
-- policy rows. The repair marker makes each pre-existing unsafe row visible rather
-- than silently binding it to its creator or any broader principal.
ALTER TABLE policy
  ADD COLUMN IF NOT EXISTS run_as_principal_id uuid REFERENCES principal(id);
ALTER TABLE policy
  ADD COLUMN IF NOT EXISTS run_as_repair_required boolean NOT NULL DEFAULT false;

-- Existing automatic policies predate an explicit run-as identity. Disable and pause
-- every one without a currently enabled restorer grant, including a missing or disabled
-- principal. Re-running this is safe: paused_at is preserved after its first value and
-- the same rows remain visibly marked for operator repair.
UPDATE policy AS policy
   SET enabled = false,
       paused_at = COALESCE(policy.paused_at, now()),
       run_as_repair_required = true
 WHERE policy.action = 'auto_remediate'
   AND (
     policy.run_as_principal_id IS NULL
     OR NOT EXISTS (
       SELECT 1
         FROM principal
         JOIN role_grant ON role_grant.principal_id = principal.id
        WHERE principal.id = policy.run_as_principal_id
          AND principal.disabled_at IS NULL
          AND role_grant.role = 'restorer'
          AND role_grant.active_from <= now()
          AND (role_grant.active_until IS NULL OR role_grant.active_until > now())
     )
   );

-- One durable link per policy/drift/job lets worker terminal state become evidence
-- without putting automation-only metadata into the remediation payload. The payload
-- continues to contain only drift ids, so automated and human remediation share the
-- same safety path.
CREATE TABLE IF NOT EXISTS auto_remediation_execution (
  job_id      uuid PRIMARY KEY REFERENCES job(id),
  tenant_ref  text NOT NULL,
  policy_id   uuid NOT NULL REFERENCES policy(id),
  drift_id    uuid NOT NULL REFERENCES drift(id),
  status      text NOT NULL CHECK (status IN ('queued','executed','failed')),
  queued_at   timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  error       text,
  UNIQUE (policy_id, drift_id)
);
CREATE INDEX IF NOT EXISTS auto_remediation_execution_job_idx
  ON auto_remediation_execution (job_id);

-- §3.5 notification model (plan task 20). A channel is an outbound destination;
-- subscriptions select the events it receives; delivery is the durable per-event,
-- per-channel log. `event` deliberately keeps the full event payload available to
-- operators when a delivery fails, instead of leaving only an opaque job error.
CREATE TABLE IF NOT EXISTS channel (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind       text NOT NULL CHECK (kind IN ('webhook','email')),
  config     jsonb NOT NULL DEFAULT '{}'::jsonb,
  enabled    boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS subscription (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  channel_id   uuid NOT NULL REFERENCES channel(id) ON DELETE CASCADE,
  event_glob   text NOT NULL,
  min_severity text NOT NULL CHECK (min_severity IN ('notice','warning','critical')),
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS subscription_channel_idx ON subscription (channel_id);

CREATE TABLE IF NOT EXISTS delivery (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event           jsonb NOT NULL,
  channel_id      uuid NOT NULL REFERENCES channel(id),
  requested_by    text NOT NULL,
  attempts        int NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  max_attempts    int NOT NULL DEFAULT 5 CHECK (max_attempts > 0),
  status          text NOT NULL DEFAULT 'queued'
                  CHECK (status IN ('queued','delivering','retrying','delivered','failed','cancelled')),
  last_error      text,
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  delivered_at    timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS delivery_status_next_attempt_idx
  ON delivery (status, next_attempt_at);
CREATE INDEX IF NOT EXISTS delivery_channel_created_idx
  ON delivery (channel_id, created_at DESC);

-- Task 42: preserve the design SQL verbatim while allowing schema re-application.
DO $schedule$
BEGIN
IF to_regclass('schedule') IS NULL THEN
CREATE TABLE schedule (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_ref    text NOT NULL,
  job_kind      text NOT NULL,       -- 'collect' | 'backup' | 'prune' | 'drift-detect' | 'offsite' | 'api-drift'
  tier          text,                -- 'tier1' | 'tier2' | 'tier3' | null (job kinds with no tier concept)
  cadence       jsonb NOT NULL,      -- { "every": "hour"|"day"|"week", "n": 1, "atTime": "05:00" | null }
  cron_override text,                -- raw cron expression; when set, takes precedence over `cadence`
  enabled       boolean NOT NULL DEFAULT true,
  next_due_at   timestamptz NOT NULL, -- the nominal due instant, never recomputed from wall-clock now
  last_job_id   uuid REFERENCES job(id),
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);
-- Plain UNIQUE(tenant_ref, job_kind, tier) does NOT work here: Postgres treats every NULL tier as
-- distinct, so it would silently allow duplicate rows for every job_kind with no tier concept
-- (prune, drift-detect, offsite). Use a expression index that collapses NULL to a sentinel instead:
CREATE UNIQUE INDEX schedule_one_per_job ON schedule (tenant_ref, job_kind, COALESCE(tier, ''));
END IF;
END
$schedule$;

-- Plan task 8 (portal-design §4.1): restore promotion requires an IMMUTABLE dry-run
-- review, never a mutable selection. A dry run persists here — the exact source
-- snapshot, raw selection, server-computed closure, target identity, waves, deferred
-- patches, guard outcomes and per-resource result — with a stable digest over its
-- planning inputs and a genuine fingerprint of the target state the closure would
-- touch. An approval references the artifact by id; execution recomputes both the
-- digest and the fingerprint and refuses to write on any mismatch, so a stale or
-- tampered promotion fails closed rather than replaying whatever the caller supplies.
CREATE TABLE IF NOT EXISTS restore_dry_run (
  id                        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_ref                text NOT NULL,
  snapshot_id               uuid NOT NULL REFERENCES snapshot(id),
  selection                 jsonb NOT NULL,
  closure_keys              jsonb NOT NULL,
  target_tenant_id          text NOT NULL,
  collector_config_path     text NOT NULL,
  target_config_path        text NOT NULL,
  reconciliation_resources  jsonb,
  waves                     jsonb NOT NULL,
  patches                   jsonb NOT NULL,
  guard_refusals            jsonb NOT NULL DEFAULT '[]'::jsonb,
  results                   jsonb NOT NULL,
  current_state_fingerprint text NOT NULL,
  digest                    text NOT NULL,
  status                    text NOT NULL CHECK (status IN ('completed','refused','failed')),
  requested_by              text NOT NULL,
  created_at                timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS restore_dry_run_tenant_created_idx
  ON restore_dry_run (tenant_ref, created_at DESC);

-- Roadmap task-55: an automation-triggered remediation records, inside its immutable
-- dry-run artifact, the exact policy identity + constraint version it was planned
-- under and the expanded closure scope its maximum impact was computed over. Promotion
-- re-resolves the live policy rows and refuses when either the version or the
-- post-closure impact no longer matches. Nullable: additive for pre-existing
-- (operator-driven) artifacts, which carry no automation context and promote exactly
-- as before. Retry-safe and forward-compatible.
ALTER TABLE restore_dry_run ADD COLUMN IF NOT EXISTS automation_context jsonb;

-- Task 79 (WS12): durable per-destination SIEM export outbox. One destination row per
-- configured sink; one outbox row per (destination, source event) so a replayed or
-- retried delivery always carries the SAME task-77 event id; one replay checkpoint per
-- destination recording the highest outbox sequence the sink has acknowledged. The
-- checkpoint advances only inside the same transaction that marks an event
-- acknowledged, so a crash after remote acceptance but before commit leaves the event
-- pending and it is redelivered under its original id (at-least-once; receivers dedup
-- on the event id). config holds credential REFERENCES only — never secret values.
CREATE TABLE IF NOT EXISTS siem_destination (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_ref  text NOT NULL,
  name        text NOT NULL,
  kind        text NOT NULL,
  config      jsonb NOT NULL DEFAULT '{}'::jsonb,
  enabled     boolean NOT NULL DEFAULT true,
  revoked_at  timestamptz,
  created_by  text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_ref, name)
);

CREATE TABLE IF NOT EXISTS siem_outbox_event (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  outbox_seq        bigserial NOT NULL UNIQUE,
  tenant_ref        text NOT NULL,
  destination_id    uuid NOT NULL REFERENCES siem_destination(id),
  event_id          text NOT NULL,
  envelope          jsonb NOT NULL,
  status            text NOT NULL DEFAULT 'pending'
                    CHECK (status IN ('pending','delivering','acknowledged','quarantined')),
  attempts          int NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  max_attempts      int NOT NULL DEFAULT 8 CHECK (max_attempts > 0),
  next_attempt_at   timestamptz NOT NULL DEFAULT now(),
  last_error        text,
  acknowledged_at   timestamptz,
  quarantined_at    timestamptz,
  quarantine_reason text,
  created_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (destination_id, event_id)
);
CREATE INDEX IF NOT EXISTS siem_outbox_event_due_idx
  ON siem_outbox_event (destination_id, status, next_attempt_at);
CREATE INDEX IF NOT EXISTS siem_outbox_event_tenant_idx
  ON siem_outbox_event (tenant_ref, destination_id);

CREATE TABLE IF NOT EXISTS siem_replay_checkpoint (
  destination_id             uuid PRIMARY KEY REFERENCES siem_destination(id),
  tenant_ref                 text NOT NULL,
  last_acknowledged_seq      bigint NOT NULL DEFAULT 0,
  last_acknowledged_event_id text,
  replay_from_seq            bigint,
  replay_requested_by        text,
  replay_requested_at        timestamptz,
  updated_at                 timestamptz NOT NULL DEFAULT now()
);

-- Task 85 (WS5): versioned benchmark control evaluation. One benchmark_evaluation row
-- per control evaluation run for a tenant; framework/edition/profile/evaluator_version
-- are recorded on EVERY row (never inferred from current registry state) so a later
-- registry edit can never rewrite the meaning of a historical result. The verdict CHECK
-- deliberately excludes 'exception' — an exception is never stored as a row's own
-- verdict, only ever as a benchmark_exception overlay referencing the evaluation, so a
-- waived failure keeps its original 'fail' verdict and evidence intact (mutation check:
-- erase underlying finding under exception). Comparing results across a different
-- edition/evaluator_version is an application-level refusal
-- (engine/benchmarks/evaluate.mjs's compareEvaluationsAcrossEditions), not a schema
-- constraint — an edition change must never be conflated with tenant drift, and this
-- table is never read by drift detection.
CREATE TABLE IF NOT EXISTS benchmark_evaluation (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_ref          text NOT NULL,
  control_id          text NOT NULL,
  framework           text NOT NULL,
  edition             text NOT NULL,
  profile             text NOT NULL,
  evaluator_version   int NOT NULL,
  verdict             text NOT NULL CHECK (verdict IN ('pass','fail','unknown','not-applicable')),
  reason              text,
  evidence_refs       jsonb NOT NULL DEFAULT '[]'::jsonb,
  observation_windows jsonb NOT NULL DEFAULT '[]'::jsonb,
  evidence_seq        bigint REFERENCES evidence(seq),
  evaluated_at        timestamptz NOT NULL,
  created_at          timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS benchmark_evaluation_tenant_control_idx
  ON benchmark_evaluation (tenant_ref, control_id, evaluated_at DESC);

CREATE TABLE IF NOT EXISTS benchmark_exception (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_ref    text NOT NULL,
  evaluation_id uuid NOT NULL REFERENCES benchmark_evaluation(id),
  actor         text NOT NULL,
  reason        text NOT NULL,
  granted_at    timestamptz NOT NULL DEFAULT now(),
  expires_at    timestamptz
);
CREATE INDEX IF NOT EXISTS benchmark_exception_evaluation_idx
  ON benchmark_exception (evaluation_id);

-- Task 62: Microsoft API / catalog drift detection. api_drift_source pins the last
-- successfully fetched official metadata source (digest, HTTP Date, ETag, extracted
-- version and the compact comparison model) per tenant and source. A failed, timed-out
-- or oversized fetch updates last_status/last_error ONLY — the pin and model are
-- retained, so a network failure can never read as "no changes". api_drift_candidate
-- holds REVIEW CANDIDATES ONLY: no row here ever registers a type, a permission or a
-- write verb (engine/coverage/capabilities.mjs remains the only path off
-- 'unsupported', and nothing in the drift path calls it).
CREATE TABLE IF NOT EXISTS api_drift_source (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_ref       text NOT NULL,
  source_key       text NOT NULL,
  url              text NOT NULL,
  etag             text,
  digest           text,
  source_date      text,
  metadata_version text,
  model            jsonb,
  last_status      text NOT NULL DEFAULT 'never-run'
                   CHECK (last_status IN ('never-run','fetched','not-modified','unknown','timeout','oversized')),
  last_error       text,
  last_checked_at  timestamptz,
  last_changed_at  timestamptz,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_ref, source_key)
);

CREATE TABLE IF NOT EXISTS api_drift_candidate (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_ref    text NOT NULL,
  source_key    text NOT NULL,
  source_url    text NOT NULL,
  kind          text NOT NULL CHECK (kind IN ('added-endpoint','removed-endpoint','changed-field')),
  resource_type text,
  path          text NOT NULL,
  field         text,
  detail        jsonb NOT NULL DEFAULT '{}'::jsonb,
  proof         jsonb NOT NULL,
  status        text NOT NULL DEFAULT 'review' CHECK (status IN ('review')),
  detected_at   timestamptz NOT NULL DEFAULT now()
);
-- A repeat fetch of unchanged metadata must not duplicate findings: the dedupe key is
-- the finding identity (tenant, source, kind, path, field), collapsed like schedule's
-- NULL tier. Persistence uses ON CONFLICT DO NOTHING against this index.
CREATE UNIQUE INDEX IF NOT EXISTS api_drift_candidate_dedupe_idx
  ON api_drift_candidate (tenant_ref, source_key, kind, path, COALESCE(field, ''));
CREATE INDEX IF NOT EXISTS api_drift_candidate_tenant_detected_idx
  ON api_drift_candidate (tenant_ref, detected_at DESC);

-- Task 48: tenant-scoped historical identity context. One row per observed
-- (tenant, type, Graph source id) records the natural key that id resolved to,
-- the observation window (first/last seen) and the snapshot that last evidenced
-- it. A row is live while tombstoned_at is null; only a successful FULL per-type
-- enumeration (outcome complete/complete-empty) may tombstone ids it did not
-- observe — failed/partial reads prove nothing about absence. Seeded from
-- preexisting successful snapshots without rewriting their stored keys.
CREATE TABLE IF NOT EXISTS resource_symbol (
  tenant_ref      text NOT NULL,
  resource_type   text NOT NULL,
  source_id       text NOT NULL,
  natural_key     text NOT NULL,
  first_seen_at   timestamptz NOT NULL DEFAULT now(),
  last_seen_at    timestamptz NOT NULL DEFAULT now(),
  source_snapshot uuid REFERENCES snapshot(id),
  tombstoned_at   timestamptz,
  PRIMARY KEY (tenant_ref, resource_type, source_id)
);
CREATE INDEX IF NOT EXISTS resource_symbol_live_idx
  ON resource_symbol (tenant_ref, resource_type) WHERE tombstoned_at IS NULL;

-- Task 50: stable resource lineage across rename and recovery. A lineage is the
-- durable logical identity of one tenant-scoped resource: the row keyed by
-- (tenant, type, source id) is the SAME row across every rename of that id — a
-- Graph object keeps its own id when renamed, so this id is never regenerated
-- by a rename, only by a genuinely new or recreated object. A brand-new source
-- id observed for the first time always starts a brand-new lineage row, even
-- when its current name collides with a name a different (tombstoned) lineage
-- once held: name reuse alone must never merge two lineages. tombstoned_at
-- mirrors resource_symbol's rule (task 48): only a successful full per-type
-- enumeration may tombstone a lineage its run did not observe.
CREATE TABLE IF NOT EXISTS resource_lineage (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_ref     text NOT NULL,
  resource_type  text NOT NULL,
  source_id      text NOT NULL,
  created_at     timestamptz NOT NULL DEFAULT now(),
  tombstoned_at  timestamptz,
  UNIQUE (tenant_ref, resource_type, source_id)
);
CREATE INDEX IF NOT EXISTS resource_lineage_live_idx
  ON resource_lineage (tenant_ref, resource_type) WHERE tombstoned_at IS NULL;

-- Every natural key a lineage has ever been observed under, with an EXPLICIT
-- validity window. At most one row per lineage has valid_until IS NULL (the
-- current name); every closed row is a historical alias only. Resolving a
-- reference against a closed alias must always be carried as stale, never as
-- current authorization — only the live (valid_until IS NULL) alias is a
-- legitimate target for a live write.
CREATE TABLE IF NOT EXISTS resource_lineage_alias (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  lineage_id      uuid NOT NULL REFERENCES resource_lineage(id) ON DELETE CASCADE,
  natural_key     text NOT NULL,
  valid_from      timestamptz NOT NULL,
  valid_until     timestamptz,
  source_snapshot uuid REFERENCES snapshot(id)
);
CREATE UNIQUE INDEX IF NOT EXISTS resource_lineage_alias_current_idx
  ON resource_lineage_alias (lineage_id) WHERE valid_until IS NULL;
CREATE INDEX IF NOT EXISTS resource_lineage_alias_key_idx
  ON resource_lineage_alias (natural_key);

-- The only mechanism allowed to unify two DIFFERENT source ids (and therefore
-- two different resource_lineage rows) into one continuous history: a
-- recreation the collector cannot see as a same-id rename (e.g. an object
-- permanently deleted and manually rebuilt under a fresh Graph id). evidence
-- is mandatory and opaque here (the caller's own proof, e.g. a restore run's
-- provenance) — this table never infers a link from name reuse alone, and a
-- predecessor must already be tombstoned before it can be "recovered from".
CREATE TABLE IF NOT EXISTS resource_lineage_recovery (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_ref       text NOT NULL,
  predecessor_id   uuid NOT NULL REFERENCES resource_lineage(id),
  successor_id     uuid NOT NULL REFERENCES resource_lineage(id),
  evidence         jsonb NOT NULL,
  recorded_by      text NOT NULL,
  recorded_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (predecessor_id, successor_id),
  CHECK (predecessor_id <> successor_id)
);
CREATE INDEX IF NOT EXISTS resource_lineage_recovery_successor_idx
  ON resource_lineage_recovery (successor_id);
