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
 *
 * A fourth mechanism (roadmap task-54) prevents a declared 'full' fidelity
 * badge from reading as unconditionally complete: every entry also carries
 * irrecoverableFields (fields Graph itself owns and no write path can ever
 * restore, from engine/cir/serverOwned.mjs's existing registry — never
 * re-derived here), a declared endpoint/version distinct from the measured
 * one a collection observed, and an honestly-unknown relationshipCompleteness
 * until a future task actually collects relationship/edge observations.
 * Cross-type window comparison stays reportObservationWindows()'s job below
 * (task-45): grouping by exact window, never a blanket "simultaneous"
 * verdict — real per-type collection timestamps differ down to the
 * millisecond even within one run, so a boolean simultaneity claim across
 * the whole report would misreport reality far more often than not.
 */

import { TYPE_COVERAGE_CTES, readCoverageOutcome, readOutcome, readOutcomeDetail, readTypeObservation } from './snapshots.mjs';
import { OBSERVATION_CONTRACT_VERSION } from '../contracts/observation.mjs';
import { capabilitySummaryFor } from './capabilities.mjs';
import { qualificationFor } from './qualification.mjs';
import { diagnoseFailure } from './diagnosis.mjs';
import { loadRelationshipState, summarizeRelationshipState } from '../collect/relationships.mjs';
import { SERVER_OWNED, SERVER_OWNED_ALWAYS } from '../cir/serverOwned.mjs';
import { listWorkloads } from '../collect/registry.mjs';
// Registers the SharePoint workload adapter (task-102) so its coverage is reported.
import '../collect/workloads/sharepoint.mjs';

const DRILL_EVIDENCE_KIND = 'fidelity-drill';
const STALE_AFTER_MS = {
  tier1: 3 * 60 * 60 * 1000,
  tier2: 3 * 24 * 60 * 60 * 1000,
  tier3: 3 * 7 * 24 * 60 * 60 * 1000,
};

