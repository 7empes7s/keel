import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import {
  classifyDryRunStatus,
  computeCurrentStateFingerprint,
  computePlanDigest,
  createDryRunArtifact,
  getDryRunArtifact,
  plannedVerbsOf,
  unplannedWrites,
  validateArtifactForApproval,
  validateArtifactForExecution,
} from './dryRunArtifact.mjs';
import { createSnapshot } from '../store/db.mjs';
import { createIsolatedTestDatabase } from '../test/dbTestHelper.mjs';
import { schemaSql } from '../store/loadSchema.mjs';

// --- computePlanDigest: the plan's identity, reproducible from the snapshot alone ---

const basePlan = {
  snapshotId: 'snapshot-1',
  selection: ['group:Admins', 'conditionalAccessPolicy:Protect-Admins'],
  closureKeys: ['conditionalAccessPolicy:Protect-Admins', 'group:Admins'],
  targetTenantId: 'target-tenant',
  collectorConfigPath: '/etc/keel/tenant-target.json',
  targetConfigPath: '/etc/keel/restorer.json',
  reconciliationResources: null,
  waves: [['group:Admins'], ['conditionalAccessPolicy:Protect-Admins']],
  patches: [],
};

{
  const a = computePlanDigest(basePlan);
  const b = computePlanDigest({
    ...basePlan,
    selection: [...basePlan.selection].reverse(),
    closureKeys: [...basePlan.closureKeys].reverse(),
  });
  assert.equal(a, b, 'selection and closureKeys order must not affect the digest');
}

for (const [field, value] of [
  ['snapshotId', 'snapshot-2'],
  ['selection', ['group:Admins']],
  ['closureKeys', ['group:Admins']],
  ['targetTenantId', 'other-tenant'],
  ['collectorConfigPath', '/etc/keel/other-collector.json'],
  ['targetConfigPath', '/etc/keel/other-restorer.json'],
  ['reconciliationResources', [{ naturalKey: 'group:Admins', resourceType: 'group', payload: null }]],
  ['waves', [['group:Admins']]],
  ['patches', [{ naturalKey: 'group:Admins', field: 'x', symbol: 'group:Y' }]],
]) {
  const changed = computePlanDigest({ ...basePlan, [field]: value });
  assert.notEqual(changed, computePlanDigest(basePlan), `changing ${field} must change the plan digest`);
}

test('manual-restore plan digest is unchanged from pre-task-55 artifacts', () => {
  const fields = { snapshotId: 'snap-pin-1', selection: ['group:Admins'], closureKeys: ['group:Admins'],
    targetTenantId: 'tenant-pin', collectorConfigPath: '/etc/keel/collector.json', targetConfigPath: '/etc/keel/target.json',
    reconciliationResources: null, waves: [['group:Admins']], patches: [] };
  const legacy = '5166cb535775f6877b0ed03be4ed6ab6e6f1cf8e9c1824f60123c56b04390de7';
  assert.equal(computePlanDigest(fields), legacy);
  assert.equal(computePlanDigest({ ...fields, automationContext: undefined }), legacy);
  assert.equal(computePlanDigest({ ...fields, automationContext: null }), legacy);
});

// --- computeCurrentStateFingerprint: the target's current shape, restricted to the closure ---

const targetResources = [
  { naturalKey: 'group:Admins', resourceType: 'group', sourceId: 'target-admins-id', payload: { displayName: 'Admins' } },
  { naturalKey: 'group:Unrelated', resourceType: 'group', sourceId: 'target-unrelated-id', payload: { displayName: 'Unrelated' } },
];

