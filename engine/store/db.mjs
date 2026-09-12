import pg from 'pg';
import { canonicalHash, HASH_VERSION } from '../cir/canonicalHash.mjs';

export async function connect(url) {
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  return client;
}

export async function createSnapshot(client, { tenantRef }) {
  const { rows } = await client.query(
    `INSERT INTO snapshot (tenant_ref) VALUES ($1) RETURNING id`,
    [tenantRef],
  );
  return rows[0].id;
}

export async function completeSnapshot(client, { id, status, coverageDigest }) {
  await client.query(
    `UPDATE snapshot SET status = $2, coverage_digest = $3, completed_at = now() WHERE id = $1`,
    [id, status, coverageDigest ?? null],
  );
}

export async function insertResourceVersion(client, { snapshotId, resource }) {
  const payloadHash =
    resource.payloadHash ?? canonicalHash(resource.payload, resource.resourceType);
  const { rows } = await client.query(
    `INSERT INTO resource_version
       (snapshot_id, natural_key, resource_type, payload, payload_hash, hash_version, criticality, blast_radius, fidelity, provenance)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
     RETURNING id`,
    [
      snapshotId, resource.naturalKey, resource.resourceType, resource.payload, payloadHash, HASH_VERSION,
      resource.criticality, resource.blastRadius, resource.fidelity, resource.provenance,
    ],
  );
  return rows[0].id;
}

export async function insertReferences(client, { fromVersion, references }) {
  for (const ref of references) {
    await client.query(
      `INSERT INTO resource_reference (from_version, field_path, to_symbol, required)
       VALUES ($1,$2,$3,$4)`,
      [fromVersion, ref.field, ref.symbol, ref.required],
    );
  }
}

export async function getLatestSnapshot(client, { tenantRef }) {
  const { rows } = await client.query(
    `SELECT * FROM snapshot
     WHERE tenant_ref = $1
       AND status = 'complete'
       AND completed_at IS NOT NULL
     ORDER BY completed_at DESC, started_at DESC, id DESC
     LIMIT 1`,
    [tenantRef],
  );
  return rows[0] ?? null;
}

export async function getResourceVersions(client, { snapshotId }) {
  const { rows } = await client.query(
    `SELECT * FROM resource_version WHERE snapshot_id = $1`,
    [snapshotId],
  );
  return rows;
}

export async function getReferences(client, { snapshotId }) {
  const { rows } = await client.query(
    `SELECT rr.* FROM resource_reference rr
     JOIN resource_version rv ON rv.id = rr.from_version
     WHERE rv.snapshot_id = $1`,
    [snapshotId],
  );
  return rows;
}
