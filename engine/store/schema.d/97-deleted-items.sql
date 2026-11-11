-- Issue #1076: the deleted users, groups, apps and Conditional Access policies each
-- backup lists, so the Changes list can say until when a removed one can be recovered
-- (deleted date + 30 days). One row per deleted object, refreshed by every listing
-- that names it; deleted_item_read holds each type's latest complete listing, and an
-- object is still deleted only while that listing named it. The snapshot ids carry no
-- foreign key, so pruning an old backup never trips on them. Additive and retry-safe.
CREATE TABLE IF NOT EXISTS deleted_item_read (
  tenant_ref    text NOT NULL,
  resource_type text NOT NULL,
  snapshot_id   uuid NOT NULL,
  read_at       timestamptz NOT NULL,
  PRIMARY KEY (tenant_ref, resource_type)
);
CREATE TABLE IF NOT EXISTS deleted_item (
  tenant_ref       text NOT NULL,
  resource_type    text NOT NULL,
  source_id        text NOT NULL,
  deleted_at       timestamptz,
  last_snapshot_id uuid NOT NULL,
  PRIMARY KEY (tenant_ref, resource_type, source_id)
);
