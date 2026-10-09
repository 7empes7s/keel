/**
 * Roadmap task-64 boundary tests: selecting a qualified native or
 * reconstructed recovery mechanism.
 *
 * Exercises engine/restore/recoveryMechanism.mjs, the live-state lookup
 * distinction, the applyWave recovery gate, the dry-run digest and the full
 * cli/keel-restore.mjs dry-run -> promotion path against the isolated test
 * database and an in-memory fake Graph. No tenant is read or written.
 * Required mutation checks:
 *
 * - Fallback to create on lookup error.
 * - Ignore retention deadline.
 * - Omit mechanism from plan digest.
 */
import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { after, test } from 'node:test';

import { canonicalHash } from '../cir/canonicalHash.mjs';
import { buildReconciliationPlan } from '../reconcile/reconciliationPlan.mjs';
import { applyWave } from '../restore/applyEngine.mjs';
import { computePlanDigest, createDryRunArtifact, getDryRunArtifactById } from '../restore/dryRunArtifact.mjs';
import {
  NATIVE_RECOVERY_ROUTES, SOFT_DELETE_RETENTION_DAYS, recoveryGate, selectRecoveryMechanism, softDeleteDeadline,
} from '../restore/recoveryMechanism.mjs';
import { createSnapshot, completeSnapshot, insertResourceVersion } from '../store/db.mjs';
import { createIsolatedTestDatabase } from '../test/dbTestHelper.mjs';
import { fakeGraph } from '../../tools/qualification/operations.mjs';
import { runRestore } from '../../cli/keel-restore.mjs';

const database = await createIsolatedTestDatabase(import.meta.url);
after(async () => { await database.cleanup(); });

const DAY = 24 * 60 * 60 * 1000;
const NOW = new Date('2026-10-03T12:00:00Z');
const daysAgo = (days, from = NOW) => new Date(from.getTime() - days * DAY).toISOString();
const governor = { async acquire() {}, observeRetryAfter() {} };
const quiet = { log() {}, error() {} };
const hrGroup = { displayName: 'HR', mailNickname: 'hr', mailEnabled: false, securityEnabled: true, groupTypes: [] };

/** A reader over a fakeGraph: live listings, deleted-items listings, injectable failures. */
function readerFor(graph, { failDeleted = null, failLive = null } = {}) {
  return {
    async collect(version, path) {
      if (path.startsWith('/directory/deletedItems/')) {
        if (failDeleted === 'throw') throw new Error('ETIMEDOUT');
        if (failDeleted) return { items: undefined, error: { status: failDeleted, error: 'denied' } };
        return { items: [...graph.deleted.values()].map((entry) => entry.body), capped: false, error: null };
      }
      const collection = path.split('?')[0];
      if (failLive && collection === failLive) return { items: undefined, error: { status: 503, error: 'unavailable' } };
      const items = [...graph.objects.entries()]
        .filter(([key]) => key.startsWith(`${collection}/`) && !key.slice(collection.length + 1).includes('/'))
        .map(([, body]) => body);
      return { items, capped: false, error: null };
    },
  };
}

const desiredHr = { naturalKey: 'group:hr', resourceType: 'group', payload: hrGroup, payloadHash: canonicalHash(hrGroup, 'group'), references: [], blastRadius: 'access-affecting' };

// ---------------------------------------------- acceptance 1: soft restore keeps the id

