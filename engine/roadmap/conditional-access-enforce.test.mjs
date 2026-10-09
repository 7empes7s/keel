/**
 * Roadmap task-152 boundary tests: a Conditional Access restore lands
 * report-only, says so as a pending step, and is turned on only as a separate,
 * approved step behind the break-glass lockout gate. Also the registered
 * Conditional Access soft-delete restore.
 *
 * Exercises engine/restore/conditionalAccessEnforcement.mjs, the lockout gate
 * (engine/safety/lockoutGate.mjs) over task-94 readiness, the production
 * applyWave() restore path and the full cli/keel-restore.mjs dry run ->
 * approval -> promotion path, against the isolated test database and an
 * in-memory fake Graph. No tenant is read or written. Mutation checks:
 *
 * - Turn a policy on without an approved request.
 * - Turn a policy on that would apply to a break-glass account.
 * - Leave a soft-restored policy in the state it was deleted in (enabled).
 */
import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { after, test } from 'node:test';

import { canonicalHash } from '../cir/canonicalHash.mjs';
import { capabilityFor } from '../coverage/capabilities.mjs';
import { qualificationFor } from '../coverage/qualification.mjs';
import { approveRequest, requestApproval, SelfApprovalError } from '../govern/approvals.mjs';
import { buildReconciliationPlan } from '../reconcile/reconciliationPlan.mjs';
import { applyWave } from '../restore/applyEngine.mjs';
import { grantRole } from '../authz/administration.mjs';
import { CompletionEvidenceError, completeItem, completionItemsFor, listCompletionItems, resourceCompletionState } from '../restore/completion.mjs';
import {
  ENFORCED, REPORT_ONLY, applyConditionalAccessEnforcement, enforcementPendingFor, pendingEnforcementSteps,
  planConditionalAccessEnforcement,
} from '../restore/conditionalAccessEnforcement.mjs';
import { getDryRunArtifactById, validateArtifactForApproval } from '../restore/dryRunArtifact.mjs';
import { NATIVE_RECOVERY_ROUTES, SOFT_DELETE_RETENTION_DAYS } from '../restore/recoveryMechanism.mjs';
import { listJournal } from '../restore/rollbackJournal.mjs';
import { breakGlassLockoutGate } from '../safety/lockoutGate.mjs';
import { createSnapshot, completeSnapshot, insertResourceVersion } from '../store/db.mjs';
import { createIsolatedTestDatabase } from '../test/dbTestHelper.mjs';
import { fakeGraph, runFixtureHarness } from '../../tools/qualification/operations.mjs';
import { main, runRestore } from '../../cli/keel-restore.mjs';

const database = await createIsolatedTestDatabase(import.meta.url);
after(async () => { await database.cleanup(); });

const PROOF = 'engine/roadmap/conditional-access-enforce.test.mjs';
const DAY = 24 * 60 * 60 * 1000;
const NOW = new Date('2026-10-09T12:00:00Z');
const daysAgo = (days, from = NOW) => new Date(from.getTime() - days * DAY).toISOString();
const governor = { async acquire() {}, observeRetryAfter() {} };
const quiet = { log() {}, error() {} };
const KEY = 'conditionalAccessPolicy:Require-MFA-All';
const POLICIES = '/identity/conditionalAccess/policies';

// ---------------------------------------------------------------- break-glass fixtures

