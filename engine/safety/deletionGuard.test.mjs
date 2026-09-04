import { strict as assert } from 'node:assert';
import { refuseUnsafeDeletion } from './deletionGuard.mjs';
import { refuseIfSynced } from './syncedObjectGuard.mjs';

const breakGlassUserIds = ['bg-user-id'];
const keelAppIds = ['keel-restorer-app-id'];
const options = { breakGlassUserIds, keelAppIds, caPolicies: [] };

const ordinaryGroup = {
  naturalKey: 'group:ordinary',
  resourceType: 'group',
  payload: { id: 'ordinary-group-id', onPremisesSyncEnabled: false },
};

// The ordinary group differs from each group-based refusal only in the property
// that triggers that refusal.
assert.deepEqual(refuseUnsafeDeletion(ordinaryGroup, options), { refused: false });

const breakGlassByNaturalKey = { ...ordinaryGroup, naturalKey: 'bg-user-id' };
const breakGlassNaturalKeyResult = refuseUnsafeDeletion(breakGlassByNaturalKey, options);
assert.equal(breakGlassNaturalKeyResult.refused, true);
assert.match(breakGlassNaturalKeyResult.reason, /break-glass/i);

const breakGlassByPayloadId = {
  ...ordinaryGroup,
  payload: { ...ordinaryGroup.payload, id: 'bg-user-id' },
};
const breakGlassPayloadIdResult = refuseUnsafeDeletion(breakGlassByPayloadId, options);
assert.equal(breakGlassPayloadIdResult.refused, true);
assert.match(breakGlassPayloadIdResult.reason, /bg-user-id/);

const safeCaPolicy = {
  naturalKey: 'conditionalAccessPolicy:ordinary',
  resourceType: 'conditionalAccessPolicy',
  payload: {
    id: 'ordinary-policy-id',
    conditions: { users: { excludeUsers: [] } },
  },
};
assert.deepEqual(refuseUnsafeDeletion(safeCaPolicy, {
  ...options,
  caPolicies: [safeCaPolicy],
}), { refused: false });
const caExcludingBreakGlass = {
  ...safeCaPolicy,
  payload: {
    ...safeCaPolicy.payload,
    conditions: { users: { excludeUsers: ['bg-user-id'] } },
  },
};
const caResult = refuseUnsafeDeletion(caExcludingBreakGlass, {
  ...options,
  caPolicies: [caExcludingBreakGlass],
});
assert.equal(caResult.refused, true);
assert.match(caResult.reason, /bg-user-id/);

const syncedGroup = {
  ...ordinaryGroup,
  payload: { ...ordinaryGroup.payload, onPremisesSyncEnabled: true },
};
const syncedResult = refuseUnsafeDeletion(syncedGroup, options);
assert.deepEqual(syncedResult, refuseIfSynced(syncedGroup));
assert.equal(syncedResult.refused, true);

const ordinaryApp = {
  naturalKey: 'application:ordinary',
  resourceType: 'application',
  payload: { id: 'ordinary-app-object-id', appId: 'ordinary-app-id' },
};
assert.deepEqual(refuseUnsafeDeletion(ordinaryApp, options), { refused: false });
const keelApp = {
  ...ordinaryApp,
  payload: { ...ordinaryApp.payload, appId: 'keel-restorer-app-id' },
};
const keelAppResult = refuseUnsafeDeletion(keelApp, options);
assert.equal(keelAppResult.refused, true);
assert.match(keelAppResult.reason, /KEEL app registration/i);

console.log('deletionGuard.test.mjs — all assertions passed');