test('a qualified soft restore is selected within retention and preserves the object id', async () => {
  const graph = fakeGraph();
  graph.deleted.set('target-hr', { path: '/groups/target-hr', body: { ...hrGroup, id: 'target-hr', deletedDateTime: daysAgo(3) } });
  const plan = await buildReconciliationPlan(readerFor(graph), [desiredHr], { now: NOW });
  const [hr] = plan.resources;
  assert.equal(hr.verb, 'restore-soft-deleted');
  assert.equal(hr.recovery.mechanism, 'soft-delete-restore');
  assert.equal(hr.recovery.idOutcome, 'retained');
  assert.equal(hr.recovery.retainedId, 'target-hr');
  assert.equal(hr.recovery.deadline, new Date(Date.parse(daysAgo(3)) + SOFT_DELETE_RETENTION_DAYS * DAY).toISOString());
  assert.equal(hr.recovery.credentialMode, 'restorer');

  const result = await applyWave(graph, governor, [hr], { targetTenant: 't', mode: 'enforce', now: () => NOW });
  assert.deepEqual(result.failed, []);
  assert.deepEqual(result.applied, [{ naturalKey: 'group:hr', targetId: 'target-hr' }]);
  assert.equal(graph.writes[0].path, '/directory/deletedItems/target-hr/restore');
  assert.ok(!graph.writes.some((write) => write.method === 'POST' && write.path === '/groups'), 'never recreated');
  assert.ok(graph.objects.has('/groups/target-hr'), 'the original id is back');
});

// ------------------------------------- acceptance 2 + mutation check: retention deadline

test('mutation check: an expired or unprovable recovery point refuses soft restore, at planning and at execution', async () => {
  const expired = selectRecoveryMechanism(
    { naturalKey: 'group:hr', resourceType: 'group', verb: 'restore-soft-deleted', live: { payload: { deletedDateTime: daysAgo(31) }, deletedItemId: 'x' } },
    { now: NOW },
  );
  assert.equal(expired.mechanism, 'refused');
  assert.match(expired.reason, /recovery-point-expired/);

  const unprovable = selectRecoveryMechanism(
    { naturalKey: 'group:hr', resourceType: 'group', verb: 'restore-soft-deleted', live: { payload: {}, deletedItemId: 'x' } },
    { now: NOW },
  );
  assert.equal(unprovable.mechanism, 'refused');
  assert.equal(softDeleteDeadline({ deletedDateTime: 'not a date' }), null);

  // Planned in time, executed after the deadline: applyWave refuses before writing.
  const graph = fakeGraph();
  graph.deleted.set('target-hr', { path: '/groups/target-hr', body: { ...hrGroup, id: 'target-hr', deletedDateTime: daysAgo(29) } });
  const [hr] = (await buildReconciliationPlan(readerFor(graph), [desiredHr], { now: NOW })).resources;
  assert.equal(hr.recovery.mechanism, 'soft-delete-restore');
  const later = new Date(NOW.getTime() + 2 * DAY);
  const result = await applyWave(graph, governor, [hr], { targetTenant: 't', mode: 'enforce', now: () => later });
  assert.equal(graph.writes.length, 0);
  assert.match(result.skipped[0].reason, /recovery-point-expired/);
  assert.match(recoveryGate(hr, { now: later }).reason, /recovery-point-expired/);
});

// --------------------------------- acceptance 3 + mutation check: no create on lookup error

test('mutation check: a 403 or a timeout on the deleted-items lookup never falls back to recreation', async () => {
  for (const failDeleted of [403, 'throw']) {
    const graph = fakeGraph();
    const plan = await buildReconciliationPlan(readerFor(graph, { failDeleted }), [desiredHr], { now: NOW });
    const [hr] = plan.resources;
    assert.equal(hr.verb, 'create', 'the diff alone would create it');
    assert.equal(hr.recovery.mechanism, 'refused', `${failDeleted}: lookup failure is not "not found"`);
    assert.match(hr.recovery.reason, /lookup-failed/);
    assert.ok(plan.deletedLookupFailures.has('group'));
    const result = await applyWave(graph, governor, [hr], { targetTenant: 't', mode: 'enforce', now: () => NOW });
    assert.equal(graph.writes.length, 0, 'nothing is created');
    assert.match(result.skipped[0].reason, /lookup-failed/);
  }
  // A clean "not found" (the lookup succeeded and the object is nowhere) recreates.
  const clean = await buildReconciliationPlan(readerFor(fakeGraph()), [desiredHr], { now: NOW });
  assert.equal(clean.resources[0].recovery.mechanism, 'recreate');
  assert.equal(clean.resources[0].recovery.idOutcome, 'new');
  // A failed LIVE listing leaves presence itself unknown: the plan fails closed.
  await assert.rejects(buildReconciliationPlan(readerFor(fakeGraph(), { failLive: '/groups' }), [desiredHr], { now: NOW }), /listing \/groups.*failed/);
});

