#!/usr/bin/env node
/**
 * M2.8 live round-trip rehearsal. This module never selects a pre-existing
 * object: live mode creates one disposable group, then uses that group alone
 * for every mutation. Collection remains on the Collector registration;
 * mutations use the separate Restorer registration.
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { getToken } from '../tenant-probe/auth.mjs';
import { GraphReader } from '../tenant-probe/graph.mjs';
import { canonicalHash } from '../../engine/cir/canonicalHash.mjs';
import { canonicalizeAll } from '../../engine/cir/canonicalize.mjs';
import { DESCRIPTORS } from '../../engine/collect/descriptors.mjs';
import { collectM1 } from '../../engine/collect/entraAdapter.mjs';
import { seedFromSnapshot } from '../../engine/govern/baseline.mjs';
import { diffSnapshots } from '../../engine/govern/diffSnapshots.mjs';
import { applyDisposition } from '../../engine/govern/disposition.mjs';
import { applyWave } from '../../engine/restore/applyEngine.mjs';
import { GraphWriter } from '../../engine/restore/graphWriter.mjs';
import { recordPriorState } from '../../engine/restore/rollbackJournal.mjs';
import { ThrottleGovernor } from '../../engine/restore/throttleGovernor.mjs';
import {
  completeSnapshot, connect, createSnapshot, getResourceVersions, insertReferences,
  insertResourceVersion,
} from '../../engine/store/db.mjs';
import { getActiveBaseline, recordDrift } from '../../engine/store/governance.mjs';

const DISPOSABLE_PREFIX = 'group:keel-rehearsal-';

const INTENDED_SEQUENCE = [
  '1. create group keel-rehearsal-<ISO timestamp> (Restorer credential)',
  '2. collect a snapshot; seed it as the active baseline',
  '3. modify the group live (description and displayName)',
  '4. detect; assert exactly one modified drift row for that natural key',
  '5. disposition rollback; execute; re-read',
  '6. assert canonicalHash now equals the baseline hash',
  '7. hard-delete the group; assert absence',
  'open item: PATCH mailNickname, mailEnabled, securityEnabled, and groupTypes; record which succeed',
];

/** Abort before a rehearsal mutation can touch a non-disposable object. */
export function assertDisposable(naturalKey) {
  if (!naturalKey?.startsWith(DISPOSABLE_PREFIX)) {
    throw new Error(`refusing to mutate non-disposable natural key: ${naturalKey}`);
  }
}

/**
 * Refuse production by comparing host, port, and database independently of
 * credentials; rehearsal writes seed baselines, snapshots, and drift rows,
 * while production holds operator-set baselines.
 */
export function assertRehearsalDatabase(dbUrl, productionUrl = process.env.KEEL_DB_URL) {
  if (!dbUrl) {
    throw new Error('the rehearsal needs a non-production database: set KEEL_DB_TEST_URL or pass --db-url');
  }
  if (!productionUrl) return dbUrl;
  const identity = (url) => {
    const parsed = new URL(url);
    return [parsed.hostname.toLowerCase(), parsed.port || '5432', parsed.pathname].join('|');
  };
  if (identity(dbUrl) === identity(productionUrl)) {
    throw new Error('refusing to run the rehearsal against the production database (KEEL_DB_URL): it seeds '
      + 'baselines, snapshots and drift rows that would appear as real governance state on the '
      + 'public status page. Use KEEL_DB_TEST_URL or pass --db-url.');
  }
  return dbUrl;
}

/** Step 4 is deliberately exact: a broader result is not rehearsal evidence. */
export function assertSingleModifiedDrift(driftRows, naturalKey) {
  if (driftRows.length !== 1) {
    throw new Error(`expected exactly one drift row for ${naturalKey}, found ${driftRows.length}`);
  }
  const drift = driftRows[0];
  if (drift.change_type !== 'modified' || drift.natural_key !== naturalKey) {
    throw new Error(`expected one modified drift row for ${naturalKey}`);
  }
  return drift;
}

function arg(name, fallback) {
  const index = process.argv.indexOf(`--${name}`);
  return index > -1 ? process.argv[index + 1] : fallback;
}

function flag(name) {
  return process.argv.includes(`--${name}`);
}

