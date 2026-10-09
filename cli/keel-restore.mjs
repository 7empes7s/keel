#!/usr/bin/env node
// /opt/keel/cli/keel-restore.mjs
//
// node keel-restore.mjs --plan <id> --collector-config /etc/keel/tenant-target.json --target-config /etc/keel/restorer.json [--enforce] [--accept-degradation]
// node keel-restore.mjs --snapshot-id <id> --select <naturalKey> [--select <naturalKey>...] --collector-config ... --target-config ... [--enforce]
//
// --plan restores everything the plan covers; --snapshot-id + --select restores the
// dependency closure of exactly the selected natural keys (portal-design §4.1 — the
// closure is recomputed here from the snapshot, never trusted from the caller).
//
// node keel-restore.mjs --snapshot-id <id> --select <key> --incident <incidentId> ... restores under an
// incident (roadmap task-71): the snapshot must be a qualified recovery point for that
// incident (or carry an investigator's override), its malicious-field exclusions are
// applied and become post-restore checks, and all of it is bound into the plan digest.
//
// node keel-restore.mjs --compensate <artifactId> [--persist-artifact <id>] [--requested-by <who>]
// plans the conflict-aware compensation of one promoted restore (roadmap task-70) as
// a dry run; it is executed only by promoting that compensation artifact with
// --artifact <id> --enforce, through the same approval as any restore.
//
// node keel-restore.mjs --enforce-conditional-access <restoreArtifactId> --policy <naturalKey> [--persist-artifact <id>] [--requested-by <who>]
// plans turning on one Conditional Access policy that restore left report-only
// while the backup had it enabled (roadmap task-152), as a dry run. It is executed
// only by promoting that artifact with --artifact <id> --enforce after an approver
// other than the requester approved it; the break-glass lockout gate runs at both.
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { getToken } from '../tools/tenant-probe/auth.mjs';
import { GraphReader } from '../tools/tenant-probe/graph.mjs';
import { collectM1 } from '../engine/collect/entraAdapter.mjs';
import { tenantRefFor } from '../engine/store/tenantRef.mjs';
import { canonicalizeAll } from '../engine/cir/canonicalize.mjs';
import { connect, getResourceVersions, getReferences } from '../engine/store/db.mjs';
import { planWaves, planDeletionWaves, phaseOneResources } from '../engine/restore/wavePlanner.mjs';
import { dependencyClosure } from '../engine/restore/selection.mjs';
import { assessDeletePlan } from '../engine/graph/impact.mjs';
import { buildReconciliationPlan } from '../engine/reconcile/reconciliationPlan.mjs';
import { ThrottleGovernor } from '../engine/restore/throttleGovernor.mjs';
import { GraphWriter } from '../engine/restore/graphWriter.mjs';
import { applyWave, applyPatches, retryThrottledGraphOperation } from '../engine/restore/applyEngine.mjs';
import { breakGlassLockoutGate, closedLockoutGate } from '../engine/safety/lockoutGate.mjs';
import { loadGroupMembership, loadLockoutGateInputs } from '../engine/safety/breakGlassReadiness.mjs';
import { withProposedConditionalAccessPolicy } from '../engine/safety/lockoutGate.mjs';
import {
  ENFORCED, EnforcementRefusal, applyConditionalAccessEnforcement, deletedPolicyRestoreRefusal, enforcementPendingFor,
  observedTurnedOn, pendingEnforcementSteps, planConditionalAccessEnforcement,
} from '../engine/restore/conditionalAccessEnforcement.mjs';
import { tenantPolicyRecordFor } from '../engine/restore/tenantPolicyOperations.mjs';
import { isAdministrativeGoverned } from '../engine/restore/administrativeOperations.mjs';
import { previewApplyPlan } from '../engine/reconcile/previewApplyPlan.mjs';
import {
  classifyDryRunStatus, computeCurrentStateFingerprint, computePlanDigest,
  createDryRunArtifact, getDryRunArtifactById, restoreCandidates, validateArtifactForExecution,
} from '../engine/restore/dryRunArtifact.mjs';
import {
  exceedsBlastRadiusCeiling, maxOperationImpact, policyConstraintVersion,
} from '../engine/policy/evaluate.mjs';
import {
  AUTOMATION_EXECUTION_EVIDENCE_KIND, assertExecutableAutomationPolicy, getAutomationPolicies,
} from '../engine/policy/execute.mjs';
import { appendEvidence } from '../engine/govern/evidence.mjs';
import { collectRelationships, loadSnapshotRelationships } from '../engine/collect/relationships.mjs';
import {
  RELATIONSHIP_RESTORE_FAMILIES, applyRelationshipOperations, planRelationshipOperations,
} from '../engine/restore/relationshipWriter.mjs';
import { planMechanism, selectRecoveryMechanism } from '../engine/restore/recoveryMechanism.mjs';
import { attachIntuneAssignments, isIntuneGoverned } from '../engine/restore/intuneOperations.mjs';
import { closeEnforcementItem, emitCompletionItems, findEnforcementItem } from '../engine/restore/completion.mjs';
import { listJournal } from '../engine/restore/rollbackJournal.mjs';
import { compensationDigestInput, planCompensation } from '../engine/restore/compensation.mjs';
import { assertContentEffectApproval, classifyContentEffects } from '../engine/safety/contentEffects.mjs';
import { canonicalHash } from '../engine/cir/canonicalHash.mjs';
import {
  IncidentRecoveryRefusal, applyIncidentExclusions, evaluatePostRestoreChecks, incidentRecoveryDigestInput,
  incidentsCoveringSnapshot, recordPostRestoreChecks, resolveIncidentRecovery,
} from '../engine/govern/incidents.mjs';

function arg(name, fallback, argv = process.argv) {
  const i = argv.indexOf(`--${name}`);
  return i > -1 ? argv[i + 1] : fallback;
}
// Repeatable flag (e.g. --select): every occurrence contributes one value.
function argAll(name, argv = process.argv) {
  const values = [];
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === `--${name}` && argv[i + 1] !== undefined) values.push(argv[i + 1]);
  }
  return values;
}
function flag(name, argv = process.argv) {
  return argv.includes(`--${name}`);
}

// Exported so cli/keel-remediate.mjs (plan task 19) can reuse the exact same check
// rather than a second copy that can drift.

/**
 * Records what a wave applied for later waves' reference resolution. An
 * application created in this run also reports its new appId, recorded as
 * `<naturalKey>#appId` — the only key a service principal's explicit appId
 * reference reads (applyEngine.mjs's rewriteReferences, roadmap task-107).
 */
export function recordAppliedIds(appliedIds, applied) {
  for (const { naturalKey, targetId, identifiers } of applied) {
    if (typeof targetId === 'string' && targetId.length > 0) appliedIds.set(naturalKey, targetId);
    for (const [name, value] of Object.entries(identifiers ?? {})) {
      if (typeof value === 'string' && value.length > 0) appliedIds.set(`${naturalKey}#${name}`, value);
    }
  }
}
export function assertSeparateRestorer(collector, restorer) {
  if (collector.tenantId !== restorer.tenantId) {
    throw new Error('Collector tenantId must match the Restorer tenantId');
  }
  if (collector.clientId === restorer.clientId
    || collector.certPath === restorer.certPath
    || collector.keyPath === restorer.keyPath) {
    throw new Error('restore requires separate Collector and Restorer registrations and certificates');
  }
}

const THROTTLE_SEEDS = {
  // spec §11.1 — seed values, to be re-verified empirically once a target
  // tenant exists (Task 23 is exactly that re-verification).
  __placeholder__: null,
};

/**
 * Roadmap task-109: the source snapshot's per-type coverage entries, read only
 * when the plan holds a governed administrative delete (applyWave authorises
 * one only from a complete observation of its collection). Scoped to the
 * snapshot's own tenant: another tenant's snapshot reads as no evidence (null).
 */
/**
 * Roadmap task-149: the break-glass lockout gate for this plan, or null when no
 * lockout-sensitive write is planned. A gate whose inputs cannot be read
 * refuses every such write, never allows it.
 *
 * Task-152 review: restoring a deleted Conditional Access policy that would
 * come back on is such a write too. Group membership is then read for the
 * inventory with those policies as they would come back.
 */
export async function lockoutGateFor(client, resources, {
  tenantRef, loadInputs = loadLockoutGateInputs, loadMembership = loadGroupMembership,
}) {
  const comingBackOn = resources.filter((resource) => resource.verb === 'restore-soft-deleted'
    && resource.resourceType === 'conditionalAccessPolicy'
    && !offWhenDeleted(resource));
  const planned = comingBackOn.length > 0 || resources.some((resource) => resource.verb && resource.verb !== 'noop'
    && tenantPolicyRecordFor(resource.resourceType, resource.verb)?.lockout === true);
  if (!planned) return null;
  try {
    const inputs = await loadInputs(client, { tenantRef });
    if (comingBackOn.length > 0) {
      const proposed = comingBackOn.reduce((inventory, resource) => withProposedConditionalAccessPolicy(inventory, {
        naturalKey: resource.naturalKey, desired: { ...resource.live.payload, state: ENFORCED },
      }), inputs.inventory);
      inputs.groupMembers = await loadMembership(client, tenantRef, proposed);
    }
    return breakGlassLockoutGate(inputs);
  } catch (error) {
    return closedLockoutGate(`break-glass readiness could not be read: ${error.message}`);
  }
}

// A deleted policy that was report-only or off needs no gate: with no gate,
// deletedPolicyRestoreRefusal refuses only one that would come back on.
const offWhenDeleted = (resource) => deletedPolicyRestoreRefusal(resource, null) === null;

export async function observedCoverageFor(client, { resources, snapshotId, tenantRef }) {
  if (!resources.some((resource) => resource.verb === 'delete' && isAdministrativeGoverned(resource.resourceType))) return null;
  const { rows } = await client.query(
    'SELECT coverage_digest FROM snapshot WHERE id = $1 AND tenant_ref = $2',
    [snapshotId, tenantRef],
  );
  const digest = rows[0]?.coverage_digest;
  return digest && typeof digest === 'object' && !Array.isArray(digest) ? digest : null;
}

