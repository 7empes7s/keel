/**
 * Undoing a restore that turned an app's sign-in on, end to end through
 * keel-restore (follow-up to PR #770): an approved undo turns it off again
 * without a manual step, and the Engage writer counts as one of KEEL's own
 * apps, so no restore or undo ever turns its sign-in off. Everything runs
 * against an in-memory Graph (engine/test/idoFakeGraph.mjs); nothing reads or
 * writes a tenant. Fixture names use the KEEL-RT- prefix.
 */
import { strict as assert } from 'node:assert';
import { after, test } from 'node:test';

import { createDryRunArtifact } from './dryRunArtifact.mjs';
import { engageWriterAppId } from './engageWriter.mjs';
import { recordPriorState, recordWriteOutcome } from './rollbackJournal.mjs';
import { createSnapshot, completeSnapshot } from '../store/db.mjs';
import { createIsolatedTestDatabase } from '../test/dbTestHelper.mjs';
import { idoFakeGraph } from '../test/idoFakeGraph.mjs';
import { schemaSql } from '../store/loadSchema.mjs';
import { runRestore } from '../../cli/keel-restore.mjs';

const database = await createIsolatedTestDatabase(import.meta.url);
after(async () => { await database.cleanup(); });

const TENANT = 'sha256:sign-in-undo';
const quiet = { log() {}, error() {} };
const SP_ID = 'sp-engage';
const SP_PATH = `/servicePrincipals/${SP_ID}`;
const KEY = 'servicePrincipal:KEEL-RT-sign-in-undo';
const ENGAGE_PATH = '/fixtures/engage-writer.json';
const SP = Object.freeze({
  id: SP_ID, appId: 'app-sign-in-undo', displayName: 'KEEL-RT-sign-in-undo', servicePrincipalType: 'Application',
  appOwnerOrganizationId: 'tenant-sign-in-undo', accountEnabled: true, appRoleAssignmentRequired: false, notes: null, tags: [],
});

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

const baseConfigs = {
  '/fixtures/collector.json': JSON.stringify({ tenantId: 'tenant-sign-in-undo', clientId: 'collector', certPath: 'c.pem', keyPath: 'c.key' }),
  '/fixtures/restorer.json': JSON.stringify({ tenantId: 'tenant-sign-in-undo', clientId: 'restorer', certPath: 'r.pem', keyPath: 'r.key' }),
};
const missing = (path) => Object.assign(new Error(`ENOENT: ${path}`), { code: 'ENOENT' });
/** readFile over the fixture configs; the Engage writer's file is absent unless given. */
const readFileWith = (engage) => (path) => {
  const files = { ...baseConfigs, ...(engage === undefined ? {} : { [ENGAGE_PATH]: engage }) };
  if (path in files) return files[path];
  throw missing(path);
};

function dependencies(graph, { approved }) {
  class Reader {
    async collect() { return { items: [], capped: false, error: null }; }

    async get(version, path) {
      if (path.startsWith('/servicePrincipals/')) return graph.read(version, path);
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
      { naturalKey: KEY, resourceType: 'servicePrincipal', sourceId: SP_ID, payload: graph.objects.get(SP_PATH) },
    ],
    engageWriterConfigPath: () => ENGAGE_PATH,
    // The second person's approval of the undo's effects (the real check is tested in content-effects.test.mjs).
    assertContentEffectApproval: async (client, { effects }) => {
      if (effects.length === 0) return null;
      if (!approved) throw new Error('blocked-content-effect: not approved');
      return { id: 'approval-sign-in-undo' };
    },
  };
}

/** A promoted restore that turned the app's sign-in on, journaled as it would be. */
async function turnedOnByRestore(client) {
  const snapshotId = await createSnapshot(client, { tenantRef: TENANT });
  await completeSnapshot(client, { id: snapshotId, status: 'complete', coverageDigest: {} });
  const forwardId = crypto.randomUUID();
  await createDryRunArtifact(client, {
    id: forwardId, tenantRef: TENANT, snapshotId, selection: [KEY], closureKeys: [KEY], targetTenantId: 'tenant-sign-in-undo',
    collectorConfigPath: '/fixtures/collector.json', targetConfigPath: '/fixtures/restorer.json', reconciliationResources: null,
    waves: [[KEY]], patches: [], guardRefusals: [], results: { applied: [], skipped: [], failed: [] },
    currentStateFingerprint: 'fp', digest: 'digest', status: 'completed', requestedBy: 'requester',
  });
  const entryId = await recordPriorState(client, {
    runId: `run-${forwardId}`, naturalKey: KEY, priorState: { ...SP, accountEnabled: false }, restoreRef: forwardId, resourceType: 'servicePrincipal',
    operation: 'update', targetId: SP_ID, blastRadius: 'access-affecting', intendedState: SP,
  });
  await recordWriteOutcome(client, { entryId, outcome: 'succeeded', postState: SP, targetId: SP_ID });
  const graph = idoFakeGraph({ seed: { [SP_PATH]: structuredClone(SP) } });
  return { graph, forwardId };
}

