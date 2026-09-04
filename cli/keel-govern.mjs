#!/usr/bin/env node
// /opt/keel/cli/keel-govern.mjs
//
// node keel-govern.mjs baseline set --snapshot <id> --by <actor>
// node keel-govern.mjs baseline show
// node keel-govern.mjs disposition <driftId> --action accept|rollback|ignore --actor <actor> --reason <reason> [--expires <iso8601>] [--confirm]
// node keel-govern.mjs evidence verify
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { getToken } from '../tools/tenant-probe/auth.mjs';
import { GraphReader } from '../tools/tenant-probe/graph.mjs';
import { collectM1 } from '../engine/collect/entraAdapter.mjs';
import { canonicalHash } from '../engine/cir/canonicalHash.mjs';
import { canonicalizeAll } from '../engine/cir/canonicalize.mjs';
import { naturalKeyFor } from '../engine/cir/naturalKey.mjs';
import { buildLiveIndex } from '../engine/reconcile/liveState.mjs';
import { decideVerb } from '../engine/reconcile/verb.mjs';
import { GraphWriter } from '../engine/restore/graphWriter.mjs';
import { applyWave } from '../engine/restore/applyEngine.mjs';
import { ThrottleGovernor } from '../engine/restore/throttleGovernor.mjs';
import { seedFromSnapshot } from '../engine/govern/baseline.mjs';
import { applyDisposition } from '../engine/govern/disposition.mjs';
import { verifyChain } from '../engine/govern/evidence.mjs';
import { connect } from '../engine/store/db.mjs';
import { getActiveBaseline } from '../engine/store/governance.mjs';

function usage() {
  console.log(`usage:
  keel-govern.mjs baseline set --snapshot <id> --by <actor> [--config /etc/keel/tenant.json] [--db-url $KEEL_DB_URL]
  keel-govern.mjs baseline show [--config /etc/keel/tenant.json] [--db-url $KEEL_DB_URL]
  keel-govern.mjs disposition <driftId> --action accept|rollback|ignore --actor <actor> --reason <reason> [--expires <iso8601>] [--confirm]
  keel-govern.mjs evidence verify [--config /etc/keel/tenant.json] [--db-url $KEEL_DB_URL]

Rollback without --confirm prints only the scoped plan. A confirmed rollback requires
--restorer-config <path>; its reads use --config (the Collector registration) and
its writes use the separate Restorer registration.`);
}

function arg(name, fallback) {
  const index = process.argv.indexOf(`--${name}`);
  return index > -1 ? process.argv[index + 1] : fallback;
}

function flag(name) {
  return process.argv.includes(`--${name}`);
}

function requiredArg(name) {
  const value = arg(name);
  if (!value || value.startsWith('--')) throw new Error(`--${name} <value> required`);
  return value;
}

function dbUrl() {
  const url = arg('db-url', process.env.KEEL_DB_URL);
  if (!url) throw new Error('KEEL_DB_URL not set (source /etc/keel/db.env or pass --db-url)');
  return url;
}

function readConfig(path = arg('config', '/etc/keel/tenant.json')) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function tenantRefFor(config) {
  return `sha256:${createHash('sha256').update(config.tenantId).digest('hex').slice(0, 16)}`;
}

function printablePlan(plan) {
  return {
    resources: plan.resources,
    expectedVerbs: Object.fromEntries(plan.expectedVerbs),
  };
}