export async function runRestore({
  planId,
  snapshotId,
  selection,
  reconciliationResources,
  previewOnly = false,
  targetConfig,
  collectorConfig,
  collectorConfigPath,
  targetConfigPath,
  mode,
  acceptDegradation,
  // Plan task 8: the ONLY way to reach an enforce run from a snapshot/selection scope.
  // artifactId promotes a previously-created, completed dry-run artifact — its own
  // frozen snapshot, selection and target config paths are what get restored, never
  // whatever the caller supplies alongside it (hence the mutual-exclusivity check
  // below). persistArtifactId is the opposite direction: it asks a DRY run to persist
  // its result under this id, so it can be reviewed and later promoted.
  artifactId,
  persistArtifactId,
  // Roadmap task-70: plan the compensation of this promoted (forward) artifact's
  // run, as a dry run. Never executes: the resulting compensation artifact is
  // promoted with artifactId, like any other dry run.
  compensateArtifactId,
  // Roadmap task-152: plan turning on one Conditional Access policy a promoted
  // restore left report-only: { restoreArtifactId, naturalKey }. A dry run only;
  // the resulting artifact is promoted with artifactId after approval.
  enforceConditionalAccess,
  // Roadmap task-55: the automation policies a remediation is executing under,
  // discovered server-side by cli/keel-remediate.mjs from the durable
  // auto_remediation_execution link table. Only identities travel here — the
  // ceiling and every other constraint are re-derived from the live policy rows
  // below, never trusted from the caller. Absent for operator-driven restores,
  // which keeps their behavior exactly as before.
  automationPolicyIds,
  // Roadmap task-71: restore this snapshot as a recovery point of this incident. A
  // selection-scope dry run only; a promotion re-resolves it from its artifact.
  incidentId,
  requestedBy,
  readFile = readFileSync,
  dbUrl = process.env.KEEL_DB_URL,
  dependencies = {},
  logger = console,
}) {
  const {
    connect: connectFn = connect,
    getResourceVersions: getResourceVersionsFn = getResourceVersions,
    getReferences: getReferencesFn = getReferences,
    planWaves: planWavesFn = planWaves,
    planDeletionWaves: planDeletionWavesFn = planDeletionWaves,
    dependencyClosure: dependencyClosureFn = dependencyClosure,
    assessDeletePlan: assessDeletePlanFn = assessDeletePlan,
    buildReconciliationPlan: buildReconciliationPlanFn = buildReconciliationPlan,
    getToken: getTokenFn = getToken,
    GraphReader: GraphReaderClass = GraphReader,
    collectM1: collectM1Fn = collectM1,
    canonicalizeAll: canonicalizeAllFn = canonicalizeAll,
    GraphWriter: GraphWriterClass = GraphWriter,
    ThrottleGovernor: ThrottleGovernorClass = ThrottleGovernor,
    applyWave: applyWaveFn = applyWave,
    applyPatches: applyPatchesFn = applyPatches,
    getDryRunArtifactById: getDryRunArtifactByIdFn = getDryRunArtifactById,
    createDryRunArtifact: createDryRunArtifactFn = createDryRunArtifact,
    computePlanDigest: computePlanDigestFn = computePlanDigest,
    computeCurrentStateFingerprint: computeCurrentStateFingerprintFn = computeCurrentStateFingerprint,
    classifyDryRunStatus: classifyDryRunStatusFn = classifyDryRunStatus,
    validateArtifactForExecution: validateArtifactForExecutionFn = validateArtifactForExecution,
    getAutomationPolicies: getAutomationPoliciesFn = getAutomationPolicies,
    loadSnapshotRelationships: loadSnapshotRelationshipsFn = loadSnapshotRelationships,
    collectRelationships: collectRelationshipsFn = collectRelationships,
    applyRelationshipOperations: applyRelationshipOperationsFn = applyRelationshipOperations,
    emitCompletionItems: emitCompletionItemsFn = emitCompletionItems,
    assertContentEffectApproval: assertContentEffectApprovalFn = assertContentEffectApproval,
    listJournal: listJournalFn = listJournal,
    resolveIncidentRecovery: resolveIncidentRecoveryFn = resolveIncidentRecovery,
    incidentsCoveringSnapshot: incidentsCoveringSnapshotFn = incidentsCoveringSnapshot,
    loadLockoutGateInputs: loadLockoutGateInputsFn = loadLockoutGateInputs,
    loadGroupMembership: loadGroupMembershipFn = loadGroupMembership,
  } = dependencies;

  if (incidentId !== undefined) {
    if (typeof incidentId !== 'string' || incidentId.length === 0) throw new Error('incidentId must be a non-empty string');
    if (artifactId !== undefined) throw new Error('incidentId is supplied by the dry-run artifact on promotion, never by the caller');
    if (selection === undefined || planId !== undefined || reconciliationResources !== undefined || compensateArtifactId !== undefined) {
      throw new Error('incidentId requires the snapshotId/selection restore scope');
    }
  }
  if (enforceConditionalAccess !== undefined) {
    if (planId !== undefined || snapshotId !== undefined || selection !== undefined || reconciliationResources !== undefined
      || artifactId !== undefined || automationPolicyIds !== undefined || compensateArtifactId !== undefined || incidentId !== undefined) {
      throw new Error('enforceConditionalAccess is its own scope — one policy of one promoted restore');
    }
    if (typeof enforceConditionalAccess?.restoreArtifactId !== 'string' || !enforceConditionalAccess.restoreArtifactId
      || typeof enforceConditionalAccess?.naturalKey !== 'string' || !enforceConditionalAccess.naturalKey) {
      throw new Error('enforceConditionalAccess needs the restoreArtifactId and the policy naturalKey');
    }
    if (mode !== 'dry-run') {
      throw new Error('turning a Conditional Access policy on is only ever planned as a dry run; execute it by promoting that artifact through the normal approval');
    }
  }
  if (compensateArtifactId !== undefined) {
    if (planId !== undefined || snapshotId !== undefined || selection !== undefined
      || reconciliationResources !== undefined || artifactId !== undefined || automationPolicyIds !== undefined) {
      throw new Error('compensateArtifactId is its own scope — the journal of that one promoted restore');
    }
    if (mode !== 'dry-run') {
      throw new Error('compensation is only ever planned as a dry run; execute it by promoting the compensation artifact through the normal approval');
    }
  }

  // §4.1: a selection-driven restore carries only the operator's RAW selection; the
  // dependency closure is recomputed here, server-side, from the snapshot — never
  // trusted from the client. Exactly one of planId, (snapshotId + selection), or
  // artifactId (an enforce promotion, which supplies its own frozen scope below).
  if (artifactId !== undefined && (planId !== undefined || snapshotId !== undefined || selection !== undefined || reconciliationResources !== undefined)) {
    throw new Error('artifactId is mutually exclusive with planId/snapshotId/selection/reconciliationResources — a promotion is driven entirely by its dry-run artifact');
  }
  if (artifactId !== undefined && mode !== 'enforce') {
    throw new Error('artifactId may only be used with mode "enforce"');
  }
  if (persistArtifactId !== undefined) {
    if (mode === 'enforce') throw new Error('persistArtifactId may only be used for a dry run, never an enforce run');
    if (compensateArtifactId === undefined && enforceConditionalAccess === undefined && (planId !== undefined || snapshotId === undefined)) {
      throw new Error('persistArtifactId requires the snapshotId/selection restore scope');
    }
  }
  if (planId !== undefined && (snapshotId !== undefined || selection !== undefined || reconciliationResources !== undefined)) {
    throw new Error('planId and snapshotId/selection/reconciliationResources are mutually exclusive restore scopes');
  }
  if (planId === undefined && snapshotId === undefined && artifactId === undefined && compensateArtifactId === undefined
    && enforceConditionalAccess === undefined) {
    throw new Error('a restore scope is required: planId, snapshotId with a selection, artifactId, or compensateArtifactId');
  }
  if (selection !== undefined) {
    if (snapshotId === undefined) throw new Error('selection requires snapshotId');
    if (!Array.isArray(selection) || selection.length === 0
      || selection.some((key) => typeof key !== 'string' || key.length === 0)) {
      throw new Error('selection must be a non-empty array of natural keys');
    }
  }
  if (reconciliationResources !== undefined) {
    if (snapshotId === undefined) throw new Error('reconciliationResources requires snapshotId');
    if (selection !== undefined) throw new Error('selection and reconciliationResources are mutually exclusive restore scopes');
    if (!Array.isArray(reconciliationResources) || reconciliationResources.length === 0) {
      throw new Error('reconciliationResources must be a non-empty array');
    }
  }
  // Task 55: on a promotion the automation context comes from the immutable artifact
  // itself; a caller may never substitute different policy identities alongside it.
  if (automationPolicyIds !== undefined) {
    if (artifactId !== undefined) {
      throw new Error('automationPolicyIds is supplied by the dry-run artifact on promotion, never by the caller');
    }
    if (!Array.isArray(automationPolicyIds) || automationPolicyIds.length === 0
      || automationPolicyIds.some((id) => typeof id !== 'string' || id.length === 0)) {
      throw new Error('automationPolicyIds must be a non-empty array of policy ids');
    }
  }
  // Plan task 8: every enforce scope, including a legacy saved plan, must promote a
  // completed dry-run artifact. A clean plan is not an immutable dry-run review.
  // Automated remediation first produces its own artifact, then reaches this same
  // artifact-only branch.
  if (mode === 'enforce' && artifactId === undefined) {
    throw new Error('enforce requires artifactId (promote a completed dry-run artifact; a direct enforce is refused)');
  }

  let client;
  try {
    client = await connectFn(dbUrl);
    const compensationDeps = {
      getDryRunArtifactByIdFn, listJournalFn, getTokenFn, GraphReaderClass, GraphWriterClass, ThrottleGovernorClass,
      collectM1Fn, canonicalizeAllFn, applyWaveFn, assessDeletePlanFn, computePlanDigestFn,
      computeCurrentStateFingerprintFn, createDryRunArtifactFn, validateArtifactForExecutionFn,
      assertContentEffectApprovalFn, classifyDryRunStatusFn, loadLockoutGateInputsFn, loadGroupMembershipFn,
    };
    if (compensateArtifactId !== undefined) {
      return await planCompensationRun({
        client, compensateArtifactId, persistArtifactId, requestedBy, readFile, logger, deps: compensationDeps,
      });
    }
    if (enforceConditionalAccess !== undefined) {
      return await planEnforcementRun({
        client, request: enforceConditionalAccess, persistArtifactId, requestedBy, readFile, logger, deps: compensationDeps,
      });
    }
    let sourceSnapshot = snapshotId;
    let plan = null;
    let artifact = null;

    if (artifactId !== undefined) {
      artifact = await getDryRunArtifactByIdFn(client, { id: artifactId });
      if (!artifact) throw new Error(`restore promotion refused: dry-run artifact not found: ${artifactId}`);
      if (artifact.status !== 'completed') {
        throw new Error(`restore promotion refused: dry-run artifact ${artifactId} is not complete (status: ${artifact.status})`);
      }
      sourceSnapshot = artifact.snapshotId;
      selection = artifact.selection;
      reconciliationResources = artifact.reconciliationResources ?? undefined;
      // Task 55: an automation-planned artifact re-resolves its recorded policy
      // identities from the live rows below; an artifact without automation context
      // (every operator-driven dry run) promotes exactly as before.
      if (artifact.automationContext) {
        automationPolicyIds = artifact.automationContext.policies.map((policy) => policy.id);
      }
      collectorConfigPath = artifact.collectorConfigPath;
      targetConfigPath = artifact.targetConfigPath;
      collectorConfig = JSON.parse(readFile(collectorConfigPath, 'utf8'));
      targetConfig = JSON.parse(readFile(targetConfigPath, 'utf8'));
      assertSeparateRestorer(collectorConfig, targetConfig);
      // Task-70: a compensation artifact is promoted here, through this same
      // artifact gate — never by a separate undo path.
      if (artifact.compensation) {
        return await executeCompensationRun({
          client, artifact, collectorConfig, targetConfig, readFile, logger, deps: compensationDeps,
        });
      }
      // Task-152: turning a Conditional Access policy on is promoted here too.
      if (artifact.conditionalAccessEnforcement) {
        return await executeEnforcementRun({
          client, artifact, collectorConfig, targetConfig, logger, deps: compensationDeps,
        });
      }
    }
    if (planId !== undefined) {
      const { rows } = await client.query('SELECT * FROM plan WHERE id = $1', [planId]);
      plan = rows[0];
      if (!plan) throw new Error(`plan ${planId} not found`);
      if (!plan.clean && !acceptDegradation) {
        throw new Error('plan is not clean — has blocking gaps. Re-run keel-plan.mjs after remediation, or pass --accept-degradation to proceed with known gaps excluded.');
      }
      sourceSnapshot = plan.source_snapshot;
    }

    const versions = await getResourceVersionsFn(client, { snapshotId: sourceSnapshot });
    const references = await getReferencesFn(client, { snapshotId: sourceSnapshot });
    let resources = restoreCandidates(versions, references);

    let closureKeys = null;
    const artifactScopeReconciliationResources = reconciliationResources;
    // A remediation reconciliation scope has no snapshot-selection argument (its raw
    // scope is the drift-derived resource keys, including desired-absence deletes).
    // Persist that exact scope as the artifact's raw selection while continuing to
    // execute it through reconciliationResources; promotion restores both fields from
    // the one immutable record.
    const immutableSelection = selection
      ?? reconciliationResources?.map((resource) => resource.naturalKey)
      ?? [];
    if (reconciliationResources !== undefined) {
      const desiredKeys = reconciliationResources
        .filter((resource) => resource.payload !== null)
        .map((resource) => resource.naturalKey);
      const closure = dependencyClosureFn(resources, desiredKeys);
      const additions = reconciliationResources.filter((resource) => resource.payload === null);
      resources = [...closure.resources, ...additions]
        .sort((left, right) => left.naturalKey.localeCompare(right.naturalKey));
      closureKeys = resources.map((resource) => resource.naturalKey);
      for (const unresolved of closure.unresolvedReferences) {
        logger.log(`unresolved reference: ${unresolved.from} at ${unresolved.field} -> ${unresolved.symbol} (no resource in this snapshot provides it)`);
      }
      logger.log(`reconciliation selection of ${reconciliationResources.length} closed to ${resources.length} resources`);
    } else if (selection !== undefined) {
      // The closure — not the raw selection — is what gets restored. Unknown keys
      // throw inside dependencyClosure; references no snapshot resource can satisfy
      // are logged, because silently dropping them is how dangling restores happen.
      const closure = dependencyClosureFn(resources, selection);
      resources = closure.resources;
      closureKeys = closure.keys;
      for (const unresolved of closure.unresolvedReferences) {
        logger.log(`unresolved reference: ${unresolved.from} at ${unresolved.field} -> ${unresolved.symbol} (no resource in this snapshot provides it)`);
      }
      logger.log(`selection of ${selection.length} closed to ${resources.length} resources`);
    }

    // Roadmap task-71: incident-qualified recovery points. A snapshot inside an open
    // incident's compromise interval is restored only under that incident, so the
    // gate cannot be sidestepped by not naming it. Under an incident the point must
    // be qualified (or carry a valid investigator override) — re-derived here at the
    // dry run AND at promotion — and the assessment's exclusions are applied to what
    // is written and become post-restore checks, all bound into the plan digest.
    const sourceTenantRef = artifact?.tenantRef
      ?? (await client.query('SELECT tenant_ref FROM snapshot WHERE id = $1', [sourceSnapshot])).rows[0]?.tenant_ref;
    if (!sourceTenantRef) throw new Error(`snapshot not found: ${sourceSnapshot}`);
    const restoreIncidentId = artifact ? (artifact.incidentRecovery?.incidentId ?? undefined) : incidentId;
    let incidentRecovery = null;
    const covering = await incidentsCoveringSnapshotFn(client, { tenantRef: sourceTenantRef, snapshotId: sourceSnapshot });
    if (covering.length > 0 && !covering.includes(restoreIncidentId)) {
      throw new Error(
        `${artifact ? 'restore promotion refused: ' : ''}incident-recovery-refused: snapshot ${sourceSnapshot} lies in a compromise interval of open incident ${covering.join(', ')} — restore it under that incident (--incident)`,
      );
    }
    if (restoreIncidentId !== undefined) {
      try {
        incidentRecovery = await resolveIncidentRecoveryFn(client, {
          tenantRef: sourceTenantRef,
          incidentId: restoreIncidentId,
          snapshotId: sourceSnapshot,
          requestedBy: artifact ? artifact.requestedBy : requestedBy,
        });
        const excluded = applyIncidentExclusions(resources, incidentRecovery.exclusions, { hash: canonicalHash });
        resources = excluded.resources;
        incidentRecovery = { ...incidentRecovery, postRestoreChecks: excluded.checks };
      } catch (error) {
        if (artifact && error instanceof IncidentRecoveryRefusal) throw new Error(`restore promotion refused: ${error.message}`);
        throw error;
      }
      logger.log(`incident ${restoreIncidentId}: recovery point ${incidentRecovery.qualification} (${incidentRecovery.reasons.join('; ')}), ${incidentRecovery.exclusions.length} exclusion(s), ${incidentRecovery.postRestoreChecks.length} post-restore check(s)`);
    }
    const incidentDigest = incidentRecovery ? incidentRecoveryDigestInput(incidentRecovery) : null;

    const { accessToken: collectorToken } = await getTokenFn(collectorConfig);
    const targetReader = new GraphReaderClass(async () => collectorToken);
    let writer;
    if (!previewOnly) {
      const { accessToken: restorerToken } = await getTokenFn(targetConfig);
      writer = new GraphWriterClass(async () => restorerToken);
    }

    // Re-collect the target's CURRENT state — not what planning saw — so a retry
    // after a partial failure treats already-created resources as done instead
    // of re-creating them (spec §9.3; see Task 17's idempotency fix).
    const targetCollected = await collectM1Fn(targetReader);
    const targetResources = canonicalizeAllFn(targetCollected);
    const existingTargetIds = new Map(targetResources.map((r) => [r.naturalKey, r.sourceId]));
    const protectedPrincipalIds = targetResources
      .filter((resource) => resource.resourceType === 'roleAssignment'
        && resource.naturalKey.includes('GlobalAdministrator'))
      .map((resource) => resource.payload.principalId);
    const deletionGuardOptions = {
      breakGlassUserIds: protectedPrincipalIds,
      breakGlassGroupIds: [],
      keelAppIds: [],
      caPolicies: targetResources.filter((resource) => resource.resourceType === 'conditionalAccessPolicy'),
    };
    const reconciliation = await buildReconciliationPlanFn(targetReader, resources, { targetResources });
    resources = reconciliation.resources;
    // Issue #155: an Intune policy carries the assignments its backup observed, so
    // applyWave writes them through /assign; a policy whose only change is its
    // assignments is planned as an update. Selection scope only (an operator-picked
    // restore and its promotion), like group edges: a remediation or legacy plan
    // scope leaves assignments untouched, and the plan says so for each policy.
    if (selection !== undefined && reconciliationResources === undefined) {
      const intuneParents = resources.filter((resource) => isIntuneGoverned(resource.resourceType) && resource.verb !== 'delete');
      if (intuneParents.length > 0) {
        const desiredAssignments = await loadSnapshotRelationshipsFn(client, {
          snapshotId: sourceSnapshot, families: ['assignment'], parentNaturalKeys: intuneParents.map((resource) => resource.naturalKey),
        });
        // Every policy present live is read, so the plan can say how many current
        // assignments a restore replaces or removes.
        const livePolicies = intuneParents.filter((resource) => resource.live?.state === 'present'
          && desiredAssignments.has(`${resource.naturalKey}|assignment`));
        const liveAssignments = livePolicies.length === 0 ? [] : await collectRelationshipsFn(targetReader, {
          tenantRef: collectorConfig.tenantId,
          parents: livePolicies.map((resource) => ({
            type: resource.resourceType, sourceId: resource.live.targetId, naturalKey: resource.naturalKey,
            subtype: resource.live.payload?.['@odata.type'] ?? null,
          })),
          families: ['assignment'],
        });
        resources = attachIntuneAssignments(resources, {
          desired: desiredAssignments,
          live: new Map(liveAssignments.map((obs) => [`${obs.parentNaturalKey}|${obs.family}`, obs])),
          resolve: (naturalKey) => existingTargetIds.get(naturalKey) ?? null,
          recoveryFor: (resource) => selectRecoveryMechanism(resource),
        });
      }
    }
    // Roadmap task-149: a lockout-sensitive tenant policy (authentication methods,
    // security defaults, authorization policy) is written only when the target's
    // break-glass accounts stay ready under the proposed policy. Loaded only when
    // such a write is planned; applyWave skips it without a gate.
    // Readiness is stored under the target's derived tenant reference, never its raw id.
    const lockoutGate = await lockoutGateFor(client, resources, {
      tenantRef: tenantRefFor(collectorConfig.tenantId), loadInputs: loadLockoutGateInputsFn, loadMembership: loadGroupMembershipFn,
    });
    // Roadmap task-109: a governed administrative delete (a tenant-wide setting the
    // snapshot did not contain) is authorised only by a complete observation of
    // that collection in the source snapshot. Read only when such a delete is
    // planned; applyWave refuses it when the entry is missing or partial.
    const observedCoverage = await observedCoverageFor(client, {
      resources, snapshotId: sourceSnapshot, tenantRef: sourceTenantRef,
    });
    // Roadmap task-64: how each resource is recovered (soft-delete restore, in-place
    // update, recreate, manual handoff, refusal), with its retained/new id, deadline,
    // credential and proof. Bound into the plan digest and persisted with the dry run;
    // applyWave re-checks it before any write.
    const recoveryMechanisms = resources
      .filter((resource) => resource.recovery && resource.recovery.mechanism !== 'none')
      .map((resource) => planMechanism(resource.recovery))
      .sort((left, right) => left.naturalKey.localeCompare(right.naturalKey));
    for (const recovery of recoveryMechanisms) {
      if (recovery.mechanism === 'manual' || recovery.mechanism === 'refused') {
        logger.log(`recovery ${recovery.mechanism}: ${recovery.naturalKey} — ${recovery.reason}`);
      }
    }
    // Roadmap task-66: retention-reducing, hold-releasing, externally-sharing and
    // irreversible effects of these writes, each with its "content is not backed up"
    // disclosure. Unclassified dangerous transitions and preservation-locked objects
    // are refusals; classified effects need a separate high-impact approval.
    const contentEffects = classifyContentEffects(resources);
    for (const effect of contentEffects.effects) {
      logger.log(`content effect ${effect.effect}: ${effect.naturalKey} ${effect.field} ${JSON.stringify(effect.before)} -> ${JSON.stringify(effect.after)}`);
    }
    if (contentEffects.refusals.length > 0 && !previewOnly && mode !== 'dry-run') {
      throw new Error(`${contentEffects.refusals[0].reason} — refusing before any write`);
    }
    const writesBeforeDeletes = resources.filter((resource) => resource.verb !== 'delete');
    const deletes = resources.filter((resource) => resource.verb === 'delete');
    const { waves, patches } = planWavesFn(writesBeforeDeletes);
    const { waves: deletionWaves } = planDeletionWavesFn(deletes);

    // Roadmap task-61: group member/owner edges of the restored groups, reconciled
    // toward what the source snapshot observed through qualified $ref operations.
    // Selection scope only (an operator-reviewed restore and its promotion); a
    // remediation or legacy plan scope leaves edges untouched, as before. A snapshot
    // that never observed a group's edges (legacy, or collected without
    // relationships) plans nothing for it — absence of evidence is never an empty set.
    let relationshipPlan = { operations: [], refusals: [], notes: [], observed: [] };
    if (selection !== undefined && reconciliationResources === undefined) {
      const groupParents = resources.filter((resource) => resource.resourceType === 'group' && resource.verb !== 'delete');
      const desiredEdges = groupParents.length === 0
        ? new Map()
        : await loadSnapshotRelationshipsFn(client, {
          snapshotId: sourceSnapshot,
          families: RELATIONSHIP_RESTORE_FAMILIES,
          parentNaturalKeys: groupParents.map((resource) => resource.naturalKey),
        });
      if (desiredEdges.size > 0) {
        const edgeParents = groupParents
          .filter((resource) => RELATIONSHIP_RESTORE_FAMILIES.some((family) => desiredEdges.has(`${resource.naturalKey}|${family}`)))
          .map((resource) => ({
            naturalKey: resource.naturalKey,
            verb: resource.verb,
            liveTargetId: resource.live?.state === 'present' ? resource.live.targetId : null,
          }));
        const liveParents = edgeParents.filter((parent) => typeof parent.liveTargetId === 'string');
        const liveObservations = liveParents.length === 0 ? [] : await collectRelationshipsFn(targetReader, {
          tenantRef: collectorConfig.tenantId,
          parents: liveParents.map((parent) => ({ type: 'group', sourceId: parent.liveTargetId, naturalKey: parent.naturalKey })),
          families: RELATIONSHIP_RESTORE_FAMILIES,
        });
        const naturalKeyById = new Map([...existingTargetIds].map(([naturalKey, id]) => [String(id).toLowerCase(), naturalKey]));
        relationshipPlan = planRelationshipOperations({
          parents: edgeParents,
          desired: desiredEdges,
          live: new Map(liveObservations.map((obs) => [`${obs.parentNaturalKey}|${obs.family}`, obs])),
          resolveTargetId: (naturalKey) => existingTargetIds.get(naturalKey) ?? null,
          pendingCreates: new Set(resources
            .filter((resource) => resource.verb === 'create' || resource.verb === 'restore-soft-deleted')
            .map((resource) => resource.naturalKey)),
          naturalKeyForTargetId: (id) => naturalKeyById.get(id) ?? null,
          protectedPrincipalIds,
        });
        for (const note of relationshipPlan.notes) logger.log(`relationship edges not reconciled: ${note.note}`);
        logger.log(`relationship edges: ${relationshipPlan.operations.length} planned, ${relationshipPlan.refusals.length} refused`);
      }
    }
    const relationshipOperations = relationshipPlan.operations;
    const relationshipFingerprint = { relationships: relationshipPlan.observed };

    // Roadmap task-59: delete impact is re-evaluated at execution against the
    // CURRENT live state just collected. A resource still referencing one being
    // deleted — and neither deleted nor rewritten by this plan — would be left
    // dangling, so the run refuses before any write. (Before task 59 such
    // references were only logged.) Relationship-edge coverage is not
    // evaluated in this path and is reported as such.
    //
    // Only a run that can write fails here. A preview or dry run reports each such
    // delete as a guard refusal instead, so the operator sees the full plan and a
    // persisted dry-run artifact classifies as 'refused' — which the artifact gate
    // then refuses to promote. Either way the delete never reaches a writer.
    const deleteAssessment = assessDeletePlanFn({ liveResources: targetResources, plannedResources: resources });
    // Fail closed: applyWave writes in any mode other than exactly 'dry-run'.
    if (deleteAssessment.refusals.length > 0 && !previewOnly && mode !== 'dry-run') {
      const first = deleteAssessment.refusals[0];
      throw new Error(
        `blocked-dependent-impact: deleting ${first.deleting} would leave ${first.dependent} referencing it at ${first.field}`
        + `${deleteAssessment.refusals.length > 1 ? ` (and ${deleteAssessment.refusals.length - 1} more)` : ''} — refusing before any write`,
      );
    }
    const dependentImpactRefusals = new Map();
    for (const refusal of deleteAssessment.refusals) {
      if (dependentImpactRefusals.has(refusal.deleting)) continue;
      dependentImpactRefusals.set(refusal.deleting, {
        naturalKey: refusal.deleting,
        reason: `blocked-dependent-impact: deleting ${refusal.deleting} would leave ${refusal.dependent} referencing it at ${refusal.field}`,
      });
    }
    // A key another guard already refuses is not deleted anyway; report it once.
    const withDependentImpact = (refusals) => [
      ...refusals,
      ...[...dependentImpactRefusals.values()]
        .filter((refusal) => !refusals.some((existing) => existing.naturalKey === refusal.naturalKey)),
    ];

    // Roadmap task-55: automation limits are re-resolved server-side at execution,
    // AFTER dependency expansion. The enqueue-time guardrail saw only the original
    // drift row; here the maximum impact is computed over the actual operations the
    // expanded closure will perform, and compared against the ceiling re-read from
    // the live policy rows — never a caller-supplied ceiling. Exceeding it returns
    // the existing blocked-max-blast-radius refusal (recorded, then thrown so the
    // worker's terminal outcome can never be 'executed'), before any write.
    let automationContext = artifact?.automationContext ?? null;
    if (automationPolicyIds !== undefined) {
      const automationPolicies = await getAutomationPoliciesFn(client, { policyIds: automationPolicyIds });
      for (const policy of automationPolicies) await assertExecutableAutomationPolicy(client, policy);
      const maxBlastRadiusCeiling = automationPolicies.reduce(
        (strictest, policy) => (exceedsBlastRadiusCeiling(policy.max_blast_radius, strictest)
          ? strictest
          : policy.max_blast_radius),
        'tenant-lockout',
      );
      const impact = maxOperationImpact(resources, patches);
      if (impact.operations.length > 0 && exceedsBlastRadiusCeiling(impact.maxBlastRadius, maxBlastRadiusCeiling)) {
        const refusalTenantRef = artifact?.tenantRef
          ?? (await client.query('SELECT tenant_ref FROM snapshot WHERE id = $1', [sourceSnapshot])).rows[0]?.tenant_ref;
        if (refusalTenantRef) {
          await appendEvidence(client, {
            tenantRef: refusalTenantRef,
            kind: AUTOMATION_EXECUTION_EVIDENCE_KIND,
            subject: {
              policyIds: automationPolicies.map((policy) => policy.id),
              outcome: 'blocked-max-blast-radius',
              maxImpact: impact.maxBlastRadius,
              maxBlastRadiusCeiling,
              expandedScope: closureKeys,
            },
            actor: 'policy-automation',
          });
        }
        throw new Error(
          `blocked-max-blast-radius: expanded closure impact ${impact.maxBlastRadius} exceeds the current automation policy ceiling ${maxBlastRadiusCeiling} — refusing before any write`,
        );
      }
      if (automationContext) {
        // Promotion-time policy version check: the policy constraints recorded in
        // the immutable artifact are compared against the live rows. A policy (or
        // grant-relevant field) changed between the dry run and promotion
        // invalidates the plan — a new dry run is required, never a quiet proceed.
        for (const recorded of automationContext.policies) {
          const current = automationPolicies.find((policy) => policy.id === recorded.id);
          if (!current || policyConstraintVersion(current) !== recorded.version) {
            throw new Error(
              `restore promotion refused: automation policy ${recorded.id} constraints changed since the dry run — a new dry run is required`,
            );
          }
        }
      } else {
        // The dry-run leg: bind policy identity/version and the expanded scope the
        // impact was computed over into the immutable plan evidence.
        automationContext = {
          policies: automationPolicies.map((policy) => ({
            id: policy.id, name: policy.name, version: policyConstraintVersion(policy),
          })),
          maxBlastRadiusCeiling,
          maxImpact: impact.maxBlastRadius,
          expandedScope: closureKeys,
          operations: impact.operations,
        };
      }
    }

    // Human preview shares scope, current-state verb resolution and ordering with
    // enforcement, but returns before acquiring Restorer credentials or a writer.
    if (previewOnly) {
      const guardRefusals = withDependentImpact([
        ...await previewApplyPlan({
          resources, waves, deletionWaves, patches, existingTargetIds,
          deletionGuardOptions,
          signInPathGate: { reader: targetReader, protectedPrincipalIds },
          targetTenant: collectorConfig.tenantId,
          lockoutGate,
        }),
        ...relationshipPlan.refusals,
        ...contentEffects.refusals,
      ]);
      return {
        snapshotId: sourceSnapshot,
        resources: resources.map(({ naturalKey, resourceType, verb, verbReason }) => ({
          naturalKey, resourceType, verb, verbReason,
        })),
        waves, deletionWaves,
        patches: patches.map(({ naturalKey, field, symbol }) => ({ naturalKey, field, symbol })),
        relationshipOperations,
        recoveryMechanisms,
        contentEffects: contentEffects.effects,
        guardRefusals,
      };
    }

    // Plan task 8, step 4: a promotion recomputes the plan digest and the
    // current-state fingerprint fresh — from THIS snapshot/selection/closure and a
    // fresh read of the target — and refuses to write on any mismatch. A changed
    // snapshot, selection, or dependency closure changes the digest; a target that
    // drifted since the dry run ran changes the fingerprint. Either one fails the
    // whole run closed, before a single write.
    if (artifact) {
      const freshDigest = computePlanDigestFn({
        snapshotId: sourceSnapshot,
        selection: immutableSelection,
        closureKeys,
        targetTenantId: targetConfig.tenantId,
        collectorConfigPath,
        targetConfigPath,
        reconciliationResources: artifactScopeReconciliationResources,
        waves,
        patches,
        automationContext,
        relationshipOperations,
        // An artifact persisted before task-64 carries no mechanisms and keeps its
        // original digest inputs; every newer artifact binds them.
        recoveryMechanisms: artifact.recoveryMechanisms == null ? null : recoveryMechanisms,
        contentEffects: contentEffects.effects,
        incidentRecovery: incidentDigest,
      });
      const freshFingerprint = computeCurrentStateFingerprintFn(targetResources, closureKeys, relationshipFingerprint);
      const validation = validateArtifactForExecutionFn(artifact, {
        digest: freshDigest,
        currentStateFingerprint: freshFingerprint,
      });
      if (!validation.ok) throw new Error(`restore promotion refused: ${validation.reason}`);
      // Task-66: the effects just recomputed must carry a separate, current
      // high-impact approval bound to exactly them — never the requester's own.
      await assertContentEffectApprovalFn(client, { artifact, effects: contentEffects.effects });
    }

    const seeds = {
      [`${targetConfig.tenantId}/entra/write`]: { capacity: 100, refillPerSecond: 100 / 20 }, // Intune-tier seed, spec §11.1
    };
    const governor = new ThrottleGovernorClass(seeds);
    const runId = planId !== undefined ? `run-${planId}` : `run-selection-${sourceSnapshot}`;
    const appliedIds = new Map();
    // Accumulated across every wave and the deferred-patch phase. Ordinarily a
    // failure throws immediately (below) — retry is safe, since applies are
    // idempotent by natural key, spec §9.3 — but persistArtifactId asks for the
    // COMPLETE per-resource picture of a dry run even when part of it fails or is
    // refused, so a persisting run collects instead of throwing and lets
    // classifyDryRunStatus below decide the artifact's terminal status.
    const results = { applied: [], skipped: [], failed: [], notRemediable: [] };

    // Task-152 review: a restored Conditional Access policy KEEL could not
    // confirm as report-only may be on. Said loudly, and an enforced run opens a
    // completion item for it before the run stops.
    const reportPoliciesThatMayBeOn = async (failures) => {
      const mayBeOn = failures.filter((entry) => entry.policyMayBeOn);
      for (const entry of mayBeOn) logger.error(`WARNING: ${entry.error}`);
      if (mayBeOn.length === 0 || mode !== 'enforce' || !artifact) return;
      await emitCompletionItemsFn(client, {
        tenantRef: artifact.tenantRef,
        restoreRef: artifact.id ?? artifactId,
        owner: artifact.requestedBy ?? null,
        applied: mayBeOn.map((entry) => ({
          naturalKey: entry.naturalKey, resourceType: 'conditionalAccessPolicy', mechanism: 'soft-delete-restore', stateUnconfirmed: true,
        })),
      });
    };

    for (const [i, waveKeys] of waves.entries()) {
      const wave = phaseOneResources(
        writesBeforeDeletes.filter((r) => waveKeys.includes(r.naturalKey)),
        patches,
      );
      logger.log(`wave ${i + 1}/${waves.length}: ${wave.length} resources`);
      const result = await applyWaveFn(writer, governor, wave, {
        targetTenant: targetConfig.tenantId,
        mode,
        existingTargetIds,
        appliedIds,
        rollbackClient: client,
        runId,
        restoreRef: mode === 'enforce' ? (artifact?.id ?? artifactId ?? null) : null,
        deletionGuardOptions,
        signInPathGate: { reader: targetReader, protectedPrincipalIds },
        observedCoverage,
        lockoutGate,
      });
      logger.log(`  applied ${result.applied.length}, skipped ${result.skipped.length}, failed ${result.failed.length}`);
      results.applied.push(...result.applied);
      results.skipped.push(...result.skipped);
      results.failed.push(...result.failed);
      results.notRemediable.push(...(result.notRemediable ?? []));
      recordAppliedIds(appliedIds, result.applied);
      if (result.failed.length) {
        await reportPoliciesThatMayBeOn(result.failed);
        if (persistArtifactId === undefined) {
          throw new Error('wave had failures — stopping run (retry is safe: applies are idempotent by natural key, spec §9.3)');
        }
        break;
      }
    }

    if (results.failed.length === 0) {
      const patchResult = await applyPatchesFn(writer, governor, patches, {
        targetTenant: targetConfig.tenantId, mode, appliedIds,
      });
      logger.log(`patched ${patchResult.applied.length}, patchFailed ${patchResult.failed.length}`);
      results.applied.push(...patchResult.applied);
      results.failed.push(...patchResult.failed);
      if (patchResult.failed.length && persistArtifactId === undefined) {
        throw new Error('deferred patch had failures — stopping run');
      }
    }

    // Task-61: planning refusals for edges are guard refusals of this run (a dry run
    // carrying any is 'refused' and can never be promoted). Edge writes run after
    // every object exists (so a member created by this run resolves through
    // appliedIds) and before any delete.
    results.skipped.push(...relationshipPlan.refusals, ...contentEffects.refusals);
    if (results.failed.length === 0 && relationshipOperations.length > 0) {
      const edgeResult = await applyRelationshipOperationsFn(writer, governor, relationshipOperations, {
        reader: targetReader,
        mode,
        targetTenant: targetConfig.tenantId,
        parentTargetIds: new Map([...existingTargetIds, ...appliedIds]),
        targetIds: new Map([...existingTargetIds, ...appliedIds]),
        rollbackClient: client,
        runId,
        restoreRef: mode === 'enforce' ? (artifact?.id ?? artifactId ?? null) : null,
      });
      logger.log(`edges: applied ${edgeResult.applied.length}, skipped ${edgeResult.skipped.length}, failed ${edgeResult.failed.length}`);
      results.applied.push(...edgeResult.applied);
      results.skipped.push(...edgeResult.skipped);
      results.failed.push(...edgeResult.failed);
      if (edgeResult.failed.length && persistArtifactId === undefined) {
        throw new Error('relationship edge operations had failures — stopping run (each edge is re-read before any retry, so a retry never adds a member twice)');
      }
    }

    if (results.failed.length === 0) {
      for (const [i, waveKeys] of deletionWaves.entries()) {
        const wave = deletes.filter((resource) => waveKeys.includes(resource.naturalKey));
        logger.log(`delete wave ${i + 1}/${deletionWaves.length}: ${wave.length} resources`);
        const result = await applyWaveFn(writer, governor, wave, {
          targetTenant: targetConfig.tenantId,
          mode,
          existingTargetIds,
          appliedIds,
          rollbackClient: client,
          runId,
          restoreRef: mode === 'enforce' ? (artifact?.id ?? artifactId ?? null) : null,
          deletionGuardOptions,
          signInPathGate: { reader: targetReader, protectedPrincipalIds },
          observedCoverage,
          lockoutGate,
        });
        logger.log(`  applied ${result.applied.length}, skipped ${result.skipped.length}, failed ${result.failed.length}`);
        results.applied.push(...result.applied);
        results.skipped.push(...result.skipped);
        results.failed.push(...result.failed);
        results.notRemediable.push(...(result.notRemediable ?? []));
        recordAppliedIds(appliedIds, result.applied);
        if (result.failed.length) {
          if (persistArtifactId === undefined) {
            throw new Error('delete wave had failures — stopping run (retry is safe: applies are idempotent by natural key, spec §9.3)');
          }
          break;
        }
      }
    }

    // Only a dry run reaches this point with dependent-impact refusals (any other
    // mode threw above), and a dry run writes nothing. Its guards still evaluated
    // those deletes, exactly as the preview does; the refusal decides the outcome,
    // so such a delete is reported as skipped, never as applied.
    if (dependentImpactRefusals.size > 0) {
      results.applied = results.applied.filter((entry) => !dependentImpactRefusals.has(entry.naturalKey));
      results.skipped = withDependentImpact(results.skipped);
    }

    // Roadmap task-65: an enforced promotion that recreated or soft-restored an object
    // leaves owned completion items for what KEEL cannot write back (secrets,
    // certificates, consent, a new id's downstream integrations) and for service
    // validation. Keyed by the promoted artifact, so a retried run never duplicates them.
    // Roadmap task-152: a Conditional Access policy the snapshot had turned on is
    // written report-only. Each one is a pending step of this run (dry run and
    // enforce alike) and, once enforced, an open enforcement completion item.
    const pendingSteps = pendingEnforcementSteps(resources, results.applied);
    for (const step of pendingSteps) logger.log(`pending step: ${step.naturalKey} left report-only; the backup had it turned on`);
    if (pendingSteps.length > 0) results.pendingSteps = pendingSteps;
    let completionItems = [];
    if (mode === 'enforce' && artifact) {
      const byKey = new Map(resources.map((resource) => [resource.naturalKey, resource]));
      const recovered = results.applied
        .map((entry) => byKey.get(entry.naturalKey))
        .filter((resource) => resource?.recovery
          && (resource.recovery.mechanism === 'recreate' || resource.recovery.mechanism === 'soft-delete-restore'
            || (resource.recovery.mechanism === 'update-existing' && enforcementPendingFor(resource))))
        .map((resource) => ({
          naturalKey: resource.naturalKey, resourceType: resource.resourceType, mechanism: resource.recovery.mechanism,
          enforcementPending: enforcementPendingFor(resource),
        }));
      if (recovered.length > 0) {
        completionItems = await emitCompletionItemsFn(client, {
          tenantRef: artifact.tenantRef,
          restoreRef: artifact.id ?? artifactId,
          owner: artifact.requestedBy ?? null,
          applied: recovered,
        });
        logger.log(`completion: ${completionItems.length} item(s) open for recovered objects`);
      }
    }

    // Roadmap task-71: the exclusions bound into the plan are checked against a FRESH
    // read of the target after an enforced incident recovery. Results go to the
    // evidence chain; a failed check fails the run visibly — a malicious grant still
    // live after recovery is never reported as a clean restore.
    let incidentChecks = [];
    if (mode === 'enforce' && artifact && incidentRecovery) {
      const reread = await collectM1Fn(targetReader);
      const collectedTypes = Array.isArray(reread) ? reread.map((entry) => entry?.[0]).filter((type) => typeof type === 'string') : [];
      incidentChecks = evaluatePostRestoreChecks(incidentRecovery.postRestoreChecks, canonicalizeAllFn(reread), { collectedTypes });
      await recordPostRestoreChecks(client, {
        tenantRef: artifact.tenantRef, artifactId: artifact.id, incidentId: incidentRecovery.incidentId,
        results: incidentChecks, actor: 'keel-restore',
      });
      for (const check of incidentChecks) logger.log(`incident check ${check.outcome}: ${check.naturalKey}${check.field ? ` ${check.field}` : ''} — ${check.detail}`);
      const failedChecks = incidentChecks.filter((check) => check.outcome === 'failed');
      if (failedChecks.length > 0) {
        throw new Error(`incident-check-failed: ${failedChecks.map((check) => check.detail).join('; ')}`);
      }
    }

    let createdArtifactId = null;
    if (persistArtifactId !== undefined) {
      const { rows: snapshotRows } = await client.query(
        'SELECT tenant_ref FROM snapshot WHERE id = $1', [sourceSnapshot],
      );
      const tenantRef = snapshotRows[0]?.tenant_ref;
      if (!tenantRef) throw new Error(`snapshot not found: ${sourceSnapshot}`);

      const status = classifyDryRunStatusFn({ failed: results.failed, skipped: results.skipped });
      const digest = computePlanDigestFn({
        snapshotId: sourceSnapshot,
        selection: immutableSelection,
        closureKeys,
        targetTenantId: targetConfig.tenantId,
        collectorConfigPath,
        targetConfigPath,
        reconciliationResources: artifactScopeReconciliationResources,
        waves,
        patches,
        automationContext,
        relationshipOperations,
        recoveryMechanisms,
        contentEffects: contentEffects.effects,
        incidentRecovery: incidentDigest,
      });
      const currentStateFingerprint = computeCurrentStateFingerprintFn(targetResources, closureKeys, relationshipFingerprint);

      await createDryRunArtifactFn(client, {
        id: persistArtifactId,
        tenantRef,
        snapshotId: sourceSnapshot,
        selection: immutableSelection,
        closureKeys,
        targetTenantId: targetConfig.tenantId,
        collectorConfigPath,
        targetConfigPath,
        reconciliationResources: artifactScopeReconciliationResources,
        waves,
        patches,
        guardRefusals: results.skipped,
        results,
        currentStateFingerprint,
        digest,
        status,
        requestedBy: requestedBy ?? 'unknown',
        automationContext,
        relationshipOperations,
        recoveryMechanisms,
        contentEffects: contentEffects.effects,
        incidentRecovery,
      });
      createdArtifactId = persistArtifactId;
      logger.log(`persisted dry-run artifact ${persistArtifactId} (status: ${status})`);
    }

    return {
      plan, resources, waves, deletionWaves, patches, appliedIds, results, relationshipOperations, recoveryMechanisms,
      completionItems, pendingSteps, contentEffects: contentEffects.effects, incidentRecovery, incidentChecks,
      selection: immutableSelection.length ? immutableSelection : null,
      artifactId: createdArtifactId ?? artifactId ?? null,
    };
  } finally {
    await client?.end();
  }
}

