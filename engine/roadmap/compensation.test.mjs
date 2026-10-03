// Roadmap task-70: conflict-aware compensation for failed restores.
//
// Acceptance:
//  - a lost success response reconciles actual state;
//  - partial-wave compensation only undoes matching writes;
//  - a concurrent admin update is not overwritten;
//  - compensation itself needs an immutable, approved artifact;
//  - irrecoverable effects remain explicit.
// Mutation checks:
//  - applying the inverse without a current-state comparison;
//  - treating a lost response as a guaranteed failure;
//  - bypassing the normal approval for an undo.
import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { after, test } from 'node:test';

import { canonicalHash } from '../cir/canonicalHash.mjs';
import { applyWave } from '../restore/applyEngine.mjs';
import { classifyWriteOutcome, listJournal } from '../restore/rollbackJournal.mjs';
import { planCompensation, reconcileUncertainWrite } from '../restore/compensation.mjs';
import { getDryRunArtifactById } from '../restore/dryRunArtifact.mjs';
import { createSnapshot, completeSnapshot, insertResourceVersion } from '../store/db.mjs';
import { createIsolatedTestDatabase } from '../test/dbTestHelper.mjs';
import { fakeGraph } from '../../tools/qualification/operations.mjs';
import { main, runRestore } from '../../cli/keel-restore.mjs';
import { JOB_HANDLERS } from '../../cli/keel-worker.mjs';

const database = await createIsolatedTestDatabase(import.meta.url);
after(async () => { await database.cleanup(); });

const TENANT = 'sha256:task-70';
const governor = { async acquire() {}, observeRetryAfter() {} };
const quiet = { log() {}, error() {} };

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

let seq = 0;
const entry = (fields) => {
  seq += 1;
  return {
    id: `entry-${seq}`, naturalKey: 'group:board', resourceType: 'group', targetId: 'board-id', blastRadius: 'access-affecting',
    outcome: 'succeeded', outcomeDetail: null, postState: null, intendedState: null, priorState: null, ...fields,
  };
};
const present = (payload, targetId = 'board-id') => ({ targetId, payload: { ...payload, id: targetId } });
const board = { displayName: 'Board', mailNickname: 'board', mailEnabled: false, securityEnabled: true, groupTypes: [] };

// ------------------------------------------------------------- write outcomes

test('a write outcome is classified from the response: only a definite rejection is a failure', () => {
  assert.equal(classifyWriteOutcome({ ok: true, status: 204 }), 'succeeded');
  assert.equal(classifyWriteOutcome({ ok: false, status: 400 }), 'failed');
  assert.equal(classifyWriteOutcome({ ok: false, status: 403 }), 'failed');
  // A lost response, a timeout, a 5xx or an exhausted 429 may have landed.
  assert.equal(classifyWriteOutcome({ ok: false, status: null, error: 'socket hang up' }), 'uncertain');
  assert.equal(classifyWriteOutcome({ ok: false, status: 408 }), 'uncertain');
  assert.equal(classifyWriteOutcome({ ok: false, status: 429, attempts: 6 }), 'uncertain');
  assert.equal(classifyWriteOutcome({ ok: false, status: 503 }), 'uncertain');
  assert.equal(classifyWriteOutcome(undefined), 'uncertain');
});

// --------------------------------------------------------- lost response

