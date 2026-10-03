// engine/policy/activation.mjs
//
// Roadmap task-92: an immutable preview before an automatic roll-back policy is turned
// on. The preview answers "what would this policy do the moment it is on?" from the
// same machinery a remediation uses, never a second planner:
//
//   - matched resources: the open drift rows policyMatches() selects today, split by the
//     enqueue-time max_blast_radius guardrail (evaluate.mjs);
//   - closure-expanded impact: each baseline's restore scope from resolveRestoreScope()
//     (cli/keel-remediate.mjs, the remediate job's own scope), closed over the snapshot
//     with dependencyClosure() on restoreCandidates() — the exact candidate set the dry
//     run plans from — and rated with maxOperationImpact() (task-55);
//   - the run-as principal's current grants and whether it may remediate right now;
//   - limits (ceiling, rate, automation halt), operations the capability registry does
//     not support, and benchmark findings linked to the matched changes (task-87).
//
// The preview is frozen: a row with its policy, grant, ownership and projection versions
// and a canonical digest (dryRunArtifact.mjs's hashing). Activation consumes one preview
// once, and only when a fresh recomputation still matches every version and the digest.
// A preview is NOT execution authorization: activation only turns the policy on through
// setPolicyEnabled(), and every roll back it later queues is re-checked by
// executeAutoRemediation(), the worker and runRestore (task-55 ceiling after expansion),
// exactly as for a policy that was never previewed.
//
// Unknown impact blocks activation: a scope that cannot be resolved, a matched resource
// missing from its backup, a reference no backed-up resource provides, or an impact
// rating KEEL does not recognise. A queued roll back is reported as queued, never as
// rolled back; only the worker's terminal outcome makes it executed.
import { existsSync } from 'node:fs';

import { appendEvidence } from '../govern/evidence.mjs';
import { complianceFindings } from '../govern/baselineCompliance.mjs';
import { can } from '../authz/can.mjs';
import { findPrincipalById } from '../authz/principals.mjs';
import { capabilityFor, isSupportedClaim } from '../coverage/capabilities.mjs';
import { FIELD_PROJECTION_CONTRACT_VERSION } from '../contracts/fieldProjection.mjs';
import { HASH_VERSION } from '../cir/canonicalHash.mjs';
import { getReferences, getResourceVersions } from '../store/db.mjs';
import { OPEN_DRIFT_PREDICATE } from '../store/openDrift.mjs';
import { dependencyClosure } from '../restore/selection.mjs';
import { canonicalDigest, restoreCandidates } from '../restore/dryRunArtifact.mjs';
import { resolveRestoreScope } from '../../cli/keel-remediate.mjs';
import {
  blastRadiusRank, exceedsBlastRadiusCeiling, exceedsMaxBlastRadius, maxOperationImpact,
  policyConstraintVersion, policyMatches, setPolicyEnabled,
} from './evaluate.mjs';
import { AUTOMATION_KILL_SWITCH_PATH } from './execute.mjs';

export const ACTIVATION_PREVIEW_EVIDENCE_KIND = 'policy-activation-preview';
export const ACTIVATION_EVIDENCE_KIND = 'policy-activation';
export const ACTIVATION_PREVIEW_TTL_MS = 30 * 60 * 1000;
export const ACTIVATION_VERSION_KEYS = Object.freeze(['policy', 'grant', 'ownership', 'projection']);
export const ACTIVATION_BLOCKERS = Object.freeze(['run-as-not-authorized', 'unknown-impact', 'automation-halted']);

export class ActivationNotFoundError extends Error {}

/** A refused activation. `code` is one of: preview-not-found, preview-expired,
 * preview-used, preview-blocked, already-active, preview-stale. `changed` names the
 * versions that moved for preview-stale. */
export class ActivationRefusedError extends Error {
  constructor(code, message, { changed = [] } = {}) {
    super(message);
    this.code = code;
    this.changed = changed;
  }
}

// What a drift's roll back does to the resource (buildRollbackPlan's expected verbs).
const DRIFT_OPERATIONS = { modified: ['update'], added: ['delete'], removed: ['create'] };
// A dependency's operation depends on the live target, which only the dry run reads:
// it is recreated when missing and updated when it drifted. Both must be supported.
const DEPENDENCY_OPERATIONS = ['create', 'update'];

