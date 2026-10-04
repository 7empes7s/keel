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

-- Roadmap task-70: the inverse-instruction journal behind conflict-aware
-- compensation. Each write records, before it is sent, what it is (operation,
-- resource type, target id, blast radius) and what it intends (intended_state);
-- after it returns, what was observed (post_state) and its outcome:
-- 'succeeded' (written and verified), 'failed' (Graph definitively rejected it),
-- or 'uncertain' (a lost response, a 5xx, or a write that did not verify — the
-- write may or may not have landed). A row still 'pending' was interrupted, and
-- is treated as uncertain. restore_ref names the promoted dry-run artifact, so a
-- compensation undoes exactly one run. Nullable and additive: entries written
-- before task-70 carry none of this and are never planned for compensation.
ALTER TABLE rollback_entry ADD COLUMN IF NOT EXISTS restore_ref text;
ALTER TABLE rollback_entry ADD COLUMN IF NOT EXISTS resource_type text;
ALTER TABLE rollback_entry ADD COLUMN IF NOT EXISTS operation text;
ALTER TABLE rollback_entry ADD COLUMN IF NOT EXISTS target_id text;
ALTER TABLE rollback_entry ADD COLUMN IF NOT EXISTS blast_radius text;
ALTER TABLE rollback_entry ADD COLUMN IF NOT EXISTS intended_state jsonb;
ALTER TABLE rollback_entry ADD COLUMN IF NOT EXISTS post_state jsonb;
ALTER TABLE rollback_entry ADD COLUMN IF NOT EXISTS outcome text;
ALTER TABLE rollback_entry ADD COLUMN IF NOT EXISTS outcome_detail text;
ALTER TABLE rollback_entry ADD COLUMN IF NOT EXISTS outcome_at timestamptz;
CREATE INDEX IF NOT EXISTS rollback_entry_restore_ref_idx ON rollback_entry (restore_ref);

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
-- Roadmap task-71: the investigator role (capability `investigate`) owns incident
-- compromise intervals, snapshot assessments, recovery-point overrides and
-- retention pins. Widening the closed role set is additive: every existing grant
-- satisfies the new check, which is recreated idempotently.
ALTER TABLE role_grant DROP CONSTRAINT IF EXISTS role_grant_role_check;
ALTER TABLE role_grant ADD CONSTRAINT role_grant_role_check
  CHECK (role IN ('viewer','operator','approver','restorer','admin','investigator'));

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

-- Roadmap task-110: an operator may acknowledge a measured load warning on a schedule.
-- Additive and nullable: legacy rows read as "not acknowledged". The acknowledgement
-- records who, when and for which cadence; it never changes cadence or next_due_at.
ALTER TABLE schedule ADD COLUMN IF NOT EXISTS forecast_acknowledgement jsonb;

-- Task 43: a system identity has an exact, code-defined capability set, not a new role.
ALTER TABLE principal ADD COLUMN IF NOT EXISTS system_kind text
  CHECK (system_kind = 'scheduler');
CREATE UNIQUE INDEX IF NOT EXISTS principal_system_kind_idx ON principal(system_kind)
  WHERE system_kind IS NOT NULL;

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

-- Roadmap task-61: the ordered group member/owner edge operations (qualified $ref
-- adds/removes) a dry run planned, frozen beside the plan digest that binds them, so
-- approvers review the exact edge changes a promotion may perform. Nullable and
-- additive: artifacts persisted before edge restore existed read as "no edge
-- operations" and promote exactly as before.
ALTER TABLE restore_dry_run ADD COLUMN IF NOT EXISTS relationship_operations jsonb;

-- Roadmap task-64: the recovery mechanism selected per resource (soft-delete
-- restore / update / recreate / manual / refused), with retained-or-new id,
-- retention deadline, credential mode and proof — bound into the plan digest so a
-- mechanism change after review invalidates approval. Nullable and additive:
-- artifacts persisted before task-64 promote exactly as before.
ALTER TABLE restore_dry_run ADD COLUMN IF NOT EXISTS recovery_mechanisms jsonb;

-- Roadmap task-66: classified content effects (retention-reducing, hold-releasing,
-- externally-sharing, irreversible) of a dry run, each with its "content is not
-- backed up" disclosure — folded into the plan digest. Nullable and additive.
ALTER TABLE restore_dry_run ADD COLUMN IF NOT EXISTS content_effects jsonb;

