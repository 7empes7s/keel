/**
 * Gap register M6: storage of the company branding files a snapshot observed.
 *
 * Same shape as the relationship observations (relationship_edge_set): one row
 * per snapshot, locale and file, tenant_ref repeated on every row so each read
 * is qualified by tenant. The bytes live once per tenant and SHA-256 in
 * branding_asset_blob, so a file that did not change since the last snapshot
 * is not stored again. The hash is recomputed here from the bytes, never taken
 * from the caller.
 */
import { createHash } from 'node:crypto';

const OUTCOMES = new Set(['present', 'absent', 'too-large', 'failed']);

function sha256Hex(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

/**
 * Records one snapshot's file observations. Returns counts per outcome plus
 * `stored` (new file contents written) and `reused` (contents already held for
 * this tenant, so nothing was written).
 */
export async function recordBrandingAssets(client, { snapshotId, tenantRef, observations }) {
  const summary = { present: 0, absent: 0, 'too-large': 0, failed: 0, stored: 0, reused: 0 };
  for (const obs of observations ?? []) {
    if (!OUTCOMES.has(obs?.outcome)) throw new Error(`invalid branding file outcome: ${obs?.outcome}`);
    summary[obs.outcome] += 1;
    let sha256 = null;
    let size = null;
    if (obs.outcome === 'present') {
      if (!Buffer.isBuffer(obs.bytes) || obs.bytes.length === 0) throw new Error(`${obs.locale}/${obs.asset}: a present file needs its bytes`);
      sha256 = sha256Hex(obs.bytes);
      size = obs.bytes.length;
      const inserted = await client.query(
        `INSERT INTO branding_asset_blob (tenant_ref, sha256, size_bytes, content)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (tenant_ref, sha256) DO NOTHING
         RETURNING sha256`,
        [tenantRef, sha256, size, obs.bytes],
      );
      summary[inserted.rows.length > 0 ? 'stored' : 'reused'] += 1;
    }
    await client.query(
      `INSERT INTO branding_asset
         (snapshot_id, tenant_ref, locale, asset, outcome, sha256, size_bytes, content_type, http_status, error)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [
        snapshotId, tenantRef, obs.locale, obs.asset, obs.outcome, sha256, size,
        obs.outcome === 'present' ? (obs.contentType ?? null) : null,
        Number.isInteger(obs.httpStatus) ? obs.httpStatus : null,
        obs.error ?? null,
      ],
    );
  }
  return summary;
}

/**
 * The file observations of one snapshot, optionally only for some locales,
 * each 'present' one with its bytes. Ordered by locale, then file.
 */
export async function loadSnapshotBrandingAssets(client, { snapshotId, locales = null }) {
  const { rows } = await client.query(
    `SELECT a.locale, a.asset, a.outcome, a.sha256, a.size_bytes, a.content_type, a.http_status, a.error, b.content
     FROM branding_asset a
     JOIN snapshot s ON s.id = a.snapshot_id AND s.tenant_ref = a.tenant_ref
     LEFT JOIN branding_asset_blob b ON b.tenant_ref = a.tenant_ref AND b.sha256 = a.sha256
     WHERE a.snapshot_id = $1
       AND ($2::text[] IS NULL OR a.locale = ANY($2::text[]))
     ORDER BY a.locale, a.asset`,
    [snapshotId, locales],
  );
  return rows.map((row) => ({
    locale: row.locale,
    asset: row.asset,
    outcome: row.outcome,
    sha256: row.sha256,
    size: row.size_bytes,
    contentType: row.content_type,
    httpStatus: row.http_status,
    error: row.error,
    bytes: row.content ?? null,
  }));
}
