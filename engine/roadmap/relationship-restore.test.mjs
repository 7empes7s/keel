/**
 * Roadmap task-61 boundary tests: qualified relationship restore operations.
 *
 * Exercises the production relationshipWriter.mjs planner/executor, the
 * applyWave relationship-via-parent guard, the dry-run digest/fingerprint and
 * the full cli/keel-restore.mjs dry-run -> promotion path against the isolated
 * test database, a fake Graph reader and a fake Graph writer. No live tenant is
 * read or written. Covers the four acceptance criteria and the three required
 * mutation checks:
 *
 * - PATCH the parent for a relationship operation.
 * - Ignore membership in the fingerprint.
 * - Remove edges after a failed read.
 */
import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { after, test } from 'node:test';

import { canonicalHash } from '../cir/canonicalHash.mjs';
import { recordRelationships, loadSnapshotRelationships } from '../collect/relationships.mjs';
import {
  EDGE_OPERATIONS, OPERATIONS, capabilityFor, edgeCapabilityKey,
} from '../coverage/capabilities.mjs';
import { decideEdgeVerb } from '../reconcile/verb.mjs';
import { applyWave } from '../restore/applyEngine.mjs';
import {
  computeCurrentStateFingerprint, computePlanDigest, createDryRunArtifact, getDryRunArtifactById,
} from '../restore/dryRunArtifact.mjs';
import {
  RELATIONSHIP_RESTORE_FAMILIES, applyRelationshipOperations, planRelationshipOperations,
  refRequestFor, relationshipOperationKey,
} from '../restore/relationshipWriter.mjs';
import { createSnapshot, completeSnapshot, insertResourceVersion } from '../store/db.mjs';
import { createIsolatedTestDatabase } from '../test/dbTestHelper.mjs';
import { runRestore } from '../../cli/keel-restore.mjs';

const database = await createIsolatedTestDatabase(import.meta.url);
after(async () => { await database.cleanup(); });

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

const governor = { async acquire() {}, observeRetryAfter() {} };
const noSleep = async () => {};
const quiet = { log() {}, error() {} };

/** A fake target tenant: edge sets per `${groupId}|${family}`, mutated only by $ref writes. */
function fakeTenant(initial = {}) {
  const edges = new Map(Object.entries(initial).map(([key, ids]) => [key, new Set(ids)]));
  const writes = [];
  const reads = [];
  const failures = { read: null, write: null };
  const edgePath = /^\/groups\/([^/]+)\/(members|owners)\?\$select=id$/;
  const reader = {
    async collect(version, path) {
      reads.push(path);
      const match = edgePath.exec(path);
      if (!match) return { items: [], pages: 1, status: 200, capped: false, error: null };
      const override = failures.read?.(path);
      if (override) return override;
      const set = edges.get(`${match[1]}|${match[2].slice(0, -1)}`) ?? new Set();
      return { items: [...set].map((id) => ({ '@odata.type': '#microsoft.graph.user', id })), pages: 1, status: 200, capped: false, error: null };
    },
  };
  const writer = {
    async write(version, path, { method, body }) {
      writes.push({ version, path, method, body });
      const add = /^\/groups\/([^/]+)\/(members|owners)\/\$ref$/.exec(path);
      const remove = /^\/groups\/([^/]+)\/(members|owners)\/([^/]+)\/\$ref$/.exec(path);
      const apply = () => {
        if (add && method === 'POST') {
          const key = `${add[1]}|${add[2].slice(0, -1)}`;
          if (!edges.has(key)) edges.set(key, new Set());
          edges.get(key).add(body['@odata.id'].split('/').pop());
        } else if (remove && method === 'DELETE') {
          edges.get(`${remove[1]}|${remove[2].slice(0, -1)}`)?.delete(remove[3]);
        }
      };
      const override = failures.write?.({ path, method, body, apply });
      if (override) return override;
      apply();
      return { ok: true, status: 204, body: null };
    },
    async read() { throw new Error('edge restore verifies through the reader, never a parent read'); },
  };
  return { edges, writes, reads, failures, reader, writer, ids: (key) => [...(edges.get(key) ?? [])].sort() };
}

const op = (action, targetNaturalKey, targetId, extra = {}) => ({
  parentNaturalKey: 'group:eng', family: 'member', action, targetNaturalKey, targetId, ...extra,
});

