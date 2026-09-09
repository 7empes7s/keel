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

// The update verb's write itself (not just its verification read) can 404 on a freshly-created
// object per this tenant's confirmed write-path lag — it must retry a 404, not fail immediately.
{
  const desired = { displayName: 'Alpha' };
  let writeCalls = 0;
  const writer = {
    write: async () => {
      writeCalls += 1;
      if (writeCalls === 1) return { ok: false, status: 404, body: null };
      return { ok: true, status: 200, body: { id: 'g5' } };
    },
    read: async () => ({ ok: true, status: 200, body: { id: 'g5', displayName: 'Alpha' } }),
  };
  const governor = { acquire: async () => {} };
  const result = await applyWave(writer, governor, [
    { naturalKey: 'group:gamma', resourceType: 'group', verb: 'update', targetId: 'g5', payload: desired },
  ], { targetTenant: 't1', mode: 'enforce' });
  assert.equal(result.applied.length, 1, `expected the write to succeed once retried: ${JSON.stringify(result)}`);
  assert.equal(writeCalls, 2, 'expected exactly one failed write attempt before the retry succeeded');
}

// Measured live 2026-09-08: the collector's selected group projection omits these fields, while
// Graph's default verify projection returns them as null. Merge semantics treat an unset property
// as absent on both sides for comparison, so these projection artifacts must not create drift.
{
  const desired = { id: 'g9', displayName: 'Alpha', mailNickname: 'alpha' };
  const writer = {
    write: async () => ({ ok: true, status: 200, body: {} }),
    read: async () => ({
      ok: true,
      status: 200,
      body: {
        ...desired,
        preferredDataLocation: null,
        preferredLanguage: null,
        uniqueName: null,
      },
    }),
  };
  const governor = { acquire: async () => {} };
  const result = await applyWave(writer, governor, [
    { naturalKey: 'group:delta', resourceType: 'group', verb: 'update', targetId: 'g9', payload: desired },
  ], { targetTenant: 't1', mode: 'enforce' });
  assert.equal(result.failed.length, 0, `null uncaptured defaults must not be drift: ${JSON.stringify(result.failed)}`);
  assert.equal(result.applied.length, 1);
}

// Merge semantics still enforce a non-null property added by the live object. The uncaptured null
// remains absent for comparison, while a real non-null addition must remain residual drift.
{
  const desired = { id: 'g9', displayName: 'Alpha' };
  const writer = {
    write: async () => ({ ok: true, status: 200, body: {} }),
    read: async () => ({
      ok: true,
      status: 200,
      body: { ...desired, description: 'added by drift', uniqueName: null },
    }),
  };
  const governor = { acquire: async () => {} };
  const result = await applyWave(writer, governor, [
    { naturalKey: 'group:delta', resourceType: 'group', verb: 'update', targetId: 'g9', payload: desired },
  ], { targetTenant: 't1', mode: 'enforce' });
  assert.equal(result.failed.length, 1, 'a non-null added property must still fail');
  assert.ok(result.failed[0].residual.includes('description'));
  assert.ok(!result.failed[0].residual.includes('uniqueName'));
}

// A captured field being nulled live is still drift: only uncaptured projection defaults receive
// symmetric unset semantics, so captured nulling remains visible to verification.
{
  const desired = { id: 'g9', displayName: 'Alpha', membershipRule: 'user.dept -eq "x"' };
  const writer = {
    write: async () => ({ ok: true, status: 200, body: {} }),
    read: async () => ({
      ok: true,
      status: 200,
      body: { ...desired, membershipRule: null, uniqueName: null },
    }),
  };
  const governor = { acquire: async () => {} };
  const result = await applyWave(writer, governor, [
    { naturalKey: 'group:delta', resourceType: 'group', verb: 'update', targetId: 'g9', payload: desired },
  ], { targetTenant: 't1', mode: 'enforce' });
  assert.equal(result.failed.length, 1, 'a captured field nulled live must still fail');
  assert.ok(result.failed[0].residual.includes('membershipRule'));
}

// False is a captured value and must be compared as a value, not treated as absent during
// normalization; a live true therefore remains a real residual drift.
{
  const desired = { id: 'g9', displayName: 'Alpha', securityEnabled: false };
  const writer = {
    write: async () => ({ ok: true, status: 200, body: {} }),
    read: async () => ({
      ok: true,
      status: 200,
      body: { ...desired, securityEnabled: true, uniqueName: null },
    }),
  };
  const governor = { acquire: async () => {} };
  const result = await applyWave(writer, governor, [
    { naturalKey: 'group:delta', resourceType: 'group', verb: 'update', targetId: 'g9', payload: desired },
  ], { targetTenant: 't1', mode: 'enforce' });
  assert.equal(result.failed.length, 1, 'false must be compared, not treated as absent');
  assert.ok(result.failed[0].residual.includes('securityEnabled'));
}