// ---------------------------------------------- acceptance 4: native routes stay manual

test('an unqualified native recovery route is a manual handoff; a failed native lookup refuses', async () => {
  // Roadmap task-152: a deleted Conditional Access policy is read from its own
  // deleted items and soft-restored, so it is no longer a native-route handoff.
  assert.equal(NATIVE_RECOVERY_ROUTES.conditionalAccessPolicy, undefined);
  const policy = {
    naturalKey: 'namedLocation:Office', resourceType: 'namedLocation', verb: 'create',
    payload: { '@odata.type': '#microsoft.graph.ipNamedLocation', displayName: 'Office', isTrusted: false, ipRanges: [] },
  };
  assert.equal(NATIVE_RECOVERY_ROUTES.namedLocation.qualified, false);
  const manual = selectRecoveryMechanism(policy, { nativeLookup: { state: 'found' }, now: NOW });
  assert.equal(manual.mechanism, 'manual');
  assert.match(manual.reason, /not credential-qualified/);
  const refused = selectRecoveryMechanism(policy, { nativeLookup: { state: 'failed' }, now: NOW });
  assert.equal(refused.mechanism, 'refused');
  assert.equal(selectRecoveryMechanism(policy, { nativeLookup: { state: 'not-found' }, now: NOW }).mechanism, 'recreate');

  const graph = fakeGraph();
  const result = await applyWave(graph, governor, [{ ...policy, references: [], recovery: manual }], { targetTenant: 't', mode: 'enforce' });
  assert.equal(graph.writes.length, 0);
  assert.match(result.skipped[0].reason, /^manual:/);

  // Unsupported capability: manual, and applyWave's own capability refusal still stands.
  const unsupported = selectRecoveryMechanism({ naturalKey: 'user:a', resourceType: 'user', verb: 'create' }, { now: NOW });
  assert.equal(unsupported.mechanism, 'manual');
});

test('a mechanism that does not match the verb is a failure, not a write', async () => {
  const graph = fakeGraph();
  const recovery = selectRecoveryMechanism({ ...desiredHr, verb: 'restore-soft-deleted', live: { payload: { deletedDateTime: daysAgo(1) }, deletedItemId: 'x' } }, { now: NOW });
  const result = await applyWave(graph, governor, [{ ...desiredHr, verb: 'create', recovery }], { targetTenant: 't', mode: 'enforce', now: () => NOW });
  assert.equal(graph.writes.length, 0);
  assert.match(result.failed[0].error, /mechanism-mismatch/);
});

// -------------------------------- acceptance 5 + mutation check: mechanism in the digest

test('mutation check: the recovery mechanism is part of the plan digest; legacy artifacts keep theirs', async () => {
  const base = {
    snapshotId: 's', selection: ['group:hr'], closureKeys: ['group:hr'], targetTenantId: 't',
    collectorConfigPath: 'c', targetConfigPath: 'r', reconciliationResources: undefined, waves: [['group:hr']], patches: [],
  };
  const restore = [{ naturalKey: 'group:hr', mechanism: 'soft-delete-restore', idOutcome: 'retained', deadline: '2026-11-01T00:00:00.000Z' }];
  const recreate = [{ naturalKey: 'group:hr', mechanism: 'recreate', idOutcome: 'new', deadline: null }];
  assert.notEqual(computePlanDigest({ ...base, recoveryMechanisms: restore }), computePlanDigest({ ...base, recoveryMechanisms: recreate }));
  assert.notEqual(computePlanDigest({ ...base, recoveryMechanisms: restore }), computePlanDigest(base));
  assert.equal(computePlanDigest({ ...base, recoveryMechanisms: null }), computePlanDigest(base), 'legacy digest inputs unchanged');
});