// ------------------------------------------------ capability and verb table

test('only group member/owner edges carry a write capability; every other family stays read-only', () => {
  assert.deepEqual([...RELATIONSHIP_RESTORE_FAMILIES], ['member', 'owner']);
  for (const family of ['member', 'owner']) {
    for (const operation of EDGE_OPERATIONS) {
      const capability = capabilityFor(edgeCapabilityKey('group', family), operation);
      assert.equal(capability.claim, 'fixture-tested');
      assert.equal(capability.proofRef, 'engine/roadmap/relationship-restore.test.mjs');
      assert.match(capability.path, /\/\$ref$/);
    }
    // An edge capability never implies an object capability, and vice versa.
    for (const operation of OPERATIONS) assert.equal(capabilityFor(edgeCapabilityKey('group', family), operation).claim, 'unsupported');
  }
  assert.equal(capabilityFor('group', 'edge-add').claim, 'unsupported', 'the parent type has no edge capability');
  for (const [parent, family] of [['group', 'transitiveMember'], ['application', 'appOwner'], ['servicePrincipal', 'appRoleGrant']]) {
    assert.equal(capabilityFor(edgeCapabilityKey(parent, family), 'edge-add').claim, 'unsupported', `${parent} ${family}`);
  }
  assert.throws(() => refRequestFor({ family: 'transitiveMember', action: 'add' }, 'g', 't'), /no qualified \$ref handler/);
});

test('decideEdgeVerb removes only when a complete desired inventory proves absence', () => {
  assert.equal(decideEdgeVerb({ desired: true, live: false, removalProven: false }).verb, 'edge-add');
  assert.equal(decideEdgeVerb({ desired: false, live: true, removalProven: true }).verb, 'edge-remove');
  assert.equal(decideEdgeVerb({ desired: false, live: true, removalProven: false }).verb, 'refuse-remove');
  assert.equal(decideEdgeVerb({ desired: true, live: true, removalProven: true }).verb, 'noop');
  assert.throws(() => decideEdgeVerb({ desired: 'yes', live: true, removalProven: true }));
});

// ---------------------------------------- acceptance 1 + mutation check 1

test('membership restore uses qualified $ref operations and never PATCHes members onto the parent', async () => {
  const tenant = fakeTenant({ 'target-eng|member': ['target-mallory'] });
  const operations = [op('add', 'user:bob', 'target-bob'), op('remove', 'user:mallory', 'target-mallory')];
  const result = await applyRelationshipOperations(tenant.writer, governor, operations, {
    reader: tenant.reader, mode: 'enforce', targetTenant: 't', parentTargetIds: new Map([['group:eng', 'target-eng']]), sleep: noSleep,
  });
  assert.deepEqual(result.failed, []);
  assert.equal(result.applied.length, 2);
  assert.deepEqual(tenant.writes.map(({ method, path }) => `${method} ${path}`), [
    'POST /groups/target-eng/members/$ref',
    'DELETE /groups/target-eng/members/target-mallory/$ref',
  ]);
  assert.deepEqual(tenant.writes[0].body, { '@odata.id': 'https://graph.microsoft.com/v1.0/directoryObjects/target-bob' });
  assert.ok(tenant.writes.every(({ method, path }) => method !== 'PATCH' && path.endsWith('/$ref')), 'no parent write');
  assert.deepEqual(tenant.ids('target-eng|member'), ['target-bob']);
});

test('mutation check: a group payload carrying membership navigation is refused by applyWave before any write', async () => {
  for (const payload of [
    { displayName: 'Eng', members: [{ id: 'target-bob' }] },
    { displayName: 'Eng', 'members@odata.bind': ['https://graph.microsoft.com/v1.0/directoryObjects/target-bob'] },
    { displayName: 'Eng', 'owners@odata.bind': ['https://graph.microsoft.com/v1.0/users/target-bob'] },
  ]) {
    for (const verb of ['create', 'update']) {
      const writes = [];
      const writer = { async write(...args) { writes.push(args); return { ok: true, status: 204, body: { id: 'x' } }; }, async read() { return { ok: true, status: 200, body: {} }; } };
      const result = await applyWave(writer, governor, [{
        naturalKey: 'group:eng', resourceType: 'group', verb, payload, targetId: 'target-eng', references: [], blastRadius: 'access-affecting',
      }], { targetTenant: 't', mode: 'enforce', existingTargetIds: new Map([['group:eng', 'target-eng']]) });
      assert.equal(writes.length, 0, `${verb} must not write`);
      assert.match(result.failed[0]?.error ?? '', /relationship-via-parent refused/);
    }
  }
});