// Roadmap task-70: the compensation of one promoted restore, recomputed from its
// journal and a FRESH read of the target every time — at the dry run and again at
// promotion — so the digest and fingerprint bind exactly what is undone.
const WRITE_SEEDS = (tenantId) => ({
  [`${tenantId}/entra/write`]: { capacity: 100, refillPerSecond: 100 / 20 }, // Intune-tier seed, spec §11.1
});

async function buildCompensation({ client, forward, collectorConfig, targetConfig, collectorConfigPath, targetConfigPath, deps }) {
  const entries = await deps.listJournalFn(client, { restoreRef: forward.id });
  if (entries.length === 0) {
    throw new Error(`compensation refused: restore ${forward.id} has no journaled writes (nothing was written, or it ran before operation journaling)`);
  }
  const { accessToken: collectorToken } = await deps.getTokenFn(collectorConfig);
  const targetReader = new deps.GraphReaderClass(async () => collectorToken);
  const targetResources = deps.canonicalizeAllFn(await deps.collectM1Fn(targetReader));
  const current = new Map(targetResources.map((resource) => [resource.naturalKey, { targetId: resource.sourceId, payload: resource.payload }]));
  const plan = planCompensation({ restoreRef: forward.id, entries, current });
  const order = plan.operations.map((op) => op.naturalKey);
  const scopeKeys = [...new Set(entries.map((entry) => entry.naturalKey))].sort((a, b) => a.localeCompare(b));
  // The compensation's own content effects (an undo can shorten retention too)
  // need the same separate approval as a forward restore's.
  const contentEffects = classifyContentEffects(plan.operations);
  const impact = deps.assessDeletePlanFn({ liveResources: targetResources, plannedResources: plan.operations });
  const impactRefusals = impact.refusals.map((refusal) => ({
    naturalKey: refusal.deleting,
    reason: `dependent impact: ${refusal.dependent} still references ${refusal.deleting} at ${refusal.field}`,
  }));
  const digest = deps.computePlanDigestFn({
    snapshotId: forward.snapshotId,
    selection: scopeKeys,
    closureKeys: scopeKeys,
    targetTenantId: targetConfig.tenantId,
    collectorConfigPath,
    targetConfigPath,
    reconciliationResources: null,
    waves: [order],
    patches: [],
    contentEffects: contentEffects.effects,
    compensation: compensationDigestInput(plan),
  });
  const fingerprint = deps.computeCurrentStateFingerprintFn(targetResources, scopeKeys);
  const protectedPrincipalIds = targetResources
    .filter((resource) => resource.resourceType === 'roleAssignment' && resource.naturalKey.includes('GlobalAdministrator'))
    .map((resource) => resource.payload.principalId);
  const deletionGuardOptions = {
    breakGlassUserIds: protectedPrincipalIds,
    breakGlassGroupIds: [],
    keelAppIds: [],
    caPolicies: targetResources.filter((resource) => resource.resourceType === 'conditionalAccessPolicy'),
  };
  const existingTargetIds = new Map(targetResources.map((resource) => [resource.naturalKey, resource.sourceId]));
  return {
    plan, order, scopeKeys, contentEffects, impactRefusals, digest, fingerprint,
    targetReader, protectedPrincipalIds, deletionGuardOptions, existingTargetIds,
  };
}

