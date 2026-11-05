-- Issue #1007: terms of use files (PDFs). The bytes are stored once per tenant and
-- content hash; each agreement's snapshot payload names its files by that hash
-- (fileData { sha256, size }), so a changed PDF is a changed payload. Additive and
-- retry-safe.
CREATE TABLE IF NOT EXISTS agreement_file_blob (
  tenant_ref  text NOT NULL,
  sha256      text NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  size_bytes  int NOT NULL CHECK (size_bytes >= 0),
  content     bytea NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_ref, sha256)
);