// ------------------------------------------------------- full CLI dry run -> promotion

const TENANT_ID = 'tenant-64';
const configs = new Map([
  ['/fixtures/collector.json', JSON.stringify({ tenantId: TENANT_ID, clientId: 'collector', certPath: 'c.pem', keyPath: 'c.key' })],
  ['/fixtures/restorer.json', JSON.stringify({ tenantId: TENANT_ID, clientId: 'restorer', certPath: 'r.pem', keyPath: 'r.key' })],
]);
const readFile = (path) => configs.get(path) ?? (() => { throw new Error(`unexpected config read: ${path}`); })();

let schemaReady = false;
async function schemaClient(t) {
  const client = await database.connect();
  t.after(async () => { await client.end(); });
  if (!schemaReady) {
    await client.query(readFileSync(new URL('../store/schema.sql', import.meta.url), 'utf8'));
    schemaReady = true;
  }
  return client;
}

async function seedSnapshot(client) {
  const snapshotId = await createSnapshot(client, { tenantRef: 'sha256:task-64' });
  await insertResourceVersion(client, {
    snapshotId,
    resource: {
      naturalKey: 'group:hr', resourceType: 'group', payload: hrGroup, payloadHash: canonicalHash(hrGroup, 'group'),
      criticality: 'tier1', blastRadius: 'access-affecting', fidelity: 'full', provenance: { adapter: 'test' },
    },
  });
  await completeSnapshot(client, { id: snapshotId, status: 'complete', coverageDigest: {} });
  return snapshotId;
}

function cliDependencies(graph) {
  const base = readerFor(graph);
  class Reader {
    async collect(version, path) {
      if (path.startsWith('/identity/conditionalAccess/policies') || path.startsWith('/roleManagement/')) {
        return { items: [], capped: false, error: null };
      }
      return base.collect(version, path);
    }

    async get(version, path) {
      if (path === '/policies/authenticationMethodsPolicy') return { ok: true, status: 200, body: { id: 'authenticationMethodsPolicy' } };
      if (path === '/policies/identitySecurityDefaultsEnforcementPolicy') return { ok: true, status: 200, body: { id: 'identitySecurityDefaultsEnforcementPolicy', isEnabled: true } };
      if (path.startsWith('/users/')) return { ok: true, status: 200, body: { id: 'break-glass-id', accountEnabled: true } };
      throw new Error(`unexpected read: ${path}`);
    }
  }
  return {
    getToken: async () => ({ accessToken: 'fake-token' }),
    GraphReader: Reader,
    GraphWriter: class { constructor() { return graph; } },
    collectM1: async () => [],
    canonicalizeAll: () => [
      { naturalKey: 'roleAssignment:GlobalAdministrator:break-glass', resourceType: 'roleAssignment', sourceId: 'ra-1', payload: { principalId: 'break-glass-id' } },
    ],
  };
}

const dryRun = (snapshotId, graph, artifactId) => runRestore({
  snapshotId, selection: ['group:hr'], mode: 'dry-run', persistArtifactId: artifactId, requestedBy: 'tester',
  collectorConfig: JSON.parse(configs.get('/fixtures/collector.json')), targetConfig: JSON.parse(configs.get('/fixtures/restorer.json')),
  collectorConfigPath: '/fixtures/collector.json', targetConfigPath: '/fixtures/restorer.json',
  readFile, dbUrl: database.url, dependencies: cliDependencies(graph), logger: quiet,
});
const promote = (artifactId, graph) => runRestore({
  artifactId, mode: 'enforce', readFile, dbUrl: database.url, dependencies: cliDependencies(graph), logger: quiet,
});

