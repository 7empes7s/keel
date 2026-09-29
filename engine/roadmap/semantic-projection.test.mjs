/**
 * Roadmap task-51 boundary tests: versioned field projection and
 * classification contracts. Exercises the production
 * engine/contracts/fieldProjection.mjs, engine/cir/canonicalHash.mjs and
 * engine/reconcile/writableProjection.mjs against adversarial fixtures —
 * including the three required mutation checks:
 *
 * - Compare raw objects instead of projection.
 * - Infer reviewed status from empty map.
 * - Hash old and new projection versions as comparable.
 */
import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import {
  FIELD_PROJECTION_CONTRACT_VERSION, OPERATIONS, REVIEW_STATES,
  classifyForOperation, exportProjection, reviewStateFor,
} from '../contracts/fieldProjection.mjs';
import { HASH_VERSION, canonicalHash, compareAcrossHashVersions } from '../cir/canonicalHash.mjs';
import { immutableDrift, unknownFields, writableProjection } from '../reconcile/writableProjection.mjs';

test('field projection contract exposes a stable version and operation vocabulary', () => {
  assert.equal(FIELD_PROJECTION_CONTRACT_VERSION, 1);
  assert.deepEqual([...OPERATIONS], ['collection', 'comparison', 'create', 'update', 'verification', 'sensitiveExport']);
  assert.deepEqual([...REVIEW_STATES], ['reviewed-empty', 'unreviewed', 'has-rules']);
});

test('review state reflects registration, never rules-map emptiness', () => {
  assert.equal(reviewStateFor('user'), 'has-rules');
  assert.equal(reviewStateFor('group'), 'has-rules');
  for (const type of ['roleAssignment', 'namedLocation', 'conditionalAccessPolicy', 'authenticationStrengthPolicy']) {
    assert.equal(reviewStateFor(type), 'reviewed-empty', `${type} should be reviewed-empty`);
  }
  // Mutation pin: an unregistered type's absent rules look exactly like a
  // registered reviewed-empty type's empty rules. Inferring review state from
  // map emptiness would collapse both to 'reviewed-empty'; only registration
  // may decide it.
  assert.equal(reviewStateFor('domain'), 'unreviewed');
  assert.equal(reviewStateFor('organization'), 'unreviewed');
});

test('classifyForOperation rejects an unknown operation and an unknown resourceType', () => {
  assert.throws(() => classifyForOperation('delete', 'displayName', 'group'), /unknown field-projection operation/);
  assert.throws(() => classifyForOperation('comparison', 'displayName', 'not-a-type'), /unknown resourceType/);
});

test('collection, comparison and verification use the base classification unchanged', () => {
  for (const operation of ['collection', 'comparison', 'verification']) {
    assert.equal(classifyForOperation(operation, 'id', 'group'), 'serverOwned');
    assert.equal(classifyForOperation(operation, 'mailEnabled', 'group'), 'immutable');
    assert.equal(classifyForOperation(operation, 'displayName', 'group'), 'writable');
    // Even an out-of-list field on a reviewed type is not narrowed for these
    // three operations — narrowing is a create/update-only behavior.
    assert.equal(classifyForOperation(operation, 'someBrandNewField', 'group'), 'writable');
  }
});

test('create: writable and immutable fields are both settable; serverOwned stays excluded; an unnamed field on a reviewed type is unknown', () => {
  assert.equal(classifyForOperation('create', 'id', 'group'), 'serverOwned');
  assert.equal(classifyForOperation('create', 'mailEnabled', 'group'), 'writable', 'immutable fields are settable at create (spec M2.3)');
  assert.equal(classifyForOperation('create', 'displayName', 'group'), 'writable');
  assert.equal(classifyForOperation('create', 'someBrandNewField', 'group'), 'unknown', 'group is reviewed; an unnamed field is unknown, not writable');
  // roleAssignment: every real field is immutable; all remain settable at create.
  assert.equal(classifyForOperation('create', 'principalId', 'roleAssignment'), 'writable');
  // Unreviewed type: no narrowing at all — an unnamed field falls through to its base class.
  assert.equal(classifyForOperation('create', 'someBrandNewField', 'domain'), 'writable');
});

