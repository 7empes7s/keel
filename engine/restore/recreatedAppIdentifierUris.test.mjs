// An application names its own appId in its Application ID URI (api://<appId>).
// Entra gives a recreated app a new appId, so:
//  - a create never sends the backup's api://<old appId>; it writes the URI
//    with the new appId right after the create;
//  - a soft-deleted app that an earlier restore recreated is restored with the
//    appId it has now, never the backup's.
// Fixtures only: a fake Graph reader and writer, no tenant is read or written.
import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import { fakeGraph } from '../../tools/qualification/operations.mjs';
import { buildReconciliationPlan } from '../reconcile/reconciliationPlan.mjs';
import { applyWave } from './applyEngine.mjs';
import { holdOwnAppIdUris, withAppId } from '../reconcile/liveAppId.mjs';

const OLD_APP_ID = 'aaaaaaaa-1111-4111-8111-11111111abcd';
const NEW_APP_ID = '22222222-2222-4222-8222-222222222222';
const OLD_OBJECT_ID = '33333333-3333-4333-8333-333333333333';
const NEW_OBJECT_ID = '44444444-4444-4444-8444-444444444444';
const OTHER_URI = 'https://keel-rt.example.com/api';

const governor = { async acquire() {}, observeRetryAfter() {} };
const fast = { attempts: 2, delayMs: 1 };

const appPayload = {
  id: OLD_OBJECT_ID, appId: OLD_APP_ID, displayName: 'KEEL-RT-app-uris', signInAudience: 'AzureADMyOrg', tags: [],
  identifierUris: [`api://${OLD_APP_ID.toUpperCase()}`, OTHER_URI, `api://${OLD_APP_ID}/scoped`],
};
const app = {
  naturalKey: `application:${OLD_APP_ID}`, resourceType: 'application', sourceId: OLD_OBJECT_ID,
  payload: appPayload, references: [], blastRadius: 'access-affecting',
};

function recordingGraph() {
  const graph = fakeGraph();
  const requests = [];
  const write = graph.write.bind(graph);
  graph.write = async (version, path, request) => {
    requests.push({ method: request.method, path, body: request.body });
    return write(version, path, request);
  };
  return { graph, requests };
}

test('holdOwnAppIdUris holds back only the URIs that name the backup appId, in any case', () => {
  const { body, held } = holdOwnAppIdUris({ identifierUris: appPayload.identifierUris, displayName: 'x' }, 'application', OLD_APP_ID);
  assert.deepEqual(body, { identifierUris: [OTHER_URI], displayName: 'x' });
  assert.deepEqual(held, [`api://${OLD_APP_ID.toUpperCase()}`, `api://${OLD_APP_ID}/scoped`]);
  assert.deepEqual(withAppId(held, OLD_APP_ID, NEW_APP_ID), [`api://${NEW_APP_ID}`, `api://${NEW_APP_ID}/scoped`]);
  // No appId, or no URI naming it: the body is sent as it is.
  const plain = { identifierUris: [OTHER_URI] };
  assert.equal(holdOwnAppIdUris(plain, 'application', OLD_APP_ID).body, plain);
  assert.equal(holdOwnAppIdUris(plain, 'application', null).body, plain);
  assert.equal(holdOwnAppIdUris(appPayload, 'servicePrincipal', OLD_APP_ID).body, appPayload);
});

test('a recreated app is created without the old api:// URIs, then given them with its new appId', async () => {
  const { graph, requests } = recordingGraph();
  const result = await applyWave(graph, governor, [{ ...app, verb: 'create' }], {
    targetTenant: 'fixture', mode: 'enforce', existingTargetIds: new Map(), readAfterWriteOptions: fast,
  });
  assert.deepEqual(result.failed, []);
  const post = requests.find((entry) => entry.method === 'POST' && entry.path === '/applications');
  assert.ok(post, 'the app is created');
  assert.deepEqual(post.body.identifierUris, [OTHER_URI], 'the create never names the backup appId');
  const [created] = result.applied;
  const newAppId = created.identifiers.appId;
  assert.notEqual(newAppId, OLD_APP_ID);
  const patch = requests.find((entry) => entry.method === 'PATCH' && entry.path === `/applications/${created.targetId}`);
  assert.deepEqual(patch?.body, { identifierUris: [OTHER_URI, `api://${newAppId}`, `api://${newAppId}/scoped`] });
  assert.deepEqual(graph.objects.get(`/applications/${created.targetId}`).identifierUris, patch.body.identifierUris);
});