const GA = '62e90394-69f5-4237-9190-012177145e10';
const BG1 = 'aaaaaaaa-0000-0000-0000-000000000001';
const BG2 = 'aaaaaaaa-0000-0000-0000-000000000002';
const BG3 = 'aaaaaaaa-0000-0000-0000-000000000003';
const account = (accountId, i) => ({
  accountId, label: `BG${i + 1}`, validationIntervalDays: 90, rotationIntervalDays: null,
  registeredAt: '2026-09-01T00:00:00Z', lastValidatedAt: '2026-10-01T00:00:00Z', lastRotatedAt: null,
  methodEvidence: { basis: 'observed', occurredAt: '2026-10-01T00:00:00Z', methods: ['fido2'] },
});
const covered = (resources) => ({ status: 'covered', resources, observedAt: NOW.toISOString() });
function gateInputs({ accountIds = [BG1, BG2], caCovered = true } = {}) {
  const accounts = accountIds.map(account);
  return {
    configured: true,
    accounts,
    now: NOW,
    groupMembers: () => null,
    inventory: {
      user: covered(accounts.map((a) => ({ naturalKey: `user:${a.label}`, payload: { id: a.accountId, userPrincipalName: `${a.label}@contoso.example`, accountEnabled: true, userType: 'Member', onPremisesSyncEnabled: null } }))),
      domain: covered([{ naturalKey: 'domain:contoso.example', payload: { id: 'contoso.example', authenticationType: 'Managed' } }]),
      conditionalAccessPolicy: caCovered ? covered([]) : { status: 'unavailable', resources: [], observedAt: null },
      roleAssignment: covered(accounts.map((a) => ({ naturalKey: `roleAssignment:GlobalAdministrator@${a.label}`, payload: { principalId: a.accountId, roleDefinitionId: GA, directoryScopeId: '/' } }))),
      roleEligibilitySchedule: covered([]),
      authenticationMethodsPolicy: covered([{ naturalKey: 'authenticationMethodsPolicy:x', payload: { authenticationMethodConfigurations: [{ id: 'Fido2', state: 'enabled', includeTargets: [{ targetType: 'group', id: 'all_users' }] }] } }]),
    },
  };
}
const gate = (options) => breakGlassLockoutGate(gateInputs(options));

/** An MFA policy for everyone that excludes both break-glass accounts. */
const mfaPolicy = Object.freeze({
  displayName: 'Require-MFA-All',
  state: ENFORCED,
  conditions: { users: { includeUsers: ['All'], excludeUsers: [BG1, BG2] }, applications: { includeApplications: ['All'] } },
  grantControls: { operator: 'OR', builtInControls: ['mfa'] },
});

/** A Collector-side reader over a fakeGraph: Conditional Access policies (live and
 * deleted) and the sign-in path singletons. */
function readerFor(graph, { liveCa = () => true } = {}) {
  const policies = () => [...graph.objects].filter(([path]) => path.startsWith(`${POLICIES}/`)).map(([, body]) => body);
  return {
    async collect(_version, path) {
      if (path.startsWith('/identity/conditionalAccess/deletedItems/policies')) {
        return { items: [...graph.deleted.values()].map((entry) => entry.body), capped: false, error: null };
      }
      if (path.split('?')[0] === POLICIES) return { items: liveCa() ? policies() : [], capped: false, error: null };
      return { items: [], capped: false, error: null };
    },
    async get(_version, path) {
      if (path === '/policies/authenticationMethodsPolicy') return { ok: true, status: 200, body: { id: 'authenticationMethodsPolicy' } };
      if (path === '/policies/identitySecurityDefaultsEnforcementPolicy') return { ok: true, status: 200, body: { id: 'identitySecurityDefaultsEnforcementPolicy', isEnabled: false } };
      if (path.startsWith('/users/')) return { ok: true, status: 200, body: { id: 'break-glass-id', accountEnabled: true } };
      throw new Error(`unexpected read: ${path}`);
    },
  };
}

const desired = (payload = mfaPolicy) => ({
  naturalKey: KEY, resourceType: 'conditionalAccessPolicy', payload, payloadHash: canonicalHash(payload, 'conditionalAccessPolicy'),
  references: [], blastRadius: 'tenant-lockout',
});

// ------------------------------------------------------------------ registration

test('Conditional Access soft-delete restore is registered and fixture-tested, never live-qualified', async () => {
  const capability = capabilityFor('conditionalAccessPolicy', 'restore-soft-deleted');
  assert.equal(capability.claim, 'fixture-tested');
  assert.equal(capability.proofRef, PROOF);
  assert.equal(capability.idOutcome, 'preserved');
  assert.match(qualificationFor('conditionalAccessPolicy').reason, /restore-soft-deleted/);
  // A deleted policy is no longer a native-route manual handoff.
  assert.equal(NATIVE_RECOVERY_ROUTES.conditionalAccessPolicy, undefined);

  // The harness proves it through the production applyWave path: a policy deleted
  // while enabled is restored with its id and put back to report-only.
  const [run] = (await runFixtureHarness({ types: ['conditionalAccessPolicy'] })).filter((r) => r.operation === 'restore-soft-deleted');
  assert.equal(run.result, 'passed', run.detail);
  assert.deepEqual(run.writes, [
    'POST /identity/conditionalAccess/deletedItems/policies/fixture-existing/restore',
    'PATCH /identity/conditionalAccess/policies/fixture-existing',
  ]);
});

