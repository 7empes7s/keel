// Security audit run 2, finding 3: accepting or ignoring a sign-in or admin-access change
// needs a second person, and an ignore always ends within 90 days.
//
// Acceptance:
//  - one operator cannot accept a weakened Conditional Access policy into the approved
//    setup, nor ignore it, without an approval a different person gave; the approved
//    setup is unchanged after the refusal;
//  - the approved decision runs through the 'dispose' job (worker wrapper) as the person
//    who asked, and only for the change, action and end date that were approved;
//  - an ignore with no end, 'infinity', a past date or more than 90 days is refused;
//  - a group change (access-affecting) is still decided by one person;
//  - an Exchange admin role group change needs the approval too; a mail-flow change does not.
// Mutation checks: drop the review check in applyDisposition or acceptServiceChange;
// drop the params match; let the requester approve; remove the 90-day cap.
import { strict as assert } from 'node:assert';
import { after, test } from 'node:test';

import { runApprovedDisposition } from '../../cli/keel-dispose.mjs';
import { JOB_HANDLERS } from '../../cli/keel-worker.mjs';
import { capabilityForJobKind } from '../authz/jobCapabilities.mjs';
import { completeSnapshot, createSnapshot, insertResourceVersion } from '../store/db.mjs';
import { recordDrift } from '../store/governance.mjs';
import { schemaSql } from '../store/loadSchema.mjs';
import { createIsolatedTestDatabase } from '../test/dbTestHelper.mjs';
import { fullSuccessfulCoverageDigest } from '../test/fullSuccessfulCoverage.mjs';
import { SelfApprovalError, approveRequest, requestApproval } from './approvals.mjs';
import { seedFromSnapshot } from './baseline.mjs';
import { applyDisposition, dispositionNeedsReview } from './disposition.mjs';
import {
  DispositionApprovalError, DispositionReviewRequiredError, IgnoreExpiryError, MAX_IGNORE_DAYS,
  driftNeedsReview, ignoreExpiry, serviceChangeNeedsReview,
} from './dispositionReview.mjs';
import { acceptServiceChange } from './workloadApproved.mjs';
import { detectWorkloadDrift } from './workloadDrift.mjs';

const DAY = 86_400_000;

const database = await createIsolatedTestDatabase(import.meta.url);
after(async () => { await database.cleanup(); });

let schemaReady = false;
async function schemaClient(t) {
  const client = await database.connect();
  t.after(async () => { await client.end(); });
  if (!schemaReady) {
    await client.query(schemaSql());
    schemaReady = true;
  }
  return client;
}

async function principal(client, name) {
  const { rows: [row] } = await client.query(
    'INSERT INTO principal (email, display_name) VALUES ($1, $2) RETURNING id::text AS id',
    [`${name}-${crypto.randomUUID()}@dispose.test`, name],
  );
  return row.id;
}

// A baseline holding one resource, and a read where it changed: the drift row's id.
async function driftFixture(client, { resourceType, blastRadius, before, after }) {
  const tenantRef = `sha256:dispose-${crypto.randomUUID()}`;
  const naturalKey = `${resourceType}:KEEL-RT-${crypto.randomUUID()}`;
  const resource = (payload, hash) => ({
    naturalKey, resourceType, payload, payloadHash: hash, criticality: 'tier1', blastRadius, fidelity: 'full', provenance: { adapter: 'test' },
  });
  const base = await createSnapshot(client, { tenantRef });
  await insertResourceVersion(client, { snapshotId: base, resource: resource(before, `${naturalKey}-before`) });
  await completeSnapshot(client, { id: base, status: 'complete', coverageDigest: fullSuccessfulCoverageDigest() });
  const baselineId = await seedFromSnapshot(client, { tenantRef, snapshotId: base, setBy: 'admin' });
  const observed = await createSnapshot(client, { tenantRef });
  await insertResourceVersion(client, { snapshotId: observed, resource: resource(after, `${naturalKey}-after`) });
  const driftId = await recordDrift(client, {
    tenantRef, baselineId, observedSnapshot: observed, naturalKey, resourceType, changeType: 'modified',
    beforeHash: `${naturalKey}-before`, afterHash: `${naturalKey}-after`, beforePayload: before, afterPayload: after, blastRadius,
  });
  return { tenantRef, baselineId, naturalKey, driftId: String(driftId) };
}

