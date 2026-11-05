/**
 * Issue #1007: storage of terms of use files (PDFs), once per tenant and
 * SHA-256 (agreement_file_blob). The snapshot payload names each file by its
 * hash (engine/collect/agreementFiles.mjs); the hash is recomputed here from
 * the bytes, never taken from the caller, and the bytes read back are checked
 * against it before a restore may send them.
 */
import { sha256Hex } from '../collect/agreementFiles.mjs';

/** Stores the files a snapshot read. Returns { stored, reused }. */
export async function recordAgreementFiles(client, { tenantRef, blobs }) {
  const summary = { stored: 0, reused: 0 };
  for (const blob of blobs ?? []) {
    if (!Buffer.isBuffer(blob?.bytes) || blob.bytes.length === 0) throw new Error('a terms of use file needs its bytes');
    const sha256 = sha256Hex(blob.bytes);
    const inserted = await client.query(
      `INSERT INTO agreement_file_blob (tenant_ref, sha256, size_bytes, content)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (tenant_ref, sha256) DO NOTHING
       RETURNING sha256`,
      [tenantRef, sha256, blob.bytes.length, blob.bytes],
    );
    summary[inserted.rows.length > 0 ? 'stored' : 'reused'] += 1;
  }
  return summary;
}

/** The stored files with these hashes, as a Map of sha256 to bytes; a row whose bytes do not hash to its key is left out. */
export async function loadAgreementFiles(client, { tenantRef, hashes }) {
  const wanted = [...new Set((hashes ?? []).filter((hash) => typeof hash === 'string' && /^[0-9a-f]{64}$/.test(hash)))];
  if (wanted.length === 0) return new Map();
  const { rows } = await client.query(
    'SELECT sha256, content FROM agreement_file_blob WHERE tenant_ref = $1 AND sha256 = ANY($2::text[])',
    [tenantRef, wanted],
  );
  return new Map(rows.filter((row) => sha256Hex(row.content) === row.sha256).map((row) => [row.sha256, row.content]));
}

/** The hashes of the files the agreement resources of a restore hold. */
export const agreementFileHashes = (resources) => (resources ?? [])
  .filter((resource) => resource?.resourceType === 'agreement')
  .flatMap((resource) => (Array.isArray(resource.payload?.files) ? resource.payload.files : []))
  .map((file) => file?.fileData?.sha256)
  .filter(Boolean);
