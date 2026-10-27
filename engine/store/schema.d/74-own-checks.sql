-- Compliance checks a tenant writes itself (engine/benchmarks/ownChecks.mjs): one setting
-- of one backed-up configuration type, the value it should have, and whether every
-- object or at least one must have it. Each belongs to a standard of the tenant's own,
-- named by them. A removed check keeps its row (removed_at) so its past results still name it.
-- Additive and safe to re-apply.
CREATE TABLE IF NOT EXISTS compliance_own_check (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_ref     text NOT NULL,
  standard       text NOT NULL,
  name           text NOT NULL,
  resource_type  text NOT NULL,
  field          text NOT NULL,
  operator       text NOT NULL CHECK (operator IN ('equals', 'not-equals')),
  expected       jsonb NOT NULL,
  applies_to     text NOT NULL CHECK (applies_to IN ('every', 'any')),
  severity       text NOT NULL DEFAULT 'medium' CHECK (severity IN ('low', 'medium', 'high')),
  created_by     text NOT NULL,
  created_at     timestamptz NOT NULL DEFAULT now(),
  removed_at     timestamptz,
  removed_by     text
);
CREATE INDEX IF NOT EXISTS compliance_own_check_tenant_idx ON compliance_own_check (tenant_ref, created_at);
