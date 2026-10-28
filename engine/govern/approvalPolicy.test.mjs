import { strict as assert } from 'node:assert';
import { randomUUID } from 'node:crypto';
import {
  APPROVAL_POLICY_ACTIONS,
  ApprovalPolicyError,
  BULK_RESTORE_THRESHOLD,
  OPERATOR_TEST_TENANT_POLICY,
  TEST_TENANT_REFS,
  classifyApprovalActions,
  getApprovalPolicies,
  setApprovalPolicy,
  standingPolicyRefusal,
} from './approvalPolicy.mjs';
import {
  APPROVAL_DECISION_EVIDENCE_KIND,
  APPROVAL_SIGNOFF_EVIDENCE_KIND,
  DuplicateApproverError,
  SelfApprovalError,
  StandingPolicyRefusedError,
  approveRequest,
  listApprovalRequests,
  rejectRequest,
  requestApproval,
} from './approvals.mjs';
import { verifyChain } from './evidence.mjs';
import { createDryRunArtifact } from '../restore/dryRunArtifact.mjs';
import { createSnapshot } from '../store/db.mjs';
import { tenantRefFor } from '../store/tenantRef.mjs';
import { TEST_TENANT_REFS as QUALIFICATION_TEST_TENANT_REFS } from '../../tools/qualification/entraLive.mjs';
import { createIsolatedTestDatabase } from '../test/dbTestHelper.mjs';
import { schemaSql } from '../store/loadSchema.mjs';

// --- the standing policy's test tenant is the qualification tools' test tenant ---
assert.deepEqual([...TEST_TENANT_REFS], [...QUALIFICATION_TEST_TENANT_REFS]);

// --- classification: what a restore's dry run records, plus what the caller declares ---
const keys = (n) => Array.from({ length: n }, (_, i) => `group:KEEL-RT-${i}`);
assert.deepEqual(classifyApprovalActions({ action: 'restore', artifact: { closureKeys: keys(2) } }), []);
assert.deepEqual(
  classifyApprovalActions({ action: 'restore', artifact: { closureKeys: keys(BULK_RESTORE_THRESHOLD) } }),
  ['bulk-restore'],
);
assert.deepEqual(
  classifyApprovalActions({ action: 'restore', artifact: { closureKeys: keys(BULK_RESTORE_THRESHOLD - 1), relationshipOperations: [{ op: 'add' }] } }),
  ['bulk-restore'],
  'member and owner edges count toward a bulk restore',
);
assert.deepEqual(
  classifyApprovalActions({ action: 'restore', artifact: { closureKeys: keys(1), reconciliationResources: [{ naturalKey: 'group:x', verb: 'delete' }] } }),
  ['delete'],
);
assert.deepEqual(
  classifyApprovalActions({ action: 'restore', artifact: { closureKeys: keys(1), relationshipOperations: [{ parentNaturalKey: 'group:x', family: 'member', action: 'remove', targetId: 'u' }] } }),
  ['delete'],
  'removing a member or owner is a delete for the two-person rule (security audit run 2, finding 7)',
);
assert.deepEqual(
  classifyApprovalActions({ action: 'restore', artifact: { closureKeys: keys(1), relationshipOperations: [{ parentNaturalKey: 'group:x', family: 'member', action: 'add', targetId: 'u' }] } }),
  [],
  'adding a member is not a delete',
);
assert.deepEqual(
  classifyApprovalActions({ action: 'restore', artifact: { closureKeys: keys(1), contentEffects: [{ effect: 'retention-reducing' }, { effect: 'hold-releasing' }, { effect: 'externally-sharing' }] } }),
  ['retention-shortening', 'legal-hold-release'],
);
assert.deepEqual(
  classifyApprovalActions({ action: 'restore', artifact: null, declared: ['content-restore-other-location'] }),
  ['content-restore-other-location'],
);
assert.throws(() => classifyApprovalActions({ action: 'restore', declared: ['everything'] }), ApprovalPolicyError);

