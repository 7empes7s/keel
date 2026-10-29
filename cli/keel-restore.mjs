#!/usr/bin/env node
// /opt/keel/cli/keel-restore.mjs
//
// node keel-restore.mjs --plan <id> --collector-config /etc/keel/tenant.json --target-config /etc/keel/restorer.json [--enforce] [--accept-degradation]
// node keel-restore.mjs --snapshot-id <id> --select <naturalKey> [--select <naturalKey>...] --collector-config ... --target-config ... [--enforce]
//
// node keel-restore.mjs --snapshot-id <id> --delete <naturalKey> [--delete <naturalKey>...] --collector-config ... --target-config ... [--persist-artifact <id>]
// plans deleting objects that exist live but are absent from the snapshot (gap D7), as a
// dry run. It is executed only by promoting that artifact with --artifact <id> --enforce;
// a key the snapshot holds, or a type Keel cannot delete, is refused.
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
//   [--delete-assigned <naturalKey> ...] [--skip-assigned <naturalKey> ...]
// plans the conflict-aware compensation of one promoted restore (roadmap task-70) as
// a dry run; it is executed only by promoting that compensation artifact with
// --artifact <id> --enforce, through the same approval as any restore. A policy the
// restore created that is assigned now is undone only by choice: --delete-assigned
// removes its assignments and deletes it, --skip-assigned leaves it as it is.
//
// node keel-restore.mjs --enforce-conditional-access <restoreArtifactId> --policy <naturalKey> [--persist-artifact <id>] [--requested-by <who>]
// plans turning on one Conditional Access policy that restore left report-only
// while the backup had it enabled (roadmap task-152), as a dry run. It is executed
// only by promoting that artifact with --artifact <id> --enforce after an approver
// other than the requester approved it; the break-glass lockout gate runs at both.
//
// node keel-restore.mjs --compliance-fix <controlId> --object <naturalKey> --collector-config ... --target-config ... [--persist-artifact <id>] [--requested-by <who>]
// plans "Make it pass" for one object a compliance control fails on (CoreView gap 6):
// the one setting the control's fix names is changed and everything else on the
// object is written back as it is live. A dry run only; it is executed only by
// promoting that artifact with --artifact <id> --enforce after an approver other
// than the requester approved it. The source is the newest backup holding the object.
//
// node keel-restore.mjs --workload <name> --collection <id> <workload options> [--collector-config <path>] [--persist-artifact <id>] [--requested-by <who>]
// plans a workload configuration restore (SharePoint, Exchange, Teams, Purview) from
// one recorded workload collection, as a dry run (gap register W2). Workload options:
//   sharepoint-site-settings   --tenant-host <host>.sharepoint.com
//   sharepoint-site-grants     --tenant-host <host>.sharepoint.com --site <site id> (one site's app grants)
//   sharepoint-site-permissions --tenant-host <host>.sharepoint.com --site <site id> [--at <ISO time>]
//                              (one site's groups, members, admins, permission levels and role
//                              assignments, from the content backup; no --collection)
//   exchange-mailbox-settings  --mailbox <user principal name> [--include-organization]
//   teams-settings             --team <team id>
//   purview-labels             --target label:<id> | label-policy:<id> (repeatable)
//   exchange-distribution-groups [--target <list name or Guid> ...] (distribution lists and
//                              mail-enabled security groups, through Microsoft365DSC in the
//                              keel-dsc image; settings, and a list that is gone)
//   exchange-role-definitions  --collection <Graph backup id> [--target <role name> ...] (custom
//                              Exchange admin roles that are gone, through Exchange Online
//                              PowerShell: New-ManagementRole from the parent, then trim its entries)
//   mail flow, Exchange settings, Teams org-wide and voice policies, Purview retention,
//   DLP and labels: [--target <key> ...]. A key is `<kind>:<Guid>` for rules, connectors
//   and policies; `<kind>:<Name>` is accepted too and resolves to the one object of that
//   kind with that name (more than one refuses the plan and lists the Guid keys).
// On the test tenant every workload restore writes only KEEL-RT- fixtures (a mailbox,
// team, member, label, policy or site named KEEL-RT-*); --allow-tenant-wide-test-writes
// also plans tenant-wide objects (a Global policy, the SharePoint tenant settings, the
// Exchange organization configuration), and such a plan needs a person's approval.
// It is executed only by promoting that artifact with --artifact <id> --enforce after an
// approver other than the requester approved it; the credential files are the
// server's (engine/restore/credentialPaths.mjs), never argv. The dry run reads with the
// server's collector file too unless --collector-config names another. PowerShell
// (Exchange, Purview, OneDrive, SharePoint, Teams) connects with the family's file from
// the workload scope file (KEEL_WORKLOAD_SCOPE_PATH, default /etc/keel/workload-scope.json):
// powershellConfigs for the dry run, and powershellRestorerConfigs or the collector file's
// -restorer.json sibling for the promotion (issue #542). A family file wins over
// --collector-config for PowerShell; Graph still reads with --collector-config.
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { readConfigFile } from '../engine/config/configFile.mjs';
import { parseCliArgs } from './args.mjs';
import { getToken } from '../tools/tenant-probe/auth.mjs';
import { GraphReader } from '../tools/tenant-probe/graph.mjs';
import { CATALOG } from '../tools/tenant-probe/catalog.mjs';
import { collectM1 } from '../engine/collect/entraAdapter.mjs';
import { tenantRefFor } from '../engine/store/tenantRef.mjs';
import { canonicalizeAll } from '../engine/cir/canonicalize.mjs';
import { connect, getResourceVersions, getReferences } from '../engine/store/db.mjs';
import { planWaves, planDeletionWaves, phaseOneResources } from '../engine/restore/wavePlanner.mjs';
import { deletionScope, dependencyClosure } from '../engine/restore/selection.mjs';
import { assessDeletePlan } from '../engine/graph/impact.mjs';
import { buildReconciliationPlan } from '../engine/reconcile/reconciliationPlan.mjs';
import { ThrottleGovernor } from '../engine/restore/throttleGovernor.mjs';
import { GraphWriter } from '../engine/restore/graphWriter.mjs';
import { applyWave, applyPatches, retryThrottledGraphOperation } from '../engine/restore/applyEngine.mjs';
import { recordTrustSkippedLocations } from '../engine/restore/namedLocationTrust.mjs';
import { breakGlassLockoutGate, closedLockoutGate } from '../engine/safety/lockoutGate.mjs';
import { loadGroupMembership, loadLockoutGateInputs } from '../engine/safety/breakGlassReadiness.mjs';
import { globalAdministratorPrincipalIds } from '../engine/safety/protectedPrincipals.mjs';
import {
  conditionalAccessGroupIds, gateRelationshipOperations, privilegedGroupIds, protectedEdgePrincipalIds,
} from '../engine/safety/edgeLockoutGate.mjs';
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
  createDryRunArtifact, getDryRunArtifactById, plannedVerbsOf, restoreCandidates, validateArtifactForExecution,
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
import { assignmentTargetResolver, attachIntuneAssignments, writesIntuneAssignments } from '../engine/restore/intuneOperations.mjs';
import { closeEnforcementItem, emitCompletionItems, findEnforcementItem } from '../engine/restore/completion.mjs';
import { listJournal, loadCreatedTargetIds } from '../engine/restore/rollbackJournal.mjs';
import { loadSnapshotBrandingAssets } from '../engine/store/brandingAssets.mjs';
import {
  BRANDING_RESOURCE_TYPES, applyBrandingAssetUploads, brandingLocaleFor, brandingUploadDigestInput, planBrandingAssetUploads,
  readLiveBrandingAssets,
} from '../engine/restore/brandingAssets.mjs';
import {
  UNDO_CHOICES, applyUndoChoices, compensationDigestInput, planCompensation, undoChoicesOf,
} from '../engine/restore/compensation.mjs';
import { readUndoAssignments } from '../engine/restore/undoAssignedPolicy.mjs';
import { assertContentEffectApproval, classifyContentEffects } from '../engine/safety/contentEffects.mjs';
import { canonicalHash } from '../engine/cir/canonicalHash.mjs';
import {
  ComplianceFixRefusal, fixFor, fixedPayload, isWorkloadFix, newestSnapshotWith, parseWorkloadFixTarget, planComplianceFix,
} from '../engine/benchmarks/fix.mjs';
import { newestWorkloadRead } from '../engine/benchmarks/runChecks.mjs';
import { planWorkloadComplianceFix } from '../engine/benchmarks/workloadFix.mjs';
import { credentialPaths } from '../engine/restore/credentialPaths.mjs';
import { engageWriterConfigPath, restoreWriterTokens } from '../engine/restore/engageWriter.mjs';
import {
  DEFAULT_SCOPE_PATH as DEFAULT_WORKLOAD_SCOPE_PATH, readWorkloadScope, workloadPowershellConfigPath,
} from '../engine/collect/workloads/powershellConfigs.mjs';
import { workloadWriteQualification } from '../engine/coverage/qualification.mjs';
import { loadWorkloadLedger } from '../engine/collect/workloadLedgerStore.mjs';
import { createPgContentIndex } from '../engine/content/index.mjs';
import { createContentStore, parseContentKey } from '../engine/content/store.mjs';
import { sharePointReadTransport } from '../engine/content/transport.mjs';
import { sitePermissionsWriteTransport } from '../engine/restore/workloads/sharepointRest.mjs';
import { createLocalStorageAdapter } from '../engine/storage/local.mjs';
import {
  WORKLOAD_RESTORES, graphTransport, isWorkloadArtifact, workloadRestoreFor,
} from '../engine/restore/workloads/dispatch.mjs';
import {
  IncidentRecoveryRefusal, applyIncidentExclusions, evaluatePostRestoreChecks, incidentRecoveryDigestInput,
  incidentsCoveringSnapshot, recordPostRestoreChecks, resolveIncidentRecovery,
} from '../engine/govern/incidents.mjs';