export async function buildCoverageReport(client, { tenantRef, catalog, descriptors, now }) {
  const generatedAt = (now ?? new Date()).toISOString();
  const { snapshot, byType, latestDigest } = await latestCompletedSnapshots(client, tenantRef);
  const drillEvidence = await loadDrillEvidence(client, tenantRef);
  const diagnosisEvidence = await loadDiagnosisEvidence(client, tenantRef, byType);
  const relationshipState = await loadRelationshipState(client, { tenantRef });

  const descriptorByType = new Map(descriptors.map((d) => [d.type, d]));
  const catalogByType = new Map(catalog.map((c) => [c.type, c]));
  const types = [];

  for (const descriptor of descriptors) {
    const entry = coveredEntry(descriptor, byType.get(descriptor.type), drillEvidence.get(descriptor.type), generatedAt, tenantRef, latestDigest?.[descriptor.type], catalogByType.get(descriptor.type));
    // Diagnosis (roadmap task-53) is an ADDITIONAL field on a failed entry.
    // It never changes status/covered/outcome/detail — the raw collection
    // outcome stays exactly as observed, diagnosis or not.
    entry.diagnosis = entry.status === 'failed'
      ? diagnoseFailure({
        feature: descriptor.type,
        failure: { httpStatus: entry.detail?.httpStatus ?? null, graphCode: entry.detail?.graphCode ?? null },
        evidence: diagnosisEvidence,
        tenantRef,
        now: new Date(generatedAt),
      })
      : null;
    // Relationship observations (tasks 57/58) are reported per parent type.
    // Never 'complete': other child families are not collected, and a stale,
    // unknown or unsupported parent read is counted as exactly that.
    const families = summarizeRelationshipState(relationshipState, { parentType: descriptor.type });
    if (Object.keys(families).length > 0) {
      const observed = Object.values(families).some((bucket) => bucket.current + bucket.stale > 0);
      entry.relationshipCompleteness = observed ? 'partial' : 'unknown';
      entry.relationships = {
        families,
        parents: new Set([...relationshipState.entries.values()].filter((e) => e.parentType === descriptor.type).map((e) => e.parentSourceId)).size,
      };
    }
    types.push(entry);
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
      observation: null,
      outcome: null,
      detail: null,
      diagnosis: null,
      criticality: entry.criticality ?? null,
      blastRadius: entry.blastRadius ?? null,
      remappable: null,
      // Evidence-backed write-operation claims (roadmap task-52) — a
      // not-covered catalogue entry still has its own capability claims,
      // independent of read-coverage status.
      writeCapability: capabilitySummaryFor(entry.type),
      // Roadmap task-63: the explicit recovery decision (automated / manual /
      // unknown) and per-operation remapping proof, from the qualification ledger.
      qualification: qualificationFor(entry.type),
      // The catalog always declares a path/version even with no collecting
      // descriptor; there is simply nothing measured yet to compare it to.
      declaredEndpoint: { path: entry.path, apiVersion: entry.version },
      // No field-classification registry entry exists for an uncollected
      // type — never guessed from CATALOG or descriptors.mjs.
      irrecoverableFields: null,
      // No relationship/edge observation exists for any catalogue type yet
      // (roadmap task-57/58 introduce that collection) — honestly unknown.
      relationshipCompleteness: 'unknown',
    });
  }

  return {
    tenantRef,
    generatedAt,
    // The report merges the newest per-type observations, each with its own
    // start/end window. It is never an atomic tenant-wide image; consumers
    // must compare observation windows before treating types as simultaneous.
    observationContract: {
      version: OBSERVATION_CONTRACT_VERSION,
      atomicTenantImage: false,
    },
    snapshot: snapshot
      ? {
          id: snapshot.id,
          status: snapshot.status,
          startedAt: snapshot.started_at,
          completedAt: snapshot.completed_at,
        }
      : null,
    types,
    // Roadmap task-102: workload configuration reads (SharePoint first) are reported
    // beside the catalogue types, never merged into them or into the summary.
    workloads: await loadWorkloadCoverage(client, tenantRef),
    summary: {
      covered: types.filter((t) => t.status === 'covered').length,
      failed: types.filter((t) => t.status === 'failed').length,
      notCovered: types.filter((t) => t.status === 'not-covered').length,
      neverCollected: types.filter((t) => t.status === 'never-collected').length,
      stale: types.filter((t) => t.stale).length,
    },
  };
}

// Fields Graph itself owns for this type — SERVER_OWNED_ALWAYS applies to
// every collected type, SERVER_OWNED.get(type) adds type-specific fields.
// This is the SAME registry engine/cir/serverOwned.mjs already uses for
// hashing/PATCH projection (spec M2.3); it is reused here, never
// re-derived, so a future classification fix in that file automatically
// keeps this report accurate. A type absent from SERVER_OWNED (nothing in
// DESCRIPTORS) reads null — an honest unknown, never an invented empty list.
function irrecoverableFieldsFor(resourceType) {
  if (!SERVER_OWNED.has(resourceType)) return null;
  return [...new Set([...SERVER_OWNED_ALWAYS, ...SERVER_OWNED.get(resourceType)])].sort();
}

