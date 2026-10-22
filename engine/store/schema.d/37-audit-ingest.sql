-- Who made a change (engine/identity/auditIngest.mjs, attribution.mjs, auditSources.mjs).
-- The same tables migrateAuditIngestion creates at run time, so a deploy creates them and
-- each collection can read Microsoft's audit logs into them. Additive and re-runnable.
CREATE TABLE IF NOT EXISTS audit_ingest_state (
  tenant_ref text NOT NULL, source text NOT NULL,
  cursor bigint, window_from timestamptz, window_until timestamptz,
  complete boolean NOT NULL DEFAULT false,
  PRIMARY KEY (tenant_ref, source)
);
ALTER TABLE audit_ingest_state ADD COLUMN IF NOT EXISTS retention_gap jsonb;
CREATE TABLE IF NOT EXISTS audit_ingest_event (
  tenant_ref text NOT NULL, source text NOT NULL, source_event_id text NOT NULL,
  occurred_at timestamptz NOT NULL,
  PRIMARY KEY (tenant_ref, source, source_event_id)
);
CREATE INDEX IF NOT EXISTS audit_ingest_event_retention ON audit_ingest_event(tenant_ref, source, occurred_at);
CREATE TABLE IF NOT EXISTS audit_ingest_run (
  id uuid PRIMARY KEY, tenant_ref text NOT NULL, source text NOT NULL,
  started_at timestamptz NOT NULL DEFAULT now(), evidence jsonb NOT NULL
);
CREATE INDEX IF NOT EXISTS audit_ingest_run_tenant ON audit_ingest_run(tenant_ref, source, started_at DESC);
CREATE TABLE IF NOT EXISTS audit_change_fact (
  tenant_ref text NOT NULL, source_event_id text NOT NULL,
  occurred_at timestamptz NOT NULL,
  target_type text NOT NULL, target_id text NOT NULL,
  operation text NOT NULL CHECK (operation IN ('create','update','delete')),
  activity text, fields text[] NOT NULL DEFAULT '{}',
  actor_kind text NOT NULL CHECK (actor_kind IN ('user','servicePrincipal')),
  actor_id text NOT NULL,
  PRIMARY KEY (tenant_ref, source_event_id)
);
CREATE INDEX IF NOT EXISTS audit_change_fact_target
  ON audit_change_fact(tenant_ref, target_type, target_id, occurred_at);
-- Facts are now looked up by object id alone (a relationship change names its parent).
CREATE INDEX IF NOT EXISTS audit_change_fact_target_id
  ON audit_change_fact(tenant_ref, target_id, occurred_at);
CREATE TABLE IF NOT EXISTS audit_sign_in_fact (
  tenant_ref text NOT NULL, source_event_id text NOT NULL,
  occurred_at timestamptz NOT NULL,
  actor_kind text NOT NULL CHECK (actor_kind IN ('user','servicePrincipal')),
  actor_id text NOT NULL,
  PRIMARY KEY (tenant_ref, source_event_id)
);
CREATE INDEX IF NOT EXISTS audit_sign_in_fact_time ON audit_sign_in_fact(tenant_ref, occurred_at);
