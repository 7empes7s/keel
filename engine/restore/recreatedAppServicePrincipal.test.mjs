// Issue #726: an app deleted together with its service principal is restored in
// two runs. The first recreates the app, and Entra gives it a new appId. The
// second run finds that app again under the backup's key (the journal's create,
// issue #485) and must create the service principal with the NEW appId. Sending
// the backup's appId fails with NoBackingApplicationObject.
// Fixtures only: a fake Graph reader and writer, no tenant is read or written.
import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import { fakeGraph } from '../../tools/qualification/operations.mjs';
import { buildReconciliationPlan } from '../reconcile/reconciliationPlan.mjs';
import { resolveSymbol } from '../graph/resolver.mjs';
import { applyWave, recordLiveIdentifiers } from './applyEngine.mjs';

const OLD_APP_ID = 'aaaaaaaa-1111-4111-8111-11111111abcd';
const NEW_APP_ID = '22222222-2222-4222-8222-222222222222';
const OLD_OBJECT_ID = '33333333-3333-4333-8333-333333333333';
const NEW_OBJECT_ID = '44444444-4444-4444-8444-444444444444';

const governor = { async acquire() {}, observeRetryAfter() {} };

const appPayload = { id: OLD_OBJECT_ID, appId: OLD_APP_ID, displayName: 'KEEL-RT-recreated-app', signInAudience: 'AzureADMyOrg', tags: [] };
const app = {
  naturalKey: `application:${OLD_APP_ID}`, resourceType: 'application', sourceId: OLD_OBJECT_ID,
  payload: appPayload, references: [], blastRadius: 'access-affecting',
};
const servicePrincipal = {
  naturalKey: `servicePrincipal:${OLD_APP_ID}`, resourceType: 'servicePrincipal', sourceId: '55555555-5555-4555-8555-555555555555',
  payload: { appId: OLD_APP_ID, accountEnabled: true, appRoleAssignmentRequired: false, tags: [], servicePrincipalType: 'Application' },
  references: [], blastRadius: 'access-affecting',
};

/** The tenant after the first run: the app is back under a new id and appId,
 * and its service principal is still gone. Deleted-items lists are empty. */
function liveReader() {
  const recreated = { ...appPayload, id: NEW_OBJECT_ID, appId: NEW_APP_ID };
  return {
    async collect(_version, path) {
      if (path.startsWith('/applications')) return { items: [recreated], error: null };
      if (path.startsWith('/servicePrincipals')) return { items: [], error: null };
      if (path.startsWith('/directory/deletedItems')) return { items: [], error: null };
      throw new Error(`unexpected collection: ${path}`);
    },
  };
}

/** The second run's plan, as cli/keel-restore.mjs builds it. */
async function secondRunPlan() {
  const createdTargetIds = new Map([[app.naturalKey, { resourceType: 'application', targetIds: [NEW_OBJECT_ID], unknownIdCreates: 0 }]]);
  const { resources } = await buildReconciliationPlan(liveReader(), [app, servicePrincipal], { sameTenant: true, createdTargetIds });
  const existingTargetIds = new Map();
  for (const resource of resources) {
    if (resource.live?.state === 'present') existingTargetIds.set(resource.naturalKey, resource.live.targetId);
  }
  return { resources, existingTargetIds };
}

test('the second run finds the recreated app under the backup key and plans its service principal as a create', async () => {
  const { resources, existingTargetIds } = await secondRunPlan();
  const byKey = new Map(resources.map((resource) => [resource.naturalKey, resource]));
  assert.equal(byKey.get(app.naturalKey).targetId, NEW_OBJECT_ID);
  assert.equal(byKey.get(app.naturalKey).live.payload.appId, NEW_APP_ID);
  assert.equal(byKey.get(servicePrincipal.naturalKey).verb, 'create');
  assert.equal(existingTargetIds.get(app.naturalKey), NEW_OBJECT_ID);
});

test('recordLiveIdentifiers records the live appId under the backup key', async () => {
  const { resources } = await secondRunPlan();
  const ids = recordLiveIdentifiers(new Map(), resources);
  assert.equal(ids.get(`${app.naturalKey}#appId`), NEW_APP_ID);
  // A value this run already holds (a create in this run) is never replaced.
  const held = recordLiveIdentifiers(new Map([[`${app.naturalKey}#appId`, 'from-this-run']]), resources);
  assert.equal(held.get(`${app.naturalKey}#appId`), 'from-this-run');
  // Only alternate identifiers of present objects: nothing for the absent principal.
  assert.deepEqual([...ids.keys()], [`${app.naturalKey}#appId`]);
  // An app that was never recreated records nothing: its appId is written as stored.
  const unchanged = { ...app, live: { state: 'present', targetId: OLD_OBJECT_ID, payload: { ...appPayload, appId: OLD_APP_ID.toUpperCase() } } };
  assert.equal(recordLiveIdentifiers(new Map(), [unchanged]).size, 0);
});