function logCompensation(logger, plan) {
  logger.log(`compensation of ${plan.compensates}: ${plan.operations.length} inverse write(s), ${plan.conflicts.length} conflict(s), ${plan.notApplied.length} not applied, ${plan.manual.length} manual, ${plan.irrecoverable.length} irrecoverable`);
  for (const conflict of plan.conflicts) logger.log(`  conflict: ${conflict.naturalKey} — ${conflict.reason}`);
  for (const item of plan.irrecoverable) logger.log(`  irrecoverable: ${item.naturalKey} — ${item.reason}`);
  for (const item of plan.manual) logger.log(`  manual: ${item.naturalKey} — ${item.reason}`);
  logger.log(`  ${plan.statement}`);
}

async function planCompensationRun({ client, compensateArtifactId, persistArtifactId, requestedBy, readFile, logger, deps }) {
  const forward = await deps.getDryRunArtifactByIdFn(client, { id: compensateArtifactId });
  if (!forward) throw new Error(`compensation refused: restore artifact not found: ${compensateArtifactId}`);
  const collectorConfig = JSON.parse(readFile(forward.collectorConfigPath, 'utf8'));
  const targetConfig = JSON.parse(readFile(forward.targetConfigPath, 'utf8'));
  assertSeparateRestorer(collectorConfig, targetConfig);

  const ctx = await buildCompensation({
    client, forward, collectorConfig, targetConfig,
    collectorConfigPath: forward.collectorConfigPath, targetConfigPath: forward.targetConfigPath, deps,
  });
  logCompensation(logger, ctx.plan);

  // The same capability, recovery, deletion and sign-in guards as any write,
  // evaluated without writing.
  const dry = ctx.plan.operations.length > 0
    ? await deps.applyWaveFn(null, new deps.ThrottleGovernorClass(WRITE_SEEDS(targetConfig.tenantId)), ctx.plan.operations, {
      targetTenant: targetConfig.tenantId,
      mode: 'dry-run',
      existingTargetIds: ctx.existingTargetIds,
      deletionGuardOptions: ctx.deletionGuardOptions,
    })
    : { applied: [], skipped: [], failed: [], notRemediable: [] };
  const refusals = [...ctx.impactRefusals, ...ctx.contentEffects.refusals];
  const results = {
    applied: dry.applied,
    skipped: [...dry.skipped, ...refusals],
    failed: dry.failed,
    notRemediable: dry.notRemediable ?? [],
  };
  const status = deps.classifyDryRunStatusFn(results);

  if (persistArtifactId !== undefined) {
    await deps.createDryRunArtifactFn(client, {
      id: persistArtifactId,
      tenantRef: forward.tenantRef,
      snapshotId: forward.snapshotId,
      selection: ctx.scopeKeys,
      closureKeys: ctx.scopeKeys,
      targetTenantId: targetConfig.tenantId,
      collectorConfigPath: forward.collectorConfigPath,
      targetConfigPath: forward.targetConfigPath,
      reconciliationResources: null,
      waves: [ctx.order],
      patches: [],
      guardRefusals: results.skipped,
      results,
      currentStateFingerprint: ctx.fingerprint,
      digest: ctx.digest,
      status,
      requestedBy: requestedBy ?? 'keel-restore',
      contentEffects: ctx.contentEffects.effects,
      compensation: ctx.plan,
    });
    logger.log(`persisted compensation dry-run artifact ${persistArtifactId} (status: ${status})`);
  }

  return {
    mode: 'dry-run',
    compensation: ctx.plan,
    results,
    status,
    contentEffects: ctx.contentEffects.effects,
    artifactId: persistArtifactId ?? null,
  };
}