{
  const a = computeCurrentStateFingerprint(targetResources, ['group:Admins']);
  const b = computeCurrentStateFingerprint([...targetResources].reverse(), ['group:Admins']);
  assert.equal(a, b, 'input order must not affect the fingerprint');
  assert.notEqual(
    a,
    computeCurrentStateFingerprint(targetResources, ['group:Admins', 'group:Unrelated']),
    'a resource outside the closure must not be silently included',
  );
}
{
  const before = computeCurrentStateFingerprint(targetResources, ['group:Admins']);
  const drifted = targetResources.map((resource) => (resource.naturalKey === 'group:Admins'
    ? { ...resource, payload: { displayName: 'Admins (renamed)' } }
    : resource));
  const after = computeCurrentStateFingerprint(drifted, ['group:Admins']);
  assert.notEqual(before, after, 'a change to a closure resource in the target must change the fingerprint');
}
{
  // The natural key and payload alone do not identify the target object. Replacing
  // the target object under the same natural key must force a fresh dry run even
  // when every other fingerprint input is unchanged.
  const before = computeCurrentStateFingerprint(targetResources, ['group:Admins']);
  const reidentified = targetResources.map((resource) => (resource.naturalKey === 'group:Admins'
    ? { ...resource, sourceId: 'target-admins-id-replaced' }
    : resource));
  const after = computeCurrentStateFingerprint(reidentified, ['group:Admins']);
  assert.notEqual(
    before,
    after,
    'changing only the target object identity must change the stale-state fingerprint',
  );
  assert.equal(
    validateArtifactForExecution(
      { status: 'completed', digest: 'digest-a', currentStateFingerprint: before },
      { digest: 'digest-a', currentStateFingerprint: after },
    ).ok,
    false,
    'a promotion is refused when only the target object identity changed',
  );
}

assert.equal(classifyDryRunStatus({ failed: [], skipped: [] }), 'completed');
assert.equal(classifyDryRunStatus({ failed: [], skipped: [{ naturalKey: 'group:Synced', reason: 'synced' }] }), 'refused');
assert.equal(classifyDryRunStatus({ failed: [{ naturalKey: 'group:X', error: 'boom' }], skipped: [] }), 'failed');

assert.deepEqual(validateArtifactForApproval(null), { ok: false, reason: 'no dry-run artifact found for this restore' });
assert.equal(validateArtifactForApproval({ status: 'refused' }).ok, false);
assert.equal(validateArtifactForApproval({ status: 'failed' }).ok, false);
assert.equal(validateArtifactForApproval({ status: 'completed' }).ok, true);

const completedArtifact = {
  status: 'completed', digest: 'digest-a', currentStateFingerprint: 'fingerprint-a',
};
assert.deepEqual(
  validateArtifactForExecution(completedArtifact, { digest: 'digest-a', currentStateFingerprint: 'fingerprint-a' }),
  { ok: true },
);
assert.equal(
  validateArtifactForExecution(completedArtifact, { digest: 'digest-b', currentStateFingerprint: 'fingerprint-a' }).ok,
  false,
);
assert.equal(
  validateArtifactForExecution(completedArtifact, { digest: 'digest-a', currentStateFingerprint: 'fingerprint-b' }).ok,
  false,
);


{
  // Issue #474: Graph returns an app or e-book category's lastModifiedDateTime as the
  // time of the read. Two reads of an unchanged category must give one fingerprint, or
  // every update is refused as "target changed since the dry run".
  for (const resourceType of ['mobileAppCategory', 'managedEBookCategory']) {
    const read = (at, displayName = 'KEEL-RT-apps-drift') => [{
      naturalKey: `${resourceType}:KEEL-RT-apps-drift`, resourceType, sourceId: 'cat-id',
      payload: { id: 'cat-id', displayName, lastModifiedDateTime: at },
    }];
    const key = [`${resourceType}:KEEL-RT-apps-drift`];
    assert.equal(
      computeCurrentStateFingerprint(read('2026-10-22T08:36:39.6299953Z'), key),
      computeCurrentStateFingerprint(read('2026-10-22T08:36:42.1325217Z'), key),
      `${resourceType}: a read-time lastModifiedDateTime must not change the fingerprint`,
    );
    assert.notEqual(
      computeCurrentStateFingerprint(read('2026-10-22T08:36:39.6299953Z'), key),
      computeCurrentStateFingerprint(read('2026-10-22T08:36:39.6299953Z', 'KEEL-RT-renamed'), key),
      `${resourceType}: a real change must still change the fingerprint`,
    );
  }
  // Issue #746: a notification template's localized messages carry the read time too.
  const template = (at, subject = 'KEEL-RT') => [{
    naturalKey: 'notificationMessageTemplate:KEEL-RT-notice', resourceType: 'notificationMessageTemplate', sourceId: 'tpl-id',
    payload: {
      id: 'tpl-id', displayName: 'KEEL-RT-notice', defaultLocale: 'en-us', lastModifiedDateTime: at,
      localizedNotificationMessages: [{ id: 'm1', locale: 'en-us', subject, messageTemplate: 'KEEL-RT test', isDefault: true, lastModifiedDateTime: at }],
    },
  }];
  const templateKey = ['notificationMessageTemplate:KEEL-RT-notice'];
  assert.equal(
    computeCurrentStateFingerprint(template('2026-10-30T02:30:43Z'), templateKey),
    computeCurrentStateFingerprint(template('2026-10-30T02:31:04Z'), templateKey),
    'a read-time lastModifiedDateTime on a template or its messages must not change the fingerprint',
  );
  assert.notEqual(
    computeCurrentStateFingerprint(template('2026-10-30T02:30:43Z'), templateKey),
    computeCurrentStateFingerprint(template('2026-10-30T02:30:43Z', 'KEEL-RT drifted'), templateKey),
    'a changed message subject must still change the fingerprint',
  );
  // Kinds not observed to stamp the read time keep the field as a change signal.
  const other = (at) => [{
    naturalKey: 'group:Admins', resourceType: 'group', sourceId: 'target-admins-id',
    payload: { displayName: 'Admins', lastModifiedDateTime: at },
  }];
  assert.notEqual(
    computeCurrentStateFingerprint(other('2026-10-22T08:00:00Z'), ['group:Admins']),
    computeCurrentStateFingerprint(other('2026-10-22T09:00:00Z'), ['group:Admins']),
  );
}
// --- createDryRunArtifact / getDryRunArtifact: real persistence, isolated test DB ---

