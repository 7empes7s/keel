-- One row per content workload per nightly content backup run (cli/keel-content-collect.mjs).
-- The content index (70-content.sql) says what is stored; this says when each workload was
-- last read and whether the read succeeded, so freshness and reports can count content
-- backups beside the settings backups (engine/coverage/serviceBackups.mjs). Additive and
-- safe to re-apply.
CREATE TABLE IF NOT EXISTS content_run (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_ref    text NOT NULL,
  workload      text NOT NULL,
  outcome       text NOT NULL,
  items         bigint NOT NULL DEFAULT 0,
  bytes         bigint NOT NULL DEFAULT 0,
  reasons       jsonb NOT NULL DEFAULT '[]'::jsonb,
  -- The content scope's name prefix for this run (KEEL-RT- for test fixtures); null is the whole tenant.
  name_prefix   text,
  started_at    timestamptz NOT NULL,
  completed_at  timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS content_run_latest_idx ON content_run (tenant_ref, workload, completed_at DESC);