async function executeCompensationRun({ client, artifact, collectorConfig, targetConfig, logger, deps }) {
  const forward = await deps.getDryRunArtifactByIdFn(client, { id: artifact.compensation.compensates });
  if (!forward) throw new Error(`compensation promotion refused: the compensated restore ${artifact.compensation.compensates} no longer exists`);
  const ctx = await buildCompensation({
    client, forward, collectorConfig, targetConfig,
    collectorConfigPath: artifact.collectorConfigPath, targetConfigPath: artifact.targetConfigPath, deps,
  });
  // Exactly the forward promotion gate: a changed journal, plan or target refuses
  // before a single write; the compensation's content effects need their own
  // separate approval.
  const validation = deps.validateArtifactForExecutionFn(artifact, { digest: ctx.digest, currentStateFingerprint: ctx.fingerprint });
  if (!validation.ok) throw new Error(`compensation promotion refused: ${validation.reason}`);
  await deps.assertContentEffectApprovalFn(client, { artifact, effects: ctx.contentEffects.effects });
  logCompensation(logger, ctx.plan);

  const results = { applied: [], skipped: [], failed: [], notRemediable: [] };
  if (ctx.plan.operations.length > 0) {
    const { accessToken: restorerToken } = await deps.getTokenFn(targetConfig);
    const writer = new deps.GraphWriterClass(async () => restorerToken);
    const result = await deps.applyWaveFn(writer, new deps.ThrottleGovernorClass(WRITE_SEEDS(targetConfig.tenantId)), ctx.plan.operations, {
      targetTenant: targetConfig.tenantId,
      mode: 'enforce',
      existingTargetIds: ctx.existingTargetIds,
      // The compensation is itself journaled under its own artifact, so a partial
      // compensation can in turn be compensated.
      rollbackClient: client,
      runId: `run-compensation-${artifact.id}`,
      restoreRef: artifact.id,
      deletionGuardOptions: ctx.deletionGuardOptions,
      signInPathGate: { reader: ctx.targetReader, protectedPrincipalIds: ctx.protectedPrincipalIds },
    });
    results.applied.push(...result.applied);
    results.skipped.push(...result.skipped);
    results.failed.push(...result.failed);
    results.notRemediable.push(...(result.notRemediable ?? []));
  }
  logger.log(`compensation applied ${results.applied.length}, skipped ${results.skipped.length}, failed ${results.failed.length}`);
  if (results.failed.length > 0) {
    throw new Error('compensation had failures — stopping (every inverse write is journaled; plan a fresh compensation from the current state)');
  }
  return { mode: 'enforce', compensation: ctx.plan, results, artifactId: artifact.id };
}