test('the service principal is created with the recreated app\'s new appId, never the backup\'s', async () => {
  const { resources, existingTargetIds } = await secondRunPlan();
  const graph = fakeGraph();
  const bodies = [];
  const write = graph.write.bind(graph);
  graph.write = async (version, path, request) => {
    bodies.push({ method: request.method, path, body: request.body });
    return write(version, path, request);
  };
  const sp = resources.find((resource) => resource.naturalKey === servicePrincipal.naturalKey);
  const result = await applyWave(graph, governor, [sp], {
    targetTenant: 'fixture', mode: 'enforce', existingTargetIds,
    appliedIds: recordLiveIdentifiers(new Map(), resources),
  });
  assert.deepEqual(result.failed, []);
  const post = bodies.find((entry) => entry.method === 'POST' && entry.path === '/servicePrincipals');
  assert.ok(post, 'the service principal is created');
  assert.equal(post.body.appId, NEW_APP_ID);
});

test('an app that names the recreated app as its API resolves to the new appId too', async () => {
  const { resources, existingTargetIds } = await secondRunPlan();
  const result = resolveSymbol(`object:${OLD_APP_ID}`, {
    targetIndex: existingTargetIds, mappingTable: new Map(), runProvenance: recordLiveIdentifiers(new Map(), resources),
  });
  assert.equal(result.resolved, true);
  assert.equal(result.targetId, NEW_APP_ID);
});

// A later dry run from the same backup, after both objects were recreated: the
// new appId Entra assigned is not a change to restore, so nothing is planned.
const NEW_SP_ID = '66666666-6666-4666-8666-666666666666';

function bothRecreatedReader(appChanges = {}) {
  const recreatedApp = { ...appPayload, id: NEW_OBJECT_ID, appId: NEW_APP_ID, identifierUris: [`api://${NEW_APP_ID}`], ...appChanges };
  const recreatedSp = { ...servicePrincipal.payload, id: NEW_SP_ID, appId: NEW_APP_ID, servicePrincipalNames: [NEW_APP_ID, `api://${NEW_APP_ID}`] };
  return {
    async collect(_version, path) {
      if (path.startsWith('/applications')) return { items: [recreatedApp], error: null };
      if (path.startsWith('/servicePrincipals')) return { items: [recreatedSp], error: null };
      if (path.startsWith('/directory/deletedItems')) return { items: [], error: null };
      throw new Error(`unexpected collection: ${path}`);
    },
  };
}

const backupApp = { ...app, payload: { ...appPayload, identifierUris: [`api://${OLD_APP_ID}`] } };
const backupSp = { ...servicePrincipal, payload: { ...servicePrincipal.payload, servicePrincipalNames: [OLD_APP_ID.toUpperCase(), `api://${OLD_APP_ID.slice(0, 9).toUpperCase()}${OLD_APP_ID.slice(9)}`] } };
const bothCreated = new Map([
  [app.naturalKey, { resourceType: 'application', targetIds: [NEW_OBJECT_ID], unknownIdCreates: 0 }],
  [servicePrincipal.naturalKey, { resourceType: 'servicePrincipal', targetIds: [NEW_SP_ID], unknownIdCreates: 0 }],
]);

test('after both were recreated, the new appId alone plans no update of the app or its principal', async () => {
  const { resources } = await buildReconciliationPlan(bothRecreatedReader(), [backupApp, backupSp], { sameTenant: true, createdTargetIds: bothCreated });
  const byKey = new Map(resources.map((resource) => [resource.naturalKey, resource]));
  assert.equal(byKey.get(app.naturalKey).verb, 'noop');
  assert.equal(byKey.get(app.naturalKey).targetId, NEW_OBJECT_ID);
  assert.equal(byKey.get(servicePrincipal.naturalKey).verb, 'noop');
  assert.equal(byKey.get(servicePrincipal.naturalKey).targetId, NEW_SP_ID);
});

test('a recreated app that changed since is still planned as an update', async () => {
  const { resources } = await buildReconciliationPlan(bothRecreatedReader({ displayName: 'Renamed' }), [backupApp, backupSp], { sameTenant: true, createdTargetIds: bothCreated });
  const byKey = new Map(resources.map((resource) => [resource.naturalKey, resource]));
  assert.equal(byKey.get(app.naturalKey).verb, 'update');
  assert.equal(byKey.get(servicePrincipal.naturalKey).verb, 'noop');
});
