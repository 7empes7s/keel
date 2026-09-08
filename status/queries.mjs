import { OPEN_DRIFT_PREDICATE } from '../engine/store/openDrift.mjs';
import { verifyChain } from '../engine/govern/evidence.mjs';
import { TYPE_COVERAGE_CTES, readCoverageOutcome } from '../engine/coverage/snapshots.mjs';

async function getLatestSnapshotMeta(client, { tenantRef }) {
  const { rows } = await client.query(
    `SELECT id, completed_at, status
     FROM snapshot
     WHERE tenant_ref = $1
     ORDER BY started_at DESC
     LIMIT 1`,
    [tenantRef],
  );
  return rows[0] ?? null;
}

export async function getResourceCounts(client, { tenantRef }) {
  const { rows } = await client.query(
    `WITH ${TYPE_COVERAGE_CTES}
     SELECT t.resource_type, t.completed_at, t.coverage_entry, count(rv.id)::int AS n
     FROM latest_type_coverage t
     LEFT JOIN resource_version rv
       ON rv.snapshot_id = t.snapshot_id AND rv.resource_type = t.resource_type
     GROUP BY t.resource_type, t.completed_at, t.coverage_entry
     ORDER BY t.resource_type`,
    [tenantRef],
  );
  const byType = rows.map((r) => ({
    resourceType: r.resource_type,
    // Unknown cardinality after a failed read is not a completed empty read.
    count: readCoverageOutcome(r.coverage_entry).covered ? r.n : null,
    asOf: r.completed_at,
  }));
  // Retain the aggregate timestamp only when all counts share it.
  const commonAsOf = byType[0]?.asOf ?? null;
  return {
    byType,
    asOf: byType.every((t) => t.asOf.getTime() === commonAsOf.getTime()) ? commonAsOf : null,
  };
}

export async function getBaselineInfo(client, { tenantRef }) {
  const { rows } = await client.query(
    'SELECT set_at FROM baseline WHERE tenant_ref = $1 AND active = true LIMIT 1',
    [tenantRef],
  );
  return rows[0] ? { setAt: rows[0].set_at } : null;
}

export async function getOpenDriftCounts(client, { tenantRef }) {
  const { rows } = await client.query(
    `SELECT d.change_type, d.blast_radius, count(*)::int AS n
     FROM drift d
     WHERE d.tenant_ref = $1
       AND ${OPEN_DRIFT_PREDICATE}
     GROUP BY d.change_type, d.blast_radius`,
    [tenantRef],
  );
  return rows.map((r) => ({ changeType: r.change_type, blastRadius: r.blast_radius, count: r.n }));
}

export async function getLastCollection(client, { tenantRef }) {
  const snapshot = await getLatestSnapshotMeta(client, { tenantRef });
  return snapshot ? { completedAt: snapshot.completed_at, status: snapshot.status } : null;
}

export async function getEvidenceIntegrity(client, { tenantRef }) {
  const result = await verifyChain(client, { tenantRef });
  const { rows } = await client.query(
    'SELECT record_count FROM evidence_head WHERE tenant_ref = $1',
    [tenantRef],
  );
  return { ok: result.ok, chainLength: rows[0] ? Number(rows[0].record_count) : 0 };
}

export async function getRecentDispositionCounts(client, { tenantRef, days = 7 }) {
  const { rows } = await client.query(
    `SELECT dsp.action, count(*)::int AS n
     FROM disposition dsp
     JOIN drift d ON d.id = dsp.drift_id
     WHERE d.tenant_ref = $1
       AND dsp.decided_at > now() - ($2 || ' days')::interval
     GROUP BY dsp.action`,
    [tenantRef, String(days)],
  );
  return rows.map((r) => ({ action: r.action, count: r.n }));
}

export async function collectGovernance(client, { tenantRef }) {
  const resourceCounts = await getResourceCounts(client, { tenantRef });
  const baseline = await getBaselineInfo(client, { tenantRef });
  const openDrift = await getOpenDriftCounts(client, { tenantRef });
  const lastCollection = await getLastCollection(client, { tenantRef });
  const evidence = await getEvidenceIntegrity(client, { tenantRef });
  const recentDispositions = await getRecentDispositionCounts(client, { tenantRef });
  return { resourceCounts, baseline, openDrift, lastCollection, evidence, recentDispositions };
}