// Roadmap task-152: turning on one Conditional Access policy a promoted restore
// left report-only. Recomputed from the restore, its open enforcement item, the
// snapshot and a FRESH read of the target every time — at the dry run and again at
// promotion — so the digest and fingerprint bind exactly the policy approved.
async function buildEnforcement({ client, forward, naturalKey, collectorConfig, targetConfig, collectorConfigPath, targetConfigPath, deps }) {
  const pending = await findEnforcementItem(client, { tenantRef: forward.tenantRef, restoreRef: forward.id, naturalKey });
  const { rows } = await client.query(
    'SELECT payload FROM resource_version WHERE snapshot_id = $1 AND natural_key = $2',
    [forward.snapshotId, naturalKey],
  );
  const { accessToken: collectorToken } = await deps.getTokenFn(collectorConfig);
  const targetReader = new deps.GraphReaderClass(async () => collectorToken);
  const targetResources = deps.canonicalizeAllFn(await deps.collectM1Fn(targetReader));
  const current = targetResources.find((resource) => resource.naturalKey === naturalKey && resource.resourceType === 'conditionalAccessPolicy');
  const live = current ? { targetId: current.sourceId, payload: current.payload } : null;
  const snapshotPayload = rows[0]?.payload ?? null;
  // Turned on outside KEEL since the restore, and matching the backup: nothing
  // to plan; the caller closes the step from this reading.
  if (observedTurnedOn({ pendingItem: pending, snapshotPayload, live })) return { observedOn: true, pending, live };
  let plan;
  try {
    plan = planConditionalAccessEnforcement({
      restoreRef: forward.id, naturalKey, pendingItem: pending, snapshotPayload, live,
    });
  } catch (error) {
    if (error instanceof EnforcementRefusal) throw new Error(`enforcement refused: ${error.message}`);
    throw error;
  }

  // The break-glass lockout gate, with this policy turned on as the proposed
  // change. Group membership is read for the policy as proposed, so a group it
  // names that the collected policies do not is still resolved (or stays unknown).
  let lockoutGate;
  try {
    const inputs = await deps.loadLockoutGateInputsFn(client, { tenantRef: forward.tenantRef });
    const desired = { ...live.payload, state: ENFORCED };
    inputs.groupMembers = await deps.loadGroupMembershipFn(client, forward.tenantRef,
      withProposedConditionalAccessPolicy(inputs.inventory, { naturalKey, desired }));
    lockoutGate = breakGlassLockoutGate(inputs);
  } catch (error) {
    lockoutGate = closedLockoutGate(`break-glass readiness could not be read: ${error.message}`);
  }

  const scopeKeys = [naturalKey];
  const digest = deps.computePlanDigestFn({
    snapshotId: forward.snapshotId,
    selection: scopeKeys,
    closureKeys: scopeKeys,
    targetTenantId: targetConfig.tenantId,
    collectorConfigPath,
    targetConfigPath,
    reconciliationResources: null,
    waves: [scopeKeys],
    patches: [],
    conditionalAccessEnforcement: plan,
  });
  const fingerprint = deps.computeCurrentStateFingerprintFn(targetResources, scopeKeys);
  const protectedPrincipalIds = targetResources
    .filter((resource) => resource.resourceType === 'roleAssignment' && resource.naturalKey.includes('GlobalAdministrator'))
    .map((resource) => resource.payload.principalId);
  return { plan, live, lockoutGate, digest, fingerprint, scopeKeys, targetReader, protectedPrincipalIds, pending };
}

