/**
 * The undo of a restore that created an Intune policy which is assigned now,
 * end to end through keel-restore (decided 2026-10-28): planning the undo
 * lists the policy for a choice and leaves it out of the plan; planning it
 * again with "delete" puts its assignments' removal and the delete in the
 * plan the approval binds, and promoting that plan removes them, then
 * deletes the policy; "skip" leaves it alone. Everything runs against an
 * in-memory Graph (engine/test/idoFakeGraph.mjs); nothing reads or writes a
 * tenant. Fixture names use the KEEL-RT- prefix.
 */
import { strict as assert } from 'node:assert';
import { after, test } from 'node:test';

import { getDryRunArtifactById, createDryRunArtifact } from './dryRunArtifact.mjs';
import { listJournal, recordPriorState, recordWriteOutcome } from './rollbackJournal.mjs';
import { createSnapshot, completeSnapshot } from '../store/db.mjs';
import { createIsolatedTestDatabase } from '../test/dbTestHelper.mjs';
import { idoFakeGraph } from '../test/idoFakeGraph.mjs';
import { schemaSql } from '../store/loadSchema.mjs';
import { main, runRestore } from '../../cli/keel-restore.mjs';
import { JOB_HANDLERS } from '../../cli/keel-worker.mjs';

const database = await createIsolatedTestDatabase(import.meta.url);
after(async () => { await database.cleanup(); });

const TENANT = 'sha256:undo-assigned';
const quiet = { log() {}, error() {} };
const POLICY_ID = 'policy-1';
const PATH = `/deviceManagement/deviceConfigurations/${POLICY_ID}`;
const KEY = 'deviceConfiguration:KEEL-RT-undo-assigned';
const POLICY = { '@odata.type': '#microsoft.graph.windows10GeneralConfiguration', displayName: 'KEEL-RT-undo-assigned', id: POLICY_ID };
const ALL_DEVICES = { target: { '@odata.type': '#microsoft.graph.allDevicesAssignmentTarget' } };
const GROUP = (groupId) => ({ target: { '@odata.type': '#microsoft.graph.groupAssignmentTarget', groupId } });

let schemaReady = false;
async function schemaClient(t) {
  const client = await database.connect();
  t.after(async () => { await client.end(); });
  if (!schemaReady) {
    await client.query(schemaSql());
    schemaReady = true;
  }
  return client;
}

const configs = new Map([
  ['/fixtures/collector.json', JSON.stringify({ tenantId: 'tenant-undo', clientId: 'collector', certPath: 'c.pem', keyPath: 'c.key' })],
  ['/fixtures/restorer.json', JSON.stringify({ tenantId: 'tenant-undo', clientId: 'restorer', certPath: 'r.pem', keyPath: 'r.key' })],
]);
const readFile = (path) => configs.get(path) ?? (() => { throw new Error(`unexpected config read: ${path}`); })();

function dependencies(graph) {
  class Reader {
    async collect() { return { items: [], capped: false, error: null }; }

    async get(version, path) {
      if (path.startsWith('/deviceManagement/')) return graph.read(version, path);
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
      ...(graph.objects.has(PATH) ? [{ naturalKey: KEY, resourceType: 'deviceConfiguration', sourceId: POLICY_ID, payload: graph.objects.get(PATH) }] : []),
    ],
  };
}

const run = (graph, options) => runRestore({ readFile, dbUrl: database.url, dependencies: dependencies(graph), logger: quiet, ...options });
const plan = (graph, forwardId, undoChoices) => {
  const id = crypto.randomUUID();
  return run(graph, {
    compensateArtifactId: forwardId, mode: 'dry-run', persistArtifactId: id, requestedBy: 'requester', ...(undoChoices ? { undoChoices } : {}),
  }).then((result) => ({ ...result, id }));
};
const promote = (artifactId, graph) => run(graph, { artifactId, mode: 'enforce' });
const writesOf = (graph) => graph.calls.filter((call) => call.method !== 'GET').map(({ method, path }) => `${method} ${path}`);

