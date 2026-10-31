-- Name lookups find a saved object by its Microsoft id, app id or role template id
-- (engine/insights/names.mjs, portal/lib/portal-data.ts withRefNames, value-names).
-- Without these indexes each lookup read the payload of every saved version: on live
-- (800k versions, 1.35 GB) the Changes feed's lookup ran for more than 9 minutes and
-- the Changes list's for 3 s (operator queue Q303). The expressions match the queries
-- exactly, so a lookup reads only the versions that hold the id.
CREATE INDEX IF NOT EXISTS resource_version_object_id_idx
  ON resource_version ((lower(payload->>'id')));
CREATE INDEX IF NOT EXISTS resource_version_app_id_idx
  ON resource_version ((lower(payload->>'appId')));
CREATE INDEX IF NOT EXISTS resource_version_role_template_id_idx
  ON resource_version ((lower(payload->>'roleTemplateId')));