// ------------------------------------------------------------------ pending step

test('the pending step appears only when the snapshot had the policy enabled and the restore wrote it report-only', () => {
  const planned = (payload, verb) => ({ ...desired(payload), verb });
  const reportOnly = { ...mfaPolicy, state: REPORT_ONLY };
  const disabled = { ...mfaPolicy, state: 'disabled' };
  for (const verb of ['create', 'update', 'restore-soft-deleted']) assert.equal(enforcementPendingFor(planned(mfaPolicy, verb)), true, verb);
  assert.equal(enforcementPendingFor(planned(mfaPolicy, 'noop')), false, 'unchanged, still enabled: nothing pending');
  assert.equal(enforcementPendingFor(planned(reportOnly, 'update')), false);
  assert.equal(enforcementPendingFor(planned(disabled, 'create')), false);
  assert.equal(enforcementPendingFor({ ...planned(mfaPolicy, 'update'), resourceType: 'namedLocation' }), false);

  const resources = [planned(mfaPolicy, 'update'), { ...planned(reportOnly, 'update'), naturalKey: 'conditionalAccessPolicy:Pilot' }];
  const steps = pendingEnforcementSteps(resources, [{ naturalKey: KEY }, { naturalKey: 'conditionalAccessPolicy:Pilot' }]);
  assert.deepEqual(steps.map((step) => [step.naturalKey, step.snapshotState, step.restoredState]), [[KEY, ENFORCED, REPORT_ONLY]]);
  assert.deepEqual(pendingEnforcementSteps(resources, []), [], 'a policy that was not written leaves no step');

  // As a completion item: open, a configuration item, and kept beside the others.
  assert.deepEqual(completionItemsFor({ resourceType: 'conditionalAccessPolicy', mechanism: 'update-existing' }), []);
  const [item] = completionItemsFor({ resourceType: 'conditionalAccessPolicy', mechanism: 'update-existing', enforcementPending: true });
  assert.equal(item.kind, 'enforcement');
  assert.equal(resourceCompletionState([{ ...item, state: 'pending' }]), 'configuration-restored');
  assert.deepEqual(completionItemsFor({ resourceType: 'conditionalAccessPolicy', mechanism: 'recreate', enforcementPending: true }).map((i) => i.kind),
    ['integration', 'enforcement', 'service-validation']);
  assert.doesNotMatch(item.description, /[0-9a-f]{8}-[0-9a-f]{4}/, 'no raw ids in what the operator reads');
});

// --------------------------------------------------------------- soft-delete restore

test('a deleted Conditional Access policy is soft-restored with its id and lands report-only', async () => {
  const graph = fakeGraph();
  graph.deleted.set('ca-1', { path: `${POLICIES}/ca-1`, body: { ...mfaPolicy, id: 'ca-1', deletedDateTime: daysAgo(3) } });
  const plan = await buildReconciliationPlan(readerFor(graph), [desired()], { now: NOW });
  const [policy] = plan.resources;
  assert.equal(policy.verb, 'restore-soft-deleted');
  assert.equal(policy.recovery.mechanism, 'soft-delete-restore');
  assert.equal(policy.recovery.retainedId, 'ca-1');
  assert.equal(policy.recovery.deadline, new Date(Date.parse(daysAgo(3)) + SOFT_DELETE_RETENTION_DAYS * DAY).toISOString());

  const result = await applyWave(graph, governor, [policy], { targetTenant: 't', mode: 'enforce', now: () => NOW });
  assert.deepEqual(result.failed, []);
  assert.deepEqual(result.applied, [{ naturalKey: KEY, targetId: 'ca-1' }]);
  assert.deepEqual(graph.writes.map((w) => `${w.method} ${w.path}`), [
    'POST /identity/conditionalAccess/deletedItems/policies/ca-1/restore',
    `PATCH ${POLICIES}/ca-1`,
  ]);
  assert.ok(!graph.writes.some((w) => w.method === 'POST' && w.path === POLICIES), 'never recreated');
  assert.equal(graph.objects.get(`${POLICIES}/ca-1`).state, REPORT_ONLY, 'mutation check: the restored policy does not stay enabled');
  assert.deepEqual(pendingEnforcementSteps(plan.resources, result.applied).map((step) => step.naturalKey), [KEY]);
});