test('update narrows an unnamed field on a reviewed type to unknown; writableProjection excludes it and unknownFields reports it', () => {
  assert.equal(classifyForOperation('update', 'displayName', 'group'), 'writable');
  assert.equal(classifyForOperation('update', 'mailEnabled', 'group'), 'immutable');
  assert.equal(classifyForOperation('update', 'id', 'group'), 'serverOwned');
  assert.equal(classifyForOperation('update', 'someBrandNewField', 'user'), 'unknown');
  // task-128: description was omitted from group's knownFields (task-51 regression),
  // stripping it from every group PATCH and stalling restore convergence.
  assert.equal(classifyForOperation('update', 'description', 'group'), 'writable');
  assert.deepEqual(
    writableProjection({ displayName: 'x', description: 'd' }, 'group'),
    { displayName: 'x', description: 'd' },
    'description survives the group writable projection',
  );

  const payload = {
    id: 'u1',
    displayName: 'Ana',
    userPrincipalName: 'ana@example.test',
    someBrandNewField: 'graph-added-this-later',
  };
  assert.deepEqual(
    writableProjection(payload, 'user'),
    { displayName: 'Ana', userPrincipalName: 'ana@example.test' },
    'the unknown field never reaches the PATCH body',
  );
  assert.deepEqual(unknownFields(payload, 'user'), ['someBrandNewField']);

  // Unreviewed type: writableProjection's behavior is untouched by this task
  // — an unnamed field on an unreviewed type still passes straight through,
  // exactly as it did before roadmap task-51.
  const domainPayload = { id: 'd1', someBrandNewField: 'still passes through' };
  assert.deepEqual(writableProjection(domainPayload, 'domain'), { someBrandNewField: 'still passes through' });
  assert.equal(unknownFields(domainPayload, 'domain'), null, 'an unreviewed type has nothing to flag against');

  assert.throws(() => unknownFields({}, 'not-a-type'), /unknown resourceType/);
});

test('sensitive fields never survive exportProjection; everything else does', () => {
  const userPayload = {
    id: 'u1', displayName: 'Ana', userPrincipalName: 'ana@example.test',
    onPremisesImmutableId: 'QUJDMTIz', employeeId: 'E-42', accountEnabled: true,
  };
  assert.deepEqual(exportProjection(userPayload, 'user'), {
    id: 'u1', displayName: 'Ana', userPrincipalName: 'ana@example.test', accountEnabled: true,
  });

  const groupPayload = {
    id: 'g1', displayName: 'Finance', mailNickname: 'finance',
    securityIdentifier: 'S-1-5-21-fake', onPremisesSamAccountName: 'FINANCE$',
  };
  assert.deepEqual(exportProjection(groupPayload, 'group'), {
    id: 'g1', displayName: 'Finance', mailNickname: 'finance',
  });

  // A reviewed-empty type has nothing to strip — export equals input.
  const namedLocationPayload = { id: 'nl1', displayName: 'HQ', isTrusted: true };
  assert.deepEqual(exportProjection(namedLocationPayload, 'namedLocation'), namedLocationPayload);

  // An unreviewed type also has nothing registered to strip — export passes through.
  const domainPayload = { id: 'd1', isDefault: true };
  assert.deepEqual(exportProjection(domainPayload, 'domain'), domainPayload);

  assert.throws(() => exportProjection({}, 'not-a-type'), /unknown resourceType/);
});

