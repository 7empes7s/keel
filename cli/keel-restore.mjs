#!/usr/bin/env node
// /opt/keel/cli/keel-restore.mjs
//
// node keel-restore.mjs --plan <id> --collector-config /etc/keel/tenant-target.json --target-config /etc/keel/restorer-target.json [--enforce] [--accept-degradation]
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { getToken } from '../tools/tenant-probe/auth.mjs';
import { GraphReader } from '../tools/tenant-probe/graph.mjs';
import { collectM1 } from '../engine/collect/entraAdapter.mjs';
import { canonicalizeAll } from '../engine/cir/canonicalize.mjs';
import { connect, getResourceVersions, getReferences } from '../engine/store/db.mjs';
import { planWaves, phaseOneResources } from '../engine/restore/wavePlanner.mjs';
import { ThrottleGovernor } from '../engine/restore/throttleGovernor.mjs';
import { GraphWriter } from '../engine/restore/graphWriter.mjs';
import { applyWave, applyPatches } from '../engine/restore/applyEngine.mjs';
import { recordPriorState } from '../engine/restore/rollbackJournal.mjs';

function arg(name, fallback, argv = process.argv) {
  const i = argv.indexOf(`--${name}`);
  return i > -1 ? argv[i + 1] : fallback;
}
function flag(name, argv = process.argv) {
  return argv.includes(`--${name}`);
}

function assertSeparateRestorer(collector, restorer) {
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
  targetConfig,
  collectorConfig,
  mode,
  acceptDegradation,
  dbUrl = process.env.KEEL_DB_URL,
  dependencies = {},
  logger = console,
}) {
  const {
    connect: connectFn = connect,
    getResourceVersions: getResourceVersionsFn = getResourceVersions,
    getReferences: getReferencesFn = getReferences,
    planWaves: planWavesFn = planWaves,
    getToken: getTokenFn = getToken,
    GraphReader: GraphReaderClass = GraphReader,
    collectM1: collectM1Fn = collectM1,
    canonicalizeAll: canonicalizeAllFn = canonicalizeAll,
    GraphWriter: GraphWriterClass = GraphWriter,
    ThrottleGovernor: ThrottleGovernorClass = ThrottleGovernor,
    applyWave: applyWaveFn = applyWave,
    applyPatches: applyPatchesFn = applyPatches,
    recordPriorState: recordPriorStateFn = recordPriorState,
  } = dependencies;

  let client;
  try {
    client = await connectFn(dbUrl);
    const { rows } = await client.query('SELECT * FROM plan WHERE id = $1', [planId]);
    const plan = rows[0];
    if (!plan) throw new Error(`plan ${planId} not found`);
    if (!plan.clean && !acceptDegradation) {
      throw new Error('plan is not clean — has blocking gaps. Re-run keel-plan.mjs after remediation, or pass --accept-degradation to proceed with known gaps excluded.');
    }

    const versions = await getResourceVersionsFn(client, { snapshotId: plan.source_snapshot });
    const references = await getReferencesFn(client, { snapshotId: plan.source_snapshot });
    const refsByVersion = new Map();
    for (const r of references) {
      if (!refsByVersion.has(r.from_version)) refsByVersion.set(r.from_version, []);
      refsByVersion.get(r.from_version).push({ field: r.field_path, symbol: r.to_symbol, required: r.required });
    }
    const resources = versions
      .filter((v) => v.resource_type !== 'user' && v.resource_type !== 'authenticationStrengthPolicy') // read-only in M1, never written
      .map((v) => ({
        naturalKey: v.natural_key, resourceType: v.resource_type, payload: v.payload,
        references: refsByVersion.get(v.id) ?? [], blastRadius: v.blast_radius, restorePriority: 100,
      }));

    const { waves, patches } = planWavesFn(resources);
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

    const seeds = {
      [`${targetConfig.tenantId}/entra/write`]: { capacity: 100, refillPerSecond: 100 / 20 }, // Intune-tier seed, spec §11.1
    };
    const governor = new ThrottleGovernorClass(seeds);
    const runId = `run-${planId}`;
    const appliedIds = new Map();

    for (const [i, waveKeys] of waves.entries()) {
      const wave = phaseOneResources(
        resources.filter((r) => waveKeys.includes(r.naturalKey)),
        patches,
      );
      logger.log(`wave ${i + 1}/${waves.length}: ${wave.length} resources`);
      if (mode === 'enforce') {
        for (const r of wave) await recordPriorStateFn(client, { runId, naturalKey: r.naturalKey, priorState: null });
      }
      const result = await applyWaveFn(writer, governor, wave, {
        targetTenant: targetConfig.tenantId,
        mode,
        existingTargetIds,
        appliedIds,
        signInPathGate: { reader: targetReader, protectedPrincipalIds },
      });
      logger.log(`  applied ${result.applied.length}, skipped ${result.skipped.length}, failed ${result.failed.length}`);
      for (const { naturalKey, targetId } of result.applied) {
        if (typeof targetId === 'string' && targetId.length > 0) appliedIds.set(naturalKey, targetId);
      }
      if (result.failed.length) {
        throw new Error('wave had failures — stopping run (retry is safe: applies are idempotent by natural key, spec §9.3)');
      }
    }

    const patchResult = await applyPatchesFn(writer, governor, patches, {
      targetTenant: targetConfig.tenantId, mode, appliedIds,
    });
    logger.log(`patched ${patchResult.applied.length}, patchFailed ${patchResult.failed.length}`);
    if (patchResult.failed.length) {
      throw new Error('deferred patch had failures — stopping run');
    }

    return { plan, resources, waves, patches, appliedIds };
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
  if (!planId) throw new Error('--plan <id> required');
  const targetConfig = JSON.parse(readFile(arg('target-config', undefined, argv), 'utf8'));
  const collectorConfigPath = arg('collector-config', undefined, argv);
  if (!collectorConfigPath) throw new Error('--collector-config <path> required for read-only sign-in-path evidence');
  const collectorConfig = JSON.parse(readFile(collectorConfigPath, 'utf8'));
  assertSeparateRestorer(collectorConfig, targetConfig);
  const mode = flag('enforce', argv) ? 'enforce' : 'dry-run';

  return runRestore({
    planId,
    targetConfig,
    collectorConfig,
    mode,
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