test('the retention deadline is enforced at planning and again at execution', async () => {
  const graph = fakeGraph();
  graph.deleted.set('ca-1', { path: `${POLICIES}/ca-1`, body: { ...mfaPolicy, id: 'ca-1', deletedDateTime: daysAgo(31) } });
  const [expired] = (await buildReconciliationPlan(readerFor(graph), [desired()], { now: NOW })).resources;
  assert.equal(expired.recovery.mechanism, 'refused');
  assert.match(expired.recovery.reason, /recovery-point-expired/);

  // A failed deleted-items read is never "not found": nothing is recreated beside the original.
  const failing = { ...readerFor(fakeGraph()), async collect(version, path) {
    if (path.startsWith('/identity/conditionalAccess/deletedItems/')) return { items: undefined, error: { status: 403, error: 'denied' } };
    return readerFor(fakeGraph()).collect(version, path);
  } };
  const [unknown] = (await buildReconciliationPlan(failing, [desired()], { now: NOW })).resources;
  assert.equal(unknown.verb, 'create');
  assert.equal(unknown.recovery.mechanism, 'refused');
  assert.match(unknown.recovery.reason, /lookup-failed/);

  graph.deleted.set('ca-1', { path: `${POLICIES}/ca-1`, body: { ...mfaPolicy, id: 'ca-1', deletedDateTime: daysAgo(29) } });
  const [inTime] = (await buildReconciliationPlan(readerFor(graph), [desired()], { now: NOW })).resources;
  assert.equal(inTime.recovery.mechanism, 'soft-delete-restore');
  const later = new Date(NOW.getTime() + 2 * DAY);
  const result = await applyWave(graph, governor, [inTime], { targetTenant: 't', mode: 'enforce', now: () => later });
  assert.equal(graph.writes.length, 0);
  assert.match(result.skipped[0].reason, /recovery-point-expired/);
});

test('a dry run of the soft-delete restore sends nothing', async () => {
  const graph = fakeGraph();
  graph.deleted.set('ca-1', { path: `${POLICIES}/ca-1`, body: { ...mfaPolicy, id: 'ca-1', deletedDateTime: daysAgo(3) } });
  const [policy] = (await buildReconciliationPlan(readerFor(graph), [desired()], { now: NOW })).resources;
  const result = await applyWave(graph, governor, [policy], { targetTenant: 't', mode: 'dry-run', now: () => NOW });
  assert.deepEqual(result.applied, [{ naturalKey: KEY, targetId: 'ca-1' }]);
  assert.equal(graph.writes.length, 0);
  assert.ok(graph.deleted.has('ca-1'));
});

// ------------------------------------------------------------------ the lockout gate

test('the lockout gate evaluates "this policy turned on" as a proposed change', () => {
  const proposed = (payload) => ({ resourceType: 'conditionalAccessPolicy', naturalKey: KEY, desired: payload });
  assert.equal(gate().evaluate(proposed(mfaPolicy)).allowed, true, 'both accounts excluded');

  // Mutation: the policy would apply to a break-glass account.
  const blocks = { ...mfaPolicy, conditions: { ...mfaPolicy.conditions, users: { includeUsers: ['All'], excludeUsers: [BG1] } } };
  const verdict = gate().evaluate(proposed(blocks));
  assert.equal(verdict.allowed, false);
  assert.match(verdict.reason, /BG2: policyExclusions fail \(enforced-policy-applies\)/);
  // A third registered account the policy does not exclude.
  assert.equal(gate({ accountIds: [BG1, BG2, BG3] }).evaluate(proposed(mfaPolicy)).allowed, false);

  // Unknown is never ready: unread policies, an unread exclusion group, no policy named.
  assert.equal(gate({ caCovered: false }).evaluate(proposed(mfaPolicy)).allowed, false);
  const byGroup = { ...mfaPolicy, conditions: { ...mfaPolicy.conditions, users: { includeUsers: ['All'], excludeGroups: ['bg-group'] } } };
  assert.match(gate().evaluate(proposed(byGroup)).reason, /policy-treatment-unknown/);
  assert.equal(gate().evaluate({ resourceType: 'conditionalAccessPolicy', desired: mfaPolicy }).allowed, false);

  // The same policy report-only is no lockout question; the proposed state is what counts.
  assert.equal(gate().evaluate(proposed({ ...blocks, state: REPORT_ONLY })).allowed, true);
});