// ---------------------------------------------------------------------------
// Cross-tenant reference rewriting at apply time (the resolver must feed the
// writer, not just the pre-flight planner). A create-verb (fallthrough)
// resource whose payload carries a GUID-valued reference field, alongside a
// `references` array (the same shape engine/graph/resolver.mjs consumes),
// must have that field rewritten to the TARGET tenant's id before the write.
// ---------------------------------------------------------------------------

// (a) A reference to a resource CREATED EARLIER IN THIS SAME RUN (runProvenance,
// threaded via the `appliedIds` option) is rewritten to that resource's target id
// — not left as the source-tenant id that appears in the payload.
{
  const sourceGroupGuid = '11111111-1111-1111-1111-111111111111';
  const targetGroupGuid = 'target-group-guid-999';
  const roleAssignmentResource = {
    naturalKey: 'roleAssignment:Owner@group:FIN-Admins',
    resourceType: 'roleAssignment',
    payload: { principalId: sourceGroupGuid, roleDefinitionId: 'role-def-guid', directoryScopeId: '/' },
    references: [{ field: 'principalId', symbol: 'group:FIN-Admins', required: true }],
    blastRadius: 'tenant-lockout',
  };
  const writer = fakeWriter();
  const result = await applyWave(writer, governor, [roleAssignmentResource], {
    targetTenant: 'target', mode: 'enforce',
    appliedIds: new Map([['group:FIN-Admins', targetGroupGuid]]),
  });
  const writeCall = writer.calls.find((c) => c.kind === 'write');
  assert.ok(writeCall, 'expected a write call');
  assert.equal(writeCall.opts.body.principalId, targetGroupGuid,
    `expected principalId rewritten to the target id, got ${JSON.stringify(writeCall.opts.body)}`);
  assert.notEqual(writeCall.opts.body.principalId, sourceGroupGuid, 'must not write the source-tenant guid');
  assert.equal(result.failed.length, 0, JSON.stringify(result.failed));
  assert.equal(result.applied.length, 1);
}

// (b) A reference that resolves to a KNOWN GLOBAL constant (the GlobalAdministrator
// role template GUID from GLOBAL_ROLE_SYMBOLS) is the same id in every tenant — the
// field must be preserved AS-IS, never overwritten with the resolver's symbolic
// placeholder ('global:GlobalAdministrator').
{
  const globalAdminTemplateGuid = '62e90394-69f5-4237-9190-012177145e10';
  const roleAssignmentResource = {
    naturalKey: 'roleAssignment:GA@user:break-glass',
    resourceType: 'roleAssignment',
    payload: { principalId: 'break-glass-principal-guid', roleDefinitionId: globalAdminTemplateGuid, directoryScopeId: '/' },
    references: [{ field: 'roleDefinitionId', symbol: 'global:GlobalAdministrator', required: true }],
    blastRadius: 'tenant-lockout',
  };
  const writer = fakeWriter();
  const result = await applyWave(writer, governor, [roleAssignmentResource], { targetTenant: 'target', mode: 'enforce' });
  const writeCall = writer.calls.find((c) => c.kind === 'write');
  assert.ok(writeCall, 'expected a write call');
  assert.equal(writeCall.opts.body.roleDefinitionId, globalAdminTemplateGuid,
    `global constant must be preserved verbatim, got ${JSON.stringify(writeCall.opts.body)}`);
  assert.equal(result.failed.length, 0, JSON.stringify(result.failed));
  assert.equal(result.applied.length, 1);
}

// (c) THE MOST IMPORTANT TEST: a reference that cannot be resolved — either because
// it points at a symbol absent from every lookup source, or because it was already
// null (unresolvable-at-collection) — must FAIL the resource. It must NEVER reach
// writer.write with a dangling source-tenant guid.
{
  const sourceGroupGuid = '22222222-2222-2222-2222-222222222222';
  const roleAssignmentResource = {
    naturalKey: 'roleAssignment:Owner@group:Ghost-Group',
    resourceType: 'roleAssignment',
    payload: { principalId: sourceGroupGuid, roleDefinitionId: 'role-def-guid', directoryScopeId: '/' },
    references: [{ field: 'principalId', symbol: 'group:Ghost-Group', required: true }],
    blastRadius: 'tenant-lockout',
  };
  const writer = fakeWriter();
  const result = await applyWave(writer, governor, [roleAssignmentResource], { targetTenant: 'target', mode: 'enforce' });
  assert.equal(writer.calls.length, 0, `must never write a dangling guid: ${JSON.stringify(writer.calls)}`);
  assert.equal(result.applied.length, 0);
  assert.equal(result.failed.length, 1, JSON.stringify(result));
  assert.match(result.failed[0].error, /group:Ghost-Group/);
}
{
  // A symbol that was already null at collection time (unresolvable-at-collection)
  // must fail exactly the same way — never silently dropped.
  const roleAssignmentResource = {
    naturalKey: 'roleAssignment:Owner@unknown',
    resourceType: 'roleAssignment',
    payload: { principalId: '33333333-3333-3333-3333-333333333333', roleDefinitionId: 'role-def-guid', directoryScopeId: '/' },
    references: [{ field: 'principalId', symbol: null, required: true }],
    blastRadius: 'tenant-lockout',
  };
  const writer = fakeWriter();
  const result = await applyWave(writer, governor, [roleAssignmentResource], { targetTenant: 'target', mode: 'enforce' });
  assert.equal(writer.calls.length, 0, `must never write a dangling guid: ${JSON.stringify(writer.calls)}`);
  assert.equal(result.failed.length, 1, JSON.stringify(result));
}

