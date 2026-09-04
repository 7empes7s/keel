import { strict as assert } from 'node:assert';
import { refuseIfSynced } from './syncedObjectGuard.mjs';

const synced = { payload: { onPremisesSyncEnabled: true } };
const cloudOnly = { payload: { onPremisesSyncEnabled: false } };
const noField = { payload: {} }; // most M1 types (namedLocation, CA policy) never carry this field

assert.equal(refuseIfSynced(synced).refused, true);
assert.equal(refuseIfSynced(cloudOnly).refused, false);
assert.equal(refuseIfSynced(noField).refused, false);
assert.match(refuseIfSynced(synced).reason, /on-premises/i);

console.log('syncedObjectGuard.test.mjs — all assertions passed');