/** How one auto_remediation_execution status reads. Only the worker's terminal
 * outcome ('executed') is a completed roll back; a queued job has not run. */
export function remediationOutcome(status) {
  switch (status) {
    case 'executed': return { status, rolledBack: true, finished: true };
    case 'failed': return { status, rolledBack: false, finished: true };
    case 'queued': return { status, rolledBack: false, finished: false };
    default: return { status: 'unknown', rolledBack: false, finished: false };
  }
}

/** What this policy has queued and done so far, by status. */
export async function summarizeAutomationOutcomes(client, { tenantRef, policyId }) {
  const { rows } = await client.query(
    `SELECT e.job_id, e.drift_id, e.status, e.queued_at, e.finished_at, d.natural_key, d.resource_type
       FROM auto_remediation_execution e
       LEFT JOIN drift d ON d.id = e.drift_id
      WHERE e.tenant_ref = $1 AND e.policy_id = $2
      ORDER BY e.queued_at DESC, e.job_id`,
    [tenantRef, policyId],
  );
  const items = rows.map((row) => ({
    jobId: String(row.job_id),
    driftId: String(row.drift_id),
    naturalKey: row.natural_key ?? null,
    resourceType: row.resource_type ?? null,
    queuedAt: iso(row.queued_at),
    finishedAt: iso(row.finished_at),
    ...remediationOutcome(row.status),
  }));
  return {
    queued: items.filter((item) => !item.finished).length,
    rolledBack: items.filter((item) => item.rolledBack).length,
    failed: items.filter((item) => item.finished && !item.rolledBack).length,
    items: items.slice(0, 20),
  };
}

function iso(value) {
  return value == null ? null : new Date(value).toISOString();
}

/** The policy version an activation is frozen under: the constraint version task-55
 * already binds into dry runs, plus the match fields that decide what it acts on. */
export function activationPolicyVersion(policy) {
  return canonicalDigest({
    constraints: policyConstraintVersion(policy),
    match: {
      resourceType: policy.resource_type ?? null,
      blastRadius: policy.blast_radius ?? null,
      naturalKeyGlob: policy.natural_key_glob ?? null,
      changeType: policy.change_type ?? null,
    },
  });
}

async function readRunAs(client, policy, now) {
  const principal = policy.run_as_principal_id
    ? await findPrincipalById(client, String(policy.run_as_principal_id))
    : null;
  const authorized = principal ? await can(client, principal, 'remediate', now) : false;
  const { rows: grants } = principal
    ? await client.query(
      `SELECT id, role, scope, active_from, active_until
         FROM role_grant
        WHERE principal_id = $1 AND active_from <= $2 AND (active_until IS NULL OR active_until > $2)
        ORDER BY active_from, id`,
      [principal.id, now],
    )
    : { rows: [] };
  const view = {
    principalId: policy.run_as_principal_id ? String(policy.run_as_principal_id) : null,
    email: principal?.email ?? null,
    name: principal?.display_name ?? principal?.email ?? null,
    readable: principal != null,
    disabled: principal?.disabled_at != null,
    authorized,
    grants: grants.map((grant) => ({
      id: String(grant.id), role: grant.role, scope: grant.scope,
      activeFrom: iso(grant.active_from), activeUntil: iso(grant.active_until),
    })),
  };
  // The grant version: who the policy acts as, whether that account is enabled, and
  // every grant active now. A revoked, added, expired or re-scoped grant changes it.
  const version = canonicalDigest({
    principalId: view.principalId, disabled: view.disabled, authorized, grants: view.grants,
  });
  return { view, version };
}

async function readOwnership(client, tenantRef, keys) {
  const { rows: [table] } = await client.query("SELECT to_regclass('resource_ownership_evidence') AS name");
  if (table.name == null || keys.length === 0) {
    return { state: table.name == null ? 'not-configured' : 'none', resources: [], version: canonicalDigest({ state: table.name == null ? 'not-configured' : 'none' }) };
  }
  const { rows } = await client.query(
    `SELECT id, natural_key, state, entity_code, entity_codes, expires_at
       FROM resource_ownership_evidence
      WHERE tenant_ref = $1 AND superseded_at IS NULL AND natural_key = ANY($2::text[])
      ORDER BY natural_key, id`,
    [tenantRef, keys],
  );
  const resources = rows.map((row) => ({
    evidenceId: String(row.id), naturalKey: row.natural_key, state: row.state,
    entityCode: row.entity_code ?? null, entityCodes: row.entity_codes ?? [], expiresAt: iso(row.expires_at),
  }));
  // Keys with no current ownership evidence are part of the version too, so evidence
  // appearing for one later changes it.
  const resolved = new Set(resources.map((resource) => resource.naturalKey));
  const missing = keys.filter((key) => !resolved.has(key));
  return { state: 'read', resources, missing, version: canonicalDigest({ resources, missing }) };
}