async function withClient(fn) {
  const client = await connect(dbUrl());
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

async function setBaseline() {
  const snapshotId = requiredArg('snapshot');
  const setBy = requiredArg('by');
  const tenantRef = tenantRefFor(readConfig());

  await withClient(async (client) => {
    const { rows } = await client.query(
      'SELECT tenant_ref FROM snapshot WHERE id = $1',
      [snapshotId],
    );
    if (!rows[0]) throw new Error(`snapshot not found: ${snapshotId}`);
    if (rows[0].tenant_ref !== tenantRef) {
      throw new Error(`snapshot ${snapshotId} does not belong to this tenant`);
    }

    const baselineId = await seedFromSnapshot(client, { tenantRef, snapshotId, setBy });
    console.log(`active baseline ${baselineId}`);
  });
}

async function showBaseline() {
  const tenantRef = tenantRefFor(readConfig());

  await withClient(async (client) => {
    const baseline = await getActiveBaseline(client, { tenantRef });
    if (!baseline) throw new Error(`no active baseline for ${tenantRef}`);

    const { rows } = await client.query(
      'SELECT count(*) AS resource_count FROM baseline_resource WHERE baseline_id = $1',
      [baseline.id],
    );
    console.log(`id: ${baseline.id}`);
    console.log(`set_at: ${baseline.set_at.toISOString()}`);
    console.log(`set_by: ${baseline.set_by}`);
    console.log(`resource_count: ${rows[0].resource_count}`);
  });
}

function expiration() {
  const value = arg('expires');
  if (value == null) return undefined;
  const expiresAt = new Date(value);
  if (Number.isNaN(expiresAt.valueOf())) throw new Error('--expires must be iso8601');
  return expiresAt;
}

function assertSeparateRestorer(collector, restorer) {
  if (collector.tenantId !== restorer.tenantId) {
    throw new Error('Restorer tenantId must match the Collector tenantId');
  }
  if (collector.clientId === restorer.clientId
    || collector.certPath === restorer.certPath
    || collector.keyPath === restorer.keyPath) {
    throw new Error('confirmed rollback requires a separate Restorer registration and certificate');
  }
}

function liveStateFor(resource, liveResources, softDeleted) {
  const live = liveResources.get(resource.naturalKey);
  if (live) {
    return {
      targetId: live.sourceId,
      payloadHash: canonicalHash(live.payload, resource.resourceType),
      payload: live.payload,
      state: 'present',
    };
  }
  return softDeleted.get(resource.naturalKey) ?? null;
}

async function executeRollback(plan, { driftId, client }) {
  const collector = readConfig();
  const restorerConfigPath = requiredArg('restorer-config');
  const restorer = JSON.parse(readFileSync(restorerConfigPath, 'utf8'));
  assertSeparateRestorer(collector, restorer);

  // Collection stays on the read-only Collector registration. The Restorer
  // registration is used below only by GraphWriter after the plan is complete.
  const { accessToken } = await getToken(collector);
  const reader = new GraphReader(async () => accessToken);
  const collected = await collectM1(reader);
  const liveResources = new Map(canonicalizeAll(collected).map((resource) => [resource.naturalKey, resource]));
  const softDeletableTypes = [...new Set(plan.resources
    .map((resource) => resource.resourceType)
    .filter((resourceType) => ['user', 'group', 'application'].includes(resourceType)))];
  const softDeleted = await buildLiveIndex(reader, {
    resourceTypes: softDeletableTypes,
    naturalKeyFor,
  });

  const unsupported = plan.resources.filter((resource) => ![
    'group', 'roleAssignment', 'namedLocation', 'conditionalAccessPolicy',
  ].includes(resource.resourceType));
  if (unsupported.length) {
    throw new Error(`rollback cannot execute read-only or unsupported resource types: ${unsupported.map((resource) => resource.resourceType).join(', ')}`);
  }

  const resolved = [];
  const noops = [];
  for (const resource of plan.resources) {
    const desired = resource.payload == null
      ? null
      : { payloadHash: canonicalHash(resource.payload, resource.resourceType) };
    const current = liveStateFor(resource, liveResources, softDeleted);
    const live = current?.state === 'present'
      ? { payloadHash: current.payloadHash }
      : null;
    const decision = decideVerb({ desired, live, softDeleted: current?.state === 'soft-deleted' });
    if (decision.verb === 'noop') {
      noops.push({ naturalKey: resource.naturalKey, reason: decision.reason });
      continue;
    }
    resolved.push({
      ...resource,
      // A delete journals the actual live payload, never the plan's desired
      // absence. applyWave writes it before it issues DELETE.
      payload: decision.verb === 'delete' ? current.payload : resource.payload,
      targetId: current?.targetId,
      deletedItemId: current?.deletedItemId,
      verb: decision.verb,
    });
  }

  // Do this before creating a Restorer token or issuing any write. The write
  // path verifies each change with read(); without it a confirmed rollback
  // would be able to mutate the tenant but not prove convergence.
  if (typeof GraphWriter.prototype.read !== 'function') {
    throw new Error('refusing rollback before writes: GraphWriter.read is required for verification');
  }

  const { accessToken: restorerToken } = await getToken(restorer);
  const writer = new GraphWriter(async () => restorerToken);
  const breakGlassUserIds = [...liveResources.values()]
    .filter((resource) => resource.resourceType === 'roleAssignment'
      && resource.naturalKey.includes('GlobalAdministrator'))
    .map((resource) => resource.payload.principalId);
  const deletionGuardOptions = {
    breakGlassUserIds,
    keelAppIds: [collector.clientId, restorer.clientId],
    caPolicies: [...liveResources.values()]
      .filter((resource) => resource.resourceType === 'conditionalAccessPolicy'),
  };
  const governor = new ThrottleGovernor({
    [`${collector.tenantId}/entra/write`]: { capacity: 100, refillPerSecond: 100 / 20 },
  });
  const result = await applyWave(writer, governor, resolved, {
    targetTenant: collector.tenantId,
    mode: 'enforce',
    deletionGuardOptions,
    rollbackClient: client,
    runId: `rollback-${driftId}-${Date.now()}`,
  });
  console.log(JSON.stringify({ ...result, noops }, null, 2));
}

async function disposition(driftId) {
  if (!driftId) throw new Error('disposition requires a drift id');
  const action = requiredArg('action');
  if (!['accept', 'rollback', 'ignore'].includes(action)) {
    throw new Error('--action must be accept, rollback, or ignore');
  }
  const actor = requiredArg('actor');
  const reason = requiredArg('reason');
  const expiresAt = expiration();

  await withClient(async (client) => {
    const result = await applyDisposition(client, {
      driftId, action, actor, reason, expiresAt,
    });

    if (action !== 'rollback') {
      console.log(`disposition ${action} applied${result ? `: ${result}` : ''}`);
      return;
    }

    console.log(JSON.stringify(printablePlan(result), null, 2));
    if (!flag('confirm')) {
      console.log('rollback plan only; pass --confirm before executing writes');
      return;
    }
    await executeRollback(result, { driftId, client });
  });
}

async function verifyEvidence() {
  const tenantRef = tenantRefFor(readConfig());
  await withClient(async (client) => {
    const result = await verifyChain(client, { tenantRef });
    if (result.ok) {
      console.log('evidence: ok');
      return;
    }
    console.log(`evidence: broken at seq ${result.brokenAtSeq}`);
  });
}

async function main() {
  if (flag('help') || flag('h')) {
    usage();
    return;
  }

  const [command, subject] = process.argv.slice(2);
  if (command === 'baseline' && subject === 'set') return setBaseline();
  if (command === 'baseline' && subject === 'show') return showBaseline();
  if (command === 'disposition') return disposition(subject);
  if (command === 'evidence' && subject === 'verify') return verifyEvidence();
  usage();
  throw new Error(`unknown command: ${command ?? '(none)'}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