async function approvedPayload(client, { baselineId, naturalKey }) {
  const { rows: [row] } = await client.query(
    `SELECT rv.payload FROM baseline_resource br JOIN resource_version rv ON rv.id = br.resource_version_id
      WHERE br.baseline_id = $1 AND br.natural_key = $2`,
    [baselineId, naturalKey],
  );
  return row.payload;
}

const caPolicy = (state) => ({ displayName: 'KEEL-RT-require-mfa', state, conditions: { users: { includeUsers: ['All'] }, applications: { includeApplications: ['All'] } }, grantControls: { builtInControls: ['mfa'] } });

test('an ignore always ends, within 90 days', () => {
  const now = new Date('2026-10-28T00:00:00Z');
  for (const bad of [undefined, null, 'infinity', 'not a date', '2026-10-27T00:00:00Z', new Date(now.valueOf() + (MAX_IGNORE_DAYS + 1) * DAY).toISOString(), 12]) {
    assert.throws(() => ignoreExpiry(bad, now), IgnoreExpiryError, String(bad));
  }
  const fine = new Date(now.valueOf() + 30 * DAY).toISOString();
  assert.equal(ignoreExpiry(fine, now).toISOString(), fine);
  assert.equal(ignoreExpiry(new Date(now.valueOf() + MAX_IGNORE_DAYS * DAY), now).valueOf(), now.valueOf() + MAX_IGNORE_DAYS * DAY);
});

test('which changes need a second person', () => {
  // The type's rating is the floor: a Conditional Access policy rated lower by its own rules still needs one.
  assert.equal(driftNeedsReview({ resourceType: 'conditionalAccessPolicy', blastRadius: 'access-affecting' }), true);
  assert.equal(driftNeedsReview({ resourceType: 'namedLocation', blastRadius: 'tenant-lockout' }), true);
  assert.equal(driftNeedsReview({ resourceType: 'roleAssignment', blastRadius: 'tenant-lockout' }), true);
  assert.equal(driftNeedsReview({ resourceType: 'group', blastRadius: 'tenant-lockout' }), true, 'a role-assignable group');
  assert.equal(driftNeedsReview({ resourceType: 'group', blastRadius: 'access-affecting' }), false);
  assert.equal(driftNeedsReview({ resourceType: 'user', blastRadius: 'cosmetic' }), false);
  assert.equal(driftNeedsReview({ resourceType: 'user', blastRadius: null }), true, 'an unrated change counts as the strictest');
  assert.equal(driftNeedsReview({ resourceType: 'user', blastRadius: 'something-new' }), true);
  // Admin-role and sign-in-trust types the catalog rates only access-affecting.
  for (const resourceType of ['exchangeRoleAssignment', 'deviceManagementRoleAssignment', 'unifiedRoleManagementPolicyAssignment', 'crossTenantAccessPolicyPartner', 'externalDomainFederation', 'identityProvider']) {
    assert.equal(driftNeedsReview({ resourceType, blastRadius: 'access-affecting' }), true, resourceType);
  }
  assert.equal(serviceChangeNeedsReview({ workload: 'exchange-role-groups', blastRadius: 'access-affecting', changeType: 'modified' }), true);
  assert.equal(serviceChangeNeedsReview({ workload: 'exchange-role-groups', blastRadius: 'cosmetic', changeType: 'modified' }), false, 'a rename');
  // An added role group is rated cosmetic, but it can hold admin rights.
  assert.equal(serviceChangeNeedsReview({ workload: 'exchange-role-groups', blastRadius: 'cosmetic', changeType: 'added' }), true);
  assert.equal(serviceChangeNeedsReview({ workload: 'exchange-role-groups', blastRadius: 'access-affecting', changeType: 'removed' }), true);
  assert.equal(serviceChangeNeedsReview({ workload: 'exchange-mail-flow', blastRadius: 'access-affecting', changeType: 'modified' }), false);
  assert.equal(capabilityForJobKind('dispose'), 'dispose-accept');
});