test('a mechanism that changes after review invalidates promotion; the reviewed soft restore keeps the id', async (t) => {
  const client = await schemaClient(t);
  const snapshotId = await seedSnapshot(client);
  // Deleted relative to the real clock: runRestore plans and executes "now".
  const deletedHr = () => ({ path: '/groups/target-hr', body: { ...hrGroup, id: 'target-hr', deletedDateTime: daysAgo(2, new Date()) } });

  const graph = fakeGraph();
  graph.deleted.set('target-hr', deletedHr());
  const first = '64000000-0000-4000-8000-000000000001';
  const dry = await dryRun(snapshotId, graph, first);
  assert.deepEqual(dry.recoveryMechanisms.map((m) => [m.naturalKey, m.mechanism, m.idOutcome, m.retainedId]), [['group:hr', 'soft-delete-restore', 'retained', 'target-hr']]);
  const artifact = await getDryRunArtifactById(client, { id: first });
  assert.equal(artifact.status, 'completed');
  assert.deepEqual(artifact.recoveryMechanisms, dry.recoveryMechanisms, 'the reviewed mechanism is frozen in the artifact');

  // The deleted original is purged before promotion: the same diff would now
  // recreate. The target fingerprint is unchanged — only the mechanism moved.
  graph.deleted.clear();
  await assert.rejects(promote(first, graph), /no longer matches the dry-run artifact/);
  assert.equal(graph.writes.length, 0, 'a changed mechanism never writes');

  // Reviewed and unchanged: promotion restores from deleted items, keeping the id.
  graph.deleted.set('target-hr', deletedHr());
  const second = '64000000-0000-4000-8000-000000000002';
  await dryRun(snapshotId, graph, second);
  const result = await promote(second, graph);
  assert.deepEqual(result.results.failed, []);
  assert.equal(graph.writes[0].path, '/directory/deletedItems/target-hr/restore');
  assert.ok(graph.objects.has('/groups/target-hr'));
  assert.ok(!graph.writes.some((write) => write.method === 'POST' && write.path === '/groups'));
});

test('a deleted-items lookup failure makes the dry run refused, so it can never be promoted into a create', async (t) => {
  const client = await schemaClient(t);
  const snapshotId = await seedSnapshot(client);
  const graph = fakeGraph();
  const deps = cliDependencies(graph);
  const failing = readerFor(graph, { failDeleted: 403 });
  const original = deps.GraphReader;
  deps.GraphReader = class extends original {
    async collect(version, path) {
      return path.startsWith('/directory/deletedItems/') ? failing.collect(version, path) : super.collect(version, path);
    }
  };
  const artifactId = '64000000-0000-4000-8000-000000000003';
  const dry = await runRestore({
    snapshotId, selection: ['group:hr'], mode: 'dry-run', persistArtifactId: artifactId, requestedBy: 'tester',
    collectorConfig: JSON.parse(configs.get('/fixtures/collector.json')), targetConfig: JSON.parse(configs.get('/fixtures/restorer.json')),
    collectorConfigPath: '/fixtures/collector.json', targetConfigPath: '/fixtures/restorer.json',
    readFile, dbUrl: database.url, dependencies: deps, logger: quiet,
  });
  assert.equal(dry.recoveryMechanisms[0].mechanism, 'refused');
  const artifact = await getDryRunArtifactById(client, { id: artifactId });
  assert.equal(artifact.status, 'refused');
  assert.match(artifact.guardRefusals[0].reason, /lookup-failed/);
  assert.equal(graph.writes.length, 0);
});

test('an artifact persisted before task-64 reads as having no mechanisms', async (t) => {
  const client = await schemaClient(t);
  const snapshotId = await createSnapshot(client, { tenantRef: 'sha256:legacy-64' });
  const artifact = await createDryRunArtifact(client, {
    id: '64000000-0000-4000-8000-000000000004', tenantRef: 'sha256:legacy-64', snapshotId, selection: ['group:hr'], closureKeys: ['group:hr'],
    targetTenantId: 't', collectorConfigPath: 'c', targetConfigPath: 'r', waves: [], patches: [], results: {},
    currentStateFingerprint: 'f', digest: 'd', status: 'completed', requestedBy: 'x',
  });
  assert.equal(artifact.recoveryMechanisms, null);
});
