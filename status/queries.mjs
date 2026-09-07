import { OPEN_DRIFT_PREDICATE } from '../engine/store/openDrift.mjs';
import { getActiveBaseline } from '../engine/store/governance.mjs';
import { getLatestSnapshot } from '../engine/store/db.mjs';
import { verifyChain } from '../engine/govern/evidence.mjs';

export async function getResourceCounts(client, { tenantRef }) {
  const snapshot = await getLatestSnapshot(client, { tenantRef });
  if (!snapshot) return { byType: [], asOf: null };
  const { rows } = await client.query(
    `SELECT resource_type, count(*)::int AS n
     FROM resource_version
     WHERE snapshot_id = $1
     GROUP BY resource_type
     ORDER BY resource_type`,
    [snapshot.id],
  );
  return {
    byType: rows.map((r) => ({ resourceType: r.resource_type, count: r.n })),
    asOf: snapshot.completed_at,
  };
}

export async function getBaselineInfo(client, { tenantRef }) {
  const baseline = await getActiveBaseline(client, { tenantRef });
  return baseline ? { setAt: baseline.set_at } : null;
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
  const snapshot = await getLatestSnapshot(client, { tenantRef });
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
  const [resourceCounts, baseline, openDrift, lastCollection, evidence, recentDispositions] =
    await Promise.all([
      getResourceCounts(client, { tenantRef }),
      getBaselineInfo(client, { tenantRef }),
      getOpenDriftCounts(client, { tenantRef }),
      getLastCollection(client, { tenantRef }),
      getEvidenceIntegrity(client, { tenantRef }),
      getRecentDispositionCounts(client, { tenantRef }),
    ]);
  return { resourceCounts, baseline, openDrift, lastCollection, evidence, recentDispositions };
}
