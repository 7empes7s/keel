#!/usr/bin/env node
// /opt/keel/cli/keel-restore.mjs
//
// node keel-restore.mjs --plan <id> --collector-config /etc/keel/tenant-target.json --target-config /etc/keel/restorer-target.json [--enforce] [--accept-degradation]
// node keel-restore.mjs --snapshot-id <id> --select <naturalKey> [--select <naturalKey>...] --collector-config ... --target-config ... [--enforce]
//
// --plan restores everything the plan covers; --snapshot-id + --select restores the
// dependency closure of exactly the selected natural keys (portal-design §4.1 — the
// closure is recomputed here from the snapshot, never trusted from the caller).
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { getToken } from '../tools/tenant-probe/auth.mjs';
import { GraphReader } from '../tools/tenant-probe/graph.mjs';
import { collectM1 } from '../engine/collect/entraAdapter.mjs';
import { canonicalizeAll } from '../engine/cir/canonicalize.mjs';
import { connect, getResourceVersions, getReferences } from '../engine/store/db.mjs';
import { planWaves, planDeletionWaves, phaseOneResources } from '../engine/restore/wavePlanner.mjs';
import { dependencyClosure } from '../engine/restore/selection.mjs';
import { buildReconciliationPlan } from '../engine/reconcile/reconciliationPlan.mjs';
import { ThrottleGovernor } from '../engine/restore/throttleGovernor.mjs';
import { GraphWriter } from '../engine/restore/graphWriter.mjs';
import { applyWave, applyPatches } from '../engine/restore/applyEngine.mjs';
import {
  classifyDryRunStatus, computeCurrentStateFingerprint, computePlanDigest,
  createDryRunArtifact, getDryRunArtifactById, validateArtifactForExecution,
} from '../engine/restore/dryRunArtifact.mjs';

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

export async function runRestore({
  planId,
  snapshotId,
  selection,
  reconciliationResources,
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
  } = dependencies;

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
    if (planId !== undefined || snapshotId === undefined) {
      throw new Error('persistArtifactId requires the snapshotId/selection restore scope');
    }
  }
  if (planId !== undefined && (snapshotId !== undefined || selection !== undefined || reconciliationResources !== undefined)) {
    throw new Error('planId and snapshotId/selection/reconciliationResources are mutually exclusive restore scopes');
  }
  if (planId === undefined && snapshotId === undefined && artifactId === undefined) {
    throw new Error('a restore scope is required: planId, snapshotId with a selection, or artifactId');
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
      collectorConfigPath = artifact.collectorConfigPath;
      targetConfigPath = artifact.targetConfigPath;
      collectorConfig = JSON.parse(readFile(collectorConfigPath, 'utf8'));
      targetConfig = JSON.parse(readFile(targetConfigPath, 'utf8'));
      assertSeparateRestorer(collectorConfig, targetConfig);
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
    const refsByVersion = new Map();
    for (const r of references) {
      if (!refsByVersion.has(r.from_version)) refsByVersion.set(r.from_version, []);
      refsByVersion.get(r.from_version).push({ field: r.field_path, symbol: r.to_symbol, required: r.required });
    }
    let resources = versions
      .filter((v) => v.resource_type !== 'user' && v.resource_type !== 'authenticationStrengthPolicy') // read-only in M1, never written
      .map((v) => ({
        naturalKey: v.natural_key, resourceType: v.resource_type, payload: v.payload,
        payloadHash: v.payload_hash,
        references: refsByVersion.get(v.id) ?? [], blastRadius: v.blast_radius, restorePriority: 100,
      }));

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

    const { accessToken: collectorToken } = await getTokenFn(collectorConfig);
    const targetReader = new GraphReaderClass(async () => collectorToken);
    const { accessToken: restorerToken } = await getTokenFn(targetConfig);
    const writer = new GraphWriterClass(async () => restorerToken);

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
    const writesBeforeDeletes = resources.filter((resource) => resource.verb !== 'delete');
    const deletes = resources.filter((resource) => resource.verb === 'delete');
    const { waves, patches } = planWavesFn(writesBeforeDeletes);
    const { waves: deletionWaves } = planDeletionWavesFn(deletes);

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
      });
      const freshFingerprint = computeCurrentStateFingerprintFn(targetResources, closureKeys);
      const validation = validateArtifactForExecutionFn(artifact, {
        digest: freshDigest,
        currentStateFingerprint: freshFingerprint,
      });
      if (!validation.ok) throw new Error(`restore promotion refused: ${validation.reason}`);
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
        deletionGuardOptions,
        signInPathGate: { reader: targetReader, protectedPrincipalIds },
      });
      logger.log(`  applied ${result.applied.length}, skipped ${result.skipped.length}, failed ${result.failed.length}`);
      results.applied.push(...result.applied);
      results.skipped.push(...result.skipped);
      results.failed.push(...result.failed);
      results.notRemediable.push(...(result.notRemediable ?? []));
      for (const { naturalKey, targetId } of result.applied) {
        if (typeof targetId === 'string' && targetId.length > 0) appliedIds.set(naturalKey, targetId);
      }
      if (result.failed.length) {
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
          deletionGuardOptions,
          signInPathGate: { reader: targetReader, protectedPrincipalIds },
        });
        logger.log(`  applied ${result.applied.length}, skipped ${result.skipped.length}, failed ${result.failed.length}`);
        results.applied.push(...result.applied);
        results.skipped.push(...result.skipped);
        results.failed.push(...result.failed);
        results.notRemediable.push(...(result.notRemediable ?? []));
        for (const { naturalKey, targetId } of result.applied) {
          if (typeof targetId === 'string' && targetId.length > 0) appliedIds.set(naturalKey, targetId);
        }
        if (result.failed.length) {
          if (persistArtifactId === undefined) {
            throw new Error('delete wave had failures — stopping run (retry is safe: applies are idempotent by natural key, spec §9.3)');
          }
          break;
        }
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
      });
      const currentStateFingerprint = computeCurrentStateFingerprintFn(targetResources, closureKeys);

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
      });
      createdArtifactId = persistArtifactId;
      logger.log(`persisted dry-run artifact ${persistArtifactId} (status: ${status})`);
    }

    return {
      plan, resources, waves, deletionWaves, patches, appliedIds, results,
      selection: immutableSelection.length ? immutableSelection : null,
      artifactId: createdArtifactId ?? artifactId ?? null,
    };
  } finally {
    await client?.end();
  }
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
  const requestedBy = arg('requested-by', undefined, argv);
  const mode = flag('enforce', argv) ? 'enforce' : 'dry-run';

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