async function readFindings(client, tenantRef, driftIds, now) {
  try {
    const { findings } = await complianceFindings(client, { tenantRef, now });
    const wanted = new Set(driftIds);
    const matching = [];
    for (const finding of findings) {
      const linked = finding.links.change.linked.filter((change) => wanted.has(change.id));
      const mismatched = finding.links.change.mismatched.filter((change) => wanted.has(change.id));
      if (linked.length === 0 && mismatched.length === 0) continue;
      matching.push({
        id: finding.id, controlId: finding.controlId, title: finding.title, verdict: finding.verdict,
        exposed: finding.exposed, exceptionState: finding.exceptionState,
        link: linked.length > 0 ? 'linked' : 'mismatch',
        driftIds: [...linked, ...mismatched].map((change) => change.id).sort(),
      });
    }
    return { state: 'read', findings: matching.sort((a, b) => a.controlId.localeCompare(b.controlId)) };
  } catch {
    // Findings are context, never a gate: an unreadable register is shown as such.
    return { state: 'unavailable', findings: [] };
  }
}

/**
 * Computes, without persisting, what turning on `policyId` would do now. Tenant-scoped:
 * a policy of another tenant reads as not found. Returns the preview object, including
 * `versions`, `digest`, `blockers` and `verdict` ('ready' | 'blocked').
 */