test('one operator cannot accept or ignore a weakened Conditional Access policy', async (t) => {
  const client = await schemaClient(t);
  const fixture = await driftFixture(client, { resourceType: 'conditionalAccessPolicy', blastRadius: 'tenant-lockout', before: caPolicy('enabled'), after: caPolicy('disabled') });
  assert.equal(await dispositionNeedsReview(client, { driftId: fixture.driftId }), true);
  const operator = await principal(client, 'operator');

  await assert.rejects(applyDisposition(client, { driftId: fixture.driftId, action: 'accept', actor: operator, reason: 'expected' }), DispositionReviewRequiredError);
  const soon = new Date(Date.now() + 7 * DAY).toISOString();
  await assert.rejects(applyDisposition(client, { driftId: fixture.driftId, action: 'ignore', actor: operator, reason: 'noise', expiresAt: soon }), DispositionReviewRequiredError);
  await assert.rejects(applyDisposition(client, { driftId: fixture.driftId, action: 'ignore', actor: operator, reason: 'noise', expiresAt: 'infinity' }), IgnoreExpiryError);
  assert.equal((await approvedPayload(client, fixture)).state, 'enabled', 'the approved setup still holds the policy on');
  const { rows } = await client.query('SELECT * FROM disposition WHERE drift_id::text = $1', [fixture.driftId]);
  assert.equal(rows.length, 0, 'nothing was recorded');
});

test('a second person approves, and the dispose job applies exactly what was approved', async (t) => {
  const client = await schemaClient(t);
  const fixture = await driftFixture(client, { resourceType: 'conditionalAccessPolicy', blastRadius: 'tenant-lockout', before: caPolicy('enabled'), after: caPolicy('disabled') });
  const operator = await principal(client, 'operator');
  const approver = await principal(client, 'approver');
  const params = { driftIds: [fixture.driftId], action: 'accept', reason: 'turned off for the KEEL-RT test' };
  const request = await requestApproval(client, { tenantRef: fixture.tenantRef, action: 'dispose', params, requestedBy: operator, justification: params.reason });

  await assert.rejects(approveRequest(client, { tenantRef: fixture.tenantRef, id: request.id, decidedBy: operator }), SelfApprovalError);
  // A pending request lets nothing through.
  await assert.rejects(applyDisposition(client, { driftId: fixture.driftId, action: 'accept', actor: operator, reason: 'x', approvalId: String(request.id) }), DispositionApprovalError);

  const { job } = await approveRequest(client, { tenantRef: fixture.tenantRef, id: request.id, decidedBy: approver });
  assert.equal(job.kind, 'dispose');
  assert.equal(job.requested_by, operator);
  assert.deepEqual(JOB_HANDLERS.dispose.argsFor(job.params, job), ['--approval-id', String(request.id), '--actor', operator]);
  assert.throws(() => JOB_HANDLERS.dispose.argsFor(job.params, { ...job, idempotency_key: 'caller-key' }), /only by an approval/);

  // The approval covers this decision only: another person, another action, nothing else.
  await assert.rejects(applyDisposition(client, { driftId: fixture.driftId, action: 'accept', actor: approver, reason: 'x', approvalId: String(request.id) }), DispositionApprovalError);
  await assert.rejects(applyDisposition(client, { driftId: fixture.driftId, action: 'ignore', actor: operator, reason: 'x', expiresAt: new Date(Date.now() + DAY).toISOString(), approvalId: String(request.id) }), DispositionApprovalError);
  const other = await driftFixture(client, { resourceType: 'conditionalAccessPolicy', blastRadius: 'tenant-lockout', before: caPolicy('enabled'), after: caPolicy('disabled') });
  await assert.rejects(applyDisposition(client, { driftId: other.driftId, action: 'accept', actor: operator, reason: 'x', approvalId: String(request.id) }), DispositionApprovalError);
  assert.equal((await approvedPayload(client, other)).state, 'enabled');

  await runApprovedDisposition(client, { approvalId: String(request.id), actor: operator });
  assert.equal((await approvedPayload(client, fixture)).state, 'disabled', 'accepted once approved');
  const { rows: [disposition] } = await client.query('SELECT actor, action FROM disposition WHERE drift_id::text = $1', [fixture.driftId]);
  assert.deepEqual(disposition, { actor: operator, action: 'accept' });
  // The approval is used: running it again is refused.
  await assert.rejects(runApprovedDisposition(client, { approvalId: String(request.id), actor: operator }), /already decided/);
});