// (d) Same-tenant restore is unaffected: when the resolved target id is IDENTICAL to
// the id already in the payload (source === target), the write body must be
// byte-identical to a resource with no `references` at all — proving the rewrite is
// a true no-op, not just "close enough."
{
  const guid = '55555555-5555-5555-5555-555555555555';
  const withRefs = {
    naturalKey: 'roleAssignment:sameTenant', resourceType: 'roleAssignment',
    payload: { principalId: guid, roleDefinitionId: 'role-def-guid', directoryScopeId: '/' },
    references: [{ field: 'principalId', symbol: 'group:FIN-Admins', required: true }],
    blastRadius: 'tenant-lockout',
  };
  const withoutRefs = {
    naturalKey: 'roleAssignment:sameTenant', resourceType: 'roleAssignment',
    payload: { principalId: guid, roleDefinitionId: 'role-def-guid', directoryScopeId: '/' },
    blastRadius: 'tenant-lockout',
  };
  const writerA = fakeWriter();
  const writerB = fakeWriter();
  const resultA = await applyWave(writerA, governor, [withRefs], {
    targetTenant: 'target', mode: 'enforce', existingTargetIds: new Map([['group:FIN-Admins', guid]]),
  });
  const resultB = await applyWave(writerB, governor, [withoutRefs], { targetTenant: 'target', mode: 'enforce' });
  const bodyA = writerA.calls.find((c) => c.kind === 'write').opts.body;
  const bodyB = writerB.calls.find((c) => c.kind === 'write').opts.body;
  assert.deepEqual(bodyA, bodyB, 'same-tenant (source id === target id) must be byte-identical to no references at all');
  assert.equal(resultA.applied.length, 1, JSON.stringify(resultA));
  assert.equal(resultB.applied.length, 1, JSON.stringify(resultB));
}

// The §10.3 replacement snapshots with the supplied read-only reader around a
// wave and turns any changed protected sign-in path into a wave failure.
{
  let grantControls = ['mfa'];
  const reader = {
    collect: async (version, path) => {
      assert.equal(version, 'v1.0');
      if (path === '/identity/conditionalAccess/policies') {
        return {
          items: [{ id: 'ca-1', displayName: 'Protect admins', grantControls: { builtInControls: grantControls } }],
          capped: false,
          error: null,
        };
      }
      if (path.startsWith('/roleManagement/directory/roleAssignments?')) {
        return {
          items: [{ id: 'role-1', principalId: 'break-glass-id', roleDefinitionId: 'global-admin', directoryScopeId: '/' }],
          capped: false,
          error: null,
        };
      }
      throw new Error(`unexpected collection ${path}`);
    },
    get: async (version, path) => {
      assert.equal(version, 'v1.0');
      if (path === '/policies/authenticationMethodsPolicy') return { ok: true, status: 200, body: { id: 'authenticationMethodsPolicy' } };
      if (path === '/policies/identitySecurityDefaultsEnforcementPolicy') return { ok: true, status: 200, body: { id: 'identitySecurityDefaultsEnforcementPolicy', isEnabled: true } };
      if (path.startsWith('/users/')) return { ok: true, status: 200, body: { id: 'break-glass-id', accountEnabled: true } };
      throw new Error(`unexpected read ${path}`);
    },
  };
  const writer = {
    write: async () => {
      grantControls = ['block'];
      return { ok: true, status: 204, body: null };
    },
    read: async () => ({ ok: true, status: 200, body: { id: 'group-id', displayName: 'Gate test' } }),
  };
  const result = await applyWave(writer, { acquire: async () => {} }, [{
    naturalKey: 'group:gate-test', resourceType: 'group', targetId: 'group-id', verb: 'update', payload: { displayName: 'Gate test' },
  }], {
    targetTenant: 'target',
    mode: 'enforce',
    signInPathGate: { reader, protectedPrincipalIds: ['break-glass-id'] },
  });
  assert.equal(result.applied.length, 1, JSON.stringify(result));
  assert.deepEqual(result.failed, [{
    naturalKey: 'sign-in-path-gate',
    error: 'sign-in path changed: conditionalAccessPolicies',
    changed: ['conditionalAccessPolicies'],
  }]);
}

console.log('applyEngine.test.mjs — all assertions passed');