// --------------------------------------------------------- the enforcement step (engine)

function restoredGraph(payload = mfaPolicy) {
  const graph = fakeGraph();
  graph.objects.set(`${POLICIES}/ca-1`, { ...payload, id: 'ca-1', state: REPORT_ONLY });
  return graph;
}
const liveOf = (graph) => ({ targetId: 'ca-1', payload: graph.objects.get(`${POLICIES}/ca-1`) });
const planFor = (graph) => planConditionalAccessEnforcement({
  restoreRef: 'restore-1', naturalKey: KEY, pendingItem: { id: 'item-1', state: 'pending' }, snapshotPayload: mfaPolicy, live: liveOf(graph),
});
const APPROVAL = Object.freeze({ approvedBy: 'approver', reason: 'turn MFA back on' });
const enforce = (graph, options = {}) => applyConditionalAccessEnforcement(graph, planFor(graph), {
  mode: 'enforce', live: liveOf(graph), lockoutGate: gate(), approval: APPROVAL,
  signInPathGate: { reader: readerFor(graph), protectedPrincipalIds: [BG1] }, readDelayMs: 0, ...options,
});

test('the step is planned only for a policy the restore left report-only from an enabled backup', () => {
  const graph = restoredGraph();
  const plan = planFor(graph);
  assert.equal(plan.fromState, REPORT_ONLY);
  assert.equal(plan.toState, ENFORCED);
  const refuse = (fields, pattern) => assert.throws(() => planConditionalAccessEnforcement({
    restoreRef: 'restore-1', naturalKey: KEY, pendingItem: { id: 'item-1', state: 'pending' }, snapshotPayload: mfaPolicy, live: liveOf(graph), ...fields,
  }), pattern);
  refuse({ pendingItem: null }, /left no enforcement step/);
  refuse({ pendingItem: { id: 'item-1', state: 'verified' } }, /already closed/);
  refuse({ snapshotPayload: { ...mfaPolicy, state: REPORT_ONLY } }, /did not have .* turned on/);
  refuse({ live: null }, /not in the target/);
  refuse({ live: { targetId: 'ca-1', payload: { ...mfaPolicy, state: ENFORCED } } }, /already turned on/);
  refuse({ live: { targetId: 'ca-1', payload: { ...mfaPolicy, state: 'disabled' } } }, /someone changed it after the restore/);
  refuse({ naturalKey: 'namedLocation:Office' }, /not a Conditional Access policy/);
});

test('a dry run evaluates the gate and sends nothing; a refused gate or a missing approval writes nothing', async () => {
  const graph = restoredGraph();
  const dry = await applyConditionalAccessEnforcement(null, planFor(graph), { mode: 'dry-run', live: liveOf(graph), lockoutGate: gate() });
  assert.deepEqual(dry.applied.map((entry) => entry.naturalKey), [KEY]);
  assert.equal(graph.writes.length, 0);

  const blocked = await enforce(graph, { lockoutGate: gate({ accountIds: [BG1, BG2, BG3] }) });
  assert.match(blocked.skipped[0].reason, /^break-glass lockout gate: /);
  const unknown = await enforce(graph, { lockoutGate: gate({ caCovered: false }) });
  assert.match(unknown.skipped[0].reason, /break-glass readiness is unknown/);
  const ungated = await enforce(graph, { lockoutGate: null });
  assert.match(ungated.skipped[0].reason, /no break-glass lockout gate/);
  // Mutation check: no approval, no write.
  const unapproved = await enforce(graph, { approval: null });
  assert.match(unapproved.failed[0].error, /requires an approved request/);
  // The policy changed since the step was planned.
  const changed = await enforce(graph, { live: { targetId: 'ca-1', payload: { ...liveOf(graph).payload, displayName: 'Other' } } });
  assert.match(changed.failed[0].error, /changed since this step was planned/);
  assert.equal(graph.writes.length, 0);
  assert.equal(graph.objects.get(`${POLICIES}/ca-1`).state, REPORT_ONLY);
});