test('an approved ignore keeps the approved end date', async (t) => {
  const client = await schemaClient(t);
  const fixture = await driftFixture(client, { resourceType: 'namedLocation', blastRadius: 'tenant-lockout', before: { displayName: 'KEEL-RT-office' }, after: { displayName: 'KEEL-RT-office', ipRanges: ['0.0.0.0/0'] } });
  const operator = await principal(client, 'operator');
  const approver = await principal(client, 'approver');
  // An older ignore that ran out does not use up a new approval.
  await client.query(`INSERT INTO disposition (drift_id, action, actor, reason, expires_at, decided_at) VALUES ($1, 'ignore', 'op', 'r', now() - interval '10 days', now() - interval '100 days')`, [fixture.driftId]);
  const expiresAt = new Date(Date.now() + 14 * DAY).toISOString();
  const request = await requestApproval(client, { tenantRef: fixture.tenantRef, action: 'dispose', params: { driftIds: [fixture.driftId], action: 'ignore', reason: 'office move', expiresAt }, requestedBy: operator });
  await approveRequest(client, { tenantRef: fixture.tenantRef, id: request.id, decidedBy: approver });
  await runApprovedDisposition(client, { approvalId: String(request.id), actor: operator });
  const { rows: [row] } = await client.query('SELECT action, expires_at FROM disposition WHERE drift_id::text = $1 ORDER BY decided_at DESC LIMIT 1', [fixture.driftId]);
  assert.equal(row.action, 'ignore');
  assert.equal(new Date(row.expires_at).toISOString(), expiresAt);
});

test('an ignore stored before the cap stops counting 90 days after it was decided', async (t) => {
  const client = await schemaClient(t);
  const { OPEN_DRIFT_PREDICATE } = await import('../store/openDrift.mjs');
  const fresh = await driftFixture(client, { resourceType: 'group', blastRadius: 'access-affecting', before: { displayName: 'KEEL-RT-a' }, after: { displayName: 'KEEL-RT-a', description: 'x' } });
  const old = await driftFixture(client, { resourceType: 'group', blastRadius: 'access-affecting', before: { displayName: 'KEEL-RT-b' }, after: { displayName: 'KEEL-RT-b', description: 'y' } });
  // Written directly, as rows saved before this rule could be: no end, decided now or 91 days ago.
  await client.query(`INSERT INTO disposition (drift_id, action, actor, reason, expires_at, decided_at) VALUES ($1, 'ignore', 'op', 'r', 'infinity', now())`, [fresh.driftId]);
  await client.query(`INSERT INTO disposition (drift_id, action, actor, reason, expires_at, decided_at) VALUES ($1, 'ignore', 'op', 'r', 'infinity', now() - interval '91 days')`, [old.driftId]);
  const open = async (driftId) => (await client.query(`SELECT 1 FROM drift d WHERE d.id::text = $1 AND ${OPEN_DRIFT_PREDICATE}`, [driftId])).rows.length === 1;
  assert.equal(await open(fresh.driftId), false, 'a recent ignore still counts');
  assert.equal(await open(old.driftId), true, 'a forever ignore from 91 days ago no longer hides the change');
});

test('a group change is still decided by one person, and its ignore is capped too', async (t) => {
  const client = await schemaClient(t);
  const fixture = await driftFixture(client, { resourceType: 'group', blastRadius: 'access-affecting', before: { displayName: 'KEEL-RT-team' }, after: { displayName: 'KEEL-RT-team', description: 'new' } });
  const operator = await principal(client, 'operator');
  assert.equal(await dispositionNeedsReview(client, { driftId: fixture.driftId }), false);
  await assert.rejects(applyDisposition(client, { driftId: fixture.driftId, action: 'ignore', actor: operator, reason: 'later', expiresAt: 'infinity' }), IgnoreExpiryError);
  await assert.rejects(applyDisposition(client, { driftId: fixture.driftId, action: 'ignore', actor: operator, reason: 'later', expiresAt: new Date(Date.now() + 120 * DAY).toISOString() }), IgnoreExpiryError);
  await applyDisposition(client, { driftId: fixture.driftId, action: 'accept', actor: operator, reason: 'expected' });
  assert.equal((await approvedPayload(client, fixture)).description, 'new');
});

