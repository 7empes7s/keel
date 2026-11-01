-- The Changes list names the ids each change points to from the backups that saw the
-- changes (portal/lib/portal-data.ts withRefNames). With the backup as the second
-- column, that limit is checked in the index, so only the versions that hold a wanted
-- id in one of those backups are read. Before, the planner read every version in those
-- backups and unpacked each payload: 3 to 4 s on live (operator queue Q305, backlog 41).
-- PR #901 (the Changes feed, backlog 40) adds the first two in its own fragment 92 with
-- the same names and definitions; IF NOT EXISTS makes either merge order safe.
CREATE INDEX IF NOT EXISTS resource_version_object_id_snapshot_idx
  ON resource_version ((lower(payload->>'id')), snapshot_id);
CREATE INDEX IF NOT EXISTS resource_version_app_id_snapshot_idx
  ON resource_version ((lower(payload->>'appId')), snapshot_id);
CREATE INDEX IF NOT EXISTS resource_version_role_template_id_snapshot_idx
  ON resource_version ((lower(payload->>'roleTemplateId')), snapshot_id);
