-- Name lookups (engine/insights/names.mjs) ask which backups hold an object id or app id,
-- then read only the newest backup's version. With the backup in the index, that first
-- step reads the index alone, never a saved payload, and the second is one exact read.
-- Before this, the Changes feed's lookup of about 500 ids read every saved version twice:
-- 11.5 s on live (operator queue Q305, backlog 40). The id-only indexes from fragment 91
-- stay; other lookups use them.
CREATE INDEX IF NOT EXISTS resource_version_object_id_snapshot_idx
  ON resource_version ((lower(payload->>'id')), snapshot_id);
CREATE INDEX IF NOT EXISTS resource_version_app_id_snapshot_idx
  ON resource_version ((lower(payload->>'appId')), snapshot_id);
-- The same lookups walk a tenant's backups newest first until one holds the object.
CREATE INDEX IF NOT EXISTS snapshot_tenant_started_idx ON snapshot (tenant_ref, started_at DESC);