// --- the standing rule covers test-tenant restores only ---
const TEST_TENANT_ID = 'test-tenant-for-standing-policy';
const TEST_REF = tenantRefFor(TEST_TENANT_ID);
const PROD_REF = tenantRefFor('production-tenant');
const refs = [TEST_REF];
const restoreOn = (artifactRef, targetTenantId) => ({
  policy: OPERATOR_TEST_TENANT_POLICY, tenantRef: artifactRef, request: { action: 'restore' },
  artifact: { tenantRef: artifactRef, targetTenantId }, testTenantRefs: refs,
});
assert.equal(standingPolicyRefusal(restoreOn(TEST_REF, TEST_TENANT_ID)), null);
assert.match(standingPolicyRefusal(restoreOn(TEST_REF, 'production-tenant')), /only the test tenant/);
assert.match(standingPolicyRefusal(restoreOn(PROD_REF, TEST_TENANT_ID)), /only the test tenant/);
assert.match(standingPolicyRefusal({ ...restoreOn(TEST_REF, TEST_TENANT_ID), artifact: null }), /dry run/);
assert.match(standingPolicyRefusal({ ...restoreOn(TEST_REF, TEST_TENANT_ID), request: { action: 'remediate' } }), /does not cover remediate/);
assert.match(standingPolicyRefusal({ ...restoreOn(TEST_REF, TEST_TENANT_ID), policy: 'anything-goes' }), /unknown standing policy/);
assert.match(standingPolicyRefusal({ ...restoreOn(TEST_REF, TEST_TENANT_ID), testTenantRefs: undefined }), /only the test tenant/,
  'the committed test tenant list does not hold a made-up tenant');