function readConfig(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function tenantRefFor(config) {
  return `sha256:${createHash('sha256').update(config.tenantId).digest('hex').slice(0, 16)}`;
}

function assertSeparateRestorer(collector, restorer) {
  if (collector.tenantId !== restorer.tenantId) {
    throw new Error('Restorer tenantId must match the Collector tenantId');
  }
  if (
    collector.clientId === restorer.clientId
    || collector.certPath === restorer.certPath
    || collector.keyPath === restorer.keyPath
  ) {
    throw new Error('Collector and Restorer credentials must be separate');
  }
}

function rehearsalGroup(timestamp) {
  const displayName = `keel-rehearsal-${timestamp}`;
  // Graph mail nicknames are the group natural key. Keep the ISO timestamp in
  // the display name and make its nickname-safe spelling unique as well.
  const mailNickname = displayName.replace(/[^A-Za-z0-9-]/g, '-');
  return {
    naturalKey: `group:${mailNickname}`,
    payload: {
      displayName,
      description: 'KEEL disposable rehearsal baseline',
      mailNickname,
      mailEnabled: false,
      securityEnabled: true,
    },
  };
}

function logEvidence(log, step, evidence) {
  log(`step ${step}: ${JSON.stringify(evidence)}`);
}

function throwOnGraphFailure(result, action) {
  if (!result?.ok) {
    throw new Error(`${action} failed: ${JSON.stringify(result?.body ?? result)}`);
  }
  return result.body;
}

async function baselineRows(client, baselineId) {
  const { rows } = await client.query(
    `SELECT rv.*
     FROM baseline_resource br
     JOIN resource_version rv ON rv.id = br.resource_version_id
     WHERE br.baseline_id = $1`,
    [baselineId],
  );
  return rows;
}

async function readGroupOnce(reader, groupId) {
  const result = await reader.get(
    'v1.0',
    `/groups/${groupId}?$select=id,displayName,description,mailNickname,groupTypes,securityEnabled,mailEnabled,membershipRule,membershipRuleProcessingState,onPremisesSyncEnabled,isAssignableToRole,visibility,createdDateTime,modifiedDateTime`,
  );
  return throwOnGraphFailure(result, `read group ${groupId}`);
}

/** Same empirically-observed lag Task 3 hardens engine/restore/applyEngine.mjs against, applied
 * here to the rehearsal's own reads of the object it just created or mutated. */
export async function readGroupWithRetry(reader, groupId, { attempts = 6, delayMs = 3000, isExpected } = {}) {
  let lastError;
  for (let i = 0; i < attempts; i += 1) {
    try {
      const group = await readGroupOnce(reader, groupId);
      if (!isExpected || isExpected(group)) return group;
      lastError = new Error(`read of ${groupId} succeeded but did not yet satisfy the expected condition`);
    } catch (error) {
      lastError = error;
    }
    if (i < attempts - 1) await new Promise((resolve) => setTimeout(resolve, delayMs));
  }
  throw lastError;
}

/** Same replication lag readGroupWithRetry and writeWithRetry handle, for an arbitrary Graph path.
 * Retries until the caller's predicate holds — which may mean waiting for a resource to APPEAR
 * (/directory/deletedItems after a soft-delete) or to VANISH (/groups after one). Returns the last
 * result when attempts run out, leaving the caller's own error handling unchanged. */
export async function getWithRetry(reader, version, path, isSatisfied, { attempts = 6, delayMs = 3000 } = {}) {
  let result;
  for (let i = 0; i < attempts; i += 1) {
    result = await reader.get(version, path);
    if (isSatisfied(result)) return result;
    if (i < attempts - 1) await new Promise((resolve) => setTimeout(resolve, delayMs));
  }
  return result;
}

/** Same tenant-specific replication lag as readGroupWithRetry, observed on the write path too:
 * a write to an object this session just created/mutated can itself 404 until the write path
 * catches up. Retries ONLY a 404 — any other failure (400, 403, a real conflict) returns
 * immediately, unretried. */
export async function writeWithRetry(writer, version, path, body, { attempts = 6, delayMs = 3000 } = {}) {
  let result;
  for (let i = 0; i < attempts; i += 1) {
    result = await writer.write(version, path, body);
    if (result.ok || result.status !== 404) return result;
    if (i < attempts - 1) await new Promise((resolve) => setTimeout(resolve, delayMs));
  }
  return result;
}

/**
 * M1's broad group projection intentionally excludes description. The
 * rehearsal must roll its description mutation back, so merge an explicit
 * Collector-only read of the group it created into each rehearsal snapshot.
 * Callers that just mutated the group pass isExpected so the overlay read
 * cannot settle for a stale replica's body (observed live 2026-09-08 08:59Z);
 * with no predicate the first successful read is accepted, as before. The
 * tenantId comes from the loaded Collector config and feeds collectM1's scope
 * for catalogue entries whose path embeds the organization id.
 */
export async function collectRehearsalSnapshot(reader, groupId, { isExpected, delayMs, tenantId } = {}) {
  const collected = await collectM1(reader, { tenantId });
  const rehearsalGroup = await readGroupWithRetry(reader, groupId, { isExpected, delayMs });
  const groupEntry = collected.find(([resourceType]) => resourceType === 'group');
  const groups = groupEntry?.[1];
  if (!groups) throw new Error('group collection missing from M1 collection');
  const existingIndex = groups.findIndex((group) => group.id === groupId);
  if (existingIndex === -1) groups.push(rehearsalGroup);
  else groups[existingIndex] = rehearsalGroup;
  return canonicalizeAll(collected);
}

export async function collectBaselineSnapshot(reader, groupId, collector) {
  return collectRehearsalSnapshot(reader, groupId, { tenantId: collector.tenantId });
}

export async function collectDetectionSnapshot(reader, groupId, collector, { isExpected } = {}) {
  return collectRehearsalSnapshot(reader, groupId, { isExpected, tenantId: collector.tenantId });
}

async function persistSnapshot(client, { tenantRef, resources }) {
  const snapshotId = await createSnapshot(client, { tenantRef });
  const itemCounts = new Map();
  for (const resource of resources) {
    itemCounts.set(resource.resourceType, (itemCounts.get(resource.resourceType) ?? 0) + 1);
    const versionId = await insertResourceVersion(client, {
      snapshotId,
      resource: { ...resource, fidelity: resource.provenance.fidelity },
    });
    await insertReferences(client, { fromVersion: versionId, references: resource.references });
  }
  // collectM1 is fail-fast across every descriptor, so reaching this point
  // proves a full successful collection. Preserve that evidence explicitly;
  // an absent resource type is a successful empty collection, not no coverage.
  const coverageDigest = Object.fromEntries(DESCRIPTORS.map(({ type }) => [type, {
    outcome: 'complete',
    itemCount: itemCounts.get(type) ?? 0,
  }]));
  await completeSnapshot(client, { id: snapshotId, status: 'complete', coverageDigest });
  return snapshotId;
}

async function detect(client, { tenantRef, reader, groupId, isExpected, collector }) {
  const baseline = await getActiveBaseline(client, { tenantRef });
  if (!baseline) throw new Error(`no active baseline for ${tenantRef}`);

  const resources = await collectDetectionSnapshot(reader, groupId, collector, { isExpected });
  const snapshotId = await persistSnapshot(client, { tenantRef, resources });
  const [before, after] = await Promise.all([
    baselineRows(client, baseline.id),
    getResourceVersions(client, { snapshotId }),
  ]);
  const drift = diffSnapshots(before, after);
  const beforeByNaturalKey = new Map(before.map((row) => [row.natural_key, row]));
  const afterByNaturalKey = new Map(after.map((row) => [row.natural_key, row]));

  for (const item of drift) {
    const beforeRow = beforeByNaturalKey.get(item.naturalKey);
    const afterRow = afterByNaturalKey.get(item.naturalKey);
    await recordDrift(client, {
      tenantRef,
      baselineId: baseline.id,
      observedSnapshot: snapshotId,
      naturalKey: item.naturalKey,
      resourceType: item.resourceType,
      changeType: item.changeType,
      beforeHash: item.beforeHash,
      afterHash: item.afterHash,
      beforePayload: beforeRow?.payload,
      afterPayload: afterRow?.payload,
      blastRadius: item.blastRadius,
    });
  }

  const { rows } = await client.query(
    `SELECT * FROM drift
     WHERE observed_snapshot = $1 AND natural_key = $2
     ORDER BY detected_at, id`,
    [snapshotId, groupNaturalKey(resources, groupId)],
  );
  return { snapshotId, rows };
}

function groupNaturalKey(resources, groupId) {
  const resource = resources.find((item) => item.resourceType === 'group' && item.sourceId === groupId);
  if (!resource) throw new Error(`rehearsal group ${groupId} missing from collected snapshot`);
  return resource.naturalKey;
}

function disposableWriter(writer, naturalKey) {
  return {
    write: async (...args) => {
      assertDisposable(naturalKey);
      return writer.write(...args);
    },
    read: (...args) => writer.read(...args),
  };
}

function probeValue(field, group) {
  if (field === 'mailNickname') return `${group.mailNickname}-probe`;
  if (field === 'mailEnabled') return !Boolean(group.mailEnabled);
  if (field === 'securityEnabled') return !Boolean(group.securityEnabled);
  if (field === 'groupTypes') return group.groupTypes?.length ? [] : ['Unified'];
  throw new Error(`unknown immutable-field probe: ${field}`);
}

async function measureImmutablePatches({ writer, reader, groupId, naturalKey, log }) {
  let current = await readGroupOnce(reader, groupId);
  let currentNaturalKey = naturalKey;
  const results = [];

  for (const field of ['mailNickname', 'mailEnabled', 'securityEnabled', 'groupTypes']) {
    assertDisposable(currentNaturalKey);
    const result = await writeWithRetry(writer, 'v1.0', `/groups/${groupId}`, {
      method: 'PATCH',
      body: { [field]: probeValue(field, current) },
    });
    const outcome = { field, ok: result.ok, status: result.status, body: result.body ?? null };
    if (result.ok) {
      current = await readGroupOnce(reader, groupId);
      currentNaturalKey = `group:${current.mailNickname}`;
      assertDisposable(currentNaturalKey);
      outcome.naturalKey = currentNaturalKey;
    }
    results.push(outcome);
    logEvidence(log, 'immutable-field probe', outcome);
  }
  return { results, naturalKey: currentNaturalKey, current };
}

export async function hardDelete({ writer, reader, client, naturalKey, groupId, priorState, runId }) {
  assertDisposable(naturalKey);
  await recordPriorState(client, { runId, naturalKey, priorState });
  throwOnGraphFailure(
    await writeWithRetry(writer, 'v1.0', `/groups/${groupId}`, { method: 'DELETE', body: {} }),
    `delete group ${groupId}`,
  );

  const absentFromGroups = await getWithRetry(reader, 'v1.0', `/groups/${groupId}`,
    (r) => r.ok === false && r.status === 404);
  if (absentFromGroups.ok || absentFromGroups.status !== 404) {
    throw new Error(`deleted group ${groupId} is still present at /groups`);
  }

  const deletedItem = await getWithRetry(reader, 'v1.0', `/directory/deletedItems/${groupId}`,
    (r) => r.ok === true);
  if (!deletedItem.ok) {
    throw new Error(`deleted group ${groupId} could not be read before permanent deletion`);
  }

  assertDisposable(naturalKey);
  await recordPriorState(client, { runId, naturalKey, priorState: deletedItem.body });
  throwOnGraphFailure(
    await writeWithRetry(writer, 'v1.0', `/directory/deletedItems/${groupId}`, { method: 'DELETE', body: {} }),
    `permanently delete group ${groupId}`,
  );

  const absentFromDeletedItems = await getWithRetry(reader, 'v1.0', `/directory/deletedItems/${groupId}`,
    (r) => r.ok === false && r.status === 404);
  if (absentFromDeletedItems.ok || absentFromDeletedItems.status !== 404) {
    throw new Error(`hard-deleted group ${groupId} is still present in deletedItems`);
  }
}

/** The rehearsal's step 7 only runs on the happy path. Any earlier failure would otherwise leave a
 * live disposable group in the tenant — observed 2026-09-08. This is best-effort cleanup, not
 * evidence: it deliberately skips the rollback journal that hardDelete writes, and it never throws,
 * so it cannot mask the failure that triggered it. */
async function cleanupOrphan({ writer, groupId, naturalKey, log }) {
  try {
    assertDisposable(naturalKey);
    await writeWithRetry(writer, 'v1.0', `/groups/${groupId}`, { method: 'DELETE', body: {} });
    await writeWithRetry(writer, 'v1.0', `/directory/deletedItems/${groupId}`, { method: 'DELETE', body: {} });
    log(`cleanup: removed orphaned rehearsal group ${groupId}`);
  } catch (error) {
    log(`cleanup FAILED for ${groupId}: ${error.message}`);
  }
}

/**
 * Runs live only when mode is exactly "live". Dry-run is deliberately the
 * default and returns before it constructs credentials, connects to the
 * database, or calls a writer.
 */
export async function runRoundTrip({
  mode = 'dry-run',
  log = (line) => process.stdout.write(`${line}\n`),
  collectorConfigPath = '/etc/keel/tenant.json',
  restorerConfigPath,
  dbUrl = process.env.KEEL_DB_TEST_URL,
  writer,
  reader,
  client,
  now = () => new Date(),
} = {}) {
  if (mode === 'dry-run') {
    log('dry-run: no writes issued; intended sequence:');
    for (const step of INTENDED_SEQUENCE) log(step);
    return { mode, sequence: INTENDED_SEQUENCE };
  }
  if (mode !== 'live') throw new Error(`unknown mode: ${mode}`);
  assertRehearsalDatabase(dbUrl);

  let ownedClient = false;
  let createdGroupId = null;
  let createdNaturalKey = null;
  let hardDeleted = false;
  try {
    const collector = readConfig(collectorConfigPath);
    const restorer = readConfig(restorerConfigPath);
    assertSeparateRestorer(collector, restorer);
    if (!reader) {
      const { accessToken } = await getToken(collector);
      reader = new GraphReader(async () => accessToken);
    }
    if (!writer) {
      const { accessToken } = await getToken(restorer);
      writer = new GraphWriter(async () => accessToken);
    }
    if (!client) {
      client = await connect(dbUrl);
      ownedClient = true;
    }

    const { naturalKey, payload } = rehearsalGroup(now().toISOString());
    assertDisposable(naturalKey);

    // 1. The first tenant mutation creates the only object this rehearsal may touch.
    const created = throwOnGraphFailure(
      await writer.write('v1.0', '/groups', { method: 'POST', body: payload }),
      'create disposable rehearsal group',
    );
    if (!created?.id) throw new Error('created rehearsal group did not return an id');
    const groupId = created.id;
    createdGroupId = groupId;
    createdNaturalKey = naturalKey;
    logEvidence(log, 1, { naturalKey, groupId, created: true });

    // 2. Collect with the Collector credential and seed that snapshot as active.
    const tenantRef = tenantRefFor(collector);
    const baselineResources = await collectBaselineSnapshot(reader, groupId, collector);
    const baselineSnapshotId = await persistSnapshot(client, { tenantRef, resources: baselineResources });
    const baselineId = await seedFromSnapshot(client, {
      tenantRef,
      snapshotId: baselineSnapshotId,
      setBy: 'keel-rehearsal',
    });
    const baselineResource = baselineResources.find((resource) => (
      resource.resourceType === 'group' && resource.sourceId === groupId
    ));
    if (!baselineResource) throw new Error(`created rehearsal group ${groupId} missing from baseline snapshot`);
    const baselineHash = canonicalHash(baselineResource.payload, 'group');
    logEvidence(log, 2, { baselineSnapshotId, baselineId, naturalKey, baselineHash });

    // 3. Mutate both fields named by the rehearsal contract.
    // Step 3 waits for the drifted content to replicate, and step 4's
    // collection must wait for the SAME content — a single predicate so the
    // two can never drift apart.
    const driftIsVisible = (group) => group.description === 'KEEL disposable rehearsal drift'
      && group.displayName === `${payload.displayName} (drifted)`;
    assertDisposable(naturalKey);
    throwOnGraphFailure(
      await writeWithRetry(writer, 'v1.0', `/groups/${groupId}`, {
        method: 'PATCH',
        body: {
          description: 'KEEL disposable rehearsal drift',
          displayName: `${payload.displayName} (drifted)`,
        },
      }),
      `modify rehearsal group ${groupId}`,
    );
    const driftedGroup = await readGroupWithRetry(reader, groupId, {
      isExpected: driftIsVisible,
    });
    logEvidence(log, 3, {
      naturalKey,
      description: driftedGroup.description,
      displayName: driftedGroup.displayName,
    });

    // 4. Detect and accept only the precise evidence for this disposable key.
    const detected = await detect(client, { tenantRef, reader, groupId, isExpected: driftIsVisible, collector });
    const drift = assertSingleModifiedDrift(detected.rows, naturalKey);
    logEvidence(log, 4, { snapshotId: detected.snapshotId, driftId: drift.id, naturalKey, changeType: drift.change_type });

    // 5. Build the scoped rollback plan, then execute its one update through
    // the normal apply path. The wrapper asserts the disposable key at the
    // exact write boundary as well as immediately before this mutating step.
    assertDisposable(naturalKey);
    const plan = await applyDisposition(client, {
      driftId: drift.id,
      action: 'rollback',
      actor: 'keel-rehearsal',
      reason: 'round-trip rehearsal',
    });
    if (plan.resources.length !== 1 || plan.resources[0].naturalKey !== naturalKey) {
      throw new Error(`rollback plan widened beyond ${naturalKey}`);
    }
    const governor = new ThrottleGovernor({
      [`${collector.tenantId}/entra/write`]: { capacity: 100, refillPerSecond: 100 / 20 },
    });
    const rollback = await applyWave(
      disposableWriter(writer, naturalKey),
      governor,
      [{
        ...plan.resources[0],
        targetId: groupId,
        verb: 'update',
      }],
      { targetTenant: collector.tenantId, mode: 'enforce' },
    );
    if (rollback.failed.length || rollback.skipped.length || rollback.applied.length !== 1) {
      throw new Error(`rollback did not apply exactly once: ${JSON.stringify(rollback)}`);
    }
    const restoredGroup = await readGroupWithRetry(reader, groupId, {
      isExpected: (group) => canonicalHash(group, 'group') === baselineHash,
    });
    logEvidence(log, 5, { naturalKey, rollback, groupId });

    // 6. Re-read with Collector credentials and prove canonical convergence.
    const restoredHash = canonicalHash(restoredGroup, 'group');
    if (restoredHash !== baselineHash) {
      throw new Error(`rollback hash mismatch: expected ${baselineHash}, got ${restoredHash}`);
    }
    logEvidence(log, 6, { naturalKey, baselineHash, restoredHash });

    // Record the requested empirical answer without changing the deliberately
    // conservative IMMUTABLE classification. The orchestrating live session
    // owns the measurement and any follow-up classification change.
    const measured = await measureImmutablePatches({
      writer: disposableWriter(writer, naturalKey),
      reader,
      groupId,
      naturalKey,
      log,
    });

    // 7. Journal before each DELETE, permanently remove only the group we
    // created, and prove absence from both live and deleted-item surfaces.
    await hardDelete({
      writer: disposableWriter(writer, measured.naturalKey),
      reader,
      client,
      naturalKey: measured.naturalKey,
      groupId,
      priorState: measured.current,
      runId: `rehearsal-${Date.now()}`,
    });
    hardDeleted = true;
    logEvidence(log, 7, { naturalKey: measured.naturalKey, groupId, absent: true });

    return { mode, naturalKey: measured.naturalKey, groupId, baselineHash, immutableFieldResults: measured.results };
  } finally {
    if (createdGroupId && !hardDeleted) {
      await cleanupOrphan({ writer, groupId: createdGroupId, naturalKey: createdNaturalKey, log });
    }
    if (ownedClient) await client.end();
  }
}

async function main() {
  const dryRun = flag('dry-run');
  const live = flag('live');
  if (dryRun && live) throw new Error('choose either --dry-run or --live');
  await runRoundTrip({
    mode: live ? 'live' : 'dry-run',
    collectorConfigPath: arg('config', '/etc/keel/tenant.json'),
    restorerConfigPath: arg('restorer-config'),
    dbUrl: arg('db-url', process.env.KEEL_DB_TEST_URL),
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error.message);
    process.exit(1);
  });
}