test('mutation check: a lost success response is journaled uncertain and reconciled from actual state, never assumed failed', async (t) => {
  const client = await schemaClient(t);
  const graph = fakeGraph();
  graph.objects.set('/groups/board-id', { ...board, id: 'board-id' });
  // The PATCH lands, but its response is lost on the way back.
  const write = graph.write.bind(graph);
  graph.write = async (version, path, request) => {
    const result = await write(version, path, request);
    return request.method === 'PATCH' ? { ok: false, status: null, error: 'connection reset' } : result;
  };
  const restoreRef = crypto.randomUUID();
  const resource = {
    naturalKey: 'group:board', resourceType: 'group', verb: 'update', targetId: 'board-id', references: [],
    payload: { ...board, displayName: 'Board (restored)' },
    live: { state: 'present', targetId: 'board-id', payload: { ...board, id: 'board-id' } },
  };
  const result = await applyWave(graph, governor, [resource], {
    targetTenant: 't', mode: 'enforce', rollbackClient: client, runId: 'run-lost', restoreRef,
  });
  assert.equal(result.failed.length, 1, 'the run itself reports the write as failed');

  const [journal] = await listJournal(client, { restoreRef });
  assert.equal(journal.operation, 'update');
  assert.equal(journal.outcome, 'uncertain', 'a lost response is never recorded as a guaranteed failure');
  assert.deepEqual(journal.priorState.displayName, 'Board');
  assert.equal(journal.intendedState.displayName, 'Board (restored)');

  // The write DID land: compensation must undo it.
  const landed = planCompensation({
    restoreRef, entries: [journal], current: new Map([['group:board', present(graph.objects.get('/groups/board-id'))]]),
  });
  assert.deepEqual(landed.reconciled, [{ naturalKey: 'group:board', outcome: 'uncertain', finding: 'landed' }]);
  assert.equal(landed.operations.length, 1);
  assert.equal(landed.operations[0].verb, 'update');
  assert.equal(landed.operations[0].payload.displayName, 'Board');
  assert.deepEqual(landed.operations[0].revertedFields, ['displayName']);

  // Had it not landed, there is nothing to undo.
  const notLanded = planCompensation({
    restoreRef, entries: [journal], current: new Map([['group:board', present(board)]]),
  });
  assert.equal(notLanded.operations.length, 0);
  assert.match(notLanded.notApplied[0].reason, /did not land/);

  // Neither intended nor prior: compensation refuses to guess.
  const unknown = planCompensation({
    restoreRef, entries: [journal], current: new Map([['group:board', present({ ...board, displayName: 'Someone else' })]]),
  });
  assert.equal(unknown.operations.length, 0);
  assert.match(unknown.conflicts[0].reason, /uncertain-outcome/);
});

test('an interrupted write (still pending) is reconciled by reading, for every operation kind', () => {
  const create = entry({ operation: 'create', outcome: 'pending', targetId: null, intendedState: board });
  assert.equal(reconcileUncertainWrite(create, null), 'not-landed');
  assert.equal(reconcileUncertainWrite(create, present(board, 'new-id')), 'landed');
  assert.equal(reconcileUncertainWrite(create, present({ ...board, displayName: 'Other' }, 'new-id')), 'unknown');

  const remove = entry({ operation: 'delete', outcome: 'pending', priorState: board });
  assert.equal(reconcileUncertainWrite(remove, null), 'landed');
  assert.equal(reconcileUncertainWrite(remove, present(board)), 'not-landed');
  assert.equal(reconcileUncertainWrite(remove, present(board, 'another-id')), 'unknown');
});

// ------------------------------------------------------ partial wave / conflicts

test('partial-wave compensation only undoes the writes that landed', () => {
  const entries = [
    entry({ naturalKey: 'group:a', operation: 'create', targetId: 'a-id', priorState: null, intendedState: { ...board, mailNickname: 'a' }, postState: { ...board, mailNickname: 'a', id: 'a-id' } }),
    entry({ naturalKey: 'group:b', operation: 'update', targetId: 'b-id', outcome: 'failed', outcomeDetail: 'status 400', priorState: { ...board, mailNickname: 'b' }, intendedState: { ...board, mailNickname: 'b', displayName: 'B2' } }),
    entry({ naturalKey: 'group:c', operation: 'update', targetId: 'c-id', outcome: 'pending', priorState: { ...board, mailNickname: 'c' }, intendedState: { ...board, mailNickname: 'c', displayName: 'C2' } }),
  ];
  const current = new Map([
    ['group:a', present({ ...board, mailNickname: 'a' }, 'a-id')],
    ['group:b', present({ ...board, mailNickname: 'b' }, 'b-id')],
    ['group:c', present({ ...board, mailNickname: 'c' }, 'c-id')], // the interrupted write never landed
  ]);
  const plan = planCompensation({ restoreRef: 'r1', entries, current });
  assert.deepEqual(plan.operations.map((op) => [op.naturalKey, op.verb, op.targetId]), [['group:a', 'delete', 'a-id']]);
  assert.deepEqual(plan.notApplied.map((item) => item.naturalKey).sort(), ['group:b', 'group:c']);
  assert.match(plan.notApplied.find((item) => item.naturalKey === 'group:b').reason, /rejected/);
  assert.equal(plan.atomic, false);
  assert.match(plan.statement, /not atomic/);
});