const database = await createIsolatedTestDatabase(import.meta.url);
let client;
try {
  client = await database.connect();
  await client.query(schemaSql());

  const principal = async (name, role) => {
    const { rows: [{ id }] } = await client.query(
      `INSERT INTO principal (email, display_name) VALUES ($1, $1) RETURNING id::text AS id`, [`${name}@policy.test`],
    );
    if (role) await client.query(`INSERT INTO role_grant (principal_id, role, granted_by) VALUES ($1, $2, 'test')`, [id, role]);
    return id;
  };
  const requester = await principal('requester', 'restorer');
  const first = await principal('first', 'approver');
  const second = await principal('second', 'approver');
  const third = await principal('third', 'approver');
  const jobCount = async () => Number((await client.query('SELECT count(*) FROM job')).rows[0].count);
  const status = async (id) => (await client.query('SELECT status FROM approval_request WHERE id = $1', [id])).rows[0].status;
  const ask = (tenantRef, policyActions = ['delete']) => requestApproval(client, {
    tenantRef, action: 'baseline-activate', params: { naturalKey: `group:${randomUUID()}` }, requestedBy: requester, policyActions,
  });

  // --- off by default: every action, one approver decides ---
  const tenantRef = 'sha256:approval-policy-test';
  assert.deepEqual(
    Object.values(await getApprovalPolicies(client, { tenantRef })).map((policy) => policy.twoPerson),
    APPROVAL_POLICY_ACTIONS.map(() => false),
  );
  const offRequest = await ask(tenantRef);
  assert.equal(offRequest.required_approvals, 1);
  assert.deepEqual(offRequest.policy_actions, ['delete']);
  const offDecision = await approveRequest(client, { tenantRef, id: offRequest.id, decidedBy: first });
  assert.equal(offDecision.request.status, 'approved');
  assert.ok(offDecision.job, 'with the rule off, one approval mints the job');

  // --- rule on: one approver is refused (signs off only), two distinct approvers pass ---
  await setApprovalPolicy(client, { tenantRef, actionClass: 'delete', twoPerson: true, actor: 'admin@policy.test' });
  assert.equal((await getApprovalPolicies(client, { tenantRef })).delete.twoPerson, true);
  const jobsBefore = await jobCount();
  const twoPerson = await ask(tenantRef);
  assert.equal(twoPerson.required_approvals, 2);
  const signed = await approveRequest(client, { tenantRef, id: twoPerson.id, decidedBy: first });
  assert.equal(signed.job, null);
  assert.equal(signed.signoffs, 1);
  assert.equal(signed.requiredApprovals, 2);
  assert.equal(await status(twoPerson.id), 'pending', 'one approval leaves a two-person request pending');
  assert.equal(await jobCount(), jobsBefore, 'one approval mints no job');
  // the inbox reads the progress: how many it needs, and who signed so far
  const listed = (await listApprovalRequests(client, { statuses: ['pending'] })).find((row) => row.id === twoPerson.id);
  assert.equal(listed.required_approvals, 2);
  assert.deepEqual(listed.signoffs, [first]);

  // the same person approving twice is refused, and changes nothing
  await assert.rejects(approveRequest(client, { tenantRef, id: twoPerson.id, decidedBy: first }), DuplicateApproverError);
  assert.equal(await status(twoPerson.id), 'pending');
  // the requester never counts as either approver
  await assert.rejects(approveRequest(client, { tenantRef, id: twoPerson.id, decidedBy: requester }), SelfApprovalError);

  const decided = await approveRequest(client, { tenantRef, id: twoPerson.id, decidedBy: second });
  assert.equal(decided.request.status, 'approved');
  assert.equal(decided.request.decided_by, second);
  assert.ok(decided.job, 'the second, different approver mints the job');
  assert.deepEqual(decided.approvers, [first, second]);
  assert.equal(await jobCount(), jobsBefore + 1);

  // --- an action the rule is off for still needs one approver ---
  const other = await ask(tenantRef, ['bulk-restore']);
  assert.equal(other.required_approvals, 1);
  assert.ok((await approveRequest(client, { tenantRef, id: other.id, decidedBy: first })).job);

  // --- turning the rule off later never lowers what a request needs ---
  const madeUnderRule = await ask(tenantRef);
  await setApprovalPolicy(client, { tenantRef, actionClass: 'delete', twoPerson: false, actor: 'admin@policy.test' });
  assert.equal((await approveRequest(client, { tenantRef, id: madeUnderRule.id, decidedBy: first })).job, null);
  assert.ok((await approveRequest(client, { tenantRef, id: madeUnderRule.id, decidedBy: second })).job);

  // --- turning it on applies to requests already waiting ---
  const madeBeforeRule = await ask(tenantRef);
  assert.equal(madeBeforeRule.required_approvals, 1);
  await setApprovalPolicy(client, { tenantRef, actionClass: 'delete', twoPerson: true, actor: 'admin@policy.test' });
  assert.equal((await approveRequest(client, { tenantRef, id: madeBeforeRule.id, decidedBy: first })).job, null);

  // --- an earlier approver who lost `approve` no longer counts ---
  await client.query(`UPDATE role_grant SET active_until = now() - interval '1 second' WHERE principal_id = $1`, [first]);
  assert.equal((await approveRequest(client, { tenantRef, id: madeBeforeRule.id, decidedBy: second })).job, null,
    'a sign-off by someone who lost approve does not count');
  assert.ok((await approveRequest(client, { tenantRef, id: madeBeforeRule.id, decidedBy: third })).job);

  // --- a two-person request can still be rejected by one approver ---
  const rejected = await ask(tenantRef);
  await approveRequest(client, { tenantRef, id: rejected.id, decidedBy: second });
  assert.equal((await rejectRequest(client, { tenantRef, id: rejected.id, decidedBy: third, reason: 'not now' })).status, 'rejected');

  // --- restores: the dry run classifies the request ---
  const snapshotId = await createSnapshot(client, { tenantRef });
  const artifact = (overrides = {}) => createDryRunArtifact(client, {
    id: randomUUID(), tenantRef, snapshotId, selection: ['group:KEEL-RT-a'], closureKeys: ['group:KEEL-RT-a'],
    targetTenantId: 'production-tenant', collectorConfigPath: '/etc/keel/a.json', targetConfigPath: '/etc/keel/b.json',
    reconciliationResources: null, waves: [['group:KEEL-RT-a']], patches: [], guardRefusals: [],
    results: { applied: [], skipped: [], failed: [], notRemediable: [] }, currentStateFingerprint: 'f', digest: 'd',
    status: 'completed', requestedBy: requester, ...overrides,
  });
  await setApprovalPolicy(client, { tenantRef, actionClass: 'bulk-restore', twoPerson: true, actor: 'admin@policy.test' });
  const bulk = await artifact({ closureKeys: keys(BULK_RESTORE_THRESHOLD) });
  const bulkRequest = await requestApproval(client, { tenantRef, action: 'restore', params: { artifactId: bulk.id }, requestedBy: requester });
  assert.deepEqual(bulkRequest.policy_actions, ['bulk-restore']);
  assert.equal(bulkRequest.required_approvals, 2);
  const small = await artifact();
  const smallRequest = await requestApproval(client, { tenantRef, action: 'restore', params: { artifactId: small.id }, requestedBy: requester });
  assert.deepEqual(smallRequest.policy_actions, []);
  assert.equal(smallRequest.required_approvals, 1);

  // --- the standing rule: refused off the test tenant, recorded on the test tenant ---
  await assert.rejects(
    approveRequest(client, { tenantRef, id: smallRequest.id, decidedBy: second, standingPolicy: OPERATOR_TEST_TENANT_POLICY }),
    StandingPolicyRefusedError,
  );
  assert.equal(await status(smallRequest.id), 'pending', 'a refused standing decision changes nothing');

  const testSnapshot = await createSnapshot(client, { tenantRef: TEST_REF });
  const testArtifact = await createDryRunArtifact(client, {
    id: randomUUID(), tenantRef: TEST_REF, snapshotId: testSnapshot, selection: ['group:KEEL-RT-b'], closureKeys: ['group:KEEL-RT-b'],
    targetTenantId: TEST_TENANT_ID, collectorConfigPath: '/etc/keel/a.json', targetConfigPath: '/etc/keel/b.json',
    reconciliationResources: null, waves: [['group:KEEL-RT-b']], patches: [], guardRefusals: [],
    results: { applied: [], skipped: [], failed: [], notRemediable: [] }, currentStateFingerprint: 'f', digest: 'd',
    status: 'completed', requestedBy: requester,
  });
  const testRequest = await requestApproval(client, { tenantRef: TEST_REF, action: 'restore', params: { artifactId: testArtifact.id }, requestedBy: requester });
  await assert.rejects(
    approveRequest(client, { tenantRef: TEST_REF, id: testRequest.id, decidedBy: requester, standingPolicy: OPERATOR_TEST_TENANT_POLICY, testTenantRefs: refs }),
    SelfApprovalError,
    'the standing rule never allows self-approval',
  );
  const standing = await approveRequest(client, {
    tenantRef: TEST_REF, id: testRequest.id, decidedBy: second, standingPolicy: OPERATOR_TEST_TENANT_POLICY, testTenantRefs: refs,
  });
  assert.equal(standing.request.status, 'approved');
  assert.equal(standing.request.standing_policy, OPERATOR_TEST_TENANT_POLICY);
  const { rows: evidence } = await client.query(
    `SELECT kind, subject, actor FROM evidence WHERE tenant_ref = $1 AND kind = $2`, [TEST_REF, APPROVAL_DECISION_EVIDENCE_KIND],
  );
  assert.ok(
    evidence.some((row) => row.subject.requestId === testRequest.id && row.subject.standingPolicy === OPERATOR_TEST_TENANT_POLICY && row.actor === second),
    'the approval id is logged with the standing policy it was made under',
  );

  // --- every step is on the evidence chain ---
  const { rows: signoffs } = await client.query(`SELECT subject FROM evidence WHERE tenant_ref = $1 AND kind = $2`, [tenantRef, APPROVAL_SIGNOFF_EVIDENCE_KIND]);
  assert.ok(signoffs.some((row) => row.subject.requestId === twoPerson.id && row.subject.requiredApprovals === 2));
  const { rows: decisions } = await client.query(`SELECT subject FROM evidence WHERE tenant_ref = $1 AND kind = $2`, [tenantRef, APPROVAL_DECISION_EVIDENCE_KIND]);
  assert.ok(decisions.some((row) => row.subject.requestId === twoPerson.id && row.subject.approvers?.length === 2));
  assert.deepEqual(await verifyChain(client, { tenantRef }), { ok: true });
  assert.deepEqual(await verifyChain(client, { tenantRef: TEST_REF }), { ok: true });
} finally {
  await client?.end();
  await database.cleanup();
}
console.log('approvalPolicy.test.mjs — all assertions passed');
