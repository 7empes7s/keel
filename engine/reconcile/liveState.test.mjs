import { strict as assert } from 'node:assert';
import { canonicalHash } from '../cir/canonicalHash.mjs';
import { buildLiveIndex } from './liveState.mjs';

const groupPath = '/groups?$select=id,displayName,mailNickname,groupTypes,securityEnabled,mailEnabled,membershipRule,membershipRuleProcessingState,onPremisesSyncEnabled,isAssignableToRole,visibility,createdDateTime';
const deletedGroupPath = '/directory/deletedItems/microsoft.graph.group';
const roleAssignmentPath = '/roleManagement/directory/roleAssignments';

function naturalKeyFor(type, object) {
  return `${type}:${object.mailNickname ?? object.displayName ?? object.id}`;
}

function fakeReader(responses, { throwOnUnsupportedDeletedType = false } = {}) {
  const calls = [];
  return {
    calls,
    async collect(version, path) {
      calls.push({ version, path });
      if (throwOnUnsupportedDeletedType && path.startsWith('/directory/deletedItems/')) {
        throw new Error(`unsupported deletedItems query: ${path}`);
      }
      return { items: responses.get(path) ?? [], error: null };
    },
  };
}

const presentGroup = {
  id: 'present-group-id',
  displayName: 'Present Group',
  mailNickname: 'present-group',
};
const deletedGroup = {
  id: 'deleted-group-id',
  displayName: 'Deleted Group',
  mailNickname: 'deleted-group',
  deletedDateTime: '2026-09-04T00:00:00Z',
};
const liveWinsGroup = {
  id: 'live-wins-id',
  displayName: 'Live Wins',
  mailNickname: 'live-wins',
};
const softDeletedDuplicate = {
  id: 'deleted-duplicate-id',
  displayName: 'Deleted Copy Must Not Win',
  mailNickname: 'live-wins',
  deletedDateTime: '2026-09-04T00:00:00Z',
};

// Present-only.
const presentReader = fakeReader(new Map([
  [groupPath, [presentGroup]],
  [deletedGroupPath, []],
]));
const presentIndex = await buildLiveIndex(presentReader, {
  resourceTypes: ['group'],
  naturalKeyFor,
});
assert.deepEqual(presentIndex.get('group:present-group'), {
  targetId: 'present-group-id',
  payloadHash: canonicalHash(presentGroup, 'group'),
  payload: presentGroup,
  state: 'present',
});

// Soft-deleted-only.
const deletedReader = fakeReader(new Map([
  [groupPath, []],
  [deletedGroupPath, [deletedGroup]],
]));
const deletedIndex = await buildLiveIndex(deletedReader, {
  resourceTypes: ['group'],
  naturalKeyFor,
});
assert.deepEqual(deletedIndex.get('group:deleted-group'), {
  targetId: 'deleted-group-id',
  payloadHash: canonicalHash(deletedGroup, 'group'),
  payload: deletedGroup,
  state: 'soft-deleted',
  deletedItemId: 'deleted-group-id',
});

// A live object wins over a soft-deleted object with the same natural key.
const liveWinsReader = fakeReader(new Map([
  [groupPath, [liveWinsGroup]],
  [deletedGroupPath, [softDeletedDuplicate]],
]));
const liveWinsIndex = await buildLiveIndex(liveWinsReader, {
  resourceTypes: ['group'],
  naturalKeyFor,
});
assert.deepEqual(liveWinsIndex.get('group:live-wins'), {
  targetId: 'live-wins-id',
  payloadHash: canonicalHash(liveWinsGroup, 'group'),
  payload: liveWinsGroup,
  state: 'present',
});

// An object listed nowhere is absent from the index.
const absentReader = fakeReader(new Map([
  [groupPath, []],
  [deletedGroupPath, []],
]));
const absentIndex = await buildLiveIndex(absentReader, {
  resourceTypes: ['group'],
  naturalKeyFor,
});
assert.equal(absentIndex.has('group:absent-group'), false);

// roleAssignment is not soft-deletable. The fake reader throws if this code
// tries the unsupported deletedItems endpoint, so the live-only call is the guard.
const unsupportedReader = fakeReader(new Map([
  [roleAssignmentPath, [{ id: 'role-assignment-id', displayName: 'Role Assignment' }]],
]), { throwOnUnsupportedDeletedType: true });
const unsupportedIndex = await buildLiveIndex(unsupportedReader, {
  resourceTypes: ['roleAssignment'],
  naturalKeyFor,
});
assert.equal(unsupportedIndex.get('roleAssignment:Role Assignment').state, 'present');
assert.equal(
  unsupportedReader.calls.some(({ path }) => path.startsWith('/directory/deletedItems/')),
  false,
);

console.log('liveState.test.mjs — all assertions passed');
