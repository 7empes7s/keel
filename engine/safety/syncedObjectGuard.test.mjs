import { strict as assert } from 'node:assert';
import { refuseIfSynced, sourceAuthorityOf } from './syncedObjectGuard.mjs';

const synced = { payload: { onPremisesSyncEnabled: true } };
const cloudOnly = { payload: { onPremisesSyncEnabled: false } };
const noField = { payload: {} }; // most M1 types (namedLocation, CA policy) never carry this field

assert.equal(synced.payload.onPremisesSyncEnabled, true);
assert.equal(refuseIfSynced(synced).refused, true);
assert.equal(refuseIfSynced(cloudOnly).refused, false);
assert.equal(refuseIfSynced(noField).refused, false);
assert.match(refuseIfSynced(synced).reason, /on-premises/i);

// Task-111: an explicit authority hint refuses hybrid/on-premises/unknown, and never downgrades a synced object.
assert.equal(refuseIfSynced({ sourceAuthority: 'hybrid', payload: {} }).refused, true);
assert.equal(refuseIfSynced({ sourceAuthority: 'on-premises', payload: {} }).refused, true);
assert.equal(refuseIfSynced({ sourceAuthority: 'bogus', payload: {} }).refused, true);
assert.equal(refuseIfSynced({ sourceAuthority: 'cloud', payload: {} }).refused, false);
assert.equal(sourceAuthorityOf({ sourceAuthority: 'cloud', payload: { onPremisesSyncEnabled: true } }), 'on-premises');

console.log('syncedObjectGuard.test.mjs — all assertions passed');