test('allowed when ready: only the state is written, and it is read back', async () => {
  const graph = restoredGraph();
  const bodies = [];
  const write = graph.write.bind(graph);
  graph.write = async (version, path, request) => { bodies.push(request.body); return write(version, path, request); };
  const result = await enforce(graph);
  assert.deepEqual(result.failed, []);
  assert.deepEqual(result.applied.map((entry) => entry.naturalKey), [KEY]);
  assert.deepEqual(graph.writes.map((w) => `${w.method} ${w.path}`), [`PATCH ${POLICIES}/ca-1`]);
  assert.deepEqual(bodies, [{ state: ENFORCED }]);
  assert.equal(graph.objects.get(`${POLICIES}/ca-1`).state, ENFORCED);
});

test('a sign-in path change beyond this one policy puts it back to report-only and fails', async () => {
  const graph = restoredGraph();
  graph.objects.set(`${POLICIES}/ca-2`, { displayName: 'Other', id: 'ca-2', state: REPORT_ONLY, conditions: { users: { includeUsers: ['None'] } } });
  const write = graph.write.bind(graph);
  graph.write = async (version, path, request) => {
    const result = await write(version, path, request);
    // Someone turns another policy on at the same moment.
    if (request.body?.state === ENFORCED) graph.objects.set(`${POLICIES}/ca-2`, { ...graph.objects.get(`${POLICIES}/ca-2`), state: ENFORCED });
    return result;
  };
  const result = await enforce(graph);
  assert.match(result.failed[0].error, /sign-in path changed beyond this policy .* put back to report-only/);
  assert.equal(graph.objects.get(`${POLICIES}/ca-1`).state, REPORT_ONLY);
});

// ------------------------------------------------------ full CLI: restore -> approval -> on

const TENANT = 'sha256:task-152';
const configs = new Map([
  ['/fixtures/collector.json', JSON.stringify({ tenantId: 'tenant-152', clientId: 'collector', certPath: 'c.pem', keyPath: 'c.key' })],
  ['/fixtures/restorer.json', JSON.stringify({ tenantId: 'tenant-152', clientId: 'restorer', certPath: 'r.pem', keyPath: 'r.key' })],
]);
const readFile = (path) => configs.get(path) ?? (() => { throw new Error(`unexpected config read: ${path}`); })();

let schemaReady = false;
async function schemaClient(t) {
  const client = await database.connect();
  t.after(async () => { await client.end(); });
  if (!schemaReady) {
    await client.query(readFileSync(new URL('../store/schema.sql', import.meta.url), 'utf8'));
    schemaReady = true;
  }
  return client;
}

function cliDependencies(graph, world) {
  const reader = readerFor(graph, { liveCa: () => world.liveCa });
  class Reader {
    collect(version, path) { return reader.collect(version, path); }
    get(version, path) { return reader.get(version, path); }
  }
  return {
    getToken: async () => ({ accessToken: 'fake-token' }),
    GraphReader: Reader,
    GraphWriter: class { constructor() { return graph; } },
    collectM1: async () => [],
    canonicalizeAll: () => [
      { naturalKey: 'roleAssignment:GlobalAdministrator:break-glass', resourceType: 'roleAssignment', sourceId: 'ra-1', payload: { principalId: 'break-glass-id' } },
      ...[...graph.objects].filter(([path]) => path.startsWith(`${POLICIES}/`)).map(([, body]) => ({
        naturalKey: `conditionalAccessPolicy:${body.displayName}`, resourceType: 'conditionalAccessPolicy', sourceId: body.id, payload: body,
      })),
    ],
    loadLockoutGateInputs: async () => gateInputs(world.gate),
    loadGroupMembership: async () => () => null,
  };
}

async function seedSnapshot(client) {
  const snapshotId = await createSnapshot(client, { tenantRef: TENANT });
  await insertResourceVersion(client, {
    snapshotId,
    resource: {
      naturalKey: KEY, resourceType: 'conditionalAccessPolicy', payload: mfaPolicy, payloadHash: canonicalHash(mfaPolicy, 'conditionalAccessPolicy'),
      criticality: 'tier1', blastRadius: 'tenant-lockout', fidelity: 'full', provenance: { adapter: 'test' },
    },
  });
  await completeSnapshot(client, { id: snapshotId, status: 'complete', coverageDigest: {} });
  return snapshotId;
}

