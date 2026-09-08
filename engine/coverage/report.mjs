/**
 * Coverage report builder (spec §6). Returns a plain data structure — no HTML,
 * no rendering; presentation belongs to the portal lane.
 *
 * Three anti-overclaim mechanisms are enforced here, non-negotiably:
 *
 * 1. A type is 'covered' only with an explicit completed outcome and a valid
 *    count (including zero). Missing/failed outcomes stay failed. Historical
 *    numeric digests retain their old non-zero-only meaning: they cannot
 *    prove a completed empty read.
 * 2. Every catalog entry is enumerated. An entry with no registered descriptor
 *    renders explicitly as 'not-covered' — the report lists the unknown, not
 *    just the known.
 * 3. fidelity is DECLARED metadata from the descriptor. It is reported as
 *    { declared, verifiedBy }, and verifiedBy stays null until a restore drill
 *    writes measured fidelity back as evidence. A declared 'full' is never
 *    presented as verified.
 */

import { TYPE_COVERAGE_CTES, readCoverageOutcome } from './snapshots.mjs';

const DRILL_EVIDENCE_KIND = 'fidelity-drill';
const STALE_AFTER_MS = {
  tier1: 3 * 60 * 60 * 1000,
  tier2: 3 * 24 * 60 * 60 * 1000,
  tier3: 3 * 7 * 24 * 60 * 60 * 1000,
};

export async function buildCoverageReport(client, { tenantRef, catalog, descriptors, now }) {
  const generatedAt = (now ?? new Date()).toISOString();
  const { snapshot, byType } = await latestCompletedSnapshots(client, tenantRef);
  const drillEvidence = await loadDrillEvidence(client, tenantRef);

  const descriptorByType = new Map(descriptors.map((d) => [d.type, d]));
  const types = [];

  for (const descriptor of descriptors) {
    types.push(coveredEntry(descriptor, byType.get(descriptor.type), drillEvidence.get(descriptor.type), generatedAt));
  }
  for (const entry of catalog) {
    if (descriptorByType.has(entry.type)) continue;
    types.push({
      type: entry.type,
      status: 'not-covered',
      covered: false,
      stale: false,
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
      stale: types.filter((t) => t.stale).length,
    },
  };
}

function coveredEntry(descriptor, observation, drill, generatedAt) {
  const lastCollectedAt = observation?.completed_at ?? null;
  let status;
  let itemCount = null;
  if (!observation) {
    status = 'never-collected';
  } else {
    const outcome = readCoverageOutcome(observation.coverage_entry);
    itemCount = outcome.itemCount;
    status = outcome.covered ? 'covered' : 'failed';
  }
  return {
    type: descriptor.type,
    status,
    covered: status === 'covered',
    // No observation has no age; its never-collected status carries that gap.
    // Freshness is independent of outcome and does not change status counts.
    stale: lastCollectedAt !== null
      && new Date(generatedAt) - new Date(lastCollectedAt) > STALE_AFTER_MS[descriptor.criticality],
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

async function latestCompletedSnapshots(client, tenantRef) {
  const { rows } = await client.query(
    `WITH ${TYPE_COVERAGE_CTES}
     SELECT latest.id, latest.status, latest.started_at, latest.completed_at,
            t.resource_type, t.coverage_entry, t.completed_at AS type_completed_at
     FROM (
       SELECT id, status, started_at, completed_at FROM completed_snapshots
       ORDER BY completed_at DESC, started_at DESC, id DESC LIMIT 1
     ) latest
     LEFT JOIN latest_type_coverage t ON true`,
    [tenantRef],
  );
  return {
    snapshot: rows[0] ?? null,
    byType: new Map(rows.filter((row) => row.resource_type !== null).map((row) => [row.resource_type, {
      coverage_entry: row.coverage_entry, completed_at: row.type_completed_at,
    }])),
  };
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
