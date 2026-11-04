-- A Graph restore dry run made with the tenant-wide option
-- (keel-restore --allow-tenant-wide-test-writes): on the test tenant it lets a
-- record marked tenantWide be planned and written. Bound into the digest, and
-- its promotion passes it on to the writers. Off for every other dry run.
ALTER TABLE restore_dry_run ADD COLUMN IF NOT EXISTS allow_tenant_wide boolean NOT NULL DEFAULT false;