// ------------------------------------------------------------- acceptance 2

test('a lost response is reconciled by reading back: the member is never added twice', async () => {
  const tenant = fakeTenant({ 'target-eng|member': [] });
  // Graph applied the add, but the response never arrived.
  tenant.failures.write = ({ apply }) => { apply(); throw new Error('socket hang up'); };
  const result = await applyRelationshipOperations(tenant.writer, governor, [op('add', 'user:bob', 'target-bob')], {
    reader: tenant.reader, mode: 'enforce', targetTenant: 't', parentTargetIds: new Map([['group:eng', 'target-eng']]), sleep: noSleep,
  });
  assert.equal(tenant.writes.length, 1, 'the add is sent exactly once');
  assert.deepEqual(result.failed, []);
  assert.equal(result.applied[0].reconciled, 'lost-response');
  assert.deepEqual(tenant.ids('target-eng|member'), ['target-bob']);
});

test('an ambiguous 5xx that did NOT apply fails without a blind resend; a 429 is safely re-sent', async () => {
  const tenant = fakeTenant({ 'target-eng|member': [] });
  tenant.failures.write = () => ({ ok: false, status: 503, body: { error: 'unavailable' } });
  const lost = await applyRelationshipOperations(tenant.writer, governor, [op('add', 'user:bob', 'target-bob')], {
    reader: tenant.reader, mode: 'enforce', targetTenant: 't', parentTargetIds: new Map([['group:eng', 'target-eng']]), sleep: noSleep,
  });
  assert.equal(tenant.writes.length, 1, 'a 503 may have applied: never re-sent');
  assert.equal(lost.failed.length, 1);
  assert.deepEqual(tenant.ids('target-eng|member'), []);

  let throttled = 0;
  const retry = fakeTenant({ 'target-eng|member': [] });
  retry.failures.write = () => (throttled++ === 0 ? { ok: false, status: 429, retryAfter: 0, body: null } : null);
  const ok = await applyRelationshipOperations(retry.writer, governor, [op('add', 'user:bob', 'target-bob')], {
    reader: retry.reader, mode: 'enforce', targetTenant: 't', parentTargetIds: new Map([['group:eng', 'target-eng']]), sleep: noSleep,
  });
  assert.equal(retry.writes.length, 2, 'a 429 provably did nothing and is re-sent');
  assert.deepEqual(ok.failed, []);
});

test('an edge already in the desired state is reconciled without a write, and every write is journalled first', async () => {
  const tenant = fakeTenant({ 'target-eng|member': ['target-bob'] });
  const journal = [];
  const rollbackClient = {
    async query(sql, values) {
      journal.push({ values, writesBefore: tenant.writes.length });
      return { rows: [] };
    },
  };
  const result = await applyRelationshipOperations(tenant.writer, governor, [
    op('add', 'user:bob', 'target-bob'), op('add', 'user:carol', 'target-carol'),
  ], {
    reader: tenant.reader, mode: 'enforce', targetTenant: 't', parentTargetIds: new Map([['group:eng', 'target-eng']]),
    rollbackClient, runId: 'run-1', sleep: noSleep,
  });
  assert.equal(tenant.writes.length, 1, 'only carol is written');
  assert.equal(result.applied.find((entry) => entry.edge.targetId === 'target-bob').reconciled, 'already-present');
  assert.equal(journal.length, 1);
  assert.equal(journal[0].writesBefore, 0, 'the journal entry precedes the write');
  assert.deepEqual(journal[0].values[2], {
    kind: 'relationship-edge', parentNaturalKey: 'group:eng', parentTargetId: 'target-eng', family: 'member', targetId: 'target-carol', present: false,
  });

  const failingJournal = fakeTenant({ 'target-eng|member': [] });
  const refused = await applyRelationshipOperations(failingJournal.writer, governor, [op('add', 'user:carol', 'target-carol')], {
    reader: failingJournal.reader, mode: 'enforce', targetTenant: 't', parentTargetIds: new Map([['group:eng', 'target-eng']]),
    rollbackClient: { async query() { throw new Error('db down'); } }, runId: 'run-2', sleep: noSleep,
  });
  assert.equal(failingJournal.writes.length, 0);
  assert.match(refused.failed[0].error, /rollback journal write failed/);
});