export async function buildActivationPreview(client, {
  tenantRef, policyId, now = new Date(), killSwitchPath = AUTOMATION_KILL_SWITCH_PATH,
  resolveScope = resolveRestoreScope,
}) {
  const { rows: [policy] } = await client.query(
    'SELECT * FROM policy WHERE id::text = $1 AND tenant_ref = $2',
    [String(policyId), tenantRef],
  );
  if (!policy) throw new ActivationNotFoundError(`policy not found: ${policyId}`);
  if (policy.action !== 'auto_remediate') {
    throw new ActivationNotFoundError(`policy ${policyId} does not roll back automatically; it needs no activation preview`);
  }

  const { rows: openDrifts } = await client.query(
    `SELECT d.* FROM drift d
      WHERE d.tenant_ref = $1 AND ${OPEN_DRIFT_PREDICATE}
      ORDER BY d.detected_at, d.id`,
    [tenantRef],
  );
  const matched = openDrifts.filter((drift) => policyMatches(policy, drift));
  const describe = (drift) => ({
    driftId: String(drift.id), naturalKey: drift.natural_key, resourceType: drift.resource_type,
    changeType: drift.change_type, blastRadius: drift.blast_radius, detectedAt: iso(drift.detected_at),
  });
  const actionable = matched.filter((drift) => !exceedsMaxBlastRadius(drift, policy));
  const overCeiling = matched.filter((drift) => exceedsMaxBlastRadius(drift, policy)).map(describe);

  const unknowns = [];
  const operations = new Map();
  const dependencies = new Map();
  const scopes = [];
  const byBaseline = new Map();
  for (const drift of actionable) {
    const key = String(drift.baseline_id);
    if (!byBaseline.has(key)) byBaseline.set(key, []);
    byBaseline.get(key).push(drift);
  }
  for (const [baselineId, drifts] of [...byBaseline].sort(([a], [b]) => a.localeCompare(b))) {
    const driftIds = drifts.map((drift) => String(drift.id));
    let scope;
    try {
      scope = await resolveScope(client, { driftIds });
    } catch (error) {
      unknowns.push({ reason: 'scope-unresolved', driftIds, naturalKeys: drifts.map((drift) => drift.natural_key).sort(), detail: error.message });
      continue;
    }
    scopes.push({ baselineId, snapshotId: String(scope.snapshotId), driftIds });
    const candidates = restoreCandidates(
      await getResourceVersions(client, { snapshotId: scope.snapshotId }),
      await getReferences(client, { snapshotId: scope.snapshotId }),
    );
    const desiredKeys = scope.reconciliationResources
      .filter((resource) => resource.payload !== null)
      .map((resource) => resource.naturalKey);
    let closure;
    try {
      closure = dependencyClosure(candidates, desiredKeys);
    } catch (error) {
      unknowns.push({ reason: 'not-in-backup', driftIds, naturalKeys: desiredKeys.sort(), detail: error.message });
      continue;
    }
    for (const unresolved of closure.unresolvedReferences) {
      unknowns.push({ reason: 'unresolved-reference', naturalKeys: [unresolved.from], detail: `${unresolved.field} -> ${unresolved.symbol}` });
    }
    for (const drift of drifts) {
      operations.set(drift.natural_key, {
        naturalKey: drift.natural_key, resourceType: drift.resource_type,
        verb: DRIFT_OPERATIONS[drift.change_type]?.[0] ?? 'unknown',
        operations: DRIFT_OPERATIONS[drift.change_type] ?? [],
        blastRadius: drift.blast_radius, role: 'matched', driftId: String(drift.id),
      });
    }
    for (const added of closure.added) {
      const resource = closure.resources.find((candidate) => candidate.naturalKey === added.naturalKey);
      const existing = dependencies.get(added.naturalKey);
      const requiredBy = [...new Set([...(existing?.requiredBy ?? []), ...added.reasons.map((reason) => reason.requiredBy)])].sort();
      dependencies.set(added.naturalKey, {
        naturalKey: added.naturalKey, resourceType: added.resourceType, blastRadius: resource?.blastRadius ?? null, requiredBy,
      });
      if (!operations.has(added.naturalKey)) {
        operations.set(added.naturalKey, {
          naturalKey: added.naturalKey, resourceType: added.resourceType, verb: 'create-or-update',
          operations: DEPENDENCY_OPERATIONS, blastRadius: resource?.blastRadius ?? null, role: 'dependency',
        });
      }
    }
  }

  const operationList = [...operations.values()].sort((a, b) => a.naturalKey.localeCompare(b.naturalKey));
  for (const operation of operationList) {
    if (blastRadiusRank(operation.blastRadius) === null) {
      unknowns.push({ reason: 'impact-unknown', naturalKeys: [operation.naturalKey], detail: `blast radius ${operation.blastRadius ?? 'missing'}` });
    }
    if (operation.operations.length === 0) {
      unknowns.push({ reason: 'operation-unknown', naturalKeys: [operation.naturalKey], detail: `change type for ${operation.naturalKey}` });
    }
  }
  const impact = maxOperationImpact(operationList);
  const dependencyList = [...dependencies.values()]
    .sort((a, b) => a.naturalKey.localeCompare(b.naturalKey))
    .map((dependency) => ({
      ...dependency,
      overCeiling: blastRadiusRank(dependency.blastRadius) !== null
        && exceedsBlastRadiusCeiling(dependency.blastRadius, policy.max_blast_radius),
    }));
  const unsupported = [];
  for (const operation of operationList) {
    for (const verb of operation.operations) {
      const claim = capabilityFor(operation.resourceType, verb).claim;
      if (!isSupportedClaim(claim)) unsupported.push({ naturalKey: operation.naturalKey, resourceType: operation.resourceType, operation: verb, claim });
    }
  }

  const runAs = await readRunAs(client, policy, now);
  const ownership = await readOwnership(client, tenantRef, operationList.map((operation) => operation.naturalKey));
  const findings = await readFindings(client, tenantRef, matched.map((drift) => String(drift.id)), now);
  const automationHalted = existsSync(killSwitchPath);
  const limits = {
    maxBlastRadius: policy.max_blast_radius,
    maxActionsPerWindow: policy.max_actions_per_window ?? null,
    windowSeconds: policy.window_seconds ?? null,
    automationHalted,
  };

  // The projection version: what the policy would act on and how — the matched drift
  // rows (by content hash), their restore sources, the closed operation set and the
  // projection/hash contracts that decide what a write means.
  const projectionVersion = canonicalDigest({
    fieldProjectionContract: FIELD_PROJECTION_CONTRACT_VERSION,
    hashVersion: HASH_VERSION,
    matched: matched.map((drift) => ({ id: String(drift.id), afterHash: drift.after_hash ?? null, beforeHash: drift.before_hash ?? null })),
    scopes,
    operations: operationList.map(({ naturalKey, verb, blastRadius }) => ({ naturalKey, verb, blastRadius })),
  });
  const versions = {
    policy: activationPolicyVersion(policy),
    grant: runAs.version,
    ownership: ownership.version,
    projection: projectionVersion,
  };

  const blockers = [];
  if (!runAs.view.authorized) blockers.push('run-as-not-authorized');
  if (unknowns.length > 0) blockers.push('unknown-impact');
  if (automationHalted) blockers.push('automation-halted');

  const body = {
    policy: { id: String(policy.id), name: policy.name, enabled: policy.enabled, action: policy.action },
    matched: actionable.map(describe),
    matchedOverCeiling: overCeiling,
    operations: operationList.map(({ operations: _, ...rest }) => rest),
    dependencies: dependencyList,
    impact: { maxBlastRadius: impact.maxBlastRadius, ceiling: policy.max_blast_radius },
    unsupported,
    unknowns,
    runAs: runAs.view,
    ownership: { state: ownership.state, resources: ownership.resources },
    benchmarkFindings: findings,
    limits,
    blockers,
    verdict: blockers.length > 0 ? 'blocked' : 'ready',
    versions,
  };
  return { ...body, digest: canonicalDigest(body) };
}

