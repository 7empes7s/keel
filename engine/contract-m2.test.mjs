import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { canonicalHash } from './cir/canonicalHash.mjs';
import { diffSnapshots } from './govern/diffSnapshots.mjs';
import { isSuppressed } from './govern/disposition.mjs';
import { appendEvidence, verifyChain } from './govern/evidence.mjs';
import { applyWave } from './restore/applyEngine.mjs';
import { ThrottleGovernor } from './restore/throttleGovernor.mjs';
import { planDeletionWaves } from './restore/wavePlanner.mjs';
import { refuseUnsafeDeletion } from './safety/deletionGuard.mjs';
import { createIsolatedTestDatabase } from './test/dbTestHelper.mjs';

function governor() {
  return new ThrottleGovernor({
    'target/entra/write': { capacity: 100, refillPerSecond: 100 },
  });
}

function updateResource(payload, overrides = {}) {
  return {
    naturalKey: 'group:finance-admins',
    resourceType: 'group',
    payload,
    targetId: 'target-group-id',
    verb: 'update',
    ...overrides,
  };
}

function updateWriter(reRead) {
  const calls = [];
  return {
    calls,
    write: async (version, path, opts) => {
      calls.push({ kind: 'write', version, path, opts });
      return { ok: true, status: 204, body: null };
    },
    read: async (version, path) => {
      calls.push({ kind: 'read', version, path });
      return { ok: true, status: 200, body: reRead };
    },
  };
}

function deletionResource(overrides = {}) {
  return {
    naturalKey: 'group:finance-admins',
    resourceType: 'group',
    targetId: 'target-group-id',
    verb: 'delete',
    blastRadius: 'access-affecting',
    payload: {
      id: 'target-group-id',
      displayName: 'Finance Admins',
      mailNickname: 'finance-admins',
    },
    references: [],
    ...overrides,
  };
}

const deletionGuardOptions = {
  breakGlassUserIds: ['break-glass-user-id'],
  breakGlassGroupIds: [],
  keelAppIds: [],
  caPolicies: [],
};

function rollbackClient() {
  return { query: async () => ({ rows: [] }) };
}

// Step 1: PATCH is a merge, so an added property must remain residual drift
// rather than being counted as a successful apply.
const desiredPatch = {
  displayName: 'Finance Admins',
  mailNickname: 'finance-admins',
};
const mergeWriter = updateWriter({
  ...desiredPatch,
  id: 'target-group-id',
  description: 'added property survives PATCH merge',
});
const mergeResult = await applyWave(mergeWriter, governor(), [updateResource(desiredPatch)], {
  targetTenant: 'target',
  mode: 'enforce',
});
assert.equal(mergeResult.applied.length, 0);
assert.equal(mergeResult.failed.length, 1);
assert.equal(mergeResult.failed[0].error, 'residual drift after update');
assert.ok(mergeResult.failed[0].residual.length > 0);
assert.ok(mergeResult.failed[0].residual.includes('description'));

// Step 2: reverse dependency order deletes the role assignment before the
// group it still references, including in the emitted writer order.
const referencedGroup = deletionResource();
const referencingRoleAssignment = deletionResource({
  naturalKey: 'roleAssignment:finance-admins',
  resourceType: 'roleAssignment',
  targetId: 'target-role-assignment-id',
  payload: { id: 'target-role-assignment-id', principalId: 'target-group-id' },
  references: [{ field: 'principalId', symbol: referencedGroup.naturalKey, required: true }],
});
const deletionPlan = planDeletionWaves([referencedGroup, referencingRoleAssignment]);
assert.deepEqual(deletionPlan.waves, [
  [referencingRoleAssignment.naturalKey],
  [referencedGroup.naturalKey],
]);
const resourcesByNaturalKey = new Map([
  [referencedGroup.naturalKey, referencedGroup],
  [referencingRoleAssignment.naturalKey, referencingRoleAssignment],
]);
const deletedNaturalKeys = [];
const deletionWriter = {
  write: async (version, path, opts) => {
    if (opts.method === 'DELETE') deletedNaturalKeys.push(
      path === '/roleManagement/directory/roleAssignments/target-role-assignment-id'
        ? referencingRoleAssignment.naturalKey
        : referencedGroup.naturalKey,
    );
    return { ok: true, status: 204, body: null };
  },
  read: async () => ({ ok: false, status: 404, body: null }),
};
for (const wave of deletionPlan.waves) {
  const result = await applyWave(
    deletionWriter,
    governor(),
    wave.map((naturalKey) => resourcesByNaturalKey.get(naturalKey)),
    {
      targetTenant: 'target',
      mode: 'enforce',
      deletionGuardOptions,
      rollbackClient: rollbackClient(),
      runId: 'contract-m2-deletion-order',
    },
  );
  assert.equal(result.failed.length, 0);
  assert.equal(result.applied.length, 1);
}
assert.deepEqual(deletedNaturalKeys, [
  referencingRoleAssignment.naturalKey,
  referencedGroup.naturalKey,
]);