/** A promoted restore that created the policy, journaled as it would be; the policy is assigned since. */
async function createdThenAssigned(client, assignments) {
  const snapshotId = await createSnapshot(client, { tenantRef: TENANT });
  await completeSnapshot(client, { id: snapshotId, status: 'complete', coverageDigest: {} });
  const forwardId = crypto.randomUUID();
  await createDryRunArtifact(client, {
    id: forwardId, tenantRef: TENANT, snapshotId, selection: [KEY], closureKeys: [KEY], targetTenantId: 'tenant-undo',
    collectorConfigPath: '/fixtures/collector.json', targetConfigPath: '/fixtures/restorer.json', reconciliationResources: null,
    waves: [[KEY]], patches: [], guardRefusals: [], results: { applied: [], skipped: [], failed: [] },
    currentStateFingerprint: 'fp', digest: 'digest', status: 'completed', requestedBy: 'requester',
  });
  const entryId = await recordPriorState(client, {
    runId: `run-${forwardId}`, naturalKey: KEY, priorState: null, restoreRef: forwardId, resourceType: 'deviceConfiguration',
    operation: 'create', targetId: POLICY_ID, blastRadius: 'access-affecting', intendedState: POLICY,
  });
  await recordWriteOutcome(client, { entryId, outcome: 'succeeded', postState: POLICY, targetId: POLICY_ID });

  const graph = idoFakeGraph({ seed: { [PATH]: POLICY } });
  await graph.write('v1.0', `${PATH}/assign`, { method: 'POST', body: { assignments } });
  graph.calls.length = 0;
  return { graph, forwardId };
}

test('an undo of a created policy that is assigned now asks to delete or skip it, and deletes it with its assignments when chosen', async (t) => {
  const client = await schemaClient(t);
  const { graph, forwardId } = await createdThenAssigned(client, [ALL_DEVICES, GROUP('group-1')]);

  // First plan: the policy waits for a choice and is not in the undo.
  const waiting = await plan(graph, forwardId);
  assert.equal(waiting.status, 'completed');
  assert.deepEqual(waiting.compensation.operations, []);
  assert.deepEqual(waiting.compensation.choices.map((item) => [item.naturalKey, item.assignmentCount, item.choice]), [[KEY, 2, null]]);
  const stored = await getDryRunArtifactById(client, { id: waiting.id });
  assert.deepEqual(stored.compensation.choices[0].targets, [{ kind: 'all-devices' }, { kind: 'group', groupId: 'group-1' }]);
  assert.deepEqual(writesOf(graph), [], 'planning writes nothing');

  // The person chooses delete: the plan now removes the assignments and deletes the policy.
  const chosen = await plan(graph, forwardId, { [KEY]: 'delete' });
  assert.deepEqual(chosen.compensation.operations.map((op) => [op.naturalKey, op.verb, op.removeAssignments]), [[KEY, 'delete', { ids: ['assignment-0', 'assignment-1'] }]]);
  assert.equal(chosen.compensation.choices[0].choice, 'delete');

  const result = await promote(chosen.id, graph);
  assert.deepEqual(result.results.failed, []);
  assert.deepEqual(result.results.applied.map((entry) => [entry.naturalKey, entry.changes]), [[KEY, { assignmentsRemoved: 2 }]]);
  assert.deepEqual(writesOf(graph), [`POST ${PATH}/assign`, `DELETE ${PATH}`]);
  assert.equal(graph.objects.has(PATH), false);
  const journal = await listJournal(client, { restoreRef: chosen.id });
  assert.deepEqual(journal.map((entry) => [entry.naturalKey, entry.operation, entry.outcome]), [[KEY, 'delete', 'succeeded']]);
  assert.match(journal[0].outcomeDetail, /its 2 assignment\(s\) were removed first/);
  // The full assignments are journaled with the delete, so they can be put back by hand.
  assert.deepEqual(journal[0].priorState.assignments.map((assignment) => assignment.target['@odata.type']),
    ['#microsoft.graph.allDevicesAssignmentTarget', '#microsoft.graph.groupAssignmentTarget']);
});

test('skipping the assigned policy leaves it and its assignments as they are', async (t) => {
  const client = await schemaClient(t);
  const { graph, forwardId } = await createdThenAssigned(client, [ALL_DEVICES]);
  const skipped = await plan(graph, forwardId, { [KEY]: 'skip' });
  assert.deepEqual(skipped.compensation.operations, []);
  assert.equal(skipped.compensation.choices[0].choice, 'skip');
  const result = await promote(skipped.id, graph);
  assert.deepEqual(result.results, { applied: [], skipped: [], failed: [], notRemediable: [] });
  assert.deepEqual(writesOf(graph), []);
  assert.equal(graph.objects.has(PATH), true);
});