// Service settings: two reads of one workload, and the change between them.
let day = 0;
async function serviceChange(client, { workload, resourceKey, before, after }) {
  const tenantRef = `sha256:dispose-svc-${crypto.randomUUID()}`;
  const read = async (fields) => {
    const at = new Date(Date.parse('2026-10-12T02:00:00Z') + (day += 1) * DAY).toISOString();
    const { rows: [collection] } = await client.query(
      `INSERT INTO workload_collection (tenant_ref, workload, outcome, observed_from, observed_to, created_at)
       VALUES ($1, $2, 'complete', $3, $3, $3) RETURNING id`,
      [tenantRef, workload, at],
    );
    if (fields) await client.query('INSERT INTO workload_observation (collection_id, resource_key, fields) VALUES ($1, $2, $3)', [collection.id, resourceKey, fields]);
    return collection.id;
  };
  await detectWorkloadDrift(client, { collectionId: await read(before) });
  await detectWorkloadDrift(client, { collectionId: await read(after) });
  const { rows: [change] } = await client.query('SELECT id::text AS id FROM workload_drift WHERE tenant_ref = $1', [tenantRef]);
  return { tenantRef, changeId: change.id };
}

test('an Exchange admin role group change needs the second person too', async (t) => {
  const client = await schemaClient(t);
  const roleGroup = (members) => ({ identity: 'KEEL-RT-admins', kind: 'roleGroup', Name: 'KEEL-RT-admins', Members: members });
  const { tenantRef, changeId } = await serviceChange(client, { workload: 'exchange-role-groups', resourceKey: 'role-group:KEEL-RT-admins', before: roleGroup(['a']), after: roleGroup(['a', 'b']) });
  const operator = await principal(client, 'operator');
  const approver = await principal(client, 'approver');
  await assert.rejects(acceptServiceChange(client, { tenantRef, changeId, actor: operator, reason: 'new admin' }), DispositionReviewRequiredError);
  const { rows: before } = await client.query('SELECT 1 FROM workload_approved WHERE tenant_ref = $1 AND fields @> $2', [tenantRef, JSON.stringify({ Members: ['a', 'b'] })]);
  assert.equal(before.length, 0);

  const params = { serviceChangeId: changeId, action: 'accept', reason: 'new admin', tenantRef };
  const request = await requestApproval(client, { tenantRef, action: 'dispose', params, requestedBy: operator });
  await approveRequest(client, { tenantRef, id: request.id, decidedBy: approver });
  await runApprovedDisposition(client, { approvalId: String(request.id), actor: operator });
  const { rows: [row] } = await client.query('SELECT approved_by FROM workload_approved WHERE tenant_ref = $1 AND fields @> $2', [tenantRef, JSON.stringify({ Members: ['a', 'b'] })]);
  assert.equal(row.approved_by, operator);

  // A new role group (rated cosmetic as an addition) needs the second person too.
  const added = await serviceChange(client, { workload: 'exchange-role-groups', resourceKey: 'role-group:KEEL-RT-new', before: null, after: roleGroup(['c']) });
  await assert.rejects(acceptServiceChange(client, { tenantRef: added.tenantRef, changeId: added.changeId, actor: operator, reason: 'new group' }), DispositionReviewRequiredError);

  // A mail-flow change is still one person's decision.
  const rule = (state) => ({ identity: 'KEEL-RT-rule', kind: 'transportRule', Name: 'KEEL-RT-rule', State: state });
  const mail = await serviceChange(client, { workload: 'exchange-mail-flow', resourceKey: 'transport-rule:KEEL-RT-rule', before: rule('Disabled'), after: rule('Enabled') });
  await acceptServiceChange(client, { tenantRef: mail.tenantRef, changeId: mail.changeId, actor: operator, reason: 'on purpose' });
});