/** A deleted (enabled) MFA policy restored through the CLI: dry run, then promotion. */
async function restoredThroughCli(client) {
  const world = { liveCa: false, gate: {} };
  const graph = fakeGraph();
  graph.deleted.set('ca-1', { path: `${POLICIES}/ca-1`, body: { ...mfaPolicy, id: 'ca-1', deletedDateTime: daysAgo(2, new Date()) } });
  const run = (options) => runRestore({ readFile, dbUrl: database.url, dependencies: cliDependencies(graph, world), logger: quiet, ...options });
  const snapshotId = await seedSnapshot(client);
  const restoreId = crypto.randomUUID();
  const dry = await run({
    snapshotId, selection: [KEY], mode: 'dry-run', persistArtifactId: restoreId, requestedBy: 'requester',
    collectorConfig: JSON.parse(configs.get('/fixtures/collector.json')), targetConfig: JSON.parse(configs.get('/fixtures/restorer.json')),
    collectorConfigPath: '/fixtures/collector.json', targetConfigPath: '/fixtures/restorer.json',
  });
  assert.equal(graph.writes.length, 0, 'the restore dry run sends nothing');
  assert.deepEqual(dry.pendingSteps.map((step) => step.naturalKey), [KEY], 'the dry run already names the pending step');
  assert.deepEqual((await getDryRunArtifactById(client, { id: restoreId })).results.pendingSteps.map((step) => step.naturalKey), [KEY]);

  const restored = await run({ artifactId: restoreId, mode: 'enforce' });
  assert.deepEqual(restored.results.failed, []);
  assert.equal(graph.objects.get(`${POLICIES}/ca-1`).state, REPORT_ONLY);
  assert.deepEqual(restored.pendingSteps.map((step) => [step.naturalKey, step.restoredState]), [[KEY, REPORT_ONLY]]);
  const items = await listCompletionItems(client, { tenantRef: TENANT, restoreRef: restoreId });
  assert.deepEqual(items.map((item) => [item.naturalKey, item.kind, item.state]), [[KEY, 'enforcement', 'pending']]);
  world.liveCa = true;
  return { graph, world, run, restoreId };
}

const planEnforcement = (run, restoreId, artifactId) => run({
  enforceConditionalAccess: { restoreArtifactId: restoreId, naturalKey: KEY }, mode: 'dry-run', persistArtifactId: artifactId, requestedBy: 'requester',
});

test('promotion requires the approval; once approved and ready it turns the policy on and closes the step', async (t) => {
  const client = await schemaClient(t);
  const { graph, run, restoreId } = await restoredThroughCli(client);
  const writesAfterRestore = graph.writes.length;

  const enforcementId = crypto.randomUUID();
  const dry = await planEnforcement(run, restoreId, enforcementId);
  assert.equal(dry.status, 'completed');
  assert.equal(graph.writes.length, writesAfterRestore, 'the enforcement dry run sends nothing');
  const artifact = await getDryRunArtifactById(client, { id: enforcementId });
  assert.equal(artifact.conditionalAccessEnforcement.naturalKey, KEY);
  assert.equal(artifact.conditionalAccessEnforcement.promotes, restoreId);

  // Never a direct enforce, from the API or the CLI.
  await assert.rejects(run({ enforceConditionalAccess: { restoreArtifactId: restoreId, naturalKey: KEY }, mode: 'enforce' }), /only ever planned as a dry run/);
  await assert.rejects(main({
    argv: ['node', 'keel-restore.mjs', '--enforce-conditional-access', restoreId, '--policy', KEY, '--enforce'],
    readFile, dbUrl: database.url, dependencies: {}, logger: quiet,
  }), /dry run only/);

  // A ticket cannot close the step: only the approved enforcement run does.
  const { rows: [restorer] } = await client.query(`INSERT INTO principal (email) VALUES ('restorer@contoso.example') RETURNING id`);
  await grantRole(client, { principalId: restorer.id, role: 'restorer', grantedBy: restorer.id });
  const [pendingItem] = await listCompletionItems(client, { tenantRef: TENANT, restoreRef: restoreId });
  await assert.rejects(
    completeItem(client, { tenantRef: TENANT, itemId: pendingItem.id, actorId: restorer.id, evidence: { type: 'ticket', reference: 'CHG-1' } }),
    CompletionEvidenceError,
  );

  // Mutation check: promoting the reviewed artifact without an approved request.
  await assert.rejects(run({ artifactId: enforcementId, mode: 'enforce' }), /needs an approved request/);
  const request = await requestApproval(client, { tenantRef: TENANT, action: 'restore', params: { artifactId: enforcementId }, requestedBy: 'requester' });
  await assert.rejects(approveRequest(client, { tenantRef: TENANT, id: request.id, decidedBy: 'requester' }), SelfApprovalError);
  await assert.rejects(run({ artifactId: enforcementId, mode: 'enforce' }), /needs an approved request/);
  assert.equal(graph.writes.length, writesAfterRestore, 'nothing written without the approval');

  const approved = await approveRequest(client, { tenantRef: TENANT, id: request.id, decidedBy: 'approver' });
  assert.equal(approved.job.params.artifactId, enforcementId);
  assert.equal(approved.job.params.mode, 'enforce');

  const result = await run({ artifactId: enforcementId, mode: 'enforce' });
  assert.deepEqual(result.results.failed, []);
  assert.deepEqual(graph.writes.slice(writesAfterRestore).map((w) => `${w.method} ${w.path}`), [`PATCH ${POLICIES}/ca-1`]);
  assert.equal(graph.objects.get(`${POLICIES}/ca-1`).state, ENFORCED);
  assert.equal(graph.objects.get(`${POLICIES}/ca-1`).id, 'ca-1', 'the restored id is kept');

  // The step is closed with a reference to the approved run, and journaled for compensation.
  const [item] = await listCompletionItems(client, { tenantRef: TENANT, restoreRef: restoreId });
  assert.equal(item.state, 'verified');
  assert.match(item.evidence[0].reference, new RegExp(enforcementId));
  assert.match(item.evidence[0].note, /approved by approver/);
  const [entry] = await listJournal(client, { restoreRef: enforcementId });
  assert.deepEqual([entry.operation, entry.outcome, entry.priorState.state, entry.intendedState.state], ['update', 'succeeded', REPORT_ONLY, ENFORCED]);

  // Done once: the step cannot be planned again.
  await assert.rejects(planEnforcement(run, restoreId, crypto.randomUUID()), /already closed/);
});

