import { strict as assert } from 'node:assert';
import { refuseUnsafeDeletion } from './deletionGuard.mjs';
import { refuseIfSynced } from './syncedObjectGuard.mjs';

const breakGlassUserIds = ['aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'];
const breakGlassGroupIds = ['ffffffff-1111-2222-3333-444444444444'];
const keelAppIds = ['99999999-8888-7777-6666-555555555555'];
const options = { breakGlassUserIds, breakGlassGroupIds, keelAppIds, caPolicies: [] };

const ordinaryGroup = {
  naturalKey: 'group:ordinary',
  resourceType: 'group',
  payload: { id: breakGlassGroupIds[0], onPremisesSyncEnabled: false },
};

// The ordinary group differs from each group-based refusal only in the property
// that triggers that refusal.
assert.deepEqual(refuseUnsafeDeletion(ordinaryGroup, options), { refused: false });

const breakGlassByNaturalKey = { ...ordinaryGroup, naturalKey: breakGlassUserIds[0] };
const breakGlassNaturalKeyResult = refuseUnsafeDeletion(breakGlassByNaturalKey, options);
assert.equal(breakGlassNaturalKeyResult.refused, true);
assert.match(breakGlassNaturalKeyResult.reason, /break-glass/i);

const breakGlassByPayloadId = {
  ...ordinaryGroup,
  payload: { ...ordinaryGroup.payload, id: breakGlassUserIds[0] },
};
const breakGlassPayloadIdResult = refuseUnsafeDeletion(breakGlassByPayloadId, options);
assert.equal(breakGlassPayloadIdResult.refused, true);
assert.match(breakGlassPayloadIdResult.reason, /aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee/);

const breakGlassByUppercasePayloadId = {
  ...ordinaryGroup,
  payload: { ...ordinaryGroup.payload, id: breakGlassUserIds[0].toUpperCase() },
};
assert.equal(refuseUnsafeDeletion(breakGlassByUppercasePayloadId, options).refused, true);

const ordinaryUpnUser = {
  resourceType: 'user',
  naturalKey: 'emergency.access@contoso.example',
  targetId: 'ordinary-user-id',
  payload: { onPremisesSyncEnabled: false },
};
assert.deepEqual(refuseUnsafeDeletion(ordinaryUpnUser, options), { refused: false });

// A resolved delete carries the current object id as targetId even when its
// payload has no id. Its user natural key remains a UPN while the break-glass
// list contains the account GUID.
const breakGlassByUpnAndTargetId = {
  ...ordinaryUpnUser,
  targetId: breakGlassUserIds[0],
};
assert.equal(refuseUnsafeDeletion(breakGlassByUpnAndTargetId, options).refused, true);

const breakGlassByUpn = {
  ...ordinaryUpnUser,
};
assert.equal(refuseUnsafeDeletion(breakGlassByUpn, {
  ...options,
  breakGlassUserIds: ['EMERGENCY.ACCESS@CONTOSO.EXAMPLE'],
}).refused, true);

const safeCaPolicy = {
  naturalKey: 'conditionalAccessPolicy:ordinary',
  resourceType: 'conditionalAccessPolicy',
  payload: {
    id: 'ordinary-policy-id',
    conditions: { users: { excludeUsers: [], excludeGroups: [], excludeRoles: [] } },
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
    conditions: { users: { excludeUsers: [breakGlassUserIds[0]], excludeGroups: [], excludeRoles: [] } },
  },
};
const caResult = refuseUnsafeDeletion(caExcludingBreakGlass, {
  ...options,
  caPolicies: [caExcludingBreakGlass],
});
assert.equal(caResult.refused, true);
assert.match(caResult.reason, /aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee/);
assert.match(caResult.reason, /conditions\.users\.excludeUsers/);

const caExcludingBreakGlassGroup = {
  ...safeCaPolicy,
  payload: {
    ...safeCaPolicy.payload,
    conditions: { users: { excludeUsers: [], excludeGroups: [breakGlassGroupIds[0].toUpperCase()], excludeRoles: [] } },
  },
};
const groupExclusionResult = refuseUnsafeDeletion(caExcludingBreakGlassGroup, {
  ...options,
  caPolicies: [caExcludingBreakGlassGroup],
});
assert.equal(groupExclusionResult.refused, true);
assert.match(groupExclusionResult.reason, /ffffffff-1111-2222-3333-444444444444/i);
assert.match(groupExclusionResult.reason, /conditions\.users\.excludeGroups/);

const caExcludingBreakGlassRole = {
  ...safeCaPolicy,
  payload: {
    ...safeCaPolicy.payload,
    conditions: { users: { excludeUsers: [], excludeGroups: [], excludeRoles: ['55555555-4444-3333-2222-111111111111'] } },
  },
};
const roleExclusionResult = refuseUnsafeDeletion(caExcludingBreakGlassRole, {
  ...options,
  caPolicies: [caExcludingBreakGlassRole],
});
assert.equal(roleExclusionResult.refused, true);
assert.match(roleExclusionResult.reason, /55555555-4444-3333-2222-111111111111/);
assert.match(roleExclusionResult.reason, /conditions\.users\.excludeRoles/);

const unverifiablePolicyResult = refuseUnsafeDeletion(safeCaPolicy, options);
assert.deepEqual(unverifiablePolicyResult, {
  refused: true,
  reason: 'cannot verify break-glass exclusions for this policy',
});

const groupProtectionPolicy = {
  ...safeCaPolicy,
  payload: {
    ...safeCaPolicy.payload,
    conditions: {
      users: {
        excludeUsers: [],
        excludeGroups: [ordinaryGroup.payload.id.toUpperCase()],
        excludeRoles: [],
      },
    },
  },
};
const protectedGroupResult = refuseUnsafeDeletion(ordinaryGroup, {
  ...options,
  caPolicies: [groupProtectionPolicy],
});
assert.equal(protectedGroupResult.refused, true);
assert.match(protectedGroupResult.reason, /conditionalAccessPolicy:ordinary/);

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
  payload: { ...ordinaryApp.payload, appId: keelAppIds[0].toUpperCase() },
};
const keelAppResult = refuseUnsafeDeletion(keelApp, options);
assert.equal(keelAppResult.refused, true);
assert.match(keelAppResult.reason, /KEEL app registration/i);

assert.throws(
  () => refuseUnsafeDeletion(ordinaryGroup, { ...options, breakGlassUserIds: [] }),
  /breakGlassUserIds must contain at least one break-glass account before deletion/,
);

console.log('deletionGuard.test.mjs — all assertions passed');