// Step 3: break-glass deletion is non-overridable both at the guard and the
// execution path, regardless of arguments accepted by those functions.
const breakGlassResource = {
  naturalKey: 'user:emergency.access@example.test',
  resourceType: 'user',
  targetId: 'break-glass-user-id',
  verb: 'delete',
  payload: { id: 'break-glass-user-id', userPrincipalName: 'emergency.access@example.test' },
};
const breakGlassRefusal = refuseUnsafeDeletion(breakGlassResource, deletionGuardOptions);
assert.equal(breakGlassRefusal.refused, true);
assert.match(breakGlassRefusal.reason, /break-glass/i);
assert.deepEqual(
  refuseUnsafeDeletion(breakGlassResource, {
    ...deletionGuardOptions,
    override: true,
    force: true,
    bypassBreakGlass: true,
  }),
  breakGlassRefusal,
);
const breakGlassWriter = updateWriter({});
const breakGlassResult = await applyWave(breakGlassWriter, governor(), [breakGlassResource], {
  targetTenant: 'target',
  mode: 'enforce',
  existingTargetIds: new Map([[breakGlassResource.naturalKey, 'break-glass-user-id']]),
  deletionGuardOptions: {
    ...deletionGuardOptions,
    override: true,
    force: true,
    bypassBreakGlass: true,
  },
  rollbackClient: rollbackClient(),
  runId: 'contract-m2-break-glass',
  simulationPassed: true,
});
assert.equal(breakGlassResult.applied.length, 0);
assert.equal(breakGlassResult.skipped.length, 1);
assert.match(breakGlassResult.skipped[0].reason, /break-glass/i);
assert.equal(breakGlassWriter.calls.length, 0);

// Step 4: equal materialized snapshots create no drift rows.
const baselineSnapshot = [{
  natural_key: 'group:finance-admins',
  resource_type: 'group',
  payload_hash: 'identical-hash',
  hash_version: 2,
  blast_radius: 'access-affecting',
}];
const observedSnapshot = baselineSnapshot.map((row) => ({ ...row }));
assert.deepEqual(diffSnapshots(baselineSnapshot, observedSnapshot), []);

// Step 5: tampering an evidence record makes verification fail at that exact
// sequence number.
const database = await createIsolatedTestDatabase(import.meta.url);
let evidenceClient;
try {
  evidenceClient = await database.connect();
  await evidenceClient.query(readFileSync(new URL('./store/schema.sql', import.meta.url), 'utf8'));
const evidenceTenantRef = 'sha256:contract-m2-evidence';
await appendEvidence(evidenceClient, {
  tenantRef: evidenceTenantRef,
  kind: 'baseline',
  subject: { naturalKey: 'group:finance-admins', changeType: 'added' },
  actor: 'contract-test',
});
await appendEvidence(evidenceClient, {
  tenantRef: evidenceTenantRef,
  kind: 'rollback',
  subject: { naturalKey: 'group:finance-admins', changeType: 'modified' },
  actor: 'contract-test',
});
assert.deepEqual(await verifyChain(evidenceClient, { tenantRef: evidenceTenantRef }), { ok: true });
const { rows: evidenceRows } = await evidenceClient.query(
  'SELECT seq, subject FROM evidence WHERE tenant_ref = $1 ORDER BY seq',
  [evidenceTenantRef],
);
const tampered = evidenceRows.at(-1);
await evidenceClient.query(
  'UPDATE evidence SET subject = $1 WHERE seq = $2',
  [{ ...tampered.subject, changeType: 'tampered' }, tampered.seq],
);
assert.deepEqual(
  await verifyChain(evidenceClient, { tenantRef: evidenceTenantRef }),
  { ok: false, brokenAtSeq: tampered.seq },
);
} finally {
  await evidenceClient?.end();
  await database.cleanup();
}

