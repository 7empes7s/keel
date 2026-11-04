-- One durable flag event per source row and rule, including flags folded into drift.
CREATE TABLE IF NOT EXISTS change_flag_event (
  tenant_ref text NOT NULL,
  source_id text NOT NULL,
  flag_key text NOT NULL,
  resource_key text NOT NULL,
  observed_at timestamptz NOT NULL,
  evaluation jsonb NOT NULL,
  alert_id uuid REFERENCES alert(id),
  alert_occurrence integer,
  resolved_at timestamptz,
  PRIMARY KEY (tenant_ref, source_id, flag_key)
);
CREATE INDEX IF NOT EXISTS change_flag_event_alert ON change_flag_event(alert_id);
CREATE TABLE IF NOT EXISTS change_flag_setting (
  tenant_ref text NOT NULL,
  flag_key text NOT NULL,
  enabled boolean NOT NULL DEFAULT true,
  PRIMARY KEY (tenant_ref, flag_key)
);
-- Audit page facts and this work item commit with their cursor. A failed alert write
-- is retried on the next ingest, even when the source cursor has advanced.
CREATE TABLE IF NOT EXISTS change_flag_pending (
  tenant_ref text NOT NULL,
  source_id text NOT NULL,
  PRIMARY KEY (tenant_ref, source_id)
);
