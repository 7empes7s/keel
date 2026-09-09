#!/usr/bin/env node
// /opt/keel/cli/keel-restore.mjs
//
// node keel-restore.mjs --plan <id> --collector-config /etc/keel/tenant-target.json --target-config /etc/keel/restorer-target.json [--enforce] [--accept-degradation]
import { readFileSync } from 'node:fs';
import { getToken } from '../tools/tenant-probe/auth.mjs';
import { GraphReader } from '../tools/tenant-probe/graph.mjs';
import { collectM1 } from '../engine/collect/entraAdapter.mjs';
import { canonicalizeAll } from '../engine/cir/canonicalize.mjs';
import { connect, getResourceVersions, getReferences } from '../engine/store/db.mjs';
import { planWaves } from '../engine/restore/wavePlanner.mjs';
import { ThrottleGovernor } from '../engine/restore/throttleGovernor.mjs';
import { GraphWriter } from '../engine/restore/graphWriter.mjs';
import { applyWave, applyPatches } from '../engine/restore/applyEngine.mjs';
import { recordPriorState } from '../engine/restore/rollbackJournal.mjs';

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 ? process.argv[i + 1] : fallback;
}
function flag(name) {
  return process.argv.includes(`--${name}`);
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

async function main() {
  const planId = arg('plan');
  if (!planId) throw new Error('--plan <id> required');
  const targetConfig = JSON.parse(readFileSync(arg('target-config'), 'utf8'));
  const collectorConfigPath = arg('collector-config');
  if (!collectorConfigPath) throw new Error('--collector-config <path> required for read-only sign-in-path evidence');
  const collectorConfig = JSON.parse(readFileSync(collectorConfigPath, 'utf8'));
  assertSeparateRestorer(collectorConfig, targetConfig);
  const mode = flag('enforce') ? 'enforce' : 'dry-run';

  const client = await connect(process.env.KEEL_DB_URL);
  const { rows } = await client.query('SELECT * FROM plan WHERE id = $1', [planId]);
  const plan = rows[0];
  if (!plan) throw new Error(`plan ${planId} not found`);
  if (!plan.clean && !flag('accept-degradation')) {
    console.error('plan is not clean — has blocking gaps. Re-run keel-plan.mjs after remediation, or pass --accept-degradation to proceed with known gaps excluded.');
    process.exit(1);
  }

  const versions = await getResourceVersions(client, { snapshotId: plan.source_snapshot });
  const references = await getReferences(client, { snapshotId: plan.source_snapshot });
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

  const { waves, patches } = planWaves(resources);
  const { accessToken: collectorToken } = await getToken(collectorConfig);
  const targetReader = new GraphReader(async () => collectorToken);
  const { accessToken: restorerToken } = await getToken(targetConfig);
  const writer = new GraphWriter(async () => restorerToken);

  // Re-collect the target's CURRENT state — not what planning saw — so a retry
  // after a partial failure treats already-created resources as done instead
  // of re-creating them (spec §9.3; see Task 17's idempotency fix).
  const targetCollected = await collectM1(targetReader);
  const targetResources = canonicalizeAll(targetCollected);
  const existingTargetIds = new Map(targetResources.map((r) => [r.naturalKey, r.sourceId]));
  const protectedPrincipalIds = targetResources
    .filter((resource) => resource.resourceType === 'roleAssignment'
      && resource.naturalKey.includes('GlobalAdministrator'))
    .map((resource) => resource.payload.principalId);

  const seeds = {
    [`${targetConfig.tenantId}/entra/write`]: { capacity: 100, refillPerSecond: 100 / 20 }, // Intune-tier seed, spec §11.1
  };
  const governor = new ThrottleGovernor(seeds);
  const runId = `run-${planId}`;
  const appliedIds = new Map();

  for (const [i, waveKeys] of waves.entries()) {
    const wave = resources.filter((r) => waveKeys.includes(r.naturalKey));
    console.log(`wave ${i + 1}/${waves.length}: ${wave.length} resources`);
    if (mode === 'enforce') {
      for (const r of wave) await recordPriorState(client, { runId, naturalKey: r.naturalKey, priorState: null });
    }
    const result = await applyWave(writer, governor, wave, {
      targetTenant: targetConfig.tenantId,
      mode,
      existingTargetIds,
      signInPathGate: { reader: targetReader, protectedPrincipalIds },
    });
    console.log(`  applied ${result.applied.length}, skipped ${result.skipped.length}, failed ${result.failed.length}`);
    for (const { naturalKey, targetId } of result.applied) appliedIds.set(naturalKey, targetId);
    if (result.failed.length) {
      console.error('wave had failures — stopping run (retry is safe: applies are idempotent by natural key, spec §9.3)');
      await client.end();
      return;
    }
  }

  const patchResult = await applyPatches(writer, governor, patches, {
    targetTenant: targetConfig.tenantId, mode, appliedIds,
  });
  console.log(`patched ${patchResult.applied.length}, patchFailed ${patchResult.failed.length}`);

  await client.end();
}

main().catch((err) => { console.error(err); process.exit(1); });
