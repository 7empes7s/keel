-- The approved setup for service settings (Exchange, SharePoint and OneDrive, Teams,
-- Purview, Power Platform): the value each resource of a workload is approved to have
-- (engine/govern/workloadApproved.mjs). Workload drift compares each read with it, the
-- way configuration drift compares a snapshot with the active baseline, so Accept adds
-- a change here and Undo puts the approved value back through the workload restore.
--
-- workload_approved_setup: one row per tenant and workload once its approved setup
-- exists, naming the read it was first taken from.
-- workload_approved: one row per approved resource. `collection_id` is the read that
-- holds the approved value, which an undo restores from. Additive and safe to re-apply.
CREATE TABLE IF NOT EXISTS workload_approved_setup (
  tenant_ref   text NOT NULL,
  workload     text NOT NULL,
  seeded_from  uuid NOT NULL REFERENCES workload_collection(id),
  seeded_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_ref, workload)
);

CREATE TABLE IF NOT EXISTS workload_approved (
  tenant_ref     text NOT NULL,
  workload       text NOT NULL,
  resource_key   text NOT NULL,
  fields         jsonb NOT NULL DEFAULT '{}'::jsonb,
  field_coverage jsonb NOT NULL DEFAULT '{}'::jsonb,
  collection_id  uuid NOT NULL REFERENCES workload_collection(id),
  approved_by    text,
  reason         text,
  approved_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_ref, workload, resource_key)
);

-- Whether a workload_drift row compares a read with the approved setup ('approved') or,
-- for rows recorded before the approved setup existed, with the read before it.
ALTER TABLE workload_drift ADD COLUMN IF NOT EXISTS compared_with text NOT NULL DEFAULT 'previous';
CREATE INDEX IF NOT EXISTS workload_drift_resource_idx ON workload_drift (tenant_ref, workload, resource_key, detected_at DESC);
