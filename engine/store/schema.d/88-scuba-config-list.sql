-- ScubaGear's config lists as a customer setting (engine/benchmarks/scubagear/config.mjs).
--
-- One row per tenant and list: the sensitive users whose names anti-phish policies
-- must protect (MS.SECURITYSUITE.2.1v1) and the partner domains they must protect
-- (MS.SECURITYSUITE.2.3v1). No row means the list is not set, and those rules read
-- "could not check". Emergency (break-glass) accounts are not kept here: they come
-- from breakglass_account. Each change is written to the audit record (evidence kind
-- 'scuba-config-list'), as counts only.
CREATE TABLE IF NOT EXISTS scuba_config_list (
  tenant_ref  text NOT NULL,
  list        text NOT NULL CHECK (list IN ('sensitive-users', 'partner-domains')),
  entries     jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(entries) = 'array'),
  updated_by  text NOT NULL,
  updated_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_ref, list)
);
