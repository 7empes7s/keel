-- Workload drift: a change between two workload collections of the same workload
-- (engine/govern/workloadDrift.mjs). Configuration drift (the drift table) compares a
-- snapshot with the active baseline; workload settings have no baseline, so each run
-- is compared with the previous usable run of the same workload. One row per changed
-- resource per run; re-detecting a run cannot double it. Additive and safe to re-apply.
CREATE TABLE IF NOT EXISTS workload_drift (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_ref             text NOT NULL,
  workload               text NOT NULL,
  collection_id          uuid NOT NULL REFERENCES workload_collection(id) ON DELETE CASCADE,
  previous_collection_id uuid NOT NULL REFERENCES workload_collection(id) ON DELETE CASCADE,
  resource_key           text NOT NULL,
  change_type            text NOT NULL CHECK (change_type IN ('added','modified','removed')),
  fields                 jsonb NOT NULL DEFAULT '[]'::jsonb,
  blast_radius           text NOT NULL,
  detected_at            timestamptz NOT NULL DEFAULT now(),
  UNIQUE (collection_id, resource_key)
);
CREATE INDEX IF NOT EXISTS workload_drift_tenant_idx ON workload_drift (tenant_ref, workload, detected_at DESC);
