-- Wave 2 FMT: Keel bundle v1 (engine/export/bundle.mjs, docs/format/keel-bundle-v1.md).
-- Additive and safe to re-apply.

-- Content items this Keel knows only by reference: imported from a bundle that named
-- them (natural key, sha256, bytes) without carrying their bytes. Items whose bytes
-- this Keel holds are in content_item; a re-export lists both, so a bundle imported
-- here exports again unchanged.
CREATE TABLE IF NOT EXISTS content_ref (
  tenant_ref   text NOT NULL,
  workload     text NOT NULL,
  container    text NOT NULL,
  item_key     text NOT NULL,
  version      text NOT NULL,
  metadata     jsonb NOT NULL DEFAULT '{}'::jsonb,
  sha256       text NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  bytes        bigint NOT NULL CHECK (bytes >= 0),
  imported_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_ref, workload, container, item_key, version)
);