test('an app whose URIs name no appId is created in one write', async () => {
  const { graph, requests } = recordingGraph();
  const plain = { ...app, verb: 'create', payload: { ...appPayload, identifierUris: [OTHER_URI] } };
  const result = await applyWave(graph, governor, [plain], {
    targetTenant: 'fixture', mode: 'enforce', existingTargetIds: new Map(), readAfterWriteOptions: fast,
  });
  assert.deepEqual(result.failed, []);
  assert.deepEqual(requests.map((entry) => entry.method), ['POST']);
});

test('a create whose new URIs Graph refuses fails loudly, naming the created app', async () => {
  const { graph } = recordingGraph();
  const write = graph.write.bind(graph);
  graph.write = async (version, path, request) => (request.method === 'PATCH'
    ? { ok: false, status: 400, body: { error: { code: 'Request_BadRequest', message: 'refused' } } }
    : write(version, path, request));
  const result = await applyWave(graph, governor, [{ ...app, verb: 'create' }], {
    targetTenant: 'fixture', mode: 'enforce', existingTargetIds: new Map(), readAfterWriteOptions: fast,
  });
  assert.equal(result.applied.length, 0);
  assert.equal(result.failed.length, 1);
  assert.match(result.failed[0].error, /Application ID URIs .* were not written/);
});

// The app an earlier restore recreated (new id, new appId) was deleted since.
function deletedRecreatedReader() {
  const deleted = { ...appPayload, id: NEW_OBJECT_ID, appId: NEW_APP_ID, identifierUris: [], deletedDateTime: '2026-10-29T00:00:00Z' };
  return {
    deleted,
    async collect(_version, path) {
      if (path.startsWith('/applications')) return { items: [], error: null };
      if (path.startsWith('/directory/deletedItems')) return { items: [deleted], error: null };
      throw new Error(`unexpected collection: ${path}`);
    },
  };
}

test('a deleted app an earlier restore recreated is restored with the appId it has now', async () => {
  const reader = deletedRecreatedReader();
  const createdTargetIds = new Map([[app.naturalKey, { resourceType: 'application', targetIds: [NEW_OBJECT_ID], unknownIdCreates: 0 }]]);
  const { resources } = await buildReconciliationPlan(reader, [app], { sameTenant: true, createdTargetIds });
  const [planned] = resources;
  assert.equal(planned.verb, 'restore-soft-deleted');

  const { graph, requests } = recordingGraph();
  const { deletedDateTime: _gone, ...restored } = reader.deleted;
  graph.deleted.set(NEW_OBJECT_ID, { path: `/applications/${NEW_OBJECT_ID}`, body: restored });
  const result = await applyWave(graph, governor, [planned], {
    targetTenant: 'fixture', mode: 'enforce', existingTargetIds: new Map(), readAfterWriteOptions: fast,
  });
  assert.deepEqual(result.failed, []);
  assert.deepEqual(result.notRemediable, []);
  const patch = requests.find((entry) => entry.method === 'PATCH' && entry.path === `/applications/${NEW_OBJECT_ID}`);
  assert.deepEqual(patch?.body.identifierUris, [`api://${NEW_APP_ID}`, OTHER_URI, `api://${NEW_APP_ID}/scoped`]);
  assert.equal(graph.objects.get(`/applications/${NEW_OBJECT_ID}`).appId, NEW_APP_ID);
});