// Security audit finding 4: argv is parsed strictly. A value that starts with "-"
// (a restore target such as "--allow-tenant-wide-test-writes") is refused instead of
// being read as a flag, and so is any unknown flag, a positional, or a repeated
// single-value option.
const STRING_OPTIONS = [
  'plan', 'snapshot-id', 'artifact', 'persist-artifact', 'compensate', 'enforce-conditional-access', 'policy',
  'requested-by', 'incident', 'compliance-fix', 'object', 'collector-config', 'target-config', 'workload',
  'collection', 'tenant-host', 'mailbox', 'team', 'site', 'at',
];
const REPEATABLE_OPTIONS = ['select', 'delete', 'target', 'delete-assigned', 'skip-assigned'];
const BOOLEAN_OPTIONS = ['enforce', 'include-organization', 'allow-tenant-wide-test-writes', 'accept-degradation'];

export function parseRestoreArgs(argv = process.argv) {
  return parseCliArgs(argv.slice(2), {
    name: 'keel-restore', strings: STRING_OPTIONS, repeatable: REPEATABLE_OPTIONS, booleans: BOOLEAN_OPTIONS,
  }).values;
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
// The Graph collector (tenant.json) and restorer (restorer.json) files. A missing or
// broken file stops the run with a plain sentence, never a raw ENOENT or JSON error.
const readCollectorConfig = (path, readFile) => readConfigFile(path, { readFile, what: 'collector settings' });
const readRestorerConfig = (path, readFile) => readConfigFile(path, { readFile, what: 'restorer settings' });

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
 *
 * Gap register D1: a tenant-lockout delete is decided from break-glass
 * readiness after the delete, so the gate is loaded for one too.
 */
export async function lockoutGateFor(client, resources, {
  tenantRef, loadInputs = loadLockoutGateInputs, loadMembership = loadGroupMembership,
}) {
  const comingBackOn = resources.filter((resource) => resource.verb === 'restore-soft-deleted'
    && resource.resourceType === 'conditionalAccessPolicy'
    && !offWhenDeleted(resource));
  const planned = comingBackOn.length > 0 || resources.some((resource) => resource.verb && resource.verb !== 'noop'
    && (tenantPolicyRecordFor(resource.resourceType, resource.verb)?.lockout === true
      || (resource.verb === 'delete' && resource.blastRadius === 'tenant-lockout')));
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

// Q45 (live run 2026-10-13): a wave said "failed 1" and the job failed with no
// reason anywhere. Every failure a run counts is printed with its reason, and
// the error that stops the run carries them, so a worker job's output says why.
const failureReason = (entry) => entry?.error ?? entry?.reason ?? 'no reason was recorded';
export function failureSummary(failed) {
  return failed.map((entry) => `${entry?.naturalKey ?? 'unknown'}: ${failureReason(entry)}`).join('; ');
}
// A completion step is a single object on the tenant policy path and a list
// on the identity path; log one line per step either way.
export function completionStepLines(entry) {
  const steps = [entry?.pendingApproval ?? entry?.completion ?? []].flat();
  return steps
    .filter((step) => step && typeof step.description === 'string' && step.description.length > 0)
    .map((step) => `completion step: ${entry.naturalKey} — ${step.description}`);
}
/**
 * Issue #642: what one applied write changed or would change (its fields, and
 * parts written beside them such as an app's categories), so a dry run and
 * its promotion both show a difference that is not in a field. Null when the
 * entry names no change.
 */
export function changeLine(entry) {
  const changes = entry?.changes;
  if (!changes || typeof changes !== 'object') return null;
  const parts = [];
  for (const [name, value] of Object.entries(changes)) {
    if (name === 'fields') {
      if (Array.isArray(value) && value.length > 0) parts.push(`fields ${value.join(', ')}`);
    } else if (value && typeof value === 'object' && !Array.isArray(value)) {
      parts.push(`${name} ${Object.entries(value).map(([key, count]) => `${key} ${typeof count === 'object' ? JSON.stringify(count) : count}`).join(', ')}`);
    } else if (value !== undefined && value !== null) {
      parts.push(`${name} ${Array.isArray(value) ? value.map((item) => (item && typeof item === 'object' ? JSON.stringify(item) : item)).join(', ') : value}`);
    }
  }
  return parts.length > 0 ? `  changes ${entry.naturalKey}: ${parts.join('; ')}` : null;
}
function logFailures(logger, failed) {
  for (const entry of failed) logger.log(`  failed ${entry?.naturalKey ?? 'unknown'}: ${failureReason(entry)}`);
}

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
  // Gap D7: natural keys present live but absent from the snapshot, to delete.
  // A dry run turns them into a reconciliation scope of desired absence (see
  // deletionScope), which the artifact stores and its promotion executes.
  deleteKeys,
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
  // The person's choice for each policy the undo would delete that is assigned
  // now: { [naturalKey]: 'delete' | 'skip' }. Only with compensateArtifactId.
  undoChoices,
  // Roadmap task-152: plan turning on one Conditional Access policy a promoted
  // restore left report-only: { restoreArtifactId, naturalKey }. A dry run only;
  // the resulting artifact is promoted with artifactId after approval.
  enforceConditionalAccess,
  // Gap register W2: plan a workload configuration restore from one recorded
  // workload collection: { workload, collectionId, ...workload options }. A dry run
  // only; the resulting artifact is promoted with artifactId after approval.
  workloadRestore,
  // CoreView gap 6, "Make it pass": plan the one-value fix a failing compliance
  // control declares, for one object: { controlId, naturalKey }. A dry run only;
  // the resulting artifact is promoted with artifactId after approval.
  complianceFix,
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
    previewApplyPlan: previewApplyPlanFn = previewApplyPlan,
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
    loadCreatedTargetIds: loadCreatedTargetIdsFn = loadCreatedTargetIds,
    resolveIncidentRecovery: resolveIncidentRecoveryFn = resolveIncidentRecovery,
    incidentsCoveringSnapshot: incidentsCoveringSnapshotFn = incidentsCoveringSnapshot,
    loadLockoutGateInputs: loadLockoutGateInputsFn = loadLockoutGateInputs,
    loadGroupMembership: loadGroupMembershipFn = loadGroupMembership,
    newestSnapshotWith: newestSnapshotWithFn = newestSnapshotWith,
    newestWorkloadRead: newestWorkloadReadFn = newestWorkloadRead,
    // W2: the workload table, how a workload run reaches the tenant, and which
    // workload writes are qualified. Tests inject fakes; nothing here is a tenant.
    workloadRestores = WORKLOAD_RESTORES,
    workloadConnection: workloadConnectionFn = defaultWorkloadConnection,
    workloadQualifications: workloadQualificationsFn = defaultWorkloadQualifications,
    contentStore: contentStoreFn = defaultContentStore,
    credentialPaths: credentialPathsFn = credentialPaths,
    engageWriterConfigPath: engageWriterConfigPathFn = engageWriterConfigPath,
    workloadScope: workloadScopeFn = defaultWorkloadScope,
    sleep = (ms) => new Promise((done) => { setTimeout(done, ms); }),
    loadSnapshotBrandingAssets: loadSnapshotBrandingAssetsFn = loadSnapshotBrandingAssets,
    readLiveBrandingAssets: readLiveBrandingAssetsFn = readLiveBrandingAssets,
    applyBrandingAssetUploads: applyBrandingAssetUploadsFn = applyBrandingAssetUploads,
  } = dependencies;

  if (incidentId !== undefined) {
    if (typeof incidentId !== 'string' || incidentId.length === 0) throw new Error('incidentId must be a non-empty string');
    if (artifactId !== undefined) throw new Error('incidentId is supplied by the dry-run artifact on promotion, never by the caller');
    if (selection === undefined || planId !== undefined || reconciliationResources !== undefined || compensateArtifactId !== undefined) {
      throw new Error('incidentId requires the snapshotId/selection restore scope');
    }
  }
  if (deleteKeys !== undefined) {
    if (!Array.isArray(deleteKeys) || deleteKeys.length === 0
      || deleteKeys.some((key) => typeof key !== 'string' || key.length === 0)) {
      throw new Error('deleteKeys must be a non-empty array of natural keys');
    }
    if (snapshotId === undefined) throw new Error('deleteKeys requires snapshotId');
    if (planId !== undefined || selection !== undefined || reconciliationResources !== undefined || artifactId !== undefined
      || compensateArtifactId !== undefined || enforceConditionalAccess !== undefined || incidentId !== undefined
      || automationPolicyIds !== undefined) {
      throw new Error('deleteKeys is its own restore scope — a snapshot and the keys to delete, nothing else');
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
  if (workloadRestore !== undefined) {
    if (planId !== undefined || snapshotId !== undefined || selection !== undefined || reconciliationResources !== undefined
      || artifactId !== undefined || automationPolicyIds !== undefined || compensateArtifactId !== undefined
      || enforceConditionalAccess !== undefined || incidentId !== undefined) {
      throw new Error('workloadRestore is its own scope: one recorded workload collection');
    }
    if (typeof workloadRestore?.workload !== 'string' || !workloadRestore.workload) {
      throw new Error('workloadRestore needs the workload name');
    }
    workloadRestoreFor(workloadRestore.workload, workloadRestores);
    if (mode !== 'dry-run') {
      throw new Error('a workload restore is only ever planned as a dry run; execute it by promoting that artifact through the normal approval');
    }
    if (!collectorConfig?.tenantId) throw new Error('a workload restore dry run needs the collector config');
  }
  if (complianceFix !== undefined) {
    if (planId !== undefined || snapshotId !== undefined || selection !== undefined || reconciliationResources !== undefined
      || artifactId !== undefined || automationPolicyIds !== undefined || compensateArtifactId !== undefined
      || enforceConditionalAccess !== undefined || workloadRestore !== undefined || incidentId !== undefined || deleteKeys !== undefined) {
      throw new Error('complianceFix is its own scope: one setting of one object');
    }
    if (typeof complianceFix?.controlId !== 'string' || !complianceFix.controlId
      || typeof complianceFix?.naturalKey !== 'string' || !complianceFix.naturalKey) {
      throw new Error('complianceFix needs the controlId and the object naturalKey');
    }
    if (mode !== 'dry-run') {
      throw new Error('a compliance fix is only ever planned as a dry run; execute it by promoting that artifact through the normal approval');
    }
    if (!collectorConfig?.tenantId) throw new Error('a compliance fix dry run needs the collector config');
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
  if (undoChoices !== undefined) {
    if (compensateArtifactId === undefined) throw new Error('undoChoices are made only when planning an undo (compensateArtifactId)');
    if (undoChoices === null || typeof undoChoices !== 'object' || Array.isArray(undoChoices)
      || Object.entries(undoChoices).some(([key, choice]) => key.length === 0 || !UNDO_CHOICES.includes(choice))) {
      throw new Error(`undoChoices must map natural keys to one of ${UNDO_CHOICES.join(', ')}`);
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
    if (compensateArtifactId === undefined && enforceConditionalAccess === undefined && workloadRestore === undefined
      && complianceFix === undefined && (planId !== undefined || snapshotId === undefined)) {
      throw new Error('persistArtifactId requires the snapshotId/selection restore scope');
    }
  }
  if (planId !== undefined && (snapshotId !== undefined || selection !== undefined || reconciliationResources !== undefined)) {
    throw new Error('planId and snapshotId/selection/reconciliationResources are mutually exclusive restore scopes');
  }
  if (planId === undefined && snapshotId === undefined && artifactId === undefined && compensateArtifactId === undefined
    && enforceConditionalAccess === undefined && workloadRestore === undefined && complianceFix === undefined) {
    throw new Error('a restore scope is required: planId, snapshotId with a selection, artifactId, compensateArtifactId, or workloadRestore');
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
      engageWriterConfigPathFn,
    };
    if (compensateArtifactId !== undefined) {
      return await planCompensationRun({
        client, compensateArtifactId, undoChoices, persistArtifactId, requestedBy, readFile, logger, deps: compensationDeps,
      });
    }
    if (enforceConditionalAccess !== undefined) {
      return await planEnforcementRun({
        client, request: enforceConditionalAccess, persistArtifactId, requestedBy, readFile, logger, deps: compensationDeps,
      });
    }
    const workloadDeps = {
      workloadRestores, workloadConnectionFn, workloadQualificationsFn, credentialPathsFn, workloadScopeFn, getTokenFn, sleep,
      // Opened only by a restore whose backup is in the content store (site permissions).
      contentStore: () => contentStoreFn({ client, readFile }),
    };
    if (workloadRestore !== undefined) {
      return await planWorkloadRun({
        client, request: workloadRestore, collectorConfig, collectorConfigPath, persistArtifactId, requestedBy, readFile, logger, deps: workloadDeps,
      });
    }
    // Gap 6 on a service read (the Defender email checks): one setting of one policy,
    // planned as a workload restore from the live policy.
    if (complianceFix !== undefined && isWorkloadFix(fixFor(complianceFix.controlId))) {
      return await planWorkloadFixRun({
        client, request: complianceFix, collectorConfig, collectorConfigPath, persistArtifactId, requestedBy, readFile, logger,
        deps: { ...workloadDeps, newestWorkloadReadFn },
      });
    }
    // Gap 6: the source of a compliance fix is the newest complete backup that
    // holds the object, found here, never named by the caller.
    if (complianceFix !== undefined) {
      snapshotId = await newestSnapshotWithFn(client, {
        tenantRef: tenantRefFor(collectorConfig.tenantId), naturalKey: complianceFix.naturalKey,
      });
      if (!snapshotId) throw new Error(`compliance fix refused: no complete backup holds ${complianceFix.naturalKey}`);
      selection = [complianceFix.naturalKey];
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
      // W2: a workload artifact has no snapshot and its config paths are only the
      // marker `workload:<name>`, so it is promoted before any snapshot or file read.
      if (isWorkloadArtifact(artifact)) {
        return await executeWorkloadRun({ client, artifact, readFile, logger, deps: workloadDeps });
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
      collectorConfig = readCollectorConfig(collectorConfigPath, readFile);
      targetConfig = readRestorerConfig(targetConfigPath, readFile);
      assertSeparateRestorer(collectorConfig, targetConfig);
      // Task-70: a compensation artifact is promoted here, through this same
      // artifact gate — never by a separate undo path.
      if (artifact.compensation) {
        return await executeCompensationRun({
          client, artifact, collectorConfig, targetConfig, readFile, logger, deps: compensationDeps,
        });
      }
      // Gap 6: a compliance fix is promoted through the restore path below, but
      // only with an approval decided by someone other than the requester.
      if (artifact.complianceFix && !(await enforcementApproval(client, artifact.id))) {
        throw new Error('restore promotion refused: a compliance fix needs an approved request from someone other than the requester');
      }
      // Task-152: turning a Conditional Access policy on is promoted here too.
      if (artifact.conditionalAccessEnforcement) {
        return await executeEnforcementRun({
          client, artifact, collectorConfig, targetConfig, logger, deps: compensationDeps,
        });
      }
    }
    // Gap 6: the fix this run plans (a dry run) or promotes (from its artifact).
    const fixRequest = artifact ? (artifact.complianceFix ?? null) : (complianceFix ?? null);
    let fixPlan = null;
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
    // Gap D7: the delete scope is checked against this snapshot and becomes the
    // reconciliation scope below, so it is persisted, digested and promoted
    // exactly like a drift remediation's added-object delete.
    if (deleteKeys !== undefined) {
      reconciliationResources = deletionScope(resources, deleteKeys);
      logger.log(`delete scope: ${reconciliationResources.map((resource) => resource.naturalKey).join(', ')}`);
    }

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
      // Gap 6: a compliance fix writes one object and nothing it depends on.
      if (fixRequest && (resources.length !== 1 || (resources[0].references ?? []).length > 0)) {
        throw new Error(`${artifact ? 'restore promotion refused: ' : ''}compliance fix refused: ${fixRequest.naturalKey} points to other objects, so Keel cannot change one setting on its own`);
      }
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
      // Issue #681: Viva Engage writes sign in as the Engage writer when it is set up.
      const { tokenFor } = await restoreWriterTokens({
        getTokenFn, targetConfig, collectorConfig, readFile, logger,
        resourceTypes: resources.map((resource) => resource.resourceType),
        path: engageWriterConfigPathFn(),
      });
      writer = new GraphWriterClass(tokenFor);
    }

    // Re-collect the target's CURRENT state — not what planning saw — so a retry
    // after a partial failure treats already-created resources as done instead
    // of re-creating them (spec §9.3; see Task 17's idempotency fix).
    // Issue #289: a type the tenant has no licence for is skipped unless this
    // restore touches it, so one unlicensed workload does not block every restore.
    const neededTypes = new Set(resources.map((resource) => resource.resourceType));
    const targetCollected = await collectM1Fn(targetReader, { needed: neededTypes });
    // Issue #466: a type this restore does not touch that cannot be read is
    // left out and listed, not read as empty. Deletes stay refused below.
    const unreadTypes = unreadTypesOf(targetCollected);
    for (const { type, error } of targetCollected?.unread ?? []) logger.log(`current state: ${type} not read (not in this restore): ${error}`);
    const targetResources = canonicalizeAllFn(targetCollected);
    // Gap 6: the desired state of a compliance fix is the object as it is live,
    // with the one setting changed, so nothing else on it is written back from
    // the backup. Planned from this fresh read at the dry run and again at
    // promotion; the digest binds the plan and the fingerprint the live object.
    if (fixRequest) {
      const live = targetResources.find((resource) => resource.naturalKey === fixRequest.naturalKey
        && resource.resourceType === resources[0]?.resourceType);
      try {
        fixPlan = planComplianceFix({ controlId: fixRequest.controlId, naturalKey: fixRequest.naturalKey, live });
      } catch (error) {
        if (error instanceof ComplianceFixRefusal) throw new Error(`${artifact ? 'restore promotion refused: ' : ''}compliance fix refused: ${error.message}`);
        throw error;
      }
      if (artifact && (fixPlan.field !== artifact.complianceFix.field || fixPlan.to !== artifact.complianceFix.to)) {
        throw new Error('restore promotion refused: the control\'s fix changed since the dry run — a new dry run is required');
      }
      const payload = fixedPayload(live.payload, fixPlan);
      resources = [{ ...resources[0], payload, payloadHash: canonicalHash(payload, fixPlan.resourceType) }];
      logger.log(`compliance fix: ${fixPlan.naturalKey} ${fixPlan.field} ${JSON.stringify(fixPlan.from)} -> ${JSON.stringify(fixPlan.to)}`);
    }
    const existingTargetIds = new Map(targetResources.map((r) => [r.naturalKey, r.sourceId]));
    const protectedPrincipalIds = globalAdministratorPrincipalIds(targetResources);
    const deletionGuardOptions = {
      breakGlassUserIds: protectedPrincipalIds,
      breakGlassGroupIds: [],
      keelAppIds: [],
      caPolicies: targetResources.filter((resource) => resource.resourceType === 'conditionalAccessPolicy'),
    };
    // Same-tenant restore: a live object is matched by its object id before its
    // natural key, so a renamed policy is updated (name put back), not recreated.
    const sameTenant = sourceTenantRef === tenantRefFor(collectorConfig.tenantId);
    // Issue #485: what earlier restores created into this tenant, by backup key,
    // so a re-run from the same snapshot finds a recreated object by its new id.
    const createdTargetIds = await loadCreatedTargetIdsFn(client, { targetTenantId: targetConfig?.tenantId ?? collectorConfig.tenantId });
    const reconciliation = await buildReconciliationPlanFn(targetReader, resources, { targetResources, sameTenant, createdTargetIds });
    resources = reconciliation.resources;
    if (fixPlan && resources[0]?.verb !== 'update') {
      throw new Error(`${artifact ? 'restore promotion refused: ' : ''}compliance fix refused: ${fixPlan.naturalKey} would be ${resources[0]?.verb ?? 'left out'}, not updated in place`);
    }
    // Security audit run 1, finding 2: the write carries its fix, so the named
    // location trust gate lets through exactly this one setting and no other.
    if (fixPlan) resources = [{ ...resources[0], complianceFix: fixPlan }];
    // An object matched by id under another name is known to the plan alone: its
    // snapshot key resolves to the live id for references and relationship edges.
    for (const resource of resources) {
      if (resource.live?.state === 'present' && !existingTargetIds.has(resource.naturalKey)) {
        existingTargetIds.set(resource.naturalKey, resource.live.targetId);
      }
    }
    // Issue #155: an Intune policy carries the assignments its backup observed, so
    // applyWave writes them through /assign; a policy whose only change is its
    // assignments is planned as an update. Selection scope only (an operator-picked
    // restore and its promotion), like group edges: a remediation or legacy plan
    // scope leaves assignments untouched, and the plan says so for each policy.
    // Restore gaps batch 14: the Wave 2 records that write assignments (scripts,
    // remediations, templates, update profiles, branding, app policies) too.
    if (selection !== undefined && reconciliationResources === undefined && !fixRequest) {
      const intuneParents = resources.filter((resource) => writesIntuneAssignments(resource.resourceType) && resource.verb !== 'delete');
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
          resolve: assignmentTargetResolver(resources, existingTargetIds),
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
    // Issue #683: what this plan does to each resource. A dry run stores it and
    // its promotion compares, so a write the reviewed plan did not list is refused.
    const plannedVerbs = plannedVerbsOf(resources);
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
    if (selection !== undefined && reconciliationResources === undefined && !fixRequest) {
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
            // groupTypes is immutable, so snapshot and live agree; either saying
            // dynamic is enough for the planner to skip member edges.
            groupTypes: [...new Set([...(resource.payload?.groupTypes ?? []), ...(resource.live?.payload?.groupTypes ?? [])])],
          }));
        const liveParents = edgeParents.filter((parent) => typeof parent.liveTargetId === 'string');
        const liveObservations = liveParents.length === 0 ? [] : await collectRelationshipsFn(targetReader, {
          tenantRef: collectorConfig.tenantId,
          parents: liveParents.map((parent) => ({ type: 'group', sourceId: parent.liveTargetId, naturalKey: parent.naturalKey })),
          families: RELATIONSHIP_RESTORE_FAMILIES,
        });
        const naturalKeyById = new Map([...existingTargetIds].map(([naturalKey, id]) => [String(id).toLowerCase(), naturalKey]));
        // Security audit run 2, finding 1: the registered break-glass accounts are
        // protected like Global Administrators, and member writes that can change
        // their readiness go through the lockout gate with the proposed membership.
        let edgeGateInputs = null;
        let edgeGateError = null;
        try {
          edgeGateInputs = await loadLockoutGateInputsFn(client, { tenantRef: tenantRefFor(collectorConfig.tenantId) });
        } catch (error) {
          edgeGateError = error.message;
        }
        const edgeProtectedIds = protectedEdgePrincipalIds(targetResources, (edgeGateInputs?.accounts ?? []).map((account) => account.accountId));
        relationshipPlan = planRelationshipOperations({
          parents: edgeParents,
          desired: desiredEdges,
          live: new Map(liveObservations.map((obs) => [`${obs.parentNaturalKey}|${obs.family}`, obs])),
          resolveTargetId: (naturalKey) => existingTargetIds.get(naturalKey) ?? null,
          pendingCreates: new Set(resources
            .filter((resource) => resource.verb === 'create' || resource.verb === 'restore-soft-deleted')
            .map((resource) => resource.naturalKey)),
          naturalKeyForTargetId: (id) => naturalKeyById.get(id) ?? null,
          protectedPrincipalIds: edgeProtectedIds,
        });
        const gatedEdges = gateRelationshipOperations({
          operations: relationshipPlan.operations,
          parentTargetIds: new Map(liveParents.map((parent) => [parent.naturalKey, parent.liveTargetId])),
          caGroupIds: conditionalAccessGroupIds(targetResources),
          privilegedGroupIds: privilegedGroupIds(targetResources),
          inputs: edgeGateInputs,
          loadError: edgeGateError,
        });
        relationshipPlan = { ...relationshipPlan, operations: gatedEdges.operations, refusals: [...relationshipPlan.refusals, ...gatedEdges.refusals] };
        for (const note of relationshipPlan.notes) logger.log(`relationship edges not reconciled: ${note.note}`);
        logger.log(`relationship edges: ${relationshipPlan.operations.length} planned, ${relationshipPlan.refusals.length} refused`);
      }
    }
    const relationshipOperations = relationshipPlan.operations;
    const relationshipFingerprint = { relationships: relationshipPlan.observed };

    // Gap register M6: the company branding files (images, favicon, custom
    // stylesheet) of each restored branding locale. Selection scope only, like
    // relationship edges. Each backed-up file is compared with the live one by
    // hash; only those that differ are uploaded, after the objects' own writes.
    // A snapshot that holds no files plans nothing.
    let brandingPlan = { uploads: [], unchanged: [], refusals: [], notes: [] };
    if (selection !== undefined && reconciliationResources === undefined && !fixRequest) {
      const brandingResources = resources.filter((resource) => BRANDING_RESOURCE_TYPES.includes(resource.resourceType) && resource.verb !== 'delete');
      const locales = [...new Set(brandingResources.map(brandingLocaleFor).filter(Boolean))].sort();
      const desiredFiles = locales.length === 0 ? [] : await loadSnapshotBrandingAssetsFn(client, { snapshotId: sourceSnapshot, locales });
      if (desiredFiles.length > 0) {
        const liveLocales = new Set(brandingResources.filter((resource) => resource.live?.state === 'present').map(brandingLocaleFor));
        const live = await readLiveBrandingAssetsFn(targetReader, { organizationId: targetConfig.tenantId, locales: [...liveLocales].sort() });
        brandingPlan = planBrandingAssetUploads({ desired: desiredFiles, live, liveLocales });
        for (const note of brandingPlan.notes) logger.log(`branding file not restored: ${note.note}`);
        logger.log(`branding files: ${brandingPlan.uploads.length} to upload, ${brandingPlan.unchanged.length} unchanged, ${brandingPlan.refusals.length} refused`);
      }
    }
    const brandingUploads = brandingUploadDigestInput(brandingPlan.uploads);

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
    // Issue #466: with a type left unread, the check above cannot see whether
    // an object of that type still references one being deleted, so every
    // delete is refused, the same way as a dependent-impact refusal.
    const incompleteReadRefusals = incompleteReadDeleteRefusals(unreadTypes, resources);
    if (incompleteReadRefusals.length > 0 && !previewOnly && mode !== 'dry-run') {
      throw new Error(`${incompleteReadRefusals[0].reason}${incompleteReadRefusals.length > 1 ? ` (and ${incompleteReadRefusals.length - 1} more)` : ''} — refusing before any write`);
    }
    for (const refusal of incompleteReadRefusals) {
      if (!dependentImpactRefusals.has(refusal.naturalKey)) dependentImpactRefusals.set(refusal.naturalKey, refusal);
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
        ...await previewApplyPlanFn({
          resources, waves, deletionWaves, patches, existingTargetIds,
          deletionGuardOptions,
          signInPathGate: { reader: targetReader, protectedPrincipalIds },
          // The tenant the restore writes to, as the enforce run uses. A preview
          // may run without a Restorer config, so fall back to the collector's.
          targetTenant: targetConfig?.tenantId ?? collectorConfig.tenantId,
          lockoutGate,
        }),
        ...relationshipPlan.refusals,
        ...brandingPlan.refusals,
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
        brandingUploads,
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
    let approvedContentEffects = [];
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
        brandingUploads,
        // An artifact persisted before task-64 carries no mechanisms and keeps its
        // original digest inputs; every newer artifact binds them.
        recoveryMechanisms: artifact.recoveryMechanisms == null ? null : recoveryMechanisms,
        contentEffects: contentEffects.effects,
        incidentRecovery: incidentDigest,
        complianceFix: fixPlan,
      });
      const freshFingerprint = computeCurrentStateFingerprintFn(targetResources, closureKeys, relationshipFingerprint);
      const validation = validateArtifactForExecutionFn(artifact, {
        digest: freshDigest,
        currentStateFingerprint: freshFingerprint,
        // Issue #683: the fresh plan may write only what the approved dry run planned.
        plannedVerbs,
      });
      if (!validation.ok) throw new Error(`restore promotion refused: ${validation.reason}`);
      // Task-66: the effects just recomputed must carry a separate, current
      // high-impact approval bound to exactly them — never the requester's own.
      const contentEffectApproval = await assertContentEffectApprovalFn(client, { artifact, effects: contentEffects.effects });
      // Gap D3: only effects whose separate approval was just checked unlock a
      // write the guard otherwise refuses (a shorter group lifetime).
      if (contentEffectApproval) approvedContentEffects = contentEffects.effects;
    }

    const seeds = {
      [`${targetConfig.tenantId}/entra/write`]: { capacity: 100, refillPerSecond: 100 / 20 }, // Intune-tier seed, spec §11.1
    };
    const governor = new ThrottleGovernorClass(seeds);
    const runId = planId !== undefined ? `run-${planId}` : `run-selection-${sourceSnapshot}`;
    const appliedIds = new Map();
    // Named locations skipped on trust: a later policy that names one is skipped too.
    const trustSkippedLocations = new Set();
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
        approvedContentEffects,
        trustSkippedLocations,
      });
      logger.log(`  applied ${result.applied.length}, skipped ${result.skipped.length}, failed ${result.failed.length}`);
      logFailures(logger, result.failed);
      for (const entry of result.applied) {
        const line = changeLine(entry);
        if (line) logger.log(line);
      }
      for (const entry of [...result.applied, ...result.skipped]) {
        for (const line of completionStepLines(entry)) logger.log(line);
      }
      results.applied.push(...result.applied);
      results.skipped.push(...result.skipped);
      results.failed.push(...result.failed);
      results.notRemediable.push(...(result.notRemediable ?? []));
      recordAppliedIds(appliedIds, result.applied);
      recordTrustSkippedLocations(trustSkippedLocations, result.skipped);
      if (result.failed.length) {
        await reportPoliciesThatMayBeOn(result.failed);
        if (persistArtifactId === undefined) {
          throw new Error(`wave had failures — stopping run (retry is safe: applies are idempotent by natural key, spec §9.3): ${failureSummary(result.failed)}`);
        }
        break;
      }
    }

    if (results.failed.length === 0) {
      const patchResult = await applyPatchesFn(writer, governor, patches, {
        targetTenant: targetConfig.tenantId, mode, appliedIds,
      });
      logger.log(`patched ${patchResult.applied.length}, patchFailed ${patchResult.failed.length}`);
      logFailures(logger, patchResult.failed);
      results.applied.push(...patchResult.applied);
      results.failed.push(...patchResult.failed);
      if (patchResult.failed.length && persistArtifactId === undefined) {
        throw new Error(`deferred patch had failures — stopping run: ${failureSummary(patchResult.failed)}`);
      }
    }

    // Task-61: planning refusals for edges are guard refusals of this run (a dry run
    // carrying any is 'refused' and can never be promoted). Edge writes run after
    // every object exists (so a member created by this run resolves through
    // appliedIds) and before any delete.
    results.skipped.push(...relationshipPlan.refusals, ...brandingPlan.refusals, ...contentEffects.refusals);
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
      logFailures(logger, edgeResult.failed);
      results.applied.push(...edgeResult.applied);
      results.skipped.push(...edgeResult.skipped);
      results.failed.push(...edgeResult.failed);
      if (edgeResult.failed.length && persistArtifactId === undefined) {
        throw new Error(`relationship edge operations had failures — stopping run (each edge is re-read before any retry, so a retry never adds a member twice): ${failureSummary(edgeResult.failed)}`);
      }
    }

    // Gap register M6: branding file uploads, after every object write and before any delete.
    if (results.failed.length === 0 && brandingPlan.uploads.length > 0) {
      const fileResult = await applyBrandingAssetUploadsFn(writer, brandingPlan.uploads, {
        reader: targetReader,
        mode,
        targetTenant: targetConfig.tenantId,
        rollbackClient: client,
        runId,
        restoreRef: mode === 'enforce' ? (artifact?.id ?? artifactId ?? null) : null,
        governor,
      });
      logger.log(`branding files: uploaded ${fileResult.applied.length}, failed ${fileResult.failed.length}`);
      logFailures(logger, fileResult.failed);
      results.applied.push(...fileResult.applied);
      results.failed.push(...fileResult.failed);
      if (fileResult.failed.length && persistArtifactId === undefined) {
        throw new Error(`branding file uploads had failures — stopping run (each file is compared by hash before any retry, so a retry uploads only what still differs): ${failureSummary(fileResult.failed)}`);
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
        logFailures(logger, result.failed);
        results.applied.push(...result.applied);
        results.skipped.push(...result.skipped);
        results.failed.push(...result.failed);
        results.notRemediable.push(...(result.notRemediable ?? []));
        recordAppliedIds(appliedIds, result.applied);
        if (result.failed.length) {
          if (persistArtifactId === undefined) {
            throw new Error(`delete wave had failures — stopping run (retry is safe: applies are idempotent by natural key, spec §9.3): ${failureSummary(result.failed)}`);
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
      // Wave 2 ENTRA: a writer's follow-up steps (missing parts of an
      // incomplete configuration) become named completion items.
      const followUpByKey = new Map(results.applied.filter((entry) => Array.isArray(entry.followUp)).map((entry) => [entry.naturalKey, entry.followUp]));
      // Issue #546: assignments the backup did not read stay a step for a
      // person after the run, whatever way the object came back (or none).
      const stepsByKey = new Map(results.applied
        .map((entry) => [entry.naturalKey, [entry.completion ?? []].flat().filter((step) => step?.requirement === 'assignments')])
        .filter(([, steps]) => steps.length > 0));
      const recovered = results.applied
        .map((entry) => byKey.get(entry.naturalKey))
        .filter((resource) => resource && (stepsByKey.has(resource.naturalKey) || (resource.recovery
          && (resource.recovery.mechanism === 'recreate' || resource.recovery.mechanism === 'soft-delete-restore'
            || (resource.recovery.mechanism === 'update-existing' && enforcementPendingFor(resource))))))
        .map((resource) => ({
          naturalKey: resource.naturalKey, resourceType: resource.resourceType,
          // An object left in place (unchanged or updated) reads as updated in place.
          mechanism: !resource.recovery || resource.recovery.mechanism === 'none' ? 'update-existing' : resource.recovery.mechanism,
          enforcementPending: enforcementPendingFor(resource), payload: resource.payload,
          ...(followUpByKey.has(resource.naturalKey) ? { followUp: followUpByKey.get(resource.naturalKey) } : {}),
          ...(stepsByKey.has(resource.naturalKey) ? { steps: stepsByKey.get(resource.naturalKey) } : {}),
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
      const checkedTypes = incidentRecovery.postRestoreChecks.map((check) => String(check.naturalKey).split(':')[0]);
      const reread = await collectM1Fn(targetReader, { needed: new Set([...neededTypes, ...checkedTypes]) });
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
        brandingUploads,
        recoveryMechanisms,
        contentEffects: contentEffects.effects,
        incidentRecovery: incidentDigest,
        complianceFix: fixPlan,
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
        complianceFix: fixPlan,
        plannedVerbs,
      });
      createdArtifactId = persistArtifactId;
      logger.log(`persisted dry-run artifact ${persistArtifactId} (status: ${status})`);
    }

    return {
      plan, resources, waves, deletionWaves, patches, appliedIds, results, relationshipOperations, brandingUploads, recoveryMechanisms,
      completionItems, pendingSteps, contentEffects: contentEffects.effects, incidentRecovery, incidentChecks,
      ...(fixPlan ? { complianceFix: fixPlan } : {}),
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

/** Issue #466: the types collectM1 left unread (failed, not needed), sorted. */
export function unreadTypesOf(collected) {
  const unread = Array.isArray(collected?.unread) ? collected.unread : [];
  return [...new Set(unread.map((entry) => entry?.type).filter((type) => typeof type === 'string'))].sort();
}

// Issue #666: kinds whose objects never hold another tenant object's id
// (catalogue `holdsNoReferences`: To Do settings and other on/off org settings).
const NO_REFERENCE_TYPES = new Set(CATALOG.filter((entry) => entry.holdsNoReferences === true).map((entry) => entry.type));
// Kinds whose objects can name only the kinds listed (catalogue `refersOnlyTo`):
// a PIM for Groups resource names one group and nothing else.
const REFERS_ONLY_TO = new Map(CATALOG.filter((entry) => Array.isArray(entry.refersOnlyTo)).map((entry) => [entry.type, new Set(entry.refersOnlyTo)]));

/** The kind a planned resource is of: its resourceType, else its natural key's prefix. */
function plannedTypeOf(resource) {
  if (typeof resource?.resourceType === 'string' && resource.resourceType) return resource.resourceType;
  const key = String(resource?.naturalKey ?? '');
  return key.includes(':') ? key.slice(0, key.indexOf(':')) : null;
}

/** True when an object of `unreadType` could name an object of `deletedType`. */
function couldReference(unreadType, deletedType) {
  if (NO_REFERENCE_TYPES.has(unreadType)) return false;
  const only = REFERS_ONLY_TO.get(unreadType);
  return !only || deletedType === null || only.has(deletedType);
}

/**
 * Issue #466: one refusal per planned delete when a type was left unread.
 * The dependent-impact check reads references from the live state, and a type
 * that was not read could still hold one, so a delete is never judged safe on
 * an incomplete read. Issue #666: a kind that cannot hold a reference at all
 * (NO_REFERENCE_TYPES) cannot hide one, so leaving it unread blocks nothing.
 * Q220: an unread kind blocks only the deletes it could point at. A kind with
 * `refersOnlyTo` cannot hide a reference to a kind outside that list (an unread
 * PIM for Groups resource blocks a group delete, not an Intune policy delete).
 * Any kind without such a flag, and a delete of unknown kind, still block.
 */
export function incompleteReadDeleteRefusals(allUnreadTypes, plannedResources) {
  const unreadTypes = Array.isArray(allUnreadTypes) ? allUnreadTypes.filter((type) => !NO_REFERENCE_TYPES.has(type)) : [];
  if (unreadTypes.length === 0) return [];
  const refusals = new Map();
  for (const resource of plannedResources ?? []) {
    if (resource?.verb !== 'delete' || refusals.has(resource.naturalKey)) continue;
    const deletedType = plannedTypeOf(resource);
    const blocking = unreadTypes.filter((type) => couldReference(type, deletedType));
    if (blocking.length === 0) continue;
    refusals.set(resource.naturalKey, {
      naturalKey: resource.naturalKey,
      reason: `blocked-incomplete-read: deleting ${resource.naturalKey} needs a full read of the target, but ${blocking.join(', ')} could not be read`,
    });
  }
  return [...refusals.values()];
}

async function buildCompensation({ client, forward, collectorConfig, targetConfig, collectorConfigPath, targetConfigPath, undoChoices = {}, deps }) {
  const entries = await deps.listJournalFn(client, { restoreRef: forward.id });
  if (entries.length === 0) {
    throw new Error(`compensation refused: restore ${forward.id} has no journaled writes (nothing was written, or it ran before operation journaling)`);
  }
  const { accessToken: collectorToken } = await deps.getTokenFn(collectorConfig);
  const targetReader = new deps.GraphReaderClass(async () => collectorToken);
  const needed = new Set(entries.map((entry) => entry.resourceType));
  const targetCollected = await deps.collectM1Fn(targetReader, { needed });
  const targetResources = deps.canonicalizeAllFn(targetCollected);
  const current = new Map(targetResources.map((resource) => [resource.naturalKey, { targetId: resource.sourceId, payload: resource.payload }]));
  // An undo of a created policy that is assigned now waits for the person's
  // choice: delete it with its assignments, or skip it.
  const planned = planCompensation({ restoreRef: forward.id, entries, current });
  const plan = applyUndoChoices(planned, { assigned: await readUndoAssignments(targetReader, planned.operations), choices: undoChoices });
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
  for (const refusal of incompleteReadDeleteRefusals(unreadTypesOf(targetCollected), plan.operations)) {
    if (!impactRefusals.some((existing) => existing.naturalKey === refusal.naturalKey)) impactRefusals.push(refusal);
  }
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
  const protectedPrincipalIds = globalAdministratorPrincipalIds(targetResources);
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
  for (const item of plan.choices ?? []) {
    logger.log(`  assigned (${item.assignmentCount}): ${item.naturalKey} — ${item.choice === 'delete' ? 'delete it with its assignments' : item.choice === 'skip' ? 'skip it' : 'waiting for your choice: delete it with its assignments, or skip it'}`);
  }
  logger.log(`  ${plan.statement}`);
}

async function planCompensationRun({ client, compensateArtifactId, undoChoices, persistArtifactId, requestedBy, readFile, logger, deps }) {
  const forward = await deps.getDryRunArtifactByIdFn(client, { id: compensateArtifactId });
  if (!forward) throw new Error(`compensation refused: restore artifact not found: ${compensateArtifactId}`);
  const collectorConfig = readCollectorConfig(forward.collectorConfigPath, readFile);
  const targetConfig = readRestorerConfig(forward.targetConfigPath, readFile);
  assertSeparateRestorer(collectorConfig, targetConfig);

  const ctx = await buildCompensation({
    client, forward, collectorConfig, targetConfig,
    collectorConfigPath: forward.collectorConfigPath, targetConfigPath: forward.targetConfigPath, undoChoices: undoChoices ?? {}, deps,
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
    // Issue #666: say why, not only that it was refused.
    for (const refusal of refusals) logger.log(`refused ${refusal.naturalKey}: ${refusal.reason}`);
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

async function executeCompensationRun({ client, artifact, collectorConfig, targetConfig, readFile, logger, deps }) {
  const forward = await deps.getDryRunArtifactByIdFn(client, { id: artifact.compensation.compensates });
  if (!forward) throw new Error(`compensation promotion refused: the compensated restore ${artifact.compensation.compensates} no longer exists`);
  const ctx = await buildCompensation({
    client, forward, collectorConfig, targetConfig,
    collectorConfigPath: artifact.collectorConfigPath, targetConfigPath: artifact.targetConfigPath,
    // The choices the reviewed plan holds; any other plan changes the digest.
    undoChoices: undoChoicesOf(artifact.compensation), deps,
  });
  // Exactly the forward promotion gate: a changed journal, plan or target refuses
  // before a single write; the compensation's content effects need their own
  // separate approval.
  const validation = deps.validateArtifactForExecutionFn(artifact, { digest: ctx.digest, currentStateFingerprint: ctx.fingerprint });
  if (!validation.ok) throw new Error(`compensation promotion refused: ${validation.reason}`);
  // An assigned policy is undone only by the person's choice: a plan still waiting for one is not run.
  const waiting = (ctx.plan.choices ?? []).filter((item) => item.choice == null).map((item) => item.naturalKey);
  if (waiting.length > 0) {
    throw new Error(`compensation promotion refused: ${waiting.length} assigned polic${waiting.length === 1 ? 'y waits' : 'ies wait'} for a choice to delete or skip (${waiting.join(', ')}); plan the undo again with the choices`);
  }
  await deps.assertContentEffectApprovalFn(client, { artifact, effects: ctx.contentEffects.effects });
  logCompensation(logger, ctx.plan);

  const results = { applied: [], skipped: [], failed: [], notRemediable: [] };
  if (ctx.plan.operations.length > 0) {
    // Issue #681: undoing a Viva Engage write signs in as the Engage writer too.
    const { tokenFor } = await restoreWriterTokens({
      getTokenFn: deps.getTokenFn, targetConfig, collectorConfig, readFile, logger,
      resourceTypes: ctx.plan.operations.map((operation) => operation.resourceType),
      path: deps.engageWriterConfigPathFn?.(),
    });
    const writer = new deps.GraphWriterClass(tokenFor);
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
  const targetResources = deps.canonicalizeAllFn(await deps.collectM1Fn(targetReader, { needed: new Set(['conditionalAccessPolicy']) }));
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
  const protectedPrincipalIds = globalAdministratorPrincipalIds(targetResources);
  return { plan, live, lockoutGate, digest, fingerprint, scopeKeys, targetReader, protectedPrincipalIds, pending };
}

async function planEnforcementRun({ client, request, persistArtifactId, requestedBy, readFile, logger, deps }) {
  const forward = await deps.getDryRunArtifactByIdFn(client, { id: request.restoreArtifactId });
  if (!forward) throw new Error(`enforcement refused: restore artifact not found: ${request.restoreArtifactId}`);
  const collectorConfig = readCollectorConfig(forward.collectorConfigPath, readFile);
  const targetConfig = readRestorerConfig(forward.targetConfigPath, readFile);
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

// ------------------------------------------------------------- workload restores (W2)

/**
 * Production connection for a workload run: a Graph transport, the cmdlet job options
 * and, for the site permissions restore, a SharePoint REST transport on the tenant host
 * (a certificate token for that host). The collector's can only read; the restorer's
 * can only send the allow-listed site permission writes (sitePermissionsWriteTransport).
 */
export async function defaultWorkloadConnection({ role, config, configPath, powershellConfigPath = null, getTokenFn }) {
  const { accessToken } = await getTokenFn(config);
  const sharePoint = (tenantHost, { webUrl = null } = {}) => {
    const token = () => getTokenFn(config, { scope: `https://${tenantHost}/.default` });
    return role === 'restorer'
      ? sitePermissionsWriteTransport(token, globalThis.fetch, { tenantHost, webUrl })
      : sharePointReadTransport(token, globalThis.fetch, { tenantHost });
  };
  return { transport: graphTransport(accessToken), powershell: { tenantConfigPath: powershellConfigPath ?? configPath }, sharePoint };
}

/** The workload scope file (KEEL_WORKLOAD_SCOPE_PATH), or {} when the host has none. */
function defaultWorkloadScope({ readFile }) {
  return readWorkloadScope({ path: process.env.KEEL_WORKLOAD_SCOPE_PATH || DEFAULT_WORKLOAD_SCOPE_PATH, readFile });
}

/**
 * Issue #542: the PowerShell config a workload restore connects with, from the
 * workload scope file, the same family file the collect uses (or its -restorer.json
 * sibling for the promotion). Exchange and Purview refuse the Graph configs, which
 * name no organization. Null leaves the role's own file.
 */
function workloadPowershellPath(workload, { role, tenantId, readFile, logger, deps, separateFrom = [] }) {
  const path = workloadPowershellConfigPath(workload, { role, tenantId, readFile, separateFrom, scope: deps.workloadScopeFn({ readFile }) });
  if (path) logger.log(`PowerShell connects as the ${role} with ${path}`);
  return path;
}

/** The content store named in the content reader file (where the content backup lives). */
async function defaultContentStore({ client, readFile, readerPath = process.env.KEEL_CONTENT_READER_PATH || '/etc/keel/content-reader.json' }) {
  const reader = readConfigFile(readerPath, { readFile, what: 'content backup reader settings' });
  if (!reader?.storage?.root || !reader?.contentKeyFile) throw new Error(`${readerPath} names no content store (storage.root and contentKeyFile)`);
  return createContentStore({
    index: createPgContentIndex(client), storage: createLocalStorageAdapter({ root: reader.storage.root }),
    key: parseContentKey(readFile(reader.contentKeyFile, 'utf8')),
  });
}

/**
 * Which workload writes are qualified for this tenant, from the stored workload
 * ledger (gap W1): the live read and write captures, the restorer's observed
 * grants and the module versions in use, rebuilt at the moment of the run so the
 * 30-day, version and tenant rules apply now. Each operation gets its own
 * workloadWriteQualification; a write with no live capture stays `disabled` (or
 * `fixture-tested`), and the executors send nothing for it. A database without
 * the ledger tables reads as no proof.
 */
export async function defaultWorkloadQualifications(client, { tenantRef, operations = [], now = new Date() }) {
  const { rows: [table] } = await client.query("SELECT to_regclass('workload_ledger_evidence') IS NOT NULL AS present");
  const stored = table?.present ? await loadWorkloadLedger(client, { tenantRef, now }) : null;
  const options = {
    readLedger: stored?.ledger ?? null,
    evidence: stored?.inputs.writes ?? [],
    tenantRef,
    now,
    runtime: stored?.inputs.runtime ?? {},
    grants: stored?.inputs.restorerGrants ?? null,
  };
  return Object.fromEntries(operations.map((operationId) => [operationId, workloadWriteQualification(operationId, options)]));
}

const WORKLOAD_SUCCESS = new Set(['verified', 'no-change']);

async function planWorkloadRun({ client, request, collectorConfig, collectorConfigPath, persistArtifactId, requestedBy, readFile, logger, deps }) {
  const entry = workloadRestoreFor(request.workload, deps.workloadRestores);
  const tenantRef = tenantRefFor(collectorConfig.tenantId);
  // The dry run reads with the collector only; it never holds the restorer.
  const powershellConfigPath = workloadPowershellPath(request.workload, {
    role: 'collector', tenantId: collectorConfig.tenantId, readFile, logger, deps,
  });
  const connection = await deps.workloadConnectionFn({
    role: 'collector', config: collectorConfig, configPath: collectorConfigPath, powershellConfigPath, getTokenFn: deps.getTokenFn,
  });
  const plan = await entry.plan(client, {
    tenantRef, tenantId: collectorConfig.tenantId, request, connection, contentStore: deps.contentStore, sleep: deps.sleep,
  });
  const artifact = await entry.create(client, {
    tenantRef, plan, requestedBy: requestedBy ?? 'keel-restore', ...(persistArtifactId !== undefined ? { id: persistArtifactId } : {}),
  });
  logger.log(`${entry.label} restore plan: ${plan.operations.length} change(s), ${plan.manual.length} manual, ${plan.refusals.length} refused`);
  logger.log(`persisted workload dry-run artifact ${artifact.id} (status: ${artifact.status})`);
  return { mode: 'dry-run', workloadRestore: plan, status: artifact.status, artifactId: artifact.id };
}

/**
 * Gap 6 on a service read: reads the policy's family live with the collector, plans
 * the one setting as a workload restore (benchmarks/workloadFix.mjs) and persists it.
 * Promotion is the ordinary workload promotion (executeWorkloadRun).
 */
async function planWorkloadFixRun({ client, request, collectorConfig, collectorConfigPath, persistArtifactId, requestedBy, readFile, logger, deps }) {
  const fix = fixFor(request.controlId);
  const entry = workloadRestoreFor(fix.workload, deps.workloadRestores);
  if (typeof entry.read !== 'function') throw new Error(`compliance fix refused: ${entry.label} has no live read for a fix`);
  const tenantRef = tenantRefFor(collectorConfig.tenantId);
  const named = parseWorkloadFixTarget(request.naturalKey);
  const checked = await deps.newestWorkloadReadFn(client, { tenantRef, resourceType: fix.workload, parts: [fix.family], now: new Date() });
  const sourceCollectionId = checked?.observation?.completeness === 'complete'
    && checked.resources.some((item) => item.id === named?.resourceKey) ? checked.collectionId : null;
  // The live read connects with the family's collector file, like any workload dry run (#542).
  const powershellConfigPath = workloadPowershellPath(fix.workload, {
    role: 'collector', tenantId: collectorConfig.tenantId, readFile, logger, deps,
  });
  const connection = await deps.workloadConnectionFn({
    role: 'collector', config: collectorConfig, configPath: collectorConfigPath, powershellConfigPath, getTokenFn: deps.getTokenFn,
  });
  const live = await entry.read({ powershell: connection.powershell });
  let plan;
  try {
    plan = planWorkloadComplianceFix({
      controlId: request.controlId, target: request.naturalKey, live, sourceCollectionId,
      tenantId: collectorConfig.tenantId, tenantRef,
    });
  } catch (error) {
    if (error instanceof ComplianceFixRefusal) throw new Error(`compliance fix refused: ${error.message}`);
    throw error;
  }
  const artifact = await entry.create(client, {
    tenantRef, plan, requestedBy: requestedBy ?? 'keel-restore', ...(persistArtifactId !== undefined ? { id: persistArtifactId } : {}),
  });
  logger.log(`compliance fix plan: ${plan.complianceFix.field} on ${plan.complianceFix.resourceKey}, ${plan.operations.length} change(s), ${plan.refusals.length} refused`);
  logger.log(`persisted workload dry-run artifact ${artifact.id} (status: ${artifact.status})`);
  return { mode: 'dry-run', workloadRestore: plan, complianceFix: plan.complianceFix, status: artifact.status, artifactId: artifact.id };
}

async function executeWorkloadRun({ client, artifact, readFile, logger, deps }) {
  const plan = artifact.workloadRestore;
  if (!plan) throw new Error('workload restore promotion refused: the artifact holds no workload plan');
  const entry = workloadRestoreFor(plan.workload, deps.workloadRestores);
  // The same approval as turning a Conditional Access policy on: approved, by
  // someone other than the requester. Checked before any credential is read.
  const approval = await enforcementApproval(client, artifact.id);
  if (!approval) {
    throw new Error('workload restore promotion refused: it needs an approved request from someone other than the requester');
  }
  // The credential files are the server's, never the artifact's marker paths.
  const paths = deps.credentialPathsFn();
  const collectorConfig = readCollectorConfig(paths.collectorConfig, readFile);
  const targetConfig = readRestorerConfig(paths.targetConfig, readFile);
  assertSeparateRestorer(collectorConfig, targetConfig);
  if (tenantRefFor(targetConfig.tenantId) !== artifact.tenantRef) {
    throw new Error('workload restore promotion refused: the restorer signs in to a different tenant than the one this plan was made for');
  }
  const powershellConfigPath = workloadPowershellPath(plan.workload, {
    role: 'restorer', tenantId: targetConfig.tenantId, readFile, logger, deps, separateFrom: [collectorConfig],
  });
  const connection = await deps.workloadConnectionFn({
    role: 'restorer', config: targetConfig, configPath: paths.targetConfig, powershellConfigPath, getTokenFn: deps.getTokenFn,
  });
  const qualifications = await deps.workloadQualificationsFn(client, { tenantRef: artifact.tenantRef, operations: entry.operations });
  const enabled = Object.values(qualifications ?? {}).filter((qualification) => qualification?.enabled === true);
  if (enabled.length === 0) {
    logger.log(`no ${entry.label} write is qualified for this tenant yet; nothing will be written`);
  } else {
    logger.log(`${entry.label}: ${enabled.length} of ${entry.operations.length} write(s) qualified for this tenant`);
  }
  const result = await entry.execute(client, {
    tenantRef: artifact.tenantRef, artifactId: artifact.id, tenantId: targetConfig.tenantId, plan, connection,
    qualifications: qualifications ?? {}, contentStore: deps.contentStore, sleep: deps.sleep,
  });
  logger.log(`${entry.label} restore: ${result.outcome}`);
  if (!WORKLOAD_SUCCESS.has(result.outcome)) {
    const reasons = [...(result.reasons ?? []), ...(result.operations ?? []).flatMap((op) => op.reasons ?? [])];
    throw new Error(`${entry.label} restore ${result.outcome}${reasons.length ? `: ${reasons.join('; ')}` : ''}`);
  }
  return { mode: 'enforce', workloadRestore: plan, outcome: result.outcome, result, artifactId: artifact.id };
}

export async function main({
  argv = process.argv,
  readFile = readFileSync,
  dbUrl = process.env.KEEL_DB_URL,
  dependencies,
  logger = console,
} = {}) {
  const opts = parseRestoreArgs(argv);
  const planId = opts.plan;
  const snapshotId = opts['snapshot-id'];
  const selection = opts.select;
  const deleteKeys = opts.delete;
  const artifactId = opts.artifact;
  const persistArtifactId = opts['persist-artifact'];
  const compensateArtifactId = opts.compensate;
  const deleteAssigned = opts['delete-assigned'] ?? [];
  const skipAssigned = opts['skip-assigned'] ?? [];
  const enforceRestoreArtifactId = opts['enforce-conditional-access'];
  const enforcePolicy = opts.policy;
  const requestedBy = opts['requested-by'];
  const incidentId = opts.incident;
  const mode = opts.enforce ? 'enforce' : 'dry-run';

  // Task-70: a compensation is planned from the promoted restore's own journal and
  // frozen config — never with --enforce, and never alongside another scope.
  if (compensateArtifactId !== undefined) {
    if (planId || snapshotId || selection.length || deleteKeys.length || artifactId !== undefined || incidentId !== undefined) {
      throw new Error('--compensate is mutually exclusive with --plan/--snapshot-id/--select/--delete/--artifact/--incident');
    }
    if (mode === 'enforce') {
      throw new Error('--compensate is a dry run only; execute it by promoting the compensation artifact with --artifact <id> --enforce');
    }
    const both = deleteAssigned.filter((key) => skipAssigned.includes(key));
    if (both.length > 0) throw new Error(`--delete-assigned and --skip-assigned both name ${both.join(', ')}`);
    const undoChoices = Object.fromEntries([...deleteAssigned.map((key) => [key, 'delete']), ...skipAssigned.map((key) => [key, 'skip'])]);
    return runRestore({
      compensateArtifactId, ...(Object.keys(undoChoices).length > 0 ? { undoChoices } : {}),
      persistArtifactId, requestedBy, mode, readFile, dbUrl, dependencies, logger,
    });
  }
  if (deleteAssigned.length > 0 || skipAssigned.length > 0) {
    throw new Error('--delete-assigned and --skip-assigned are choices for an undo plan (--compensate) only');
  }

  // Task-152: turning a Conditional Access policy on is planned from one promoted
  // restore and one policy — never with --enforce, and never alongside another scope.
  if (enforceRestoreArtifactId !== undefined) {
    if (planId || snapshotId || selection.length || deleteKeys.length || artifactId !== undefined || incidentId !== undefined) {
      throw new Error('--enforce-conditional-access is mutually exclusive with --plan/--snapshot-id/--select/--delete/--artifact/--incident');
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

  // Gap 6: a compliance fix is planned for one control and one object — never
  // with --enforce, and never alongside another scope.
  const fixControlId = opts['compliance-fix'];
  if (fixControlId !== undefined) {
    if (planId || snapshotId || selection.length || deleteKeys.length || artifactId !== undefined || incidentId !== undefined) {
      throw new Error('--compliance-fix is mutually exclusive with --plan/--snapshot-id/--select/--delete/--artifact/--incident');
    }
    const object = opts.object;
    if (!object) throw new Error('--compliance-fix requires --object <naturalKey>');
    if (mode === 'enforce') {
      throw new Error('--compliance-fix is a dry run only; execute it by promoting that artifact with --artifact <id> --enforce after approval');
    }
    const fixCollectorPath = opts['collector-config'];
    const fixTargetPath = opts['target-config'];
    if (!fixCollectorPath || !fixTargetPath) throw new Error('--compliance-fix requires --collector-config and --target-config');
    const fixCollector = readCollectorConfig(fixCollectorPath, readFile);
    const fixTarget = readRestorerConfig(fixTargetPath, readFile);
    assertSeparateRestorer(fixCollector, fixTarget);
    return runRestore({
      complianceFix: { controlId: fixControlId, naturalKey: object },
      collectorConfig: fixCollector, targetConfig: fixTarget,
      collectorConfigPath: fixCollectorPath, targetConfigPath: fixTargetPath,
      persistArtifactId, requestedBy, mode, readFile, dbUrl, dependencies, logger,
    });
  }

  // W2: a workload restore is planned from one recorded workload collection with the
  // collector only — never with --enforce, and never alongside another scope.
  const workload = opts.workload;
  if (workload !== undefined) {
    if (planId || snapshotId || selection.length || artifactId !== undefined || incidentId !== undefined) {
      throw new Error('--workload is mutually exclusive with --plan/--snapshot-id/--select/--artifact/--incident');
    }
    if (mode === 'enforce') {
      throw new Error('--workload is a dry run only; execute it by promoting that artifact with --artifact <id> --enforce after approval');
    }
    // The dry run reads with the collector: the server's file (credentialPaths, the
    // same one its promotion reads) unless the operator names another.
    const collectorConfigPath = opts['collector-config']
      ?? (dependencies?.credentialPaths ?? credentialPaths)().collectorConfig;
    return runRestore({
      workloadRestore: {
        workload,
        collectionId: opts.collection,
        tenantHost: opts['tenant-host'],
        mailbox: opts.mailbox,
        includeOrganization: opts['include-organization'],
        teamId: opts.team,
        siteId: opts.site,
        at: opts.at,
        targets: opts.target,
        allowTenantWide: opts['allow-tenant-wide-test-writes'],
      },
      collectorConfig: readCollectorConfig(collectorConfigPath, readFile),
      collectorConfigPath,
      persistArtifactId, requestedBy, mode, readFile, dbUrl, dependencies, logger,
    });
  }

  // Plan task 8: --artifact promotes a completed dry-run artifact and is the ONLY way
  // to reach --enforce for every restore scope — it carries its own frozen
  // snapshot, selection and target config paths, so it is mutually exclusive with
  // every other scope flag.
  if (artifactId !== undefined && (planId || snapshotId || selection.length || deleteKeys.length)) {
    throw new Error('--artifact is mutually exclusive with --plan/--snapshot-id/--select/--delete — a promotion is driven entirely by its dry-run artifact');
  }
  if (artifactId !== undefined && mode !== 'enforce') {
    throw new Error('--artifact may only be used with --enforce');
  }
  if (persistArtifactId !== undefined && mode === 'enforce') {
    throw new Error('--persist-artifact may only be used for a dry run, never with --enforce');
  }
  // --plan and --snapshot-id/--select are two scopes for the one apply path; mixing
  // them is a usage error, and so is either half of the selection scope on its own.
  if (planId && (snapshotId || selection.length || deleteKeys.length)) {
    throw new Error('--plan is mutually exclusive with --snapshot-id/--select/--delete');
  }
  if (!snapshotId && selection.length) throw new Error('--select requires --snapshot-id');
  // Gap D7: --delete is its own scope on a snapshot — never mixed with --select or
  // an incident recovery, and never a direct enforce (promote its dry run instead).
  if (deleteKeys.length) {
    if (!snapshotId) throw new Error('--delete requires --snapshot-id');
    if (selection.length) throw new Error('--delete and --select are separate restore scopes — run them as two restores');
    if (incidentId !== undefined) throw new Error('--delete cannot be combined with --incident');
  }
  // Task-71: a promotion's incident comes from its artifact, never from argv.
  if (incidentId !== undefined && (artifactId !== undefined || !snapshotId)) {
    throw new Error('--incident requires --snapshot-id/--select (a promotion carries its incident in the dry-run artifact)');
  }
  if (snapshotId && !selection.length && !deleteKeys.length) {
    throw new Error('--snapshot-id requires at least one --select <naturalKey> or --delete <naturalKey>');
  }
  if (!planId && !snapshotId && !artifactId) {
    throw new Error('--plan <id>, --snapshot-id <id> with --select or --delete <naturalKey>, --workload <name>, or --artifact <id> required');
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
    targetConfigPath = opts['target-config'];
    if (!targetConfigPath) throw new Error('--target-config <path> required');
    targetConfig = readRestorerConfig(targetConfigPath, readFile);
    collectorConfigPath = opts['collector-config'];
    if (!collectorConfigPath) throw new Error('--collector-config <path> required for read-only sign-in-path evidence');
    collectorConfig = readCollectorConfig(collectorConfigPath, readFile);
    assertSeparateRestorer(collectorConfig, targetConfig);
  }

  return runRestore({
    planId,
    snapshotId,
    selection: selection.length ? selection : undefined,
    deleteKeys: deleteKeys.length ? deleteKeys : undefined,
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
    acceptDegradation: opts['accept-degradation'],
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
