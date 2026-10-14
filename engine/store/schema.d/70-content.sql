-- Wave 1 CONT: the content store's index (engine/content/index.mjs).
-- The bytes live on the storage adapter as encrypted chunks; these tables say which
-- chunks exist and which items they make up. Additive and safe to re-apply.

-- One row per stored chunk. id is the keyed hash (HMAC-SHA-256) of the chunk's plaintext,
-- so a chunk is stored once however many items share it.
CREATE TABLE IF NOT EXISTS content_chunk (
  id            text PRIMARY KEY CHECK (id ~ '^[0-9a-f]{64}$'),
  key_id        text NOT NULL,
  object_name   text NOT NULL,
  plain_bytes   integer NOT NULL CHECK (plain_bytes > 0),
  stored_bytes  integer NOT NULL CHECK (stored_bytes > 0),
  created_at    timestamptz NOT NULL DEFAULT now()
);

-- One row per item version. chunks is the ordered list of [chunk id, plaintext bytes];
-- new_bytes is what this put added to storage (0 when every chunk was already held).
CREATE TABLE IF NOT EXISTS content_item (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_ref  text NOT NULL,
  workload    text NOT NULL,
  container   text NOT NULL,
  item_key    text NOT NULL,
  version     text NOT NULL,
  metadata    jsonb NOT NULL DEFAULT '{}'::jsonb,
  sha256      text NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  bytes       bigint NOT NULL CHECK (bytes >= 0),
  chunks      jsonb NOT NULL,
  key_id      text NOT NULL,
  new_bytes   bigint NOT NULL DEFAULT 0,
  -- Milliseconds, so a listed item's createdAt (a JS Date) is the exact stored value and
  -- the (created_at, id) paging cursor compares equal to it.
  created_at  timestamptz NOT NULL DEFAULT date_trunc('milliseconds', clock_timestamp()),
  UNIQUE (tenant_ref, workload, container, item_key, version)
);
CREATE INDEX IF NOT EXISTS content_item_container_created_idx ON content_item (container, created_at, id);