test('post-write verification fails an edge the read-back does not show', async () => {
  const tenant = fakeTenant({ 'target-eng|member': [] });
  tenant.failures.write = () => ({ ok: true, status: 204, body: null }); // claims success, applies nothing
  const result = await applyRelationshipOperations(tenant.writer, governor, [op('add', 'user:bob', 'target-bob')], {
    reader: tenant.reader, mode: 'enforce', targetTenant: 't', parentTargetIds: new Map([['group:eng', 'target-eng']]),
    verifyAttempts: 3, sleep: noSleep,
  });
  assert.deepEqual(result.applied, []);
  assert.match(result.failed[0].error, /post-write verification failed/);
});

// ------------------------------------------ acceptance 4 + mutation check 3

const desiredOf = (outcome, targets) => new Map([['group:eng|member', {
  parentNaturalKey: 'group:eng', family: 'member', outcome,
  targets: targets.map(([sourceId, naturalKey]) => ({ targetId: sourceId, targetNaturalKey: naturalKey })),
}]]);
const liveOf = (outcome, ids) => new Map([['group:eng|member', { outcome, targets: ids.map((targetId) => ({ targetId })) }]]);
const targets = new Map([['user:alice', 'target-alice'], ['user:bob', 'target-bob'], ['user:mallory', 'target-mallory']]);
const planFor = (desired, live, extra = {}) => planRelationshipOperations({
  parents: [{ naturalKey: 'group:eng', verb: 'noop', liveTargetId: 'target-eng' }],
  desired, live,
  resolveTargetId: (key) => targets.get(key) ?? null,
  naturalKeyForTargetId: (id) => [...targets].find(([, value]) => value === id)?.[0] ?? null,
  ...extra,
});

test('a partial desired inventory refuses removal (adds still planned, the dry run is refused)', () => {
  const plan = planFor(desiredOf('partial', [['src-alice', 'user:alice']]), liveOf('complete', ['target-mallory']));
  assert.deepEqual(plan.operations.map(({ action, targetId }) => `${action}:${targetId}`), ['add:target-alice']);
  assert.equal(plan.refusals.length, 1);
  assert.match(plan.refusals[0].reason, /partial-edge-inventory/);
});

test('mutation check: a failed or partial live read removes nothing — at planning and at execution', async () => {
  for (const outcome of ['failed', 'partial']) {
    const plan = planFor(desiredOf('complete', [['src-alice', 'user:alice']]), liveOf(outcome, ['target-mallory']));
    assert.deepEqual(plan.operations, [], `${outcome} live read plans no operation`);
    assert.match(plan.refusals[0].reason, /blocked-edge-read/);
  }
  const missing = planFor(desiredOf('complete', []), new Map());
  assert.deepEqual(missing.operations, []);
  assert.match(missing.refusals[0].reason, /not performed/);

  // At execution: the precondition read fails, so a planned removal is never sent.
  const tenant = fakeTenant({ 'target-eng|member': ['target-mallory'] });
  tenant.failures.read = () => ({ items: undefined, pages: 0, status: 403, capped: false, error: { status: 403, code: 'Authorization_RequestDenied', error: 'denied' } });
  const result = await applyRelationshipOperations(tenant.writer, governor, [op('remove', 'user:mallory', 'target-mallory')], {
    reader: tenant.reader, mode: 'enforce', targetTenant: 't', parentTargetIds: new Map([['group:eng', 'target-eng']]), sleep: noSleep,
  });
  assert.equal(tenant.writes.length, 0);
  assert.match(result.skipped[0].reason, /blocked-edge-read/);
  assert.deepEqual(tenant.ids('target-eng|member'), ['target-mallory']);

  // A read cut short by paging is partial, never complete-empty.
  tenant.failures.read = () => ({ items: [], pages: 1, status: 200, capped: true, error: null });
  const capped = await applyRelationshipOperations(tenant.writer, governor, [op('remove', 'user:mallory', 'target-mallory')], {
    reader: tenant.reader, mode: 'enforce', targetTenant: 't', parentTargetIds: new Map([['group:eng', 'target-eng']]), sleep: noSleep,
  });
  assert.equal(tenant.writes.length, 0);
  assert.equal(capped.skipped.length, 1);
});

