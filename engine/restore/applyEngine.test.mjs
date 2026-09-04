import { strict as assert } from 'node:assert';
import { applyWave } from './applyEngine.mjs';
import { ThrottleGovernor } from './throttleGovernor.mjs';

function fakeWriter({ writeOk = true, readBody } = {}) {
  const calls = [];
  let lastWriteBody;
  return {
    calls,
    write: async (version, path, opts) => {
      calls.push({ kind: 'write', path, opts });
      lastWriteBody = opts.body;
      return writeOk ? { ok: true, status: 201, body: { id: 'new-id-1' } } : { ok: false, status: 400, body: { error: 'bad' } };
    },
    read: async (version, path) => {
      calls.push({ kind: 'read', version, path });
      return {
        ok: true,
        status: 200,
        body: readBody ?? lastWriteBody ?? { displayName: 'Finance Admins', mailNickname: 'FIN-Admins' },
      };
    },
  };
}

const governor = new ThrottleGovernor({ 'target/entra/write': { capacity: 100, refillPerSecond: 100 } });

const groupResource = { naturalKey: 'group:FIN-Admins', resourceType: 'group',
  payload: { displayName: 'Finance Admins', mailNickname: 'FIN-Admins' }, blastRadius: 'access-affecting' };
const syncedUser = { naturalKey: 'group:Synced-Thing', resourceType: 'group',
  payload: { onPremisesSyncEnabled: true }, blastRadius: 'access-affecting' };
const caResource = { naturalKey: 'conditionalAccessPolicy:X', resourceType: 'conditionalAccessPolicy',
  payload: { displayName: 'X', state: 'enabled' }, blastRadius: 'tenant-lockout' };

// dry-run never calls write/read at all.
const dryWriter = fakeWriter();
const dryResult = await applyWave(dryWriter, governor, [groupResource], { targetTenant: 'target', mode: 'dry-run' });
assert.equal(dryWriter.calls.length, 0);
assert.equal(dryResult.applied.length, 1); // still reported as "would apply"
assert.equal(dryResult.applied[0].targetId, null);

// enforce: writes, then reads and compares hashes, before counting as applied.
const enforceWriter = fakeWriter();
const enforceResult = await applyWave(enforceWriter, governor, [groupResource], { targetTenant: 'target', mode: 'enforce' });
assert.equal(enforceResult.applied.length, 1);
assert.equal(enforceWriter.calls.filter((c) => c.kind === 'read').length, 1);

// Synced object is skipped, not written.
const syncedResult = await applyWave(fakeWriter(), governor, [syncedUser], { targetTenant: 'target', mode: 'enforce' });
assert.equal(syncedResult.skipped.length, 1);
assert.match(syncedResult.skipped[0].reason, /on-premises/i);

// A CA policy's write payload must be report-only-forced — inspect what was
// actually sent, not just that something was sent (dangerous-direction check).
const caWriter = fakeWriter();
await applyWave(caWriter, governor, [caResource], { targetTenant: 'target', mode: 'enforce' });
const sentBody = caWriter.calls.find((c) => c.kind === 'write').opts.body;
assert.equal(sentBody.state, 'enabledForReportingButNotEnforced');

// Write succeeds but the re-read hash disagrees — must NOT count as applied
// (spec §11.5: ops/s measured only on VERIFIED writes).
const mismatchWriter = fakeWriter({ readBody: { displayName: 'Different Admins', mailNickname: 'FIN-Admins' } });
const mismatchResult = await applyWave(mismatchWriter, governor, [groupResource], { targetTenant: 'target', mode: 'enforce' });
assert.equal(mismatchResult.applied.length, 0);
assert.equal(mismatchResult.failed.length, 1);
assert.match(mismatchResult.failed[0].error, /verif/i);

// Idempotent retry (spec §9.3): the resource's OWN natural key already exists
// in the target. A correct re-run must skip the create and just re-read —
// this is the diverging case against the very first test above, which used an
// EMPTY existingTargetIds and therefore always created. Reusing that same
// empty-map path here would prove nothing.
const idempotentWriter = fakeWriter();
const idempotentResult = await applyWave(idempotentWriter, governor, [groupResource], {
  targetTenant: 'target', mode: 'enforce',
  existingTargetIds: new Map([['group:FIN-Admins', 'already-there-id']]),
});
assert.equal(idempotentWriter.calls.filter((c) => c.kind === 'write').length, 0, 'must not re-create an existing resource');
assert.equal(idempotentResult.applied[0].targetId, 'already-there-id');

// Existing target object whose hash does NOT match the plan is a conflict, not
// an auto-overwrite — spec §9.3 says "skips resources whose hash already
// matches," not "overwrites on mismatch."
const conflictResult = await applyWave(fakeWriter({ readBody: { displayName: 'Different Admins', mailNickname: 'FIN-Admins' } }), governor, [groupResource], {
  targetTenant: 'target', mode: 'enforce',
  existingTargetIds: new Map([['group:FIN-Admins', 'already-there-id']]),
});
assert.equal(conflictResult.failed.length, 1);
assert.match(conflictResult.failed[0].error, /conflict/i);
assert.match(conflictResult.failed[0].error, /actual hash [a-f0-9]{64}.*desired hash [a-f0-9]{64}/i);

console.log('applyEngine.test.mjs — all assertions passed');
