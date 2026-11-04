-- Object id, app id and role template id indexes with the backup as the second column,
-- so a lookup limited to some backups checks that limit inside the index and reads only
-- the versions that hold a wanted id. The id-only indexes from fragment 91 stay; other
-- lookups use them. Plain (not concurrent) builds, like fragment 91: writes to
-- resource_version wait a few seconds the first time this is applied.
--
-- Users:
-- - engine/insights/names.mjs (the Changes feed's name lookup, backlog 40): probes which
--   backups hold an id, newest first, then reads only that backup's version. Before, it
--   read every saved version twice: 11.5 s on live (operator queue Q305).
-- - portal/lib/portal-data.ts withRefNames (the Changes list, backlog 41): names the ids
--   a change points to from the backups that saw the changes. Before, the planner read
--   every version in those backups and unpacked each payload: 3 to 4 s on live.
CREATE INDEX IF NOT EXISTS resource_version_object_id_snapshot_idx
  ON resource_version ((lower(payload->>'id')), snapshot_id);
CREATE INDEX IF NOT EXISTS resource_version_app_id_snapshot_idx
  ON resource_version ((lower(payload->>'appId')), snapshot_id);
CREATE INDEX IF NOT EXISTS resource_version_role_template_id_snapshot_idx
  ON resource_version ((lower(payload->>'roleTemplateId')), snapshot_id);
-- The name lookup walks a tenant's backups newest first until one holds the object.
CREATE INDEX IF NOT EXISTS snapshot_tenant_started_idx ON snapshot (tenant_ref, started_at DESC);