test('mutation check: a concurrent admin update is never overwritten — the inverse is applied only after a current-state comparison', () => {
  const updated = entry({
    operation: 'update', priorState: { ...board, description: 'old' },
    intendedState: { ...board, displayName: 'Board (restored)', description: 'old' },
    postState: { ...board, id: 'board-id', displayName: 'Board (restored)', description: 'old' },
  });
  // An admin renamed the group again after the restore: refuse, write nothing.
  const renamed = planCompensation({
    restoreRef: 'r2', entries: [updated], current: new Map([['group:board', present({ ...board, displayName: 'Board (admin)', description: 'old' })]]),
  });
  assert.deepEqual(renamed.operations, []);
  assert.equal(renamed.conflicts.length, 1);
  assert.match(renamed.conflicts[0].reason, /concurrent-change: displayName/);

  // An admin changed a DIFFERENT field: undo only what this restore changed, and
  // keep the admin's change.
  const otherField = planCompensation({
    restoreRef: 'r2', entries: [updated], current: new Map([['group:board', present({ ...board, displayName: 'Board (restored)', description: 'admin note' })]]),
  });
  assert.equal(otherField.operations.length, 1);
  assert.equal(otherField.operations[0].payload.displayName, 'Board');
  assert.equal(otherField.operations[0].payload.description, 'admin note');
  assert.deepEqual(otherField.operations[0].revertedFields, ['displayName']);

  // A created object that was edited afterwards is not deleted.
  const created = entry({ operation: 'create', intendedState: board, postState: { ...board, id: 'board-id' } });
  const edited = planCompensation({
    restoreRef: 'r2', entries: [created], current: new Map([['group:board', present({ ...board, displayName: 'In use now' })]]),
  });
  assert.deepEqual(edited.operations, []);
  assert.match(edited.conflicts[0].reason, /concurrent-change/);

  // The natural key now held by a different object is a conflict, not a delete.
  const replaced = planCompensation({
    restoreRef: 'r2', entries: [created], current: new Map([['group:board', present(board, 'someone-elses-id')]]),
  });
  assert.deepEqual(replaced.operations, []);
  assert.match(replaced.conflicts[0].reason, /different object/);
});

// ------------------------------------------------------------- irrecoverable

test('irrecoverable effects remain explicit: deleted objects, content consequences and edges', () => {
  const plan = planCompensation({
    restoreRef: 'r3',
    entries: [
      entry({ naturalKey: 'group:gone', operation: 'delete', targetId: 'gone-id', priorState: { ...board, mailNickname: 'gone' } }),
      entry({
        naturalKey: 'group:board', operation: 'update', priorState: { ...board, visibility: 'Private' },
        intendedState: { ...board, visibility: 'Public' }, postState: { ...board, id: 'board-id', visibility: 'Public' },
      }),
      entry({ naturalKey: 'group:board|member|user:x', operation: 'edge-add', priorState: { kind: 'relationship-edge', present: false }, outcome: 'pending' }),
    ],
    current: new Map([['group:board', present({ ...board, visibility: 'Public' })]]),
  });
  const deleted = plan.irrecoverable.find((item) => item.naturalKey === 'group:gone');
  assert.equal(deleted.effect, 'object-deleted');
  assert.match(deleted.reason, /does not recreate it/);
  assert.equal(plan.operations.some((op) => op.naturalKey === 'group:gone'), false, 'a deleted object is never recreated by compensation');

  const sharing = plan.irrecoverable.find((item) => item.naturalKey === 'group:board');
  assert.equal(sharing.effect, 'externally-sharing');
  assert.match(sharing.reason, /not recoverable by KEEL/);
  // The setting itself is still reverted.
  assert.equal(plan.operations.find((op) => op.naturalKey === 'group:board').payload.visibility, 'Private');

  assert.deepEqual(plan.manual.map((item) => item.naturalKey), ['group:board|member|user:x']);
});

// --------------------------------------------- full CLI: failed run -> compensation

const configs = new Map([
  ['/fixtures/collector.json', JSON.stringify({ tenantId: 'tenant-70', clientId: 'collector', certPath: 'c.pem', keyPath: 'c.key' })],
  ['/fixtures/restorer.json', JSON.stringify({ tenantId: 'tenant-70', clientId: 'restorer', certPath: 'r.pem', keyPath: 'r.key' })],
]);
const readFile = (path) => configs.get(path) ?? (() => { throw new Error(`unexpected config read: ${path}`); })();

function groupsOf(graph) {
  return [...graph.objects].filter(([key]) => key.startsWith('/groups/')).map(([, body]) => body);
}