test('lineage remapping: targets resolve to target-tenant ids; unresolved targets are refused, never written by source id', () => {
  const plan = planFor(desiredOf('complete', [['src-alice', 'user:alice'], ['src-ghost', null]]), liveOf('complete', ['target-mallory']));
  assert.deepEqual(plan.operations.map(({ action, targetId }) => `${action}:${targetId}`), ['add:target-alice']);
  assert.ok(!JSON.stringify(plan.operations).includes('src-'), 'no source id reaches an operation');
  assert.ok(plan.refusals.some((r) => /unresolved-edge-target/.test(r.reason)));
  assert.ok(plan.refusals.some((r) => /removal-unproven/.test(r.reason)), 'an unresolved desired target makes removal unprovable');

  // A member this run creates is deferred and resolved from run provenance at execution.
  const deferred = planFor(desiredOf('complete', [['src-new', 'group:new-team']]), liveOf('complete-empty', []), {
    pendingCreates: new Set(['group:new-team']),
  });
  assert.deepEqual(deferred.operations, [op('add', 'group:new-team', null)]);
});

test('a break-glass principal is never removed from an edge set', () => {
  const plan = planFor(desiredOf('complete', []), liveOf('complete', ['target-mallory']), { protectedPrincipalIds: ['TARGET-MALLORY'] });
  assert.deepEqual(plan.operations, []);
  assert.match(plan.refusals[0].reason, /protected-principal/);
});

test('a snapshot that never observed edges (legacy) plans nothing; an unreadable snapshot set is a note, not an empty set', () => {
  const legacy = planFor(new Map(), liveOf('complete', ['target-mallory']));
  assert.deepEqual([legacy.operations, legacy.refusals, legacy.observed], [[], [], []]);
  const failed = planFor(desiredOf('failed', []), liveOf('complete', ['target-mallory']));
  assert.deepEqual(failed.operations, []);
  assert.equal(failed.notes.length, 1);
});

// ---------------------------------------- digest/fingerprint + mutation check 2

test('mutation check: membership is part of the current-state fingerprint and edge operations of the plan digest', () => {
  const resources = [{ naturalKey: 'group:eng', sourceId: 'target-eng', payload: { displayName: 'Eng' } }];
  const before = computeCurrentStateFingerprint(resources, ['group:eng'], {
    relationships: [{ parentNaturalKey: 'group:eng', family: 'member', outcome: 'complete', targetIds: ['target-alice'] }],
  });
  const after = computeCurrentStateFingerprint(resources, ['group:eng'], {
    relationships: [{ parentNaturalKey: 'group:eng', family: 'member', outcome: 'complete', targetIds: ['target-alice', 'target-zed'] }],
  });
  assert.notEqual(before, after, 'a concurrent member change must change the fingerprint');
  // Backward compatibility: no edge sets keeps the pre-task-61 value exactly.
  assert.equal(computeCurrentStateFingerprint(resources, ['group:eng'], { relationships: [] }), computeCurrentStateFingerprint(resources, ['group:eng']));

  const base = {
    snapshotId: 's', selection: ['group:eng'], closureKeys: ['group:eng'], targetTenantId: 't',
    collectorConfigPath: 'c', targetConfigPath: 'r', reconciliationResources: undefined, waves: [['group:eng']], patches: [],
  };
  assert.equal(computePlanDigest({ ...base, relationshipOperations: [] }), computePlanDigest(base));
  assert.notEqual(computePlanDigest({ ...base, relationshipOperations: [op('add', 'user:bob', 'target-bob')] }), computePlanDigest(base));
});

// ------------------------------------------------- acceptance 3: full CLI path

const TENANT_ID = 'tenant-61';
const configs = new Map([
  ['/fixtures/collector.json', JSON.stringify({ tenantId: TENANT_ID, clientId: 'collector', certPath: 'c.pem', keyPath: 'c.key' })],
  ['/fixtures/restorer.json', JSON.stringify({ tenantId: TENANT_ID, clientId: 'restorer', certPath: 'r.pem', keyPath: 'r.key' })],
]);
const readFile = (path) => {
  if (!configs.has(path)) throw new Error(`unexpected config read: ${path}`);
  return configs.get(path);
};
const liveGroup = { id: 'target-eng', displayName: 'Eng', mailNickname: 'eng', securityEnabled: true, mailEnabled: false, groupTypes: [] };

