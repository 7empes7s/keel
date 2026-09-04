import { strict as assert } from 'node:assert';
import { SERVER_OWNED, SERVER_OWNED_ALWAYS } from '../../engine/cir/serverOwned.mjs';
import { sideEffectPaths } from './writeSideEffects.mjs';

const before = {
  id: 'group-before',
  displayName: 'KEEL rehearsal group',
  modifiedDateTime: '2026-09-04T00:00:00Z',
};
const after = {
  id: 'group-before',
  displayName: 'KEEL rehearsal group renamed',
  modifiedDateTime: '2026-09-04T00:01:00Z',
};

const measured = sideEffectPaths(before, after, { patchedField: 'displayName' });
assert.deepEqual(measured, new Set(['modifiedDateTime']));

assert.deepEqual(
  sideEffectPaths(
    before,
    { ...before, displayName: 'KEEL rehearsal group renamed' },
    { patchedField: 'displayName' },
  ),
  new Set(),
);

const groupServerOwned = new Set([
  ...SERVER_OWNED_ALWAYS,
  ...SERVER_OWNED.get('group'),
]);
for (const path of measured) {
  assert.ok(groupServerOwned.has(path), `serverOwned.mjs is missing measured group path: ${path}`);
}

console.log('writeSideEffects.test.mjs — all assertions passed');