function cliDependencies(graph) {
  class Reader {
    async collect(version, path) {
      if (path.startsWith('/groups')) return { items: groupsOf(graph), capped: false, error: null };
      return { items: [], capped: false, error: null };
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
      ...groupsOf(graph).map((group) => ({
        naturalKey: `group:${group.mailNickname}`, resourceType: 'group', sourceId: group.id, payload: group,
      })),
    ],
  };
}

async function seedGroups(client, groups) {
  const snapshotId = await createSnapshot(client, { tenantRef: TENANT });
  for (const payload of groups) {
    await insertResourceVersion(client, {
      snapshotId,
      resource: {
        naturalKey: `group:${payload.mailNickname}`, resourceType: 'group', payload, payloadHash: canonicalHash(payload, 'group'),
        criticality: 'tier1', blastRadius: 'access-affecting', fidelity: 'full', provenance: { adapter: 'test' },
      },
    });
  }
  await completeSnapshot(client, { id: snapshotId, status: 'complete', coverageDigest: {} });
  return snapshotId;
}

const run = (graph, options) => runRestore({
  readFile, dbUrl: database.url, dependencies: cliDependencies(graph), logger: quiet, ...options,
});
const forwardDryRun = (snapshotId, graph, artifactId, selection) => run(graph, {
  snapshotId, selection, mode: 'dry-run', persistArtifactId: artifactId, requestedBy: 'requester',
  collectorConfig: JSON.parse(configs.get('/fixtures/collector.json')), targetConfig: JSON.parse(configs.get('/fixtures/restorer.json')),
  collectorConfigPath: '/fixtures/collector.json', targetConfigPath: '/fixtures/restorer.json',
});
const promote = (artifactId, graph) => run(graph, { artifactId, mode: 'enforce' });
const compensate = (forwardId, graph, artifactId) => run(graph, {
  compensateArtifactId: forwardId, mode: 'dry-run', persistArtifactId: artifactId, requestedBy: 'requester',
});

async function failedForwardRun(client) {
  const graph = fakeGraph();
  graph.objects.set('/groups/board-id', { ...board, id: 'board-id' });
  graph.objects.set('/groups/ops-id', { ...board, mailNickname: 'ops', displayName: 'Ops', id: 'ops-id' });
  const snapshotId = await seedGroups(client, [
    { ...board, displayName: 'Board (restored)' },
    { ...board, mailNickname: 'ops', displayName: 'Ops (restored)' },
  ]);
  const forwardId = crypto.randomUUID();
  const dry = await forwardDryRun(snapshotId, graph, forwardId, ['group:board', 'group:ops']);
  assert.equal((await getDryRunArtifactById(client, { id: forwardId })).status, 'completed', JSON.stringify(dry.results));

  // Graph definitively rejects the ops update; the board update lands.
  const write = graph.write.bind(graph);
  graph.write = async (version, path, request) => (path === '/groups/ops-id' && request.method === 'PATCH'
    ? { ok: false, status: 400, body: { error: { code: 'Request_BadRequest' } } }
    : write(version, path, request));
  await assert.rejects(promote(forwardId, graph), /wave had failures/);
  graph.write = write;
  assert.equal(graph.objects.get('/groups/board-id').displayName, 'Board (restored)');
  assert.equal(graph.objects.get('/groups/ops-id').displayName, 'Ops');
  return { graph, forwardId };
}

test('a failed restore is compensated through a reviewed artifact: only the landed write is undone, and the undo is journaled', async (t) => {
  const client = await schemaClient(t);
  const { graph, forwardId } = await failedForwardRun(client);

  const journal = await listJournal(client, { restoreRef: forwardId });
  assert.deepEqual(journal.map((item) => [item.naturalKey, item.outcome]).sort(), [['group:board', 'succeeded'], ['group:ops', 'failed']]);

  const compensationId = crypto.randomUUID();
  const dry = await compensate(forwardId, graph, compensationId);
  assert.equal(dry.status, 'completed');
  assert.deepEqual(dry.compensation.operations.map((op) => [op.naturalKey, op.verb]), [['group:board', 'update']]);
  assert.deepEqual(dry.compensation.notApplied.map((item) => item.naturalKey), ['group:ops']);
  assert.equal(graph.objects.get('/groups/board-id').displayName, 'Board (restored)', 'a compensation dry run writes nothing');

  const artifact = await getDryRunArtifactById(client, { id: compensationId });
  assert.equal(artifact.compensation.compensates, forwardId);
  assert.equal(artifact.status, 'completed');

  const result = await promote(compensationId, graph);
  assert.deepEqual(result.results.failed, []);
  assert.equal(graph.objects.get('/groups/board-id').displayName, 'Board');
  assert.equal(graph.objects.get('/groups/ops-id').displayName, 'Ops');

  // The compensation is itself journaled under its own artifact, so it can be undone too.
  const undoJournal = await listJournal(client, { restoreRef: compensationId });
  assert.deepEqual(undoJournal.map((item) => [item.naturalKey, item.operation, item.outcome]), [['group:board', 'update', 'succeeded']]);
});

