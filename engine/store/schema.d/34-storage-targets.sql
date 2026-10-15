-- Wave 2 STORE: one row per copy of a backup artifact on a storage target
-- (engine/storage/targets.mjs recordShipment). A shipment to N targets writes N rows
-- with the same artifact and shipment status, so a partial shipment shows exactly
-- which target lacks a verified copy. No credentials: target_id is the configured id.
-- Additive and safe to re-apply.
CREATE TABLE IF NOT EXISTS storage_copy (
  id               bigserial PRIMARY KEY,
  artifact_name    text NOT NULL,
  artifact_sha256  text NOT NULL CHECK (artifact_sha256 ~ '^[0-9a-f]{64}$'),
  artifact_bytes   bigint NOT NULL CHECK (artifact_bytes >= 0),
  target_id        text NOT NULL,
  provider         text NOT NULL,
  shipment_status  text NOT NULL CHECK (shipment_status IN ('complete', 'partial', 'failed')),
  verified         boolean NOT NULL,
  published        text NOT NULL CHECK (published IN ('published', 'already-present', 'error')),
  immutability     text NOT NULL,
  failures         jsonb NOT NULL DEFAULT '[]'::jsonb,
  shipped_at       timestamptz NOT NULL,
  recorded_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS storage_copy_artifact_idx ON storage_copy (artifact_sha256, target_id);
CREATE INDEX IF NOT EXISTS storage_copy_target_idx ON storage_copy (target_id, shipped_at DESC);