const database = await createIsolatedTestDatabase(import.meta.url);
let client;
try {
  client = await database.connect();
  await client.query(schemaSql());

  const tenantRef = 'sha256:dry-run-artifact-test';
  const snapshotId = await createSnapshot(client, { tenantRef });

  const fields = {
    id: 'aaaaaaaa-0000-4000-8000-000000000001',
    tenantRef,
    snapshotId,
    selection: ['group:Admins'],
    closureKeys: ['group:Admins'],
    targetTenantId: 'target-tenant',
    collectorConfigPath: '/etc/keel/tenant-target.json',
    targetConfigPath: '/etc/keel/restorer.json',
    reconciliationResources: null,
    waves: [['group:Admins']],
    patches: [],
    guardRefusals: [],
    results: { applied: [{ naturalKey: 'group:Admins', targetId: null }], skipped: [], failed: [], notRemediable: [] },
    currentStateFingerprint: 'fingerprint-1',
    digest: 'digest-1',
    status: 'completed',
    requestedBy: 'principal-restorer',
  };
  const created = await createDryRunArtifact(client, fields);
  assert.equal(created.id, fields.id);
  assert.equal(created.status, 'completed');
  assert.deepEqual(created.selection, fields.selection);
  assert.deepEqual(created.results, fields.results);
  assert.equal(created.automationContext, null);
  assert.equal(created.plannedVerbs, null, 'an artifact stored without planned verbs reads back as not recorded');

  const fetched = await getDryRunArtifact(client, { id: fields.id, tenantRef });
  assert.deepEqual(fetched, created);
  assert.equal(fetched.automationContext, null);

  // A colliding ID must raise PostgreSQL's unique_violation, never replace the
  // reviewed changes or promotion decision (nor silently discard the new write).
  const collidingFields = {
    ...fields,
    selection: ['group:Different'],
    closureKeys: ['group:Different'],
    targetTenantId: 'different-target',
    waves: [['group:Different']],
    guardRefusals: [{ naturalKey: 'group:Different', reason: 'synced' }],
    results: { applied: [], skipped: [{ naturalKey: 'group:Different', reason: 'synced' }], failed: [] },
    currentStateFingerprint: 'different-fingerprint',
    digest: 'different-digest',
    status: 'refused',
    requestedBy: 'different-requester',
  };
  try {
    await assert.rejects(
      createDryRunArtifact(client, collidingFields),
      (error) => error.code === '23505' && error.constraint === 'restore_dry_run_pkey',
      'a duplicate artifact ID must surface a real database uniqueness error',
    );
  } finally {
    assert.deepEqual(
      await getDryRunArtifact(client, { id: fields.id, tenantRef }),
      created,
      'an artifact ID collision must leave every original immutable review field unchanged',
    );
  }

  assert.equal(
    await getDryRunArtifact(client, { id: fields.id, tenantRef: 'sha256:someone-else' }),
    null,
    'an artifact is never visible outside its own tenant',
  );
  // Issue #683: the planned verbs are stored and read back as written.
  const plannedVerbs = [{ naturalKey: 'group:Admins', verb: 'noop' }];
  const withVerbs = await createDryRunArtifact(client, { ...fields, id: 'aaaaaaaa-0000-4000-8000-000000000683', plannedVerbs });
  assert.deepEqual(withVerbs.plannedVerbs, plannedVerbs);
  assert.deepEqual((await getDryRunArtifact(client, { id: withVerbs.id, tenantRef })).plannedVerbs, plannedVerbs);
  await assert.rejects(
    createDryRunArtifact(client, { ...fields, id: 'aaaaaaaa-0000-4000-8000-000000000002', status: 'bogus' }),
    /invalid dry-run artifact status/,
  );
} finally {
  await client?.end();
  await database.cleanup();
}

