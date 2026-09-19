/**
 * Release source-parity contract (roadmap task-46).
 *
 * A parity record states, for one portal surface family, which engine reader
 * the family renders from, where the ported source came from (original commit
 * provenance) and a parity status. Three rules are enforced here,
 * non-negotiably:
 *
 * 1. The family inventory is closed. A surface family outside SURFACE_FAMILIES
 *    has no parity record and can never be defined; an omitted family is
 *    reported by missingSurfaceFamilies, never silently dropped.
 * 2. Source tests never assert deployment. A 'source-tested' record proves the
 *    source tree only; a 'deployed' record requires an explicit evidence
 *    reference (a readiness or qualification record), so a source-parity
 *    report can never present source tests as deployment status.
 * 3. Legacy or absent records read as 'unknown' and are never promoted.
 *
 * The six families ported from the M4 design branch are jobs, policies,
 * notifications, principals, evidence and collection-history. The collection
 * history binding is the job history surface family: every collection run is
 * recorded as a job and rendered through the jobs surfaces, so
 * collection-history carries the same reader as jobs.
 */

export const RELEASE_CONTRACT_VERSION = 1;

export const SURFACE_FAMILIES = Object.freeze([
  // Pre-M4 surface families (plan tasks 13-16).
  'dashboard',
  'coverage',
  'drift',
  'baselines',
  'backups',
  'restore',
  // Ported M4 surface families (roadmap tasks 35-41).
  'jobs',
  'policies',
  'notifications',
  'principals',
  'evidence',
  'collection-history',
]);

export const PARITY_STATUSES = Object.freeze(['source-tested', 'deployed', 'diverged', 'unknown']);

export class UnknownSurfaceFamilyError extends Error {
  constructor(family) {
    super(`unknown surface family: ${family}`);
    this.name = 'UnknownSurfaceFamilyError';
  }
}

export class DeploymentEvidenceRequiredError extends Error {
  constructor(family) {
    super(`surface family ${family} cannot read 'deployed' from source tests — a deployment evidence reference is required`);
    this.name = 'DeploymentEvidenceRequiredError';
  }
}

export function defineSurfaceParity({
  family, reader, status, provenance, evidence = null,
}) {
  if (!SURFACE_FAMILIES.includes(family)) {
    throw new UnknownSurfaceFamilyError(family);
  }
  if (typeof reader !== 'string' || !reader.startsWith('engine/')) {
    throw new TypeError('surface parity requires the engine reader module the family renders from');
  }
  if (!PARITY_STATUSES.includes(status)) {
    throw new TypeError(`unknown parity status: ${status}`);
  }
  if (typeof provenance?.commit !== 'string' || provenance.commit.length === 0) {
    throw new TypeError('surface parity requires the original commit provenance');
  }
  if (status === 'deployed' && (typeof evidence !== 'string' || evidence.length === 0)) {
    throw new DeploymentEvidenceRequiredError(family);
  }
  return Object.freeze({
    contractVersion: RELEASE_CONTRACT_VERSION,
    family,
    reader,
    status,
    provenance: Object.freeze({
      commit: provenance.commit,
      ref: provenance.ref ?? null,
    }),
    evidence: status === 'deployed' ? evidence : null,
  });
}

/**
 * Read any stored parity record. Legacy records (no contract version) and
 * absent records are preserved as 'unknown' with no reader and no provenance;
 * a legacy claim — even one asserting 'deployed' — is never promoted.
 */
export function readSurfaceParity(record, { family } = {}) {
  if (record && typeof record === 'object' && record.contractVersion === RELEASE_CONTRACT_VERSION) {
    return defineSurfaceParity(record);
  }
  if (typeof family !== 'string' || !SURFACE_FAMILIES.includes(family)) {
    throw new UnknownSurfaceFamilyError(family ?? record?.family);
  }
  return Object.freeze({
    contractVersion: 0,
    legacy: true,
    family,
    reader: null,
    status: 'unknown',
    provenance: null,
    evidence: null,
  });
}

/**
 * Closed-inventory completeness: the families the caller registered, minus the
 * contract inventory. An omitted surface family is named here, never dropped.
 */
export function missingSurfaceFamilies(registeredFamilies) {
  const registered = new Set(registeredFamilies);
  return SURFACE_FAMILIES.filter((family) => !registered.has(family));
}

/**
 * Summarize parity records into per-status families. Source tests and
 * deployment status stay in separate buckets: a family reads as deployed only
 * from a 'deployed' record carrying its evidence reference, and a
 * 'source-tested' record never appears under deployment.
 */
export function summarizeParity(records) {
  const sourceTested = [];
  const diverged = [];
  const unknown = [];
  const deployment = {};
  for (const record of records) {
    const parity = record?.contractVersion === RELEASE_CONTRACT_VERSION
      ? defineSurfaceParity(record)
      : readSurfaceParity(record, { family: record?.family });
    if (parity.status === 'source-tested') sourceTested.push(parity.family);
    else if (parity.status === 'diverged') diverged.push(parity.family);
    else if (parity.status === 'deployed') deployment[parity.family] = parity.evidence;
    else unknown.push(parity.family);
  }
  return Object.freeze({
    sourceTested: Object.freeze(sourceTested),
    diverged: Object.freeze(diverged),
    unknown: Object.freeze(unknown),
    deployment: Object.freeze(deployment),
  });
}
