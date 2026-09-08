/**
 * Coverage report builder (spec §6). Returns a plain data structure — no HTML,
 * no rendering; presentation belongs to the portal lane.
 *
 * Three anti-overclaim mechanisms are enforced here, non-negotiably:
 *
 * 1. A type is 'covered' only when its last completed collection returned a
 *    NON-ZERO item count. Zero items reports 'failed', not covered — a missing
 *    OAuth scope makes Graph return an empty 200, which is indistinguishable
 *    from "the tenant has none of these" unless we refuse to call it coverage
 *    (spec §11.3).
 * 2. Every catalog entry is enumerated. An entry with no registered descriptor
 *    renders explicitly as 'not-covered' — the report lists the unknown, not
 *    just the known.
 * 3. fidelity is DECLARED metadata from the descriptor. It is reported as
 *    { declared, verifiedBy }, and verifiedBy stays null until a restore drill
 *    writes measured fidelity back as evidence. A declared 'full' is never
 *    presented as verified.
 */

const DRILL_EVIDENCE_KIND = 'fidelity-drill';

export async function buildCoverageReport(client, { tenantRef, catalog, descriptors, now }) {
  const generatedAt = (now ?? new Date()).toISOString();
  const snapshot = await latestCompletedSnapshot(client, tenantRef);
  const digest = snapshot?.coverage_digest ?? null;
  const drillEvidence = await loadDrillEvidence(client, tenantRef);

  const descriptorByType = new Map(descriptors.map((d) => [d.type, d]));
  const types = [];

  for (const descriptor of descriptors) {
    types.push(coveredEntry(descriptor, snapshot, digest, drillEvidence.get(descriptor.type)));
  }
  for (const entry of catalog) {
    if (descriptorByType.has(entry.type)) continue;
    types.push({
      type: entry.type,
      status: 'not-covered',
      covered: false,
      itemCount: null,
      lastCollectedAt: null,
      adapter: null,
      fidelity: null,
      criticality: entry.criticality ?? null,
      blastRadius: entry.blastRadius ?? null,
      remappable: null,
    });
  }

  return {
    tenantRef,
    generatedAt,
    snapshot: snapshot
      ? {
          id: snapshot.id,
          status: snapshot.status,
          startedAt: snapshot.started_at,
          completedAt: snapshot.completed_at,
        }
      : null,
    types,
    summary: {
      covered: types.filter((t) => t.status === 'covered').length,
      failed: types.filter((t) => t.status === 'failed').length,
      notCovered: types.filter((t) => t.status === 'not-covered').length,
      neverCollected: types.filter((t) => t.status === 'never-collected').length,
    },
  };
}

function coveredEntry(descriptor, snapshot, digest, drill) {
  const lastCollectedAt = snapshot?.completed_at ?? null;
  let status;
  let itemCount = null;
  if (!snapshot) {
    status = 'never-collected';
  } else {
    itemCount = digest?.[descriptor.type] ?? 0;
    // Anti-overclaim: a completed collection that yielded zero items for this
    // type (or omitted it from the digest entirely) is FAILED coverage.
    status = itemCount > 0 ? 'covered' : 'failed';
  }
  return {
    type: descriptor.type,
    status,
    covered: status === 'covered',
    itemCount,
    lastCollectedAt,
    adapter: descriptor.adapter,
    fidelity: {
      declared: descriptor.fidelity,
      verifiedBy: drill
        ? { kind: drill.kind, at: drill.occurred_at, measuredFidelity: drill.subject.measuredFidelity }
        : null,
    },
    criticality: descriptor.criticality,
    blastRadius: descriptor.blastRadius,
    remappable: descriptor.remappable,
  };
}

async function latestCompletedSnapshot(client, tenantRef) {
  const { rows } = await client.query(
    `SELECT id, status, started_at, completed_at, coverage_digest
       FROM snapshot
      WHERE tenant_ref = $1 AND status = 'complete' AND completed_at IS NOT NULL
      ORDER BY completed_at DESC
      LIMIT 1`,
    [tenantRef],
  );
  return rows[0] ?? null;
}

/** Latest fidelity-drill evidence per resource type, if any drill has run. */
async function loadDrillEvidence(client, tenantRef) {
  const { rows } = await client.query(
    `SELECT DISTINCT ON (subject->>'resourceType') kind, occurred_at, subject
       FROM evidence
      WHERE tenant_ref = $1 AND kind = $2
      ORDER BY subject->>'resourceType', occurred_at DESC`,
    [tenantRef, DRILL_EVIDENCE_KIND],
  );
  return new Map(rows.map((row) => [row.subject.resourceType, row]));
}