async function seedSnapshot(client, { memberOutcome = 'complete' } = {}) {
  const tenantRef = 'sha256:task-61';
  const snapshotId = await createSnapshot(client, { tenantRef });
  await insertResourceVersion(client, {
    snapshotId,
    resource: {
      naturalKey: 'group:eng', resourceType: 'group', payload: liveGroup, payloadHash: canonicalHash(liveGroup, 'group'),
      criticality: 'tier1', blastRadius: 'access-affecting', fidelity: 'full', provenance: { adapter: 'test' },
    },
  });
  await completeSnapshot(client, { id: snapshotId, status: 'complete', coverageDigest: {} });
  const at = new Date().toISOString();
  const set = (family, outcome, ids) => ({
    tenantRef, parentType: 'group', parentSourceId: 'source-eng', parentNaturalKey: 'group:eng', family, edgeType: family,
    direction: 'direct', endpoint: `/groups/source-eng/${family}s?$select=id`, apiVersion: 'v1.0', startedAt: at, completedAt: at,
    outcome, targets: ids.map((id) => ({ edgeKey: id, targetId: id, targetType: 'user', attributes: null })),
    itemCount: ids.length, pagesCompleted: 1, httpStatus: 200, graphCode: null, error: null,
  });
  await recordRelationships(client, {
    snapshotId, tenantRef,
    observations: [set('member', memberOutcome, ['source-alice', 'source-bob']), set('owner', 'complete', ['source-carol'])],
    context: new Map([
      ['source-alice', { symbol: 'user:alice', type: 'user' }],
      ['source-bob', { symbol: 'user:bob', type: 'user' }],
      ['source-carol', { symbol: 'user:carol', type: 'user' }],
    ]),
  });
  return snapshotId;
}