console.log('dryRunArtifact.test.mjs — all assertions passed');

// --- Issue #683: execution writes only what the approved dry run planned ---

test('plannedVerbsOf lists each resource with its verb, sorted, an absent verb as create', () => {
  assert.deepEqual(plannedVerbsOf([
    { naturalKey: 'group:B', verb: 'noop' },
    { naturalKey: 'engageCommunity:A', verb: 'update' },
    { naturalKey: 'group:C' },
  ]), [
    { naturalKey: 'engageCommunity:A', verb: 'update' },
    { naturalKey: 'group:B', verb: 'noop' },
    { naturalKey: 'group:C', verb: 'create' },
  ]);
});

test('unplannedWrites lists a write the plan left alone or planned with another verb', () => {
  const planned = [
    { naturalKey: 'engageCommunity:keel-rt-community', verb: 'update' },
    { naturalKey: 'group:keel-rt-community', verb: 'noop' },
    { naturalKey: 'group:Old', verb: 'update' },
    { naturalKey: 'group:Gone', verb: 'restore-soft-deleted' },
  ];
  const fresh = [
    { naturalKey: 'engageCommunity:keel-rt-community', verb: 'update' },
    { naturalKey: 'group:keel-rt-community', verb: 'update' },
    { naturalKey: 'group:Old', verb: 'noop' },
    { naturalKey: 'group:Gone', verb: 'create' },
  ];
  assert.deepEqual(unplannedWrites(planned, fresh), [
    { naturalKey: 'group:keel-rt-community', planned: 'noop', now: 'update' },
    { naturalKey: 'group:Gone', planned: 'restore-soft-deleted', now: 'create' },
  ]);
  assert.deepEqual(unplannedWrites(planned, planned), [], 'the same plan has no unplanned write');
});

test('unplannedWrites lists every write when the artifact recorded no planned verbs', () => {
  assert.deepEqual(unplannedWrites(null, [
    { naturalKey: 'group:A', verb: 'update' },
    { naturalKey: 'group:B', verb: 'noop' },
  ]), [{ naturalKey: 'group:A', planned: null, now: 'update' }]);
});

test('validateArtifactForExecution refuses a write the approved plan did not list', () => {
  const artifact = {
    status: 'completed', digest: 'd', currentStateFingerprint: 'f',
    plannedVerbs: [{ naturalKey: 'group:keel-rt-community', verb: 'noop' }],
  };
  const fresh = [{ naturalKey: 'group:keel-rt-community', verb: 'update' }];
  const refused = validateArtifactForExecution(artifact, { digest: 'd', currentStateFingerprint: 'f', plannedVerbs: fresh });
  assert.equal(refused.ok, false);
  assert.match(refused.reason, /would write what the approved plan did not list: group:keel-rt-community update \(dry run: noop\) — a new dry run and approval are required/);
  assert.deepEqual(validateArtifactForExecution(artifact, { digest: 'd', currentStateFingerprint: 'f', plannedVerbs: artifact.plannedVerbs }), { ok: true });
  assert.deepEqual(validateArtifactForExecution(artifact, { digest: 'd', currentStateFingerprint: 'f' }), { ok: true },
    'a caller that does not plan per resource (compensation, Conditional Access turn-on) is not compared');
  const old = validateArtifactForExecution({ ...artifact, plannedVerbs: null }, { digest: 'd', currentStateFingerprint: 'f', plannedVerbs: fresh });
  assert.match(old.reason, /predates planned writes being recorded: group:keel-rt-community update \(dry run: not recorded\)/);
});