function rowToPreview(row) {
  return {
    ...row.preview,
    id: String(row.id),
    requestedBy: row.requested_by,
    createdAt: iso(row.created_at),
    expiresAt: iso(row.expires_at),
  };
}

/** Computes and freezes a preview. Returns the stored preview with id and expiry. */
export async function createActivationPreview(client, {
  tenantRef, policyId, requestedBy, now = new Date(), ttlMs = ACTIVATION_PREVIEW_TTL_MS, ...options
}) {
  if (typeof requestedBy !== 'string' || requestedBy.length === 0) throw new Error('requestedBy is required');
  const preview = await buildActivationPreview(client, { tenantRef, policyId, now, ...options });
  const { rows: [row] } = await client.query(
    `INSERT INTO policy_activation_preview
       (tenant_ref, policy_id, requested_by, policy_version, grant_version, ownership_version,
        projection_version, digest, verdict, preview, created_at, expires_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
     RETURNING *`,
    [
      tenantRef, preview.policy.id, requestedBy, preview.versions.policy, preview.versions.grant,
      preview.versions.ownership, preview.versions.projection, preview.digest, preview.verdict,
      JSON.stringify(preview), now, new Date(now.getTime() + ttlMs),
    ],
  );
  await appendEvidence(client, {
    tenantRef,
    kind: ACTIVATION_PREVIEW_EVIDENCE_KIND,
    subject: {
      previewId: String(row.id), policyId: preview.policy.id, verdict: preview.verdict,
      blockers: preview.blockers, versions: preview.versions, digest: preview.digest,
      matched: preview.matched.length, operations: preview.operations.length,
      dependenciesOverCeiling: preview.dependencies.filter((dependency) => dependency.overCeiling).length,
    },
    actor: requestedBy,
  });
  return rowToPreview(row);
}

/** One frozen preview, tenant-scoped, or null. */
export async function getActivationPreview(client, { tenantRef, previewId }) {
  const { rows: [row] } = await client.query(
    'SELECT * FROM policy_activation_preview WHERE id::text = $1 AND tenant_ref = $2',
    [String(previewId), tenantRef],
  );
  return row ? rowToPreview(row) : null;
}

/** The latest activation of a policy, or null — including every policy turned on
 * before previews existed (legacy read: no row, never a fabricated preview). */
export async function latestActivation(client, { tenantRef, policyId }) {
  const { rows: [row] } = await client.query(
    `SELECT * FROM policy_activation WHERE tenant_ref = $1 AND policy_id::text = $2
      ORDER BY activated_at DESC, id DESC LIMIT 1`,
    [tenantRef, String(policyId)],
  );
  return row
    ? { id: String(row.id), previewId: String(row.preview_id), activatedBy: row.activated_by, activatedAt: iso(row.activated_at), versions: row.versions }
    : null;
}