function cliDependencies(tenant) {
  class Reader {
    async collect(version, path) {
      if (path.startsWith('/groups?')) return { items: [liveGroup], pages: 1, status: 200, capped: false, error: null };
      return tenant.reader.collect(version, path);
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
    GraphWriter: class { constructor() { return tenant.writer; } },
    collectM1: async () => [],
    canonicalizeAll: () => [
      { naturalKey: 'group:eng', resourceType: 'group', sourceId: 'target-eng', payload: liveGroup },
      { naturalKey: 'user:alice', resourceType: 'user', sourceId: 'target-alice', payload: { id: 'target-alice' } },
      { naturalKey: 'user:bob', resourceType: 'user', sourceId: 'target-bob', payload: { id: 'target-bob' } },
      { naturalKey: 'user:carol', resourceType: 'user', sourceId: 'target-carol', payload: { id: 'target-carol' } },
      { naturalKey: 'user:mallory', resourceType: 'user', sourceId: 'target-mallory', payload: { id: 'target-mallory' } },
      { naturalKey: 'roleAssignment:GlobalAdministrator:break-glass', resourceType: 'roleAssignment', sourceId: 'ra-1', payload: { principalId: 'break-glass-id' } },
    ],
  };
}

async function dryRun(snapshotId, tenant, artifactId) {
  return runRestore({
    snapshotId, selection: ['group:eng'], mode: 'dry-run', persistArtifactId: artifactId, requestedBy: 'tester',
    collectorConfig: JSON.parse(configs.get('/fixtures/collector.json')), targetConfig: JSON.parse(configs.get('/fixtures/restorer.json')),
    collectorConfigPath: '/fixtures/collector.json', targetConfigPath: '/fixtures/restorer.json',
    readFile, dbUrl: database.url, dependencies: cliDependencies(tenant), logger: quiet,
  });
}

async function promote(artifactId, tenant) {
  return runRestore({ artifactId, mode: 'enforce', readFile, dbUrl: database.url, dependencies: cliDependencies(tenant), logger: quiet });
}

test('dry run -> promotion restores edges through $ref; a concurrent edge change refuses promotion', async (t) => {
  const client = await schemaClient(t);
  const snapshotId = await seedSnapshot(client);
  assert.equal((await loadSnapshotRelationships(client, { snapshotId })).size, 2);

  // Live: alice + mallory are members, no owners. Desired: alice + bob members, carol owner.
  const tenant = fakeTenant({ 'target-eng|member': ['target-alice', 'target-mallory'], 'target-eng|owner': [] });
  const artifactId = '61000000-0000-4000-8000-000000000001';
  const dry = await dryRun(snapshotId, tenant, artifactId);
  assert.equal(tenant.writes.length, 0, 'a dry run never writes');
  assert.deepEqual(dry.relationshipOperations.map(({ family, action, targetNaturalKey }) => `${family}:${action}:${targetNaturalKey}`), [
    'member:add:user:bob', 'member:remove:user:mallory', 'owner:add:user:carol',
  ]);
  const artifact = await getDryRunArtifactById(client, { id: artifactId });
  assert.equal(artifact.status, 'completed');
  assert.deepEqual(artifact.relationshipOperations, dry.relationshipOperations, 'the reviewed edge operations are frozen in the artifact');

  // Someone legitimately adds a member between review and promotion.
  tenant.edges.get('target-eng|member').add('target-zed');
  // The extra member changes both the live fingerprint and the edge operations the
  // plan would now need; whichever check fires first, promotion is refused.
  await assert.rejects(promote(artifactId, tenant), /target has changed since the dry run|no longer matches the dry-run artifact/);
  assert.equal(tenant.writes.length, 0, 'a refused promotion writes nothing');

  // A fresh dry run over the new state promotes cleanly.
  tenant.edges.get('target-eng|member').delete('target-zed');
  const second = '61000000-0000-4000-8000-000000000002';
  await dryRun(snapshotId, tenant, second);
  const result = await promote(second, tenant);
  assert.deepEqual(result.results.failed, []);
  assert.deepEqual(tenant.ids('target-eng|member'), ['target-alice', 'target-bob']);
  assert.deepEqual(tenant.ids('target-eng|owner'), ['target-carol']);
  assert.ok(tenant.writes.every(({ method, path }) => method !== 'PATCH' && path.endsWith('/$ref')), 'every write is a qualified $ref');
  const journal = await client.query(`SELECT natural_key FROM rollback_entry WHERE run_id = $1 ORDER BY natural_key`, [`run-selection-${snapshotId}`]);
  assert.deepEqual(journal.rows.map((row) => row.natural_key), [
    relationshipOperationKey(op('add', 'user:bob', 'target-bob')),
    relationshipOperationKey(op('remove', 'user:mallory', 'target-mallory')),
    relationshipOperationKey({ ...op('add', 'user:carol', 'target-carol'), family: 'owner' }),
  ].sort());
});

test('a partial snapshot inventory makes the dry run refused, so its removal can never be promoted', async (t) => {
  const client = await schemaClient(t);
  const snapshotId = await seedSnapshot(client, { memberOutcome: 'partial' });
  const tenant = fakeTenant({ 'target-eng|member': ['target-alice', 'target-mallory'], 'target-eng|owner': ['target-carol'] });
  const artifactId = '61000000-0000-4000-8000-000000000003';
  const dry = await dryRun(snapshotId, tenant, artifactId);
  assert.ok(!dry.relationshipOperations.some((entry) => entry.action === 'remove'));
  const artifact = await getDryRunArtifactById(client, { id: artifactId });
  assert.equal(artifact.status, 'refused');
  assert.ok(artifact.guardRefusals.some((r) => /partial-edge-inventory/.test(r.reason)));
  await assert.rejects(promote(artifactId, tenant), /not complete \(status: refused\)/);
  assert.equal(tenant.writes.length, 0);
});

test('legacy artifacts (no relationship_operations column value) read as no edge operations', async (t) => {
  const client = await schemaClient(t);
  const snapshotId = await createSnapshot(client, { tenantRef: 'sha256:legacy' });
  const artifact = await createDryRunArtifact(client, {
    id: '61000000-0000-4000-8000-000000000004', tenantRef: 'sha256:legacy', snapshotId, selection: ['group:eng'], closureKeys: ['group:eng'],
    targetTenantId: 't', collectorConfigPath: 'c', targetConfigPath: 'r', waves: [], patches: [], results: {},
    currentStateFingerprint: 'f', digest: 'd', status: 'completed', requestedBy: 'x',
  });
  assert.equal(artifact.relationshipOperations, null);
});
