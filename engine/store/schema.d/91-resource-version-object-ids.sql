-- Name lookups find a saved object by its Microsoft id, app id or role template id
-- (engine/insights/names.mjs, portal/lib/portal-data.ts withRefNames, value-names).
-- Without these indexes each lookup read the payload of every saved version: on live
-- (800k versions, 1.35 GB) the Changes feed's lookup ran for more than 9 minutes and
-- the Changes list's for 3 s (operator queue Q303). The expressions match the queries
-- exactly, so a lookup reads only the versions that hold the id.
-- The backup is the second column, so a lookup limited to some backups (the Changes
-- list names ids from the backups that saw the changes) skips every other version
-- without reading it (operator queue Q305). A lookup by id alone still uses them.
CREATE INDEX IF NOT EXISTS resource_version_object_id_snapshot_idx
  ON resource_version ((lower(payload->>'id')), snapshot_id);
CREATE INDEX IF NOT EXISTS resource_version_app_id_snapshot_idx
  ON resource_version ((lower(payload->>'appId')), snapshot_id);
CREATE INDEX IF NOT EXISTS resource_version_role_template_id_snapshot_idx
  ON resource_version ((lower(payload->>'roleTemplateId')), snapshot_id);
-- The single-column indexes these replace (first shipped in this file).
DROP INDEX IF EXISTS resource_version_object_id_idx;
DROP INDEX IF EXISTS resource_version_app_id_idx;
DROP INDEX IF EXISTS resource_version_role_template_id_idx;