test('a policy assigned differently after the choice refuses the reviewed plan, and nothing is written', async (t) => {
  const client = await schemaClient(t);
  const { graph, forwardId } = await createdThenAssigned(client, [ALL_DEVICES]);
  const chosen = await plan(graph, forwardId, { [KEY]: 'delete' });
  await graph.write('v1.0', `${PATH}/assign`, { method: 'POST', body: { assignments: [ALL_DEVICES, GROUP('group-2')] } });
  graph.calls.length = 0;
  await assert.rejects(promote(chosen.id, graph), /compensation promotion refused: the recomputed restore plan no longer matches/);
  assert.deepEqual(writesOf(graph), []);
  assert.equal(graph.objects.has(PATH), true);

  // A choice is never forged into the stored plan: the digest binds it.
  const waiting = await plan(graph, forwardId);
  const forged = { ...waiting.compensation, choices: waiting.compensation.choices.map((item) => ({ ...item, choice: 'delete' })) };
  await client.query('UPDATE restore_dry_run SET compensation = $2 WHERE id = $1', [waiting.id, JSON.stringify(forged)]);
  await assert.rejects(promote(waiting.id, graph), /compensation promotion refused: the recomputed restore plan no longer matches/);
  assert.deepEqual(writesOf(graph), []);
});

test('a plan still waiting for a choice is never run', async (t) => {
  const client = await schemaClient(t);
  const { graph, forwardId } = await createdThenAssigned(client, [ALL_DEVICES]);
  const waiting = await plan(graph, forwardId);
  await assert.rejects(promote(waiting.id, graph), /compensation promotion refused: 1 assigned policy waits for a choice to delete or skip/);
  assert.deepEqual(writesOf(graph), []);
});

test('choices are made only when planning an undo, and only as delete or skip', async (t) => {
  const client = await schemaClient(t);
  const { graph, forwardId } = await createdThenAssigned(client, [ALL_DEVICES]);
  await assert.rejects(run(graph, { compensateArtifactId: forwardId, mode: 'dry-run', undoChoices: { [KEY]: 'remove' } }), /undoChoices must map natural keys to one of delete, skip/);
  await assert.rejects(run(graph, { artifactId: forwardId, mode: 'enforce', undoChoices: { [KEY]: 'delete' } }), /undoChoices are made only when planning an undo/);
  await assert.rejects(main({
    argv: ['node', 'keel-restore.mjs', '--compensate', forwardId, '--delete-assigned', KEY, '--skip-assigned', KEY],
    readFile, dbUrl: database.url, dependencies: dependencies(graph), logger: quiet,
  }), /both name/);
  await assert.rejects(main({
    argv: ['node', 'keel-restore.mjs', '--artifact', forwardId, '--enforce', '--delete-assigned', KEY],
    readFile, dbUrl: database.url, dependencies: dependencies(graph), logger: quiet,
  }), /choices for an undo plan \(--compensate\) only/);
  const viaCli = await main({
    argv: ['node', 'keel-restore.mjs', '--compensate', forwardId, '--delete-assigned', KEY],
    readFile, dbUrl: database.url, dependencies: dependencies(graph), logger: quiet,
  });
  assert.deepEqual(viaCli.compensation.choices.map((item) => item.choice), ['delete']);
});

test('the worker passes the person\'s choices to the undo plan, and nothing else', () => {
  assert.deepEqual(
    JOB_HANDLERS.restore.argsFor({ compensates: 'forward-id', artifactId: 'undo-id', undoChoices: { [KEY]: 'delete', 'configurationPolicy:KEEL-RT-b': 'skip' } }, { requested_by: 'principal-1' }),
    ['--compensate', 'forward-id', '--persist-artifact', 'undo-id', '--requested-by', 'principal-1',
      '--delete-assigned', KEY, '--skip-assigned', 'configurationPolicy:KEEL-RT-b'],
  );
  assert.throws(() => JOB_HANDLERS.restore.argsFor({ compensates: 'f', artifactId: 'u', undoChoices: { [KEY]: 'remove' } }, { requested_by: 'p' }), /must be delete or skip/);
  assert.throws(() => JOB_HANDLERS.restore.argsFor({ compensates: 'f', artifactId: 'u', undoChoices: ['x'] }, { requested_by: 'p' }), /must be an object/);
  assert.throws(() => JOB_HANDLERS.restore.argsFor({ compensates: 'f', artifactId: 'u', undoChoices: { '--enforce': 'delete' } }, { requested_by: 'p' }), /must not start with "-"/);
});