async function planEnforcementRun({ client, request, persistArtifactId, requestedBy, readFile, logger, deps }) {
  const forward = await deps.getDryRunArtifactByIdFn(client, { id: request.restoreArtifactId });
  if (!forward) throw new Error(`enforcement refused: restore artifact not found: ${request.restoreArtifactId}`);
  const collectorConfig = JSON.parse(readFile(forward.collectorConfigPath, 'utf8'));
  const targetConfig = JSON.parse(readFile(forward.targetConfigPath, 'utf8'));
  assertSeparateRestorer(collectorConfig, targetConfig);
  const ctx = await buildEnforcement({
    client, forward, naturalKey: request.naturalKey, collectorConfig, targetConfig,
    collectorConfigPath: forward.collectorConfigPath, targetConfigPath: forward.targetConfigPath, deps,
  });
  if (ctx.observedOn) {
    // Nothing is written to the tenant: the step is closed from the live reading.
    const closed = await closeEnforcementItem(client, {
      tenantRef: forward.tenantRef, itemId: ctx.pending.id,
      observedOn: { restoreRef: forward.id, observedAt: new Date().toISOString() },
    });
    logger.log(`turn on ${request.naturalKey}: already on outside KEEL and matching the backup — step closed`);
    return {
      mode: 'dry-run', status: 'completed', observedOn: true, completionItem: closed.item, artifactId: null,
      results: { applied: [], skipped: [], failed: [], notRemediable: [] },
    };
  }
  // The lockout gate is evaluated (the sign-in path gate runs only around the
  // write, at execution); nothing is written.
  const dry = await applyConditionalAccessEnforcement(null, ctx.plan, { mode: 'dry-run', live: ctx.live, lockoutGate: ctx.lockoutGate });
  const results = { ...dry, notRemediable: [] };
  const status = deps.classifyDryRunStatusFn(results);
  logger.log(`turn on ${ctx.plan.naturalKey}: ${status}${dry.skipped[0] ? ` — ${dry.skipped[0].reason}` : ''}`);

  if (persistArtifactId !== undefined) {
    await deps.createDryRunArtifactFn(client, {
      id: persistArtifactId,
      tenantRef: forward.tenantRef,
      snapshotId: forward.snapshotId,
      selection: ctx.scopeKeys,
      closureKeys: ctx.scopeKeys,
      targetTenantId: targetConfig.tenantId,
      collectorConfigPath: forward.collectorConfigPath,
      targetConfigPath: forward.targetConfigPath,
      reconciliationResources: null,
      waves: [ctx.scopeKeys],
      patches: [],
      guardRefusals: results.skipped,
      results,
      currentStateFingerprint: ctx.fingerprint,
      digest: ctx.digest,
      status,
      requestedBy: requestedBy ?? 'keel-restore',
      conditionalAccessEnforcement: ctx.plan,
    });
    logger.log(`persisted enforcement dry-run artifact ${persistArtifactId} (status: ${status})`);
  }
  return { mode: 'dry-run', conditionalAccessEnforcement: ctx.plan, results, status, artifactId: persistArtifactId ?? null };
}