/**
 * Turns an automatic roll-back policy on from a frozen preview. Refuses (throwing
 * ActivationRefusedError, with refusal evidence) unless the preview belongs to this
 * tenant and policy, is unexpired, unused and ready, the policy is off, and a fresh
 * recomputation matches every frozen version and the digest. Then turns the policy on
 * through setPolicyEnabled(), which re-checks the run-as grant itself. Returns
 * { policy, activation }. Nothing here is consulted at execution time.
 */
export async function activatePolicy(client, {
  tenantRef, policyId, previewId, activatedBy, now = new Date(), ...options
}) {
  const refuse = async (code, message, extra = {}) => {
    await appendEvidence(client, {
      tenantRef,
      kind: ACTIVATION_EVIDENCE_KIND,
      subject: { policyId: String(policyId), previewId: String(previewId), outcome: 'refused', code, ...extra },
      actor: activatedBy,
    });
    throw new ActivationRefusedError(code, message, extra);
  };

  const { rows: [row] } = await client.query(
    `SELECT * FROM policy_activation_preview
      WHERE id::text = $1 AND tenant_ref = $2 AND policy_id::text = $3`,
    [String(previewId), tenantRef, String(policyId)],
  );
  if (!row) return refuse('preview-not-found', 'no activation preview of this policy was found');
  if (!(new Date(row.expires_at) > now)) return refuse('preview-expired', 'the activation preview has expired; preview again');
  const { rows: used } = await client.query('SELECT id FROM policy_activation WHERE preview_id = $1', [row.id]);
  if (used.length > 0) return refuse('preview-used', 'this activation preview was already used; preview again');
  if (row.verdict !== 'ready') return refuse('preview-blocked', `the activation preview was blocked: ${row.preview.blockers.join(', ')}`);

  const fresh = await buildActivationPreview(client, { tenantRef, policyId, now, ...options });
  if (fresh.policy.enabled) return refuse('already-active', 'the policy is already on');
  const frozen = {
    policy: row.policy_version, grant: row.grant_version, ownership: row.ownership_version, projection: row.projection_version,
  };
  const changed = ACTIVATION_VERSION_KEYS.filter((key) => frozen[key] !== fresh.versions[key]);
  if (changed.length > 0) {
    return refuse('preview-stale', `${changed.join(', ')} changed since the preview; preview again`, { changed });
  }
  if (fresh.digest !== row.digest) {
    return refuse('preview-stale', 'what the policy would act on changed since the preview; preview again', { changed: ['preview'] });
  }
  if (fresh.verdict !== 'ready') {
    return refuse('preview-blocked', `activation is blocked now: ${fresh.blockers.join(', ')}`);
  }

  // Single use: the UNIQUE preview_id lets exactly one concurrent activation through.
  const { rows: [activation] } = await client.query(
    `INSERT INTO policy_activation (tenant_ref, policy_id, preview_id, activated_by, activated_at, versions)
     VALUES ($1,$2,$3,$4,$5,$6)
     ON CONFLICT (preview_id) DO NOTHING
     RETURNING *`,
    [tenantRef, row.policy_id, row.id, activatedBy, now, JSON.stringify(fresh.versions)],
  );
  if (!activation) return refuse('preview-used', 'this activation preview was already used; preview again');
  let policy;
  try {
    policy = await setPolicyEnabled(client, { policyId: row.policy_id, enabled: true });
  } catch (error) {
    await client.query('DELETE FROM policy_activation WHERE id = $1', [activation.id]);
    return refuse('preview-blocked', `the policy could not be turned on: ${error.message}`);
  }
  await appendEvidence(client, {
    tenantRef,
    kind: ACTIVATION_EVIDENCE_KIND,
    subject: {
      policyId: String(row.policy_id), previewId: String(row.id), activationId: String(activation.id),
      outcome: 'activated', versions: fresh.versions, digest: fresh.digest,
      // Recorded so the audit record never reads an activation as an approval of
      // future roll backs: each one is checked again when it runs.
      executionChecks: 'every queued roll back is re-checked at execution',
    },
    actor: activatedBy,
  });
  return {
    policy,
    activation: {
      id: String(activation.id), previewId: String(row.id), activatedBy, activatedAt: iso(activation.activated_at), versions: fresh.versions,
    },
  };
}
