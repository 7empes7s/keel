// An app registration names the API it calls by appId and each permission by the
// id that API publishes (requiredResourceAccess). Those references got index-only
// symbols no restored resource has as a key, so they never matched the target:
// every app asking for a permission failed to restore with "not-found-in-target",
// and the restore page listed each permission as missing from the backup.
import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import { canonicalizeAll } from '../cir/canonicalize.mjs';
import { withExplicitReferences } from '../coverage/qualification.mjs';
import { isVerbatimSymbol, resolveSymbol } from '../graph/resolver.mjs';
import { rewriteReferences } from './applyEngine.mjs';
import { dependencyClosure } from './selection.mjs';
import { planWaves } from './wavePlanner.mjs';

const GRAPH_APP_ID = '00000003-0000-0000-c000-000000000000';
const graph = {
  id: '11111111-1111-4111-8111-111111111111', appId: GRAPH_APP_ID, displayName: 'Microsoft Graph',
  appRoles: [{ id: 'df021288-bdef-4463-88db-98f22de89214', value: 'User.Read.All' }],
  oauth2PermissionScopes: [{ id: 'e1fe6dd8-ba31-4d61-89e7-88639da4683d', value: 'User.Read' }],
};
const payroll = {
  id: '22222222-2222-4222-8222-222222222222', appId: '33333333-3333-4333-8333-333333333333', displayName: 'Payroll',
  requiredResourceAccess: [{
    resourceAppId: GRAPH_APP_ID,
    resourceAccess: [{ id: 'df021288-bdef-4463-88db-98f22de89214', type: 'Role' }, { id: 'e1fe6dd8-ba31-4d61-89e7-88639da4683d', type: 'Scope' }],
  }],
};
const resources = canonicalizeAll([['servicePrincipal', [graph]], ['application', [payroll]]]);
const app = resources.find((resource) => resource.resourceType === 'application');
const context = (runProvenance = new Map()) => ({
  targetIndex: new Map(resources.map((resource) => [resource.naturalKey, resource.sourceId])), mappingTable: new Map(), runProvenance,
});

test('the fixture carries the index-only symbols a real backup stores', () => {
  const symbols = app.references.map((ref) => ref.symbol).sort();
  assert.deepEqual(symbols, [
    `object:${GRAPH_APP_ID}`,
    `permission:${GRAPH_APP_ID}/role:User.Read.All`,
    `permission:${GRAPH_APP_ID}/scope:User.Read`,
  ]);
});

test('an app that asks for API permissions is written with them as backed up', () => {
  const written = rewriteReferences(app.payload, withExplicitReferences(app), context(), app.naturalKey, 'application');
  assert.deepEqual(written.requiredResourceAccess, payroll.requiredResourceAccess);
});

test('an API recreated in this run is named by its new appId', () => {
  const ownApi = '44444444-4444-4444-8444-444444444444';
  const recreated = '55555555-5555-4555-8555-555555555555';
  assert.deepEqual(
    resolveSymbol(`object:${ownApi}`, context(new Map([[`application:${ownApi}#appId`, recreated]]))),
    { resolved: true, targetId: recreated, via: 'prior-restore' },
  );
});

test('an API the target has neither as an app nor as a service principal still refuses', () => {
  const empty = { targetIndex: new Map(), mappingTable: new Map(), runProvenance: new Map() };
  assert.deepEqual(resolveSymbol(`object:${GRAPH_APP_ID}`, empty), { resolved: false, reason: 'not-found-in-target' });
  assert.throws(() => rewriteReferences(app.payload, withExplicitReferences(app), empty, app.naturalKey, 'application'), /not-found-in-target/);
});

// Payroll calls the tenant's own Leave API. Restored together, the API is written
// first, so a recreated API's new appId is known before Payroll names it.
test('an app restored with the API it calls waits for that API', () => {
  const leaveApi = {
    id: '66666666-6666-4666-8666-666666666666', appId: '77777777-7777-4777-8777-777777777777', displayName: 'Leave API',
    appRoles: [{ id: '88888888-8888-4888-8888-888888888888', value: 'Leave.Read' }],
  };
  const caller = {
    ...payroll,
    requiredResourceAccess: [{ resourceAppId: leaveApi.appId, resourceAccess: [{ id: '88888888-8888-4888-8888-888888888888', type: 'Role' }] }],
  };
  const both = canonicalizeAll([['application', [leaveApi, caller]]]);
  const callerKey = `application:${caller.appId}`;
  const apiKey = `application:${leaveApi.appId}`;
  assert.ok(both.find((r) => r.naturalKey === callerKey).references.some((ref) => ref.symbol === `object:${leaveApi.appId}`));

  const { waves } = planWaves(both);
  const waveOf = (key) => waves.findIndex((wave) => wave.some((entry) => (entry.naturalKey ?? entry) === key));
  assert.ok(waveOf(apiKey) >= 0 && waveOf(apiKey) < waveOf(callerKey), 'the API is written in an earlier wave');

  const closure = dependencyClosure(both, [callerKey]);
  assert.deepEqual(closure.added.map((entry) => entry.naturalKey), [apiKey], 'choosing the caller puts its API back too');
  assert.deepEqual(closure.unresolvedReferences, []);
});

test('an object: symbol built from a name is never written into an id field', () => {
  assert.equal(resolveSymbol('object:Finance', context()).resolved, false);
  assert.equal(isVerbatimSymbol('object:Finance'), false);
});

test('the restore preview no longer lists the permissions as missing', () => {
  const closure = dependencyClosure([app], [app.naturalKey]);
  assert.deepEqual(closure.unresolvedReferences, []);
  assert.deepEqual(closure.keys, [app.naturalKey]);
});
