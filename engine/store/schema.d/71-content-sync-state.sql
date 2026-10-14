-- Wave 1 content wiring: where the content collectors keep their delta state between
-- nightly runs (engine/content/syncState.mjs). One row per tenant, workload and state
-- key: a mailbox, a OneDrive or a SharePoint library. The state is the collector's own
-- plain JSON (delta links, cursors). Losing a row only costs a full re-read. Additive
-- and safe to re-apply.
CREATE TABLE IF NOT EXISTS content_sync_state (
  tenant_ref  text NOT NULL,
  workload    text NOT NULL,
  state_key   text NOT NULL,
  state       jsonb NOT NULL,
  updated_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_ref, workload, state_key)
);
