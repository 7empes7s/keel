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

// A fake writer whose read() returns 404 for the first two calls on a given path, then
// succeeds — simulating the observed read-after-write lag.
function flakyThenOkReader(okBody) {
  const callsPerPath = new Map();
  return {
    read: async (version, path) => {
      const n = (callsPerPath.get(path) ?? 0) + 1;
      callsPerPath.set(path, n);
      if (n <= 2) return { ok: false, status: 404, body: null };
      return { ok: true, status: 200, body: okBody };
    },
  };
}

{
  const desired = { displayName: 'Alpha' };
  const writer = {
    write: async () => ({ ok: true, status: 200, body: { id: 'g1' } }),
    ...flakyThenOkReader({ id: 'g1', displayName: 'Alpha' }),
  };
  const governor = { acquire: async () => {} };
  const result = await applyWave(writer, governor, [
    { naturalKey: 'group:alpha', resourceType: 'group', verb: 'update', targetId: 'g1', payload: desired },
  ], { targetTenant: 't1', mode: 'enforce' });
  assert.equal(result.applied.length, 1, `expected the update to succeed once the flaky read recovers: ${JSON.stringify(result)}`);
  assert.equal(result.failed.length, 0);
}

// A writer whose read() returns 404 forever — retries must exhaust and still report failure,
// not hang or silently swallow a genuine problem.
{
  const writer = {
    write: async () => ({ ok: true, status: 200, body: { id: 'g2' } }),
    read: async () => ({ ok: false, status: 404, body: null }),
  };
  const governor = { acquire: async () => {} };
  const result = await applyWave(writer, governor, [
    { naturalKey: 'group:beta', resourceType: 'group', verb: 'update', targetId: 'g2', payload: { displayName: 'Beta' } },
  ], { targetTenant: 't1', mode: 'enforce' });
  assert.equal(result.applied.length, 0);
  assert.equal(result.failed.length, 1, `expected exhausted retries to still report failure: ${JSON.stringify(result)}`);
}

// A read that succeeds immediately but returns STALE content (pre-write values) for the first
// two calls, then reflects the write on the third — the failure mode confirmed live on
// 2026-09-07, distinct from a 404: nothing about a stale-but-200 read looks like a failure to a
// presence-only retry, so it must be retried based on content, not just on `.ok`.
{
  const desired = { displayName: 'Alpha' };
  let calls = 0;
  const writer = {
    write: async () => ({ ok: true, status: 200, body: { id: 'g3' } }),
    read: async () => {
      calls += 1;
      const displayName = calls <= 2 ? 'Beta' : 'Alpha'; // stale twice, then caught up
      return { ok: true, status: 200, body: { id: 'g3', displayName } };
    },
  };
  const governor = { acquire: async () => {} };
  const result = await applyWave(writer, governor, [
    { naturalKey: 'group:alpha', resourceType: 'group', verb: 'update', targetId: 'g3', payload: desired },
  ], { targetTenant: 't1', mode: 'enforce' });
  assert.equal(result.applied.length, 1, `expected the update to converge once the stale read catches up: ${JSON.stringify(result)}`);
  assert.equal(result.failed.length, 0);
  assert.equal(calls, 3, 'expected exactly two stale reads before the third succeeded');
}

// A genuinely-mismatched final state (not staleness — a real, permanent residual) must still be
// reported as a failure once retries are exhausted, not retried forever or silently accepted.
{
  const desired = { displayName: 'Alpha' };
  const writer = {
    write: async () => ({ ok: true, status: 200, body: { id: 'g4' } }),
    read: async () => ({ ok: true, status: 200, body: { id: 'g4', displayName: 'SomethingElseEntirely' } }),
  };
  const governor = { acquire: async () => {} };
  const result = await applyWave(writer, governor, [
    { naturalKey: 'group:beta', resourceType: 'group', verb: 'update', targetId: 'g4', payload: desired },
  ], { targetTenant: 't1', mode: 'enforce' });
  assert.equal(result.applied.length, 0);
  assert.equal(result.failed.length, 1, `expected a real, persistent mismatch to still fail after retries exhaust: ${JSON.stringify(result)}`);
}

console.log('applyEngine.test.mjs — all assertions passed');