test('promotion is refused when a break-glass account would be blocked or readiness is unknown, at the dry run and again at execution', async (t) => {
  const client = await schemaClient(t);
  const { graph, world, run, restoreId } = await restoredThroughCli(client);
  const writesAfterRestore = graph.writes.length;

  for (const gateOptions of [{ accountIds: [BG1, BG2, BG3] }, { caCovered: false }]) {
    world.gate = gateOptions;
    const refusedId = crypto.randomUUID();
    const refused = await planEnforcement(run, restoreId, refusedId);
    assert.equal(refused.status, 'refused', JSON.stringify(gateOptions));
    assert.match(refused.results.skipped[0].reason, /^break-glass lockout gate: /);
    const validation = validateArtifactForApproval(await getDryRunArtifactById(client, { id: refusedId }));
    assert.equal(validation.ok, false, 'a refused step can never be approved');
  }

  // Ready at review and approval, not at execution: the gate runs again and refuses.
  world.gate = {};
  const enforcementId = crypto.randomUUID();
  assert.equal((await planEnforcement(run, restoreId, enforcementId)).status, 'completed');
  const request = await requestApproval(client, { tenantRef: TENANT, action: 'restore', params: { artifactId: enforcementId }, requestedBy: 'requester' });
  await approveRequest(client, { tenantRef: TENANT, id: request.id, decidedBy: 'approver' });
  world.gate = { accountIds: [BG1, BG2, BG3] };
  await assert.rejects(run({ artifactId: enforcementId, mode: 'enforce' }), /enforcement promotion refused: break-glass lockout gate/);

  // A policy changed after review refuses too.
  world.gate = {};
  graph.objects.set(`${POLICIES}/ca-1`, { ...graph.objects.get(`${POLICIES}/ca-1`), grantControls: { operator: 'OR', builtInControls: ['block'] } });
  await assert.rejects(run({ artifactId: enforcementId, mode: 'enforce' }), /enforcement promotion refused: (the target has changed|the recomputed restore plan no longer matches)/);

  assert.equal(graph.writes.length, writesAfterRestore, 'nothing was written by any refused step');
  assert.equal(graph.objects.get(`${POLICIES}/ca-1`).state, REPORT_ONLY);
  const [item] = await listCompletionItems(client, { tenantRef: TENANT, restoreRef: restoreId });
  assert.equal(item.state, 'pending', 'the step stays open');
});
