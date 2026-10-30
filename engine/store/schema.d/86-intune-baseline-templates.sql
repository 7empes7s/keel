-- Intune security baseline templates read from the tenant (engine/benchmarks/intuneBaselines.mjs).
--
-- Microsoft publishes its baselines as settings catalog templates in each tenant. One row
-- per read: every baseline template version with its settings and recommended values, in
-- Keel's compact shape. This is Microsoft-published reference data, not tenant
-- configuration, so it is kept apart from backups. Only the newest few reads per tenant
-- are kept. outcome is complete, complete-empty, partial (some templates could not be
-- read, listed in failures) or failed (the template list could not be read).
CREATE TABLE IF NOT EXISTS intune_baseline_template_read (
  id         bigserial PRIMARY KEY,
  tenant_ref text NOT NULL,
  read_at    timestamptz NOT NULL,
  outcome    text NOT NULL CHECK (outcome IN ('complete', 'complete-empty', 'partial', 'failed')),
  error      text,
  failures   jsonb NOT NULL DEFAULT '[]'::jsonb,
  templates  jsonb NOT NULL DEFAULT '[]'::jsonb
);
CREATE INDEX IF NOT EXISTS intune_baseline_template_read_newest
  ON intune_baseline_template_read (tenant_ref, read_at DESC);