-- Roadmap task-70: a compensation dry run — the inverse plan for one failed
-- promotion (compensates = that artifact's id), its operations, conflict
-- refusals, manual items and irrecoverable effects. Folded into the plan digest,
-- so it is promoted only through the same immutable-artifact approval as a
-- forward restore. Null for every forward restore.
ALTER TABLE restore_dry_run ADD COLUMN IF NOT EXISTS compensation jsonb;

-- The SEPARATE high-impact approval those effects require: bound to the digest of
-- exactly the effects reviewed, never the requester, and re-checked for a current
-- approve grant at promotion. A revoked row no longer counts.
CREATE TABLE IF NOT EXISTS content_effect_approval (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_ref     text NOT NULL,
  artifact_id    uuid NOT NULL REFERENCES restore_dry_run(id),
  effects_digest text NOT NULL,
  approved_by    text NOT NULL,
  justification  text NOT NULL,
  approved_at    timestamptz NOT NULL DEFAULT now(),
  revoked_at     timestamptz,
  UNIQUE (artifact_id, effects_digest, approved_by)
);

-- Roadmap task-65: owned completion items for what a restore cannot write back
-- (secrets, certificates, consent, a new object id's downstream integrations) and
-- the service validation after it. Metadata and evidence REFERENCES only — never a
-- secret value. restore_ref is the promoted dry-run artifact id. Emission is
-- idempotent on the unique key; every transition is also an event row.
CREATE TABLE IF NOT EXISTS recovery_completion_item (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_ref    text NOT NULL,
  restore_ref   text NOT NULL,
  natural_key   text NOT NULL,
  resource_type text NOT NULL,
  mechanism     text NOT NULL,
  kind          text NOT NULL CHECK (kind IN ('credential','certificate','consent','integration','service-validation')),
  requirement   text NOT NULL,
  description   text NOT NULL,
  owner         text,
  state         text NOT NULL DEFAULT 'pending' CHECK (state IN ('pending','verified')),
  evidence      jsonb NOT NULL DEFAULT '[]'::jsonb,
  closed_by     text,
  closed_at     timestamptz,
  reopen_count  int NOT NULL DEFAULT 0,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_ref, restore_ref, natural_key, kind, requirement)
);
CREATE INDEX IF NOT EXISTS recovery_completion_item_open_idx
  ON recovery_completion_item (tenant_ref, state, created_at DESC);

CREATE TABLE IF NOT EXISTS recovery_completion_event (
  id         bigserial PRIMARY KEY,
  item_id    uuid NOT NULL REFERENCES recovery_completion_item(id),
  tenant_ref text NOT NULL,
  from_state text NOT NULL,
  to_state   text NOT NULL,
  actor      text NOT NULL,
  evidence   jsonb,
  at         timestamptz NOT NULL DEFAULT now()
);

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

-- Task 57: first-class relationship (edge) observations. A parent resource's
-- payload never proves its edges: group members and owners are read as
-- SEPARATE paginated child collections. One relationship_edge_set row records
-- one child read (parent x family) inside one snapshot, with its own outcome,
-- pagination evidence, API source and window; relationship_edge holds the
-- targets that read observed. outcome vocabulary matches the type digest:
-- complete / complete-empty / partial / failed. Edges of a partial or failed
-- set are retained only as what was observed — never as a complete edge set —
-- and a failed set carries no edges, so an empty edge table is never
-- confused with a failed read. tenant_ref is repeated on both tables so
-- every read path can qualify by tenant without trusting a join.
CREATE TABLE IF NOT EXISTS relationship_edge_set (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  snapshot_id      uuid NOT NULL REFERENCES snapshot(id),
  tenant_ref       text NOT NULL,
  parent_type      text NOT NULL,
  parent_source_id text NOT NULL,
  parent_natural_key text,
  family           text NOT NULL,
  edge_type        text NOT NULL,
  direction        text NOT NULL,
  outcome          text NOT NULL,
  item_count       int,
  pages_completed  int,
  endpoint         text,
  api_version      text,
  started_at       timestamptz,
  completed_at     timestamptz,
  http_status      int,
  graph_code       text,
  error            text,
  UNIQUE (snapshot_id, parent_type, parent_source_id, family)
);
CREATE INDEX IF NOT EXISTS relationship_edge_set_parent_idx
  ON relationship_edge_set (tenant_ref, parent_type, parent_source_id, family, completed_at);

CREATE TABLE IF NOT EXISTS relationship_edge (
  set_id             uuid NOT NULL REFERENCES relationship_edge_set(id) ON DELETE CASCADE,
  tenant_ref         text NOT NULL,
  target_source_id   text NOT NULL,
  target_type        text,
  target_natural_key text,
  PRIMARY KEY (set_id, target_source_id)
);

-- Task 58: an edge is identified by edge_key (a composite for families where a
-- bare target id is not enough — an Intune include AND exclude assignment of
-- the same group are two edges), with `attributes` carrying what must be
-- preserved but is not identity (assignment filter, intent, settings digest).
-- Additive and retry-safe: pre-existing task-57 rows are backfilled with
-- edge_key = target_source_id. The old primary key would forbid two edges to
-- one target, so it is replaced by a unique index on the edge identity.
ALTER TABLE relationship_edge ADD COLUMN IF NOT EXISTS edge_key text;
ALTER TABLE relationship_edge ADD COLUMN IF NOT EXISTS attributes jsonb;
UPDATE relationship_edge SET edge_key = target_source_id WHERE edge_key IS NULL;
ALTER TABLE relationship_edge DROP CONSTRAINT IF EXISTS relationship_edge_pkey;
CREATE UNIQUE INDEX IF NOT EXISTS relationship_edge_identity_idx ON relationship_edge (set_id, edge_key);

-- Roadmap task-71: incident-qualified recovery points and retention pins.
-- An incident is investigator-owned. Its compromise intervals bound when the tenant
-- may have been under attacker control (ends_at NULL = still ongoing). Each snapshot
-- assessment is an append-only version (verdict + malicious-field exclusions) for
-- one snapshot under one incident; the newest version is the current one. A
-- recovery override is an investigator's explicit, reasoned authorization to use a
-- point that is unsuitable or unassessed, bound to the exact assessment state it
-- was made against. A retention pin keeps a snapshot from routine prune until an
-- authorized release; a pin says nothing about whether the snapshot is clean.
-- Every table is tenant-scoped; all additive and retry-safe. snapshot_id carries no
-- foreign key on purpose: assessment, override and pin history must outlive a
-- snapshot that routine prune later removes (an ACTIVE pin keeps it from prune),
-- and never block that prune. Tenant scope is checked in code on every read.
CREATE TABLE IF NOT EXISTS incident (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_ref  text NOT NULL,
  title       text NOT NULL,
  owner       text NOT NULL,
  status      text NOT NULL DEFAULT 'open' CHECK (status IN ('open','closed')),
  opened_at   timestamptz NOT NULL DEFAULT now(),
  closed_at   timestamptz,
  closed_by   text
);
CREATE INDEX IF NOT EXISTS incident_tenant_idx ON incident (tenant_ref, opened_at DESC);

CREATE TABLE IF NOT EXISTS incident_compromise_interval (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_ref  text NOT NULL,
  incident_id uuid NOT NULL REFERENCES incident(id),
  starts_at   timestamptz NOT NULL,
  ends_at     timestamptz,
  reason      text NOT NULL,
  recorded_by text NOT NULL,
  recorded_at timestamptz NOT NULL DEFAULT now(),
  CHECK (ends_at IS NULL OR ends_at > starts_at)
);
CREATE INDEX IF NOT EXISTS incident_compromise_interval_incident_idx
  ON incident_compromise_interval (tenant_ref, incident_id);

CREATE TABLE IF NOT EXISTS incident_snapshot_assessment (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_ref           text NOT NULL,
  incident_id          uuid NOT NULL REFERENCES incident(id),
  snapshot_id          uuid NOT NULL,
  version              int NOT NULL,
  verdict              text NOT NULL CHECK (verdict IN ('clean','compromised')),
  exclusions           jsonb NOT NULL DEFAULT '[]'::jsonb,
  in_compromise_window boolean NOT NULL,
  rationale            text NOT NULL,
  assessed_by          text NOT NULL,
  assessed_at          timestamptz NOT NULL DEFAULT now(),
  UNIQUE (incident_id, snapshot_id, version)
);
CREATE INDEX IF NOT EXISTS incident_snapshot_assessment_lookup_idx
  ON incident_snapshot_assessment (tenant_ref, incident_id, snapshot_id, version DESC);

CREATE TABLE IF NOT EXISTS incident_recovery_override (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_ref             text NOT NULL,
  incident_id            uuid NOT NULL REFERENCES incident(id),
  snapshot_id            uuid NOT NULL,
  -- NULL binds the override to "no current assessment"; otherwise the fingerprint
  -- of the assessment version it was made against.
  assessment_fingerprint text,
  in_compromise_window   boolean NOT NULL,
  reason                 text NOT NULL,
  authorized_by          text NOT NULL,
  authorized_at          timestamptz NOT NULL DEFAULT now(),
  revoked_at             timestamptz,
  revoked_by             text
);
CREATE INDEX IF NOT EXISTS incident_recovery_override_lookup_idx
  ON incident_recovery_override (tenant_ref, incident_id, snapshot_id);

CREATE TABLE IF NOT EXISTS retention_pin (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_ref     text NOT NULL,
  incident_id    uuid NOT NULL REFERENCES incident(id),
  snapshot_id    uuid NOT NULL,
  reason         text NOT NULL,
  pinned_by      text NOT NULL,
  pinned_at      timestamptz NOT NULL DEFAULT now(),
  released_at    timestamptz,
  released_by    text,
  release_reason text
);
CREATE UNIQUE INDEX IF NOT EXISTS retention_pin_active_idx
  ON retention_pin (incident_id, snapshot_id) WHERE released_at IS NULL;
CREATE INDEX IF NOT EXISTS retention_pin_tenant_idx ON retention_pin (tenant_ref, snapshot_id);

-- The incident recovery context a dry run was planned under (incident, recovery
-- point qualification, assessment version/fingerprint, exclusions, override and the
-- post-restore checks), folded into the plan digest. Null for every restore not run
-- under an incident, which keeps their digest unchanged.
ALTER TABLE restore_dry_run ADD COLUMN IF NOT EXISTS incident_recovery jsonb;

-- Task 82 (WS7): durable alert lifecycle. One alert row per condition identity
-- (tenant, resource, control, condition); a recurrence reopens the same row as a new
-- occurrence instead of creating another alert. Every state change is an append-only
-- alert_transition row (UPDATE and DELETE are refused by trigger), and every applied
-- condition event leaves an alert_event_receipt keyed by its event id, so a retried or
-- duplicated event is recognised instead of re-applied. A suppressed alert keeps its row,
-- its history and the live condition state; suppression only stops notification.
CREATE TABLE IF NOT EXISTS alert (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_ref            text NOT NULL,
  resource_key          text NOT NULL,
  control               text NOT NULL,
  condition             text NOT NULL,
  state                 text NOT NULL CHECK (state IN ('open','acknowledged','resolved','reopened','suppressed')),
  condition_active      boolean NOT NULL,
  severity              text NOT NULL CHECK (severity IN ('notice','warning','critical')),
  occurrence            int NOT NULL DEFAULT 1 CHECK (occurrence >= 1),
  firing_count          int NOT NULL DEFAULT 1 CHECK (firing_count >= 0),
  flap_count            int NOT NULL DEFAULT 0 CHECK (flap_count >= 0),
  detail                jsonb NOT NULL DEFAULT '{}'::jsonb,
  first_opened_at       timestamptz NOT NULL,
  occurrence_started_at timestamptz NOT NULL,
  last_firing_at        timestamptz NOT NULL,
  last_observed_at      timestamptz NOT NULL,
  last_event_id         text NOT NULL,
  acknowledged_by       text,
  acknowledged_at       timestamptz,
  resolved_at           timestamptz,
  resolved_event_id     text,
  suppressed_by         text,
  suppressed_at         timestamptz,
  suppression_reason    text,
  notified_occurrence   int NOT NULL DEFAULT 0,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS alert_condition_identity_idx
  ON alert (tenant_ref, resource_key, control, condition);
CREATE INDEX IF NOT EXISTS alert_tenant_state_idx ON alert (tenant_ref, state, updated_at DESC);

CREATE TABLE IF NOT EXISTS alert_transition (
  id          bigserial PRIMARY KEY,
  alert_id    uuid NOT NULL REFERENCES alert(id),
  tenant_ref  text NOT NULL,
  occurrence  int NOT NULL,
  from_state  text,
  to_state    text NOT NULL,
  reason      text NOT NULL,
  event_id    text,
  actor       text NOT NULL,
  occurred_at timestamptz NOT NULL,
  recorded_at timestamptz NOT NULL DEFAULT now(),
  evidence    jsonb NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX IF NOT EXISTS alert_transition_alert_idx ON alert_transition (alert_id, id);

CREATE TABLE IF NOT EXISTS alert_event_receipt (
  tenant_ref  text NOT NULL,
  event_id    text NOT NULL,
  alert_id    uuid REFERENCES alert(id),
  outcome     text NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_ref, event_id)
);

CREATE OR REPLACE FUNCTION alert_transition_append_only() RETURNS trigger
LANGUAGE plpgsql AS $alert_transition$
BEGIN
  RAISE EXCEPTION 'alert_transition is append-only';
END;
$alert_transition$;
DROP TRIGGER IF EXISTS alert_transition_append_only ON alert_transition;
CREATE TRIGGER alert_transition_append_only
  BEFORE UPDATE OR DELETE ON alert_transition
  FOR EACH ROW EXECUTE FUNCTION alert_transition_append_only();

-- Roadmap task-87: baseline capture and versioning. A baseline records the collection
-- it was captured from (source_snapshot_id), when that collection finished
-- (captured_at, the basis of its age, never the page load) and what it covered
-- (observation_scope: the collection window and the types it read). A re-snapshot is a
-- NEW baseline row, version + 1, that names the version it supersedes; the old row's
-- baseline_resource rows are never touched, and superseded_at only marks it read-only.
-- Nullable and additive: baselines set before task-87 read their capture window from
-- the snapshots their resource versions came from (engine/govern/baselineCompliance.mjs).
ALTER TABLE baseline ADD COLUMN IF NOT EXISTS source_snapshot_id uuid REFERENCES snapshot(id);
ALTER TABLE baseline ADD COLUMN IF NOT EXISTS captured_at timestamptz;
ALTER TABLE baseline ADD COLUMN IF NOT EXISTS observation_scope jsonb;
ALTER TABLE baseline ADD COLUMN IF NOT EXISTS version int NOT NULL DEFAULT 1;
ALTER TABLE baseline ADD COLUMN IF NOT EXISTS supersedes_id uuid REFERENCES baseline(id);
ALTER TABLE baseline ADD COLUMN IF NOT EXISTS superseded_at timestamptz;
CREATE UNIQUE INDEX IF NOT EXISTS baseline_supersedes_once_idx
  ON baseline (supersedes_id) WHERE supersedes_id IS NOT NULL;

-- Roadmap task-87: an authorized exception names an owner, a reason and an expiry.
-- Rows written before task-87 have no owner; the compliance view treats them (and any
-- exception without an expiry) as incomplete, so the finding stays exposed.
ALTER TABLE benchmark_exception ADD COLUMN IF NOT EXISTS owner text;

-- Task 89: CMDB-first ownership with explicit SHARED/unknown/unresolved states.
-- Append-only evidence bound to a tenant-scoped resource_lineage row (task 50),
-- never to a display name: a reused name is a different lineage and inherits
-- nothing. A newer resolution supersedes the current row (superseded_at) but
-- never rewrites it, so approval evidence that cited an earlier row still reads
-- the owner it was decided under after the resource moves. expires_at bounds
-- freshness; an expired row authorizes no write. A failed CMDB lookup is
-- recorded as 'unresolved' with no entity — it never falls back or widens.
CREATE TABLE IF NOT EXISTS resource_ownership_evidence (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_ref        text NOT NULL,
  lineage_id        uuid NOT NULL REFERENCES resource_lineage(id),
  state             text NOT NULL CHECK (state IN ('owned','shared','unknown','unresolved')),
  entity_code       text,
  entity_codes      text[] NOT NULL DEFAULT '{}',
  source            text NOT NULL CHECK (source IN ('cmdb','entity-code-fallback','none')),
  reason            text NOT NULL,
  cmdb_record_ref   text,
  natural_key       text,
  observed_at       timestamptz NOT NULL,
  expires_at        timestamptz NOT NULL,
  superseded_at     timestamptz,
  recorded_by       text NOT NULL,
  CHECK ((state = 'owned') = (entity_code IS NOT NULL))
);
CREATE UNIQUE INDEX IF NOT EXISTS resource_ownership_evidence_current_idx
  ON resource_ownership_evidence (lineage_id) WHERE superseded_at IS NULL;
CREATE INDEX IF NOT EXISTS resource_ownership_evidence_tenant_idx
  ON resource_ownership_evidence (tenant_ref, lineage_id, observed_at DESC);

-- Task 90: entity-scoped grants and approval eligibility. role_grant.scope already
-- exists with default '*' (central); an entity-scoped grant stores 'entity:CODE'.
-- The check is additive: every existing row holds '*'. approval_request.entity_scope
-- records the resources a request concerns and their ownership when it was made, so a
-- later change of owner or grant is detected at decision time. NULL is a request made
-- before task 90 and is decided by central approvers only.
ALTER TABLE role_grant DROP CONSTRAINT IF EXISTS role_grant_scope_check;
ALTER TABLE role_grant ADD CONSTRAINT role_grant_scope_check
  CHECK (scope = '*' OR scope ~ '^entity:[A-Z][A-Z0-9_]{1,31}$');
ALTER TABLE approval_request ADD COLUMN IF NOT EXISTS entity_scope jsonb;
-- Task 91: where a request was routed when it was made (approvals.mjs#routeApproval):
-- an entity's approvers, an explicit central handoff, or refused. Advisory; eligibility
-- is re-decided on current ownership and grants. NULL is a request made before task 91.
ALTER TABLE approval_request ADD COLUMN IF NOT EXISTS route jsonb;

-- Task 83 (WS7): acknowledgement deadlines and escalation. A rule assigns an owner and
-- an acknowledgement window to the alerts it matches; the deadline is computed when an
-- occurrence opens and persisted on the alert, so a restart cannot lose an overdue one.
-- escalated_occurrence is the atomic claim: an occurrence escalates at most once.
CREATE TABLE IF NOT EXISTS alert_escalation_rule (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_ref          text NOT NULL,
  control             text,
  min_severity        text NOT NULL DEFAULT 'notice' CHECK (min_severity IN ('notice','warning','critical')),
  ack_within_ms       int NOT NULL CHECK (ack_within_ms > 0),
  owner_principal_id  uuid REFERENCES principal(id),
  escalate_channel_id uuid REFERENCES channel(id),
  enabled             boolean NOT NULL DEFAULT true,
  created_by          text NOT NULL,
  created_at          timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS alert_escalation_rule_tenant_idx ON alert_escalation_rule (tenant_ref, enabled);

ALTER TABLE alert ADD COLUMN IF NOT EXISTS ack_deadline_at timestamptz;
ALTER TABLE alert ADD COLUMN IF NOT EXISTS owner_principal_id uuid;
ALTER TABLE alert ADD COLUMN IF NOT EXISTS owner_source text NOT NULL DEFAULT 'unassigned'
  CHECK (owner_source IN ('rule','unassigned'));
ALTER TABLE alert ADD COLUMN IF NOT EXISTS escalation_rule_id uuid;
ALTER TABLE alert ADD COLUMN IF NOT EXISTS escalated_occurrence int NOT NULL DEFAULT 0;
ALTER TABLE alert ADD COLUMN IF NOT EXISTS escalation_error text;
CREATE INDEX IF NOT EXISTS alert_ack_deadline_idx ON alert (ack_deadline_at)
  WHERE state IN ('open','reopened') AND condition_active;

-- Roadmap task-84: Teams, Slack, PagerDuty and SMS channels. The kind list widens in
-- place (existing webhook/email rows are untouched), and each delivery keeps the
-- provider's redacted receipt: outcome, HTTP status, provider id or dedup key and what
-- "delivered" means for that provider. Legacy deliveries read as a null receipt.
ALTER TABLE channel DROP CONSTRAINT IF EXISTS channel_kind_check;
ALTER TABLE channel ADD CONSTRAINT channel_kind_check
  CHECK (kind IN ('webhook','email','teams','slack','pagerduty','sms'));
ALTER TABLE delivery ADD COLUMN IF NOT EXISTS provider_receipt jsonb;

-- Roadmap task-102: workload configuration reads (SharePoint first). One row per run,
-- including runs refused for lack of qualification (outcome 'disabled'), and one
-- observation per resource of that run with per-field coverage. Additive: nothing
-- reads these tables except the coverage report's `workloads` section.
CREATE TABLE IF NOT EXISTS workload_collection (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_ref    text NOT NULL,
  workload      text NOT NULL,
  outcome       text NOT NULL CHECK (outcome IN ('complete','complete-empty','partial','failed','disabled')),
  observed_from timestamptz NOT NULL,
  observed_to   timestamptz NOT NULL,
  digest        jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS workload_collection_latest_idx ON workload_collection (tenant_ref, workload, created_at DESC);

CREATE TABLE IF NOT EXISTS workload_observation (
  collection_id  uuid NOT NULL REFERENCES workload_collection(id) ON DELETE CASCADE,
  resource_key   text NOT NULL,
  fields         jsonb NOT NULL DEFAULT '{}'::jsonb,
  field_coverage jsonb NOT NULL DEFAULT '{}'::jsonb,
  PRIMARY KEY (collection_id, resource_key)
);

-- Roadmap task-103: a workload configuration restore (SharePoint tenant sharing
-- settings first) is planned into the same immutable dry-run artifact, so its
-- content-effect approval and promotion checks are the existing ones. Its source is
-- a workload collection, not an Entra snapshot, so snapshot_id may be null, but
-- only on a row that carries the frozen workload plan.
ALTER TABLE restore_dry_run ADD COLUMN IF NOT EXISTS workload_restore jsonb;
ALTER TABLE restore_dry_run ALTER COLUMN snapshot_id DROP NOT NULL;
ALTER TABLE restore_dry_run DROP CONSTRAINT IF EXISTS restore_dry_run_source_check;
ALTER TABLE restore_dry_run ADD CONSTRAINT restore_dry_run_source_check
  CHECK (snapshot_id IS NOT NULL OR workload_restore IS NOT NULL);

-- Roadmap task-94: emergency (break-glass) account lifecycle. An account is registered
-- by Entra object id with its review intervals; its lifecycle events (a recorded
-- emergency sign-in test, a recorded credential change, method evidence observed by a
-- read-only reader or attested by a person) are append-only. KEEL never rotates a
-- credential or changes a policy from these rows. Additive and retry-safe; an install
-- without these tables reads as "not configured", never as ready.
CREATE TABLE IF NOT EXISTS breakglass_account (
  tenant_ref               text NOT NULL,
  account_id               text NOT NULL CHECK (account_id ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'),
  label                    text NOT NULL,
  resource_key             text NOT NULL,
  validation_interval_days int NOT NULL DEFAULT 90 CHECK (validation_interval_days BETWEEN 1 AND 366),
  rotation_interval_days   int CHECK (rotation_interval_days IS NULL OR rotation_interval_days BETWEEN 1 AND 730),
  registered_by            text NOT NULL,
  registered_at            timestamptz NOT NULL DEFAULT now(),
  retired_by               text,
  retired_at               timestamptz,
  retired_reason           text,
  PRIMARY KEY (tenant_ref, account_id)
);

CREATE TABLE IF NOT EXISTS breakglass_lifecycle_event (
  id          bigserial PRIMARY KEY,
  tenant_ref  text NOT NULL,
  account_id  text NOT NULL,
  kind        text NOT NULL CHECK (kind IN ('validated','credential-rotated','methods-attested','methods-observed')),
  occurred_at timestamptz NOT NULL,
  recorded_by text NOT NULL,
  recorded_at timestamptz NOT NULL DEFAULT now(),
  detail      jsonb NOT NULL DEFAULT '{}'::jsonb,
  FOREIGN KEY (tenant_ref, account_id) REFERENCES breakglass_account (tenant_ref, account_id)
);
CREATE INDEX IF NOT EXISTS breakglass_lifecycle_event_idx
  ON breakglass_lifecycle_event (tenant_ref, account_id, kind, occurred_at DESC);

CREATE OR REPLACE FUNCTION breakglass_lifecycle_event_append_only() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'breakglass_lifecycle_event is append-only';
END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS breakglass_lifecycle_event_append_only ON breakglass_lifecycle_event;
CREATE TRIGGER breakglass_lifecycle_event_append_only
  BEFORE UPDATE OR DELETE ON breakglass_lifecycle_event
  FOR EACH ROW EXECUTE FUNCTION breakglass_lifecycle_event_append_only();

-- Roadmap task-92: immutable policy activation previews. Before an automatic roll-back
-- policy is turned on, KEEL freezes what it would act on (matched changes, everything
-- they depend on, run-as grants, limits, unsupported operations, benchmark findings)
-- with the policy, grant, ownership and projection versions it was computed under.
-- A preview row is never updated. Activation is a separate row that consumes one
-- preview exactly once (UNIQUE preview_id) and only while every version still
-- matches a fresh recomputation. Neither row authorizes execution: every queued roll
-- back is still re-checked by engine/policy/execute.mjs and the restore path.
-- Additive: policies turned on before this table existed have no activation row and
-- read as "turned on before previews existed"; they keep running under the same
-- execution-time checks.
CREATE TABLE IF NOT EXISTS policy_activation_preview (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_ref         text NOT NULL,
  policy_id          uuid NOT NULL REFERENCES policy(id),
  requested_by       text NOT NULL,
  policy_version     text NOT NULL,
  grant_version      text NOT NULL,
  ownership_version  text NOT NULL,
  projection_version text NOT NULL,
  digest             text NOT NULL,
  verdict            text NOT NULL CHECK (verdict IN ('ready','blocked')),
  preview            jsonb NOT NULL,
  created_at         timestamptz NOT NULL DEFAULT now(),
  expires_at         timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS policy_activation_preview_policy_idx
  ON policy_activation_preview (tenant_ref, policy_id, created_at DESC);

CREATE TABLE IF NOT EXISTS policy_activation (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_ref   text NOT NULL,
  policy_id    uuid NOT NULL REFERENCES policy(id),
  preview_id   uuid NOT NULL UNIQUE REFERENCES policy_activation_preview(id),
  activated_by text NOT NULL,
  activated_at timestamptz NOT NULL DEFAULT now(),
  versions     jsonb NOT NULL
);
CREATE INDEX IF NOT EXISTS policy_activation_policy_idx
  ON policy_activation (tenant_ref, policy_id, activated_at DESC);

-- Roadmap task-93: time-bounded approved emergency deviations. A change intent is an
-- immutable approval of exact field transitions (before -> after) on one resource,
-- with an owner, an approver who is not the owner, a window [window_start, window_end)
-- and an optional external change id. While the window is open, automatic roll back of
-- a drift whose every changed field matches an approved transition is refused; the drift
-- stays open and visible. Any other field change on the same resource is handled
-- normally. decision_digest is the canonical digest of the decision a future ITSM mirror
-- (task-97) must carry, so both records name the same approval.
-- Additive: nothing existed before; a tenant with no rows behaves exactly as before.
CREATE TABLE IF NOT EXISTS change_intent (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_ref            text NOT NULL,
  natural_key           text NOT NULL,
  resource_type         text NOT NULL,
  transitions           jsonb NOT NULL,
  transition_digest     text NOT NULL,
  owner_principal_id    uuid NOT NULL REFERENCES principal(id),
  approver_principal_id uuid NOT NULL REFERENCES principal(id),
  reason                text NOT NULL CHECK (length(btrim(reason)) > 0),
  external_change_id    text,
  source_drift_id       uuid REFERENCES drift(id),
  window_start          timestamptz NOT NULL,
  window_end            timestamptz NOT NULL,
  approved_at           timestamptz NOT NULL,
  decision_digest       text NOT NULL,
  CHECK (window_end > window_start),
  CHECK (owner_principal_id <> approver_principal_id),
  CHECK (jsonb_typeof(transitions) = 'array' AND jsonb_array_length(transitions) > 0)
);
CREATE INDEX IF NOT EXISTS change_intent_resource_idx
  ON change_intent (tenant_ref, natural_key, window_end);

-- State transitions of an intent, append-only: 'revoked' ends the window early;
-- 'settled' records that the intent's resource was evaluated afresh after the window
-- ended. One of each per intent, so a repeated or concurrent settle acts once.
CREATE TABLE IF NOT EXISTS change_intent_event (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_ref  text NOT NULL,
  intent_id   uuid NOT NULL REFERENCES change_intent(id),
  kind        text NOT NULL CHECK (kind IN ('revoked','settled')),
  occurred_at timestamptz NOT NULL,
  actor       text NOT NULL,
  detail      jsonb NOT NULL DEFAULT '{}'::jsonb,
  UNIQUE (intent_id, kind)
);

CREATE OR REPLACE FUNCTION change_intent_append_only() RETURNS trigger
LANGUAGE plpgsql AS $change_intent$
BEGIN
  RAISE EXCEPTION '% is append-only', TG_TABLE_NAME;
END;
$change_intent$;
DROP TRIGGER IF EXISTS change_intent_append_only ON change_intent;
CREATE TRIGGER change_intent_append_only
  BEFORE UPDATE OR DELETE ON change_intent
  FOR EACH ROW EXECUTE FUNCTION change_intent_append_only();
DROP TRIGGER IF EXISTS change_intent_event_append_only ON change_intent_event;
CREATE TRIGGER change_intent_event_append_only
  BEFORE UPDATE OR DELETE ON change_intent_event
  FOR EACH ROW EXECUTE FUNCTION change_intent_append_only();