/** Plans the undo of the forward restore, then promotes it when the plan is complete. */
async function undo(graph, forwardId, { engage, approved = true } = {}) {
  const options = { readFile: readFileWith(engage), dbUrl: database.url, dependencies: dependencies(graph, { approved }), logger: quiet };
  const id = crypto.randomUUID();
  const planned = await runRestore({ ...options, compensateArtifactId: forwardId, mode: 'dry-run', persistArtifactId: id, requestedBy: 'requester' });
  graph.calls.length = 0;
  if (planned.status !== 'completed') return { planned, promoted: null };
  const promoted = await runRestore({ ...options, artifactId: id, mode: 'enforce' });
  return { planned, promoted };
}

const signInWrites = (graph) => graph.calls.filter((call) => call.method === 'PATCH' && 'accountEnabled' in (call.body ?? {}));

test('an approved undo of a restore that turned an app\'s sign-in on turns it off, with no manual step', async (t) => {
  const client = await schemaClient(t);
  const { graph, forwardId } = await turnedOnByRestore(client);
  const { planned, promoted } = await undo(graph, forwardId);
  assert.deepEqual(planned.contentEffects.map((effect) => [effect.naturalKey, effect.field, effect.effect]), [[KEY, 'accountEnabled', 'blocks-sign-in']]);
  assert.deepEqual(promoted.results.failed, []);
  assert.deepEqual(promoted.results.skipped, []);
  assert.deepEqual(signInWrites(graph).map((call) => call.body), [{ accountEnabled: false }]);
  assert.equal(graph.objects.get(SP_PATH).accountEnabled, false);
  const [applied] = promoted.results.applied;
  assert.equal(applied.changes.signIn, 'off');
  assert.deepEqual(applied.completion ?? [], [], 'nothing is left for a person to do');
});

test('an undo without the approval is refused before it writes anything', async (t) => {
  const client = await schemaClient(t);
  const { graph, forwardId } = await turnedOnByRestore(client);
  await assert.rejects(undo(graph, forwardId, { approved: false }), /blocked-content-effect/);
  assert.equal(signInWrites(graph).length, 0);
  assert.equal(graph.objects.get(SP_PATH).accountEnabled, true);
});

/** The undo plan is refused with the reason, so it can never be promoted, and nothing is written. */
function assertHeld({ planned, promoted }, graph, reason) {
  assert.equal(planned.status, 'refused');
  assert.equal(promoted, null);
  assert.deepEqual(planned.results.skipped.map((item) => item.naturalKey), [KEY]);
  assert.match(planned.results.skipped[0].reason, reason);
  assert.deepEqual(planned.results.skipped[0].completion.map((item) => item.requirement), ['servicePrincipalSignIn']);
  assert.equal(signInWrites(graph).length, 0);
  assert.equal(graph.objects.get(SP_PATH).accountEnabled, true);
}

test('the Engage writer is one of KEEL\'s own apps: an approved undo never turns its sign-in off', async (t) => {
  const client = await schemaClient(t);
  const { graph, forwardId } = await turnedOnByRestore(client);
  const engage = JSON.stringify({ tenantId: 'tenant-sign-in-undo', clientId: SP.appId.toUpperCase(), certPath: 'e.pem', keyPath: 'e.key' });
  assertHeld(await undo(graph, forwardId, { engage }), graph, /one of KEEL's own apps/);
});

test('an Engage writer settings file that cannot be read holds every sign-in turn-off', async (t) => {
  for (const engage of ['{ not json', JSON.stringify({ tenantId: 'tenant-sign-in-undo' })]) {
    const client = await schemaClient(t);
    const { graph, forwardId } = await turnedOnByRestore(client);
    assertHeld(await undo(graph, forwardId, { engage }), graph, /cannot tell here which apps are its own \(the Engage writer settings file/);
  }
});

test('the Engage writer\'s app id is read from its settings file, and only a missing file means none', () => {
  assert.deepEqual(engageWriterAppId({ path: ENGAGE_PATH, readFile: readFileWith(undefined) }), { appId: null });
  assert.deepEqual(engageWriterAppId({ path: ENGAGE_PATH, readFile: readFileWith(JSON.stringify({ clientId: 'engage-app' })) }), { appId: 'engage-app' });
  assert.match(engageWriterAppId({ path: ENGAGE_PATH, readFile: readFileWith('{') }).unreadable, /could not be read/);
  assert.match(engageWriterAppId({ path: ENGAGE_PATH, readFile: readFileWith('{}') }).unreadable, /names no clientId/);
  const denied = () => { throw Object.assign(new Error('EACCES'), { code: 'EACCES' }); };
  assert.match(engageWriterAppId({ path: ENGAGE_PATH, readFile: denied }).unreadable, /could not be read/);
});