// Step 6: an expired ignore resurfaces drift, and an ignore for a prior state
// cannot suppress the same natural key after its hash changes.
const now = new Date('2026-09-04T12:00:00.000Z');
const currentDrift = {
  naturalKey: 'group:finance-admins',
  afterHash: 'new-after-hash',
};
assert.equal(isSuppressed(currentDrift, [{
  action: 'ignore',
  expiresAt: new Date('2026-09-04T11:59:59.000Z'),
  drift: { naturalKey: currentDrift.naturalKey, afterHash: currentDrift.afterHash },
}], now), false);
assert.equal(isSuppressed(currentDrift, [{
  action: 'ignore',
  expiresAt: new Date('2026-09-04T12:01:00.000Z'),
  drift: { naturalKey: currentDrift.naturalKey, afterHash: 'prior-after-hash' },
}], now), false);

// Step 7: hash-version changes are unsafe to compare and must throw rather
// than manufacture a drift row.
assert.throws(
  () => diffSnapshots(
    [{ ...baselineSnapshot[0], natural_key: 'group:hash-version', hash_version: 2 }],
    [{ ...baselineSnapshot[0], natural_key: 'group:hash-version', hash_version: 3 }],
  ),
  /cannot compare hash versions/,
);

// Step 8: an update converges when its writable value is restored, even though
// the server changes server-owned id and modifiedDateTime during the write.
const baselinePayload = {
  id: 'baseline-group-id',
  createdDateTime: '2026-09-04T00:00:00.000Z',
  modifiedDateTime: '2026-09-04T00:00:00.000Z',
  displayName: 'Finance Admins',
  description: 'Baseline description',
  mailNickname: 'finance-admins',
};
const driftedPayload = {
  ...baselinePayload,
  id: 'drifted-group-id',
  modifiedDateTime: '2026-09-04T01:00:00.000Z',
  displayName: 'Finance Administrators',
};
assert.notEqual(
  canonicalHash(baselinePayload, 'group'),
  canonicalHash(driftedPayload, 'group'),
);
const convergenceWriter = updateWriter({
  ...baselinePayload,
  id: 'post-write-group-id',
  modifiedDateTime: '2026-09-04T02:00:00.000Z',
});
const convergenceResult = await applyWave(
  convergenceWriter,
  governor(),
  [updateResource(baselinePayload)],
  { targetTenant: 'target', mode: 'enforce' },
);
assert.equal(convergenceResult.applied.length, 1);
assert.equal(convergenceResult.failed.length, 0);
assert.equal(convergenceResult.applied[0].naturalKey, 'group:finance-admins');

// Step 9: immutable-only residual drift is not-remediable, not failed, and
// does not make a second PATCH attempt.
// Uses mailEnabled (still immutable per serverOwned.mjs) rather than mailNickname —
// mailNickname was reclassified writable 2026-09-07 (Task 1), so it no longer
// exercises this not-remediable path.
const immutableDesired = {
  displayName: 'Finance Admins',
  mailEnabled: false,
};
const immutableWriter = updateWriter({
  displayName: 'Finance Admins',
  mailEnabled: true,
});
const immutableResult = await applyWave(
  immutableWriter,
  governor(),
  [updateResource(immutableDesired)],
  { targetTenant: 'target', mode: 'enforce' },
);
assert.equal(immutableResult.applied.length, 0);
assert.equal(immutableResult.failed.length, 0);
assert.equal(immutableResult.notRemediable.length, 1);
assert.deepEqual(immutableResult.notRemediable[0], {
  naturalKey: 'group:finance-admins',
  status: 'not-remediable',
  immutable: ['mailEnabled'],
});
assert.equal(
  immutableWriter.calls.filter((call) => call.kind === 'write' && call.opts.method === 'PATCH').length,
  1,
);

console.log('contract-m2.test.mjs — all assertions passed');