test('comparison excludes serverOwned via the fieldProjection contract: cosmetic changes converge, behavior changes remain drift', () => {
  const before = {
    id: 'g-before', createdDateTime: '2026-09-04T00:00:00Z',
    displayName: 'Finance Admins', mailNickname: 'finance-admins',
  };
  const cosmeticChange = { ...before, id: 'g-after', createdDateTime: '2026-09-05T00:00:00Z' };
  const behaviorChange = { ...before, displayName: 'Legal Admins' };

  assert.equal(
    canonicalHash(before, 'group'), canonicalHash(cosmeticChange, 'group'),
    'a serverOwned-only change is cosmetic: zero semantic drift',
  );
  assert.notEqual(
    canonicalHash(before, 'group'), canonicalHash(behaviorChange, 'group'),
    'a writable-field change is real drift',
  );
  // Mutation pin: comparing the raw objects instead of the projection would
  // treat the cosmetic change as drift too — the raw payloads really do
  // differ byte-for-byte; only the projection converges them.
  assert.notEqual(JSON.stringify(before), JSON.stringify(cosmeticChange));

  assert.equal(HASH_VERSION, 2, 'comparison narrows nothing new, so the hash version is unchanged by this task');
});

test('compareAcrossHashVersions never trusts a raw hash across versions: reprojects when possible, else unknown', () => {
  const sameVersion = compareAcrossHashVersions(
    { hashVersion: 2, payload: { id: 'g1', displayName: 'Finance' } },
    { hashVersion: 2, payload: { id: 'g1', displayName: 'Finance' } },
    'group',
  );
  assert.deepEqual(sameVersion, { comparable: true, changed: false, method: 'direct' });

  // Mixed versions with both raw payloads available. The "legacy" hash
  // strings stand in for whatever an incompatible old algorithm once
  // produced — deliberately different from each other even though the
  // payloads are semantically identical under the CURRENT rules (they only
  // differ in serverOwned fields). Old hashes must not manufacture a change.
  const payloadA = { id: 'g1', createdDateTime: '2026-09-04T00:00:00Z', displayName: 'Finance' };
  const payloadB = { id: 'g1', createdDateTime: '2026-09-05T00:00:00Z', displayName: 'Finance' };
  const reprojected = compareAcrossHashVersions(
    { hashVersion: 1, hash: 'legacy-hash-abc', payload: payloadA },
    { hashVersion: 2, hash: 'legacy-hash-xyz', payload: payloadB },
    'group',
  );
  assert.deepEqual(
    reprojected, { comparable: true, changed: false, method: 'reprojected' },
    'reprojection under current rules finds these unchanged even though the stale hash strings differ',
  );

  // Mutation pin: treating hashVersion 1 and 2 as directly comparable would
  // compare 'legacy-hash-abc' !== 'legacy-hash-xyz' and manufacture `changed:
  // true` out of nothing but differing stale hash algorithms.
  assert.notEqual('legacy-hash-abc', 'legacy-hash-xyz');

  const behaviorChanged = compareAcrossHashVersions(
    { hashVersion: 1, hash: 'legacy-hash-abc', payload: payloadA },
    { hashVersion: 2, hash: 'legacy-hash-xyz', payload: { ...payloadB, displayName: 'Legal' } },
    'group',
  );
  assert.equal(behaviorChanged.changed, true, 'a genuine writable-field change still registers after reprojection');

  const missingPayload = compareAcrossHashVersions(
    { hashVersion: 1, hash: 'legacy-hash-abc' },
    { hashVersion: 2, payload: payloadB },
    'group',
  );
  assert.deepEqual(
    missingPayload, { comparable: false, changed: null, method: 'unknown' },
    'no raw payload to reproject from means the verdict is unknown, never a guess',
  );

  assert.throws(
    () => compareAcrossHashVersions({ payload: payloadA }, { hashVersion: 2, payload: payloadB }, 'group'),
    /requires an explicit hashVersion/,
  );
});

test('immutableDrift is unchanged by this task', () => {
  assert.deepEqual(
    immutableDrift(
      { mailEnabled: false, displayName: 'Finance' },
      { mailEnabled: true, displayName: 'Finance' },
      'group',
    ),
    ['mailEnabled'],
  );
});
