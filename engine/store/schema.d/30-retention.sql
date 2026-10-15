-- Wave 2 RET: retention policies, legal holds and prune reports (engine/store/retention.mjs).
-- Additive and safe to re-apply.
--
-- Scope, for policies and holds alike: no workload = the whole tenant; then a workload
-- ('config' for settings snapshots, else a content workload), a container in it (the
-- snapshot tier, or a mailbox, drive or site) and one item in that container (a
-- snapshot id, or a content item key).

CREATE TABLE IF NOT EXISTS retention_policy (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_ref       text NOT NULL,
  workload         text,
  container        text,
  item_key         text,
  daily            integer NOT NULL DEFAULT 0 CHECK (daily >= 0),
  weekly           integer NOT NULL DEFAULT 0 CHECK (weekly >= 0),
  monthly          integer NOT NULL DEFAULT 0 CHECK (monthly >= 0),
  yearly           integer NOT NULL DEFAULT 0 CHECK (yearly >= 0),
  keep_within_days integer NOT NULL DEFAULT 0 CHECK (keep_within_days >= 0),
  keep_forever     boolean NOT NULL DEFAULT false,
  set_by           text NOT NULL,
  set_at           timestamptz NOT NULL DEFAULT now(),
  CHECK (container IS NULL OR workload IS NOT NULL),
  CHECK (item_key IS NULL OR container IS NOT NULL),
  CHECK (keep_forever OR keep_within_days > 0 OR daily + weekly + monthly + yearly > 0)
);
CREATE UNIQUE INDEX IF NOT EXISTS retention_policy_scope_idx
  ON retention_policy (tenant_ref, (coalesce(workload, '')), (coalesce(container, '')), (coalesce(item_key, '')));

-- An active hold (released_at IS NULL) keeps everything in its scope from prune.
CREATE TABLE IF NOT EXISTS legal_hold (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_ref     text NOT NULL,
  workload       text,
  container      text,
  item_key       text,
  reason         text NOT NULL CHECK (btrim(reason) <> ''),
  placed_by      text NOT NULL,
  placed_at      timestamptz NOT NULL DEFAULT now(),
  released_at    timestamptz,
  released_by    text,
  release_reason text,
  CHECK (container IS NULL OR workload IS NOT NULL),
  CHECK (item_key IS NULL OR container IS NOT NULL),
  CHECK (released_at IS NULL OR (released_by IS NOT NULL AND btrim(coalesce(release_reason, '')) <> ''))
);
CREATE INDEX IF NOT EXISTS legal_hold_active_idx ON legal_hold (tenant_ref) WHERE released_at IS NULL;

-- Every prune run, dry or not, writes what goes, what stays and why before it deletes.
CREATE TABLE IF NOT EXISTS retention_prune_report (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_ref         text NOT NULL,
  mode               text NOT NULL CHECK (mode IN ('dry-run', 'apply')),
  created_at         timestamptz NOT NULL DEFAULT now(),
  snapshots_deleted  integer NOT NULL,
  versions_deleted   integer NOT NULL,
  chunks_deleted     integer NOT NULL,
  report             jsonb NOT NULL
);
CREATE INDEX IF NOT EXISTS retention_prune_report_tenant_idx ON retention_prune_report (tenant_ref, created_at);