function coveredEntry(descriptor, observation, drill, generatedAt, tenantRef, digestEntry, catalogEntry) {
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
  // The structured per-type outcome: from the newest observation when one
  // exists, otherwise from the latest run's digest (e.g. an explicit
  // not-requested marker). Legacy entries without an outcome read null.
  const outcomeEntry = observation?.coverage_entry ?? digestEntry ?? null;
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
    // Normalized per-type outcome (complete / complete-empty / partial /
    // failed / not-requested) and the structured evidence carried with it:
    // HTTP status, Graph code, redacted message, endpoint/API version,
    // observation timestamps and pagination state. Both are null when the
    // digest predates structured outcomes — never invented.
    outcome: readOutcome(outcomeEntry),
    detail: readOutcomeDetail(outcomeEntry),
    // The versioned observation anchoring this entry (task-45). Legacy digest
    // entries still read, with the snapshot run bounds as their window and
    // 'unknown' evidence level; a cross-tenant entry is rejected upstream.
    observation: observation
      ? readTypeObservation({
        resourceType: descriptor.type,
        coverageEntry: observation.coverage_entry,
        snapshotId: observation.snapshot_id,
        snapshotStartedAt: observation.started_at,
        snapshotCompletedAt: observation.completed_at,
        tenantRef,
      })
      : null,
    fidelity: {
      declared: descriptor.fidelity,
      verifiedBy: drill
        ? { kind: drill.kind, at: drill.occurred_at, measuredFidelity: drill.subject.measuredFidelity }
        : null,
    },
    criticality: descriptor.criticality,
    blastRadius: descriptor.blastRadius,
    // remappable is a narrow reference-resolution fact (can this type be a
    // cross-tenant reference TARGET), kept for backward compatibility.
    // writeCapability (roadmap task-52) is the evidence-backed answer to the
    // actual question a caller usually wants: can this type itself be
    // created/updated/deleted/restored, and how strong is the proof.
    // Neither is derived from the other — see capabilities.mjs's header.
    remappable: descriptor.remappable,
    writeCapability: capabilitySummaryFor(descriptor.type),
    qualification: qualificationFor(descriptor.type),
    // Declared endpoint/version (roadmap task-54): from the catalog
    // registration itself, present even before any collection ever ran —
    // distinct from detail.endpoint/detail.apiVersion above, which is
    // measured and only populated once an observation carries it. No
    // catalog entry (a descriptor with nothing registered for it) reads null.
    declaredEndpoint: catalogEntry ? { path: catalogEntry.path, apiVersion: catalogEntry.version } : null,
    irrecoverableFields: irrecoverableFieldsFor(descriptor.type),
    // No relationship/edge observation exists for any catalogue type yet
    // (roadmap task-57/58 introduce that collection) — honestly unknown
    // rather than a fabricated claim, for every type including this one.
    relationshipCompleteness: 'unknown',
  };
}

/**
 * The latest run per registered workload. A workload never run reads
 * 'never-collected'; a run refused for lack of qualification reads 'disabled' with
 * its reasons. A database from before task-102 has no table and reads the same as
 * never collected.
 */
async function loadWorkloadCoverage(client, tenantRef) {
  const { rows: [table] } = await client.query("SELECT to_regclass('workload_collection') IS NOT NULL AS present");
  const latest = new Map();
  if (table?.present) {
    const { rows } = await client.query(
      `SELECT DISTINCT ON (workload) workload, outcome, observed_from, observed_to, digest
         FROM workload_collection WHERE tenant_ref = $1
        ORDER BY workload, created_at DESC, id DESC`,
      [tenantRef],
    );
    for (const row of rows) latest.set(row.workload, row);
  }
  return listWorkloads().map((descriptor) => {
    const row = latest.get(descriptor.workload);
    const digest = row?.digest ?? {};
    return {
      workload: descriptor.workload,
      type: descriptor.type,
      status: row ? row.outcome : 'never-collected',
      covered: row ? ['complete', 'complete-empty'].includes(row.outcome) : false,
      observation: row ? { startedAt: asIsoInstant(row.observed_from), endedAt: asIsoInstant(row.observed_to) } : null,
      resources: digest.discovery?.sites ?? null,
      fieldCounts: digest.fieldCounts ?? null,
      outOfScope: Array.isArray(digest.outOfScope) ? digest.outOfScope.length : null,
      reasons: digest.reasons ?? [],
    };
  });
}