/** The approval that promoted this artifact: approved, by someone other than the requester. */
async function enforcementApproval(client, artifactId) {
  const { rows } = await client.query(
    `SELECT requested_by, decided_by, justification FROM approval_request
      WHERE action = 'restore' AND status = 'approved' AND params->>'artifactId' = $1
        AND decided_by IS NOT NULL AND decided_by <> requested_by
      ORDER BY decided_at DESC LIMIT 1`,
    [artifactId],
  );
  return rows[0] ? { approvedBy: rows[0].decided_by, reason: rows[0].justification ?? `approved restore ${artifactId}` } : null;
}

async function executeEnforcementRun({ client, artifact, collectorConfig, targetConfig, logger, deps }) {
  const forward = await deps.getDryRunArtifactByIdFn(client, { id: artifact.conditionalAccessEnforcement.promotes });
  if (!forward) throw new Error(`enforcement promotion refused: the restore ${artifact.conditionalAccessEnforcement.promotes} no longer exists`);
  const ctx = await buildEnforcement({
    client, forward, naturalKey: artifact.conditionalAccessEnforcement.naturalKey, collectorConfig, targetConfig,
    collectorConfigPath: artifact.collectorConfigPath, targetConfigPath: artifact.targetConfigPath, deps,
  });
  if (ctx.observedOn) throw new Error('enforcement promotion refused: the policy is already turned on — plan the step again to close it');
  // Exactly the forward promotion gate: a changed plan or policy refuses first.
  const validation = deps.validateArtifactForExecutionFn(artifact, { digest: ctx.digest, currentStateFingerprint: ctx.fingerprint });
  if (!validation.ok) throw new Error(`enforcement promotion refused: ${validation.reason}`);
  const approval = await enforcementApproval(client, artifact.id);
  if (!approval) throw new Error('enforcement promotion refused: turning a Conditional Access policy on needs an approved request from someone other than the requester');

  const { accessToken: restorerToken } = await deps.getTokenFn(targetConfig);
  const writer = new deps.GraphWriterClass(async () => restorerToken);
  // The same bounded throttle retry (429/503, Retry-After) applyWave uses.
  const governor = new deps.ThrottleGovernorClass(WRITE_SEEDS(targetConfig.tenantId));
  const result = await applyConditionalAccessEnforcement(writer, ctx.plan, {
    retryOperation: (operation) => retryThrottledGraphOperation(operation, {
      governor, targetTenant: targetConfig.tenantId, operationClass: 'write',
    }),
    mode: 'enforce',
    live: ctx.live,
    lockoutGate: ctx.lockoutGate,
    approval,
    signInPathGate: { reader: ctx.targetReader, protectedPrincipalIds: ctx.protectedPrincipalIds },
    rollbackClient: client,
    runId: `run-enforcement-${artifact.id}`,
    restoreRef: artifact.id,
  });
  const results = { ...result, notRemediable: [] };
  logger.log(`turn on ${ctx.plan.naturalKey}: applied ${results.applied.length}, skipped ${results.skipped.length}, failed ${results.failed.length}`);
  if (results.skipped.length > 0) throw new Error(`enforcement promotion refused: ${results.skipped[0].reason}`);
  if (results.failed.length > 0) {
    if (results.failed[0].policyMayBeOn) {
      logger.error(`WARNING: ${results.failed[0].error}`);
      await emitCompletionItems(client, {
        tenantRef: forward.tenantRef, restoreRef: forward.id, owner: artifact.requestedBy ?? null,
        applied: [{ naturalKey: ctx.plan.naturalKey, resourceType: 'conditionalAccessPolicy', mechanism: 'update-existing', stateUnconfirmed: true }],
      });
    }
    throw new Error(`enforcement failed: ${results.failed[0].error}`);
  }
  const closed = await closeEnforcementItem(client, {
    tenantRef: forward.tenantRef, itemId: ctx.pending.id, artifactId: artifact.id, approvedBy: approval.approvedBy,
  });
  return { mode: 'enforce', conditionalAccessEnforcement: ctx.plan, results, completionItem: closed.item, artifactId: artifact.id };
}

export async function main({
  argv = process.argv,
  readFile = readFileSync,
  dbUrl = process.env.KEEL_DB_URL,
  dependencies,
  logger = console,
} = {}) {
  const planId = arg('plan', undefined, argv);
  const snapshotId = arg('snapshot-id', undefined, argv);
  const selection = argAll('select', argv);
  const artifactId = arg('artifact', undefined, argv);
  const persistArtifactId = arg('persist-artifact', undefined, argv);
  const compensateArtifactId = arg('compensate', undefined, argv);
  const enforceRestoreArtifactId = arg('enforce-conditional-access', undefined, argv);
  const enforcePolicy = arg('policy', undefined, argv);
  const requestedBy = arg('requested-by', undefined, argv);
  const incidentId = arg('incident', undefined, argv);
  const mode = flag('enforce', argv) ? 'enforce' : 'dry-run';

  // Task-70: a compensation is planned from the promoted restore's own journal and
  // frozen config — never with --enforce, and never alongside another scope.
  if (compensateArtifactId !== undefined) {
    if (planId || snapshotId || selection.length || artifactId !== undefined || incidentId !== undefined) {
      throw new Error('--compensate is mutually exclusive with --plan/--snapshot-id/--select/--artifact/--incident');
    }
    if (mode === 'enforce') {
      throw new Error('--compensate is a dry run only; execute it by promoting the compensation artifact with --artifact <id> --enforce');
    }
    return runRestore({
      compensateArtifactId, persistArtifactId, requestedBy, mode, readFile, dbUrl, dependencies, logger,
    });
  }

  // Task-152: turning a Conditional Access policy on is planned from one promoted
  // restore and one policy — never with --enforce, and never alongside another scope.
  if (enforceRestoreArtifactId !== undefined) {
    if (planId || snapshotId || selection.length || artifactId !== undefined || incidentId !== undefined) {
      throw new Error('--enforce-conditional-access is mutually exclusive with --plan/--snapshot-id/--select/--artifact/--incident');
    }
    if (!enforcePolicy) throw new Error('--enforce-conditional-access requires --policy <naturalKey>');
    if (mode === 'enforce') {
      throw new Error('--enforce-conditional-access is a dry run only; execute it by promoting that artifact with --artifact <id> --enforce after approval');
    }
    return runRestore({
      enforceConditionalAccess: { restoreArtifactId: enforceRestoreArtifactId, naturalKey: enforcePolicy },
      persistArtifactId, requestedBy, mode, readFile, dbUrl, dependencies, logger,
    });
  }

  // Plan task 8: --artifact promotes a completed dry-run artifact and is the ONLY way
  // to reach --enforce for every restore scope — it carries its own frozen
  // snapshot, selection and target config paths, so it is mutually exclusive with
  // every other scope flag.
  if (artifactId !== undefined && (planId || snapshotId || selection.length)) {
    throw new Error('--artifact is mutually exclusive with --plan/--snapshot-id/--select — a promotion is driven entirely by its dry-run artifact');
  }
  if (artifactId !== undefined && mode !== 'enforce') {
    throw new Error('--artifact may only be used with --enforce');
  }
  if (persistArtifactId !== undefined && mode === 'enforce') {
    throw new Error('--persist-artifact may only be used for a dry run, never with --enforce');
  }
  // --plan and --snapshot-id/--select are two scopes for the one apply path; mixing
  // them is a usage error, and so is either half of the selection scope on its own.
  if (planId && (snapshotId || selection.length)) {
    throw new Error('--plan is mutually exclusive with --snapshot-id/--select');
  }
  if (!snapshotId && selection.length) throw new Error('--select requires --snapshot-id');
  // Task-71: a promotion's incident comes from its artifact, never from argv.
  if (incidentId !== undefined && (artifactId !== undefined || !snapshotId)) {
    throw new Error('--incident requires --snapshot-id/--select (a promotion carries its incident in the dry-run artifact)');
  }
  if (snapshotId && !selection.length) throw new Error('--snapshot-id requires at least one --select <naturalKey>');
  if (!planId && !snapshotId && !artifactId) {
    throw new Error('--plan <id>, --snapshot-id <id> with --select <naturalKey>, or --artifact <id> required');
  }
  if (mode === 'enforce' && !artifactId) {
    throw new Error('enforce requires --artifact <id> (promote a completed dry-run artifact; a direct enforce is refused)');
  }

  // A promotion (--artifact) loads its own frozen target/collector config paths from
  // the artifact row inside runRestore — argv never supplies them for that scope.
  let targetConfig;
  let collectorConfig;
  let collectorConfigPath;
  let targetConfigPath;
  if (artifactId === undefined) {
    targetConfigPath = arg('target-config', undefined, argv);
    if (!targetConfigPath) throw new Error('--target-config <path> required');
    targetConfig = JSON.parse(readFile(targetConfigPath, 'utf8'));
    collectorConfigPath = arg('collector-config', undefined, argv);
    if (!collectorConfigPath) throw new Error('--collector-config <path> required for read-only sign-in-path evidence');
    collectorConfig = JSON.parse(readFile(collectorConfigPath, 'utf8'));
    assertSeparateRestorer(collectorConfig, targetConfig);
  }

  return runRestore({
    planId,
    snapshotId,
    selection: selection.length ? selection : undefined,
    targetConfig,
    collectorConfig,
    collectorConfigPath,
    targetConfigPath,
    mode,
    artifactId,
    persistArtifactId,
    incidentId,
    requestedBy,
    readFile,
    acceptDegradation: flag('accept-degradation', argv),
    dbUrl,
    dependencies,
    logger,
  });
}

export async function runCli(options = {}) {
  try {
    await main(options);
    return 0;
  } catch (err) {
    (options.logger ?? console).error(err);
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runCli().then((exitCode) => { process.exitCode = exitCode; });
}