test('mutation check: an undo is never executed outside the normal artifact approval', async (t) => {
  const client = await schemaClient(t);
  const { graph, forwardId } = await failedForwardRun(client);
  const writesBefore = graph.writes.length;

  // No direct enforce of a compensation, from the API or the CLI.
  await assert.rejects(run(graph, { compensateArtifactId: forwardId, mode: 'enforce' }), /only ever planned as a dry run/);
  await assert.rejects(main({
    argv: ['node', 'keel-restore.mjs', '--compensate', forwardId, '--enforce'],
    readFile, dbUrl: database.url, dependencies: cliDependencies(graph), logger: quiet,
  }), /dry run only/);

  // A target changed since the compensation was reviewed refuses promotion.
  const compensationId = crypto.randomUUID();
  await compensate(forwardId, graph, compensationId);
  graph.objects.set('/groups/board-id', { ...graph.objects.get('/groups/board-id'), displayName: 'Board (admin)' });
  // (The re-derived plan changes too — the conflict — so either gate may fire first.)
  await assert.rejects(promote(compensationId, graph), /compensation promotion refused: (the target has changed|the recomputed restore plan no longer matches)/);

  // The plan is re-derived from the journal at promotion, never trusted from the
  // stored artifact: a journal altered after review changes the plan digest.
  graph.objects.set('/groups/board-id', { ...graph.objects.get('/groups/board-id'), displayName: 'Board (restored)' });
  const reviewedId = crypto.randomUUID();
  await compensate(forwardId, graph, reviewedId);
  await client.query(
    `UPDATE rollback_entry SET prior_state = jsonb_set(prior_state, '{displayName}', '"Board (forged)"') WHERE restore_ref = $1 AND natural_key = 'group:board'`,
    [forwardId],
  );
  await assert.rejects(promote(reviewedId, graph), /compensation promotion refused: the recomputed restore plan no longer matches/);

  // A refused compensation dry run can never be promoted.
  await client.query(`UPDATE restore_dry_run SET status = 'refused' WHERE id = $1`, [compensationId]);
  await assert.rejects(promote(compensationId, graph), /not complete \(status: refused\)/);

  assert.equal(graph.writes.length, writesBefore, 'nothing was written by any refused undo');
});

test('a restore with no journaled writes cannot be compensated', async (t) => {
  const client = await schemaClient(t);
  const graph = fakeGraph();
  graph.objects.set('/groups/board-id', { ...board, id: 'board-id' });
  const snapshotId = await seedGroups(client, [{ ...board, displayName: 'Board (restored)' }]);
  const forwardId = crypto.randomUUID();
  await forwardDryRun(snapshotId, graph, forwardId, ['group:board']);
  await assert.rejects(compensate(forwardId, graph, crypto.randomUUID()), /has no journaled writes/);
  await assert.rejects(compensate(crypto.randomUUID(), graph, crypto.randomUUID()), /restore artifact not found/);
});

test('the worker runs a compensation only as a dry run, from the restore id alone', () => {
  assert.deepEqual(
    JOB_HANDLERS.restore.argsFor({ compensates: 'forward-id', artifactId: 'undo-id' }, { requested_by: 'principal-1' }),
    ['--compensate', 'forward-id', '--persist-artifact', 'undo-id', '--requested-by', 'principal-1'],
  );
  assert.throws(
    () => JOB_HANDLERS.restore.argsFor({ compensates: 'forward-id', artifactId: 'undo-id', targetConfig: '/etc/x.json' }, { requested_by: 'p' }),
    /carries only params.compensates and params.artifactId/,
  );
  // Executing the undo is an ordinary promotion of the compensation artifact.
  assert.deepEqual(JOB_HANDLERS.restore.argsFor({ artifactId: 'undo-id', mode: 'enforce' }), ['--artifact', 'undo-id', '--enforce']);
});