async function latestCompletedSnapshots(client, tenantRef) {
  const { rows } = await client.query(
    `WITH ${TYPE_COVERAGE_CTES}
     SELECT latest.id, latest.status, latest.started_at, latest.completed_at, latest.coverage_digest,
            t.resource_type, t.coverage_entry, t.snapshot_id AS type_snapshot_id,
            t.started_at AS type_started_at, t.completed_at AS type_completed_at
     FROM (
       SELECT id, status, started_at, completed_at, coverage_digest FROM completed_snapshots
       ORDER BY completed_at DESC, started_at DESC, id DESC LIMIT 1
     ) latest
     LEFT JOIN latest_type_coverage t ON true`,
    [tenantRef],
  );
  return {
    snapshot: rows[0] ?? null,
    // The latest run's full digest, so explicit non-observations (not-requested)
    // stay visible even though they are not observations and never join byType.
    latestDigest: rows[0]?.coverage_digest ?? null,
    byType: new Map(rows.filter((row) => row.resource_type !== null).map((row) => [row.resource_type, {
      coverage_entry: row.coverage_entry,
      snapshot_id: row.type_snapshot_id,
      started_at: row.type_started_at,
      completed_at: row.type_completed_at,
    }])),
  };
}

/**
 * Distinct observation windows present in a report, keyed by
 * `startedAt/endedAt`, each listing the types observed in that window. More
 * than one entry proves the report is not an atomic tenant-wide image.
 */
export function reportObservationWindows(report) {
  const windows = new Map();
  for (const type of report.types) {
    const window = type.observation?.window;
    if (!window) continue;
    const key = `${window.startedAt}/${window.endedAt}`;
    if (!windows.has(key)) windows.set(key, []);
    windows.get(key).push(type.type);
  }
  return windows;
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

// The three evidence dimensions a diagnosis joins (roadmap task-53), each
// backed by its own collected type. Time qualification (stale/future), the
// newest-mention-decides rule and the cross-tenant refusal are enforced by
// engine/coverage/diagnosis.mjs; this loader only assembles newest mentions
// and their payloads, tenant-scoped like every other report read.
const DIAGNOSIS_EVIDENCE_TYPES = Object.freeze({
  sku: 'subscribedSku',
  consent: 'oauth2PermissionGrant',
  roles: 'roleAssignment',
});

function asIsoInstant(value) {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value.toISOString();
  if (typeof value === 'string' && !Number.isNaN(Date.parse(value))) return new Date(value).toISOString();
  return null;
}

/**
 * The newest mention of each evidence type, exactly as the coverage CTE
 * selected it (newest including failures — an older success is never
 * substituted). Payloads load only from the snapshot behind a completed
 * newest mention; a failed/partial newest mention carries none, so stale
 * payloads can never justify a diagnosis after the read started failing.
 */
async function loadDiagnosisEvidence(client, tenantRef, byType) {
  const evidence = {};
  for (const [dimension, resourceType] of Object.entries(DIAGNOSIS_EVIDENCE_TYPES)) {
    const mention = byType.get(resourceType);
    if (!mention) {
      evidence[dimension] = [];
      continue;
    }
    const entry = mention.coverage_entry;
    const covered = readCoverageOutcome(entry).covered;
    const outcome = readOutcome(entry) ?? (covered ? 'complete' : 'unknown');
    const observedAt = asIsoInstant(entry?.completedAt) ?? asIsoInstant(mention.completed_at);
    let payloads = [];
    if (covered) {
      const { rows } = await client.query(
        `SELECT payload FROM resource_version WHERE snapshot_id = $1 AND resource_type = $2`,
        [mention.snapshot_id, resourceType],
      );
      payloads = rows.map((row) => row.payload);
    }
    const mentionBase = { outcome, observedAt, tenantRef };
    if (dimension === 'sku') {
      evidence.sku = [{ ...mentionBase, skus: payloads }];
    } else if (dimension === 'consent') {
      const grantedScopes = new Set();
      for (const grant of payloads) {
        for (const scope of String(grant?.scope ?? '').split(/\s+/)) {
          if (scope) grantedScopes.add(scope);
        }
      }
      evidence.consent = [{ ...mentionBase, grantedScopes: [...grantedScopes] }];
    } else {
      evidence.roles = [{
        ...mentionBase,
        assignedRoleIds: payloads.map((assignment) => assignment?.roleDefinitionId).filter((id) => typeof id === 'string'),
      }];
    }
  }
  return evidence;
}
