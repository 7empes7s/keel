/**
 * Roadmap task-94 boundary tests: emergency (break-glass) account readiness and the
 * usage canary. Exercises engine/safety/breakGlassReadiness.mjs over collected
 * inventory in the isolated test database, task-88 audit ingestion (with its fixture
 * read-only adapter) feeding task-91 minimized facts, and the task-82/83 alert
 * lifecycle. Fixture-tested only: no Microsoft call is made.
 *
 * Acceptance:
 *  - a Conditional Access exclusion alone cannot make readiness pass;
 *  - unknown credential evidence stays unknown;
 *  - usage creates a correlated alert;
 *  - a stale validation becomes due;
 *  - an unsupported policy surface is visible.
 *
 * Required mutation checks (each must fail a test here):
 *  - Collapse readiness to the CA exclusion boolean.
 *  - Assume an absent method means secure.
 *  - Suppress the emergency-account usage event.
 */
import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import { grantRole } from '../authz/administration.mjs';
import { createFixtureAuditAdapter, ingestAudit, migrateAuditIngestion } from '../identity/auditIngest.mjs';
import { acknowledgeAlert, resolveAlert } from '../notify/alerts.mjs';
import { createEscalationRule } from '../notify/escalation.mjs';
import { assertBreakGlassCoverage, policyTreatment } from '../safety/breakGlassInvariant.mjs';
import {
  BREAKGLASS_CONTROL, BreakGlassAuthorizationError, GLOBAL_ADMINISTRATOR, USAGE_CONDITION, VALIDATION_DUE_CONDITION,
  createFixtureMethodReader, evaluateAccountReadiness, loadBreakGlassReadiness, observeBreakGlassMethods,
  recordBreakGlassLifecycle, registerBreakGlassAccount, retireBreakGlassAccount, runBreakGlassCanary, sweepBreakGlassCanaries,
} from '../safety/breakGlassReadiness.mjs';
import { createIsolatedTestDatabase } from '../test/dbTestHelper.mjs';
import { main } from '../../cli/keel-breakglass.mjs';

const A = 'tenant-bg-a';
const B = 'tenant-bg-b';
const DAY = 86400000;
const HOUR = 3600000;
const NOW = Date.now();
const at = (offsetMs) => new Date(NOW + offsetMs);
const iso = (offsetMs) => at(offsetMs).toISOString();

const ID = {
  bg1: 'b9000000-0000-4000-8000-000000000001',
  bg2: 'b9000000-0000-4000-8000-000000000002',
  admin: 'a0000000-0000-4000-8000-0000000000ad',
  synced: 'b9000000-0000-4000-8000-0000000000aa',
  exclusionGroup: 'e9000000-0000-4000-8000-0000000000e1',
  target: 'c9000000-0000-4000-8000-0000000000c1',
};
const EMAILS = { bg1: 'bg1@contoso.onmicrosoft.com', bg2: 'bg2@contoso.onmicrosoft.com' };

const user = (id, upn, extra = {}) => ({
  naturalKey: `user:${upn}`, type: 'user',
  payload: { id, userPrincipalName: upn, accountEnabled: true, userType: 'Member', onPremisesSyncEnabled: null, ...extra },
});
const ga = (principalId) => ({
  naturalKey: `roleAssignment:GlobalAdministrator@${principalId}@/`, type: 'roleAssignment',
  payload: { id: `ra-${principalId}`, principalId, roleDefinitionId: GLOBAL_ADMINISTRATOR, directoryScopeId: '/' },
});
const ca = (name, users, state = 'enabled', extra = {}) => ({
  naturalKey: `conditionalAccessPolicy:${name}`, type: 'conditionalAccessPolicy',
  payload: { id: `ca-${name}`, displayName: name, state, conditions: { users, ...extra }, grantControls: { builtInControls: ['mfa'] } },
});
const methodsPolicy = (fido2State = 'enabled') => ({
  naturalKey: 'authenticationMethodsPolicy:Authentication Methods Policy', type: 'authenticationMethodsPolicy',
  payload: { id: 'authenticationMethodsPolicy', authenticationMethodConfigurations: [{ id: 'Fido2', state: fido2State }, { id: 'X509Certificate', state: 'disabled' }] },
});
const domain = (name, authenticationType) => ({ naturalKey: `domain:${name}`, type: 'domain', payload: { id: name, authenticationType } });

/** The healthy baseline inventory: two cloud-only GA accounts excluded from every enforced policy. */
function healthyInventory() {
  return [
    user(ID.bg1, EMAILS.bg1), user(ID.bg2, EMAILS.bg2), user(ID.admin, 'admin@contoso.com'),
    domain('contoso.onmicrosoft.com', 'Managed'), domain('contoso.com', 'Federated'),
    ga(ID.bg1), ga(ID.bg2),
    ca('Require MFA for all', { includeUsers: ['All'], excludeUsers: [ID.bg1, ID.bg2] }),
    ca('Block legacy auth', { includeUsers: ['All'], excludeUsers: [ID.bg1, ID.bg2] }),
    ca('Report only risk', { includeUsers: ['All'] }, 'enabledForReportingButNotEnforced', { signInRiskLevels: ['high'] }),
    ca('Old policy', { includeUsers: ['All'] }, 'disabled'),
    methodsPolicy(),
  ];
}
const ALL_TYPES = ['user', 'domain', 'roleAssignment', 'conditionalAccessPolicy', 'authenticationMethodsPolicy', 'roleEligibilitySchedule'];

async function setup(t) {
  const db = await createIsolatedTestDatabase(import.meta.url);
  const client = await db.connect();
  t.after(async () => { await client.end(); await db.cleanup(); });
  const schema = readFileSync(new URL('../store/schema.sql', import.meta.url), 'utf8');
  await client.query(schema);
  await client.query(schema); // retry-safe

  const unique = `${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
  const principal = async (name, roles) => {
    const { rows: [row] } = await client.query('INSERT INTO principal(email) VALUES ($1) RETURNING *', [`${name}-${unique}@example.invalid`]);
    for (const role of roles) await grantRole(client, { principalId: row.id, role, grantedBy: 'fixture', activeFrom: new Date(Date.now() - 60_000) });
    return row;
  };
  const p = {
    admin: await principal('bg-admin', ['admin', 'viewer']),
    operator: await principal('bg-operator', ['operator', 'viewer', 'admin']),
    viewer: await principal('bg-viewer', ['viewer']),
  };

  /** A completed collection of `types` (legacy positive counts are covered). */
  const collect = async (tenantRef, resources, { types = ALL_TYPES, completedAt = at(-HOUR) } = {}) => {
    const digest = Object.fromEntries(types.map((type) => [type, Math.max(1, resources.filter((r) => r.type === type).length)]));
    const { rows: [snapshot] } = await client.query(
      `INSERT INTO snapshot (tenant_ref, status, started_at, completed_at, coverage_digest) VALUES ($1,'complete',$2,$2,$3) RETURNING id`,
      [tenantRef, completedAt, digest],
    );
    for (const resource of resources.filter((r) => types.includes(r.type))) {
      await client.query(
        `INSERT INTO resource_version (snapshot_id, natural_key, resource_type, payload, payload_hash, criticality, blast_radius, fidelity, provenance)
         VALUES ($1,$2,$3,$4,'fixture','tier1','access-affecting','full','{}')`,
        [snapshot.id, resource.naturalKey, resource.type, resource.payload],
      );
    }
    return snapshot.id;
  };
  const register = async (tenantRef, name, extra = {}) => registerBreakGlassAccount(client, {
    tenantRef, actor: p.admin.id, accountId: ID[name], label: EMAILS[name], validationIntervalDays: 90, ...extra,
  });
  const lifecycle = (tenantRef, name, kind, extra = {}) => recordBreakGlassLifecycle(client, {
    tenantRef, actor: p.admin.id, accountId: ID[name], kind, ...extra,
  });
  const readiness = (tenantRef = A, now = at(0)) => loadBreakGlassReadiness(client, { tenantRef, now });
  const ingest = async (tenantRef, source, events, window = { from: iso(-10 * DAY), until: iso(0) }) => {
    await migrateAuditIngestion(client);
    return ingestAudit(client, {
      tenantRef, managedTenantRef: tenantRef, requestedBy: p.operator.id, source, enabled: true,
      from: window.from, until: window.until, retentionDays: 30, maxRequests: 5, maxEvents: 100, maxDurationMs: 5000, pageSize: 50,
      adapter: createFixtureAuditAdapter({ tenantRef, pages: [{ events, nextCursor: null }] }),
    });
  };
  return { client, p, collect, register, lifecycle, readiness, ingest };
}

/** Both accounts registered, recently tested, with the healthy inventory collected. */
async function readyTenant(t) {
  const ctx = await setup(t);
  await ctx.collect(A, healthyInventory());
  for (const name of ['bg1', 'bg2']) {
    await ctx.register(A, name);
    await ctx.lifecycle(A, name, 'validated', { occurredAt: at(-10 * DAY), note: 'quarterly emergency sign-in test' });
  }
  return ctx;
}

test('a Conditional Access exclusion alone never makes an emergency account ready', async (t) => {
  const ctx = await readyTenant(t);
  let report = await ctx.readiness();
  const [bg1] = report.accounts;
  // Excluded from every enforced policy, active GA, cloud-only and recently tested ...
  assert.equal(bg1.dimensions.policyExclusions.status, 'pass');
  assert.equal(bg1.dimensions.policyExclusions.reason, 'excluded-from-every-enforced-policy');
  assert.equal(bg1.dimensions.cloudOnlyIdentity.status, 'pass');
  assert.equal(bg1.dimensions.privilegedAccessPath.status, 'pass');
  assert.equal(bg1.dimensions.lastValidation.status, 'pass');
  // ... but no credential evidence: never ready.
  assert.equal(bg1.dimensions.phishingResistantCredential.status, 'unknown');
  assert.equal(bg1.overall, 'unknown');
  assert.notEqual(report.overall, 'ready');

  // A password and an app notification are not phishing resistant.
  for (const name of ['bg1', 'bg2']) await ctx.lifecycle(A, name, 'methods-attested', { methods: ['password', 'microsoftAuthenticator'] });
  report = await ctx.readiness();
  assert.equal(report.accounts[0].dimensions.policyExclusions.status, 'pass');
  assert.deepEqual([report.accounts[0].dimensions.phishingResistantCredential.status, report.accounts[0].overall], ['fail', 'not-ready']);
  assert.equal(report.overall, 'not-ready');

  // Every dimension passing is what makes the account ready.
  for (const name of ['bg1', 'bg2']) await ctx.lifecycle(A, name, 'methods-attested', { methods: ['fido2', 'password'] });
  report = await ctx.readiness();
  assert.deepEqual(report.accounts.map((account) => account.overall), ['ready', 'ready']);
  assert.equal(report.accounts[0].dimensions.phishingResistantCredential.evidence.basis, 'attested');
  assert.equal(report.overall, 'ready');

  // The other dimensions each still veto: an eligible-only role, a synced or disabled
  // account, an enforced policy that reaches the account.
  const fail = (inventory, name = 'bg1') => evaluateAccountReadiness({
    account: report.accounts.find((account) => account.accountId === ID[name]), inventory, now: at(0),
  });
  const inventoryOf = (resources) => Object.fromEntries(ALL_TYPES.map((type) => [type, { status: 'covered', observedAt: iso(-HOUR), resources: resources.filter((r) => r.type === type) }]));
  const healthy = healthyInventory();
  const eligibleOnly = inventoryOf([...healthy.filter((r) => !(r.type === 'roleAssignment' && r.payload.principalId === ID.bg1)),
    { naturalKey: 'roleEligibilitySchedule:ga-bg1', type: 'roleEligibilitySchedule', payload: { principalId: ID.bg1, roleDefinitionId: GLOBAL_ADMINISTRATOR } }]);
  let verdict = fail(eligibleOnly);
  assert.deepEqual([verdict.dimensions.privilegedAccessPath.reason, verdict.overall], ['eligible-only-needs-activation', 'not-ready']);
  verdict = fail(inventoryOf(healthy.map((r) => (r.payload.id === ID.bg1 ? user(ID.bg1, EMAILS.bg1, { onPremisesSyncEnabled: true }) : r))));
  assert.deepEqual([verdict.dimensions.cloudOnlyIdentity.reason, verdict.overall], ['synchronized-from-on-premises', 'not-ready']);
  verdict = fail(inventoryOf(healthy.map((r) => (r.payload.id === ID.bg1 ? user(ID.bg1, EMAILS.bg1, { accountEnabled: false }) : r))));
  assert.equal(verdict.dimensions.cloudOnlyIdentity.reason, 'account-disabled');
  // An account on a federated domain depends on the federation service.
  verdict = fail(inventoryOf(healthy.map((r) => (r.payload.id === ID.bg1 ? user(ID.bg1, 'bg1@contoso.com') : r))));
  assert.equal(verdict.dimensions.cloudOnlyIdentity.reason, 'federated-domain');
  // A sync flag that was not collected is not evidence of a cloud-only account.
  const unsynced = user(ID.bg1, EMAILS.bg1);
  delete unsynced.payload.onPremisesSyncEnabled;
  verdict = fail(inventoryOf(healthy.map((r) => (r.payload.id === ID.bg1 ? unsynced : r))));
  assert.deepEqual([verdict.dimensions.cloudOnlyIdentity.status, verdict.overall], ['unknown', 'unknown']);
  verdict = fail(inventoryOf([...healthy, ca('New admin policy', { includeRoles: [GLOBAL_ADMINISTRATOR] })]));
  assert.deepEqual([verdict.dimensions.policyExclusions.status, verdict.overall], ['fail', 'not-ready']);
  assert.ok(verdict.dimensions.policyExclusions.evidence.policies.some((entry) => entry.policy === 'conditionalAccessPolicy:New admin policy' && entry.treatment === 'applies'));

  // Fewer than two accounts is never ready (spec §10.4 precondition), and retiring one
  // takes it out of the count but keeps its history.
  await retireBreakGlassAccount(ctx.client, { tenantRef: A, actor: ctx.p.admin.id, accountId: ID.bg2, reason: 'replaced' });
  report = await ctx.readiness();
  assert.deepEqual([report.accounts.length, report.overall, report.reason], [1, 'not-ready', 'fewer-than-two-accounts']);
  const { rows: [{ count }] } = await ctx.client.query("SELECT count(*)::int FROM breakglass_lifecycle_event WHERE account_id = $1", [ID.bg2]);
  assert.equal(count, 3, 'its test and both method records are kept');
  // The pre-existing restore invariant is unchanged.
  assert.equal(assertBreakGlassCoverage({ breakGlassUserIds: [ID.bg1], caPoliciesInRestoreSet: [] }).ok, false);
});

test('unknown credential evidence stays unknown', async (t) => {
  const ctx = await readyTenant(t);
  let [bg1] = (await ctx.readiness()).accounts;
  assert.deepEqual([bg1.dimensions.phishingResistantCredential.status, bg1.dimensions.phishingResistantCredential.reason], ['unknown', 'no-method-evidence']);

  // A failed or refused read records nothing: still unknown, never "nothing registered".
  const reader = createFixtureMethodReader({
    tenantRef: A,
    methods: { [ID.bg1]: Object.assign(new Error('forbidden'), { status: 403 }), [ID.bg2]: ['fido2'] },
  });
  const observed = await observeBreakGlassMethods(ctx.client, { tenantRef: A, managedTenantRef: A, requestedBy: ctx.p.operator.id, adapter: reader, now: at(0) });
  assert.deepEqual(observed.map((entry) => entry.status), ['read-scope-revoked', 'observed']);
  const report = await ctx.readiness();
  [bg1] = report.accounts;
  const bg2 = report.accounts[1];
  assert.equal(bg1.dimensions.phishingResistantCredential.status, 'unknown');
  assert.deepEqual([bg2.dimensions.phishingResistantCredential.status, bg2.dimensions.phishingResistantCredential.evidence.basis], ['pass', 'observed']);
  // The reader must be the tenant's read-only collector reader.
  await assert.rejects(observeBreakGlassMethods(ctx.client, { tenantRef: A, managedTenantRef: A, requestedBy: ctx.p.operator.id, adapter: { ...reader, tenantRef: B } }), /read-only method reader/);

  // A registered FIDO2 key whose tenant method policy was not collected is unknown,
  // and one switched off there fails.
  const account = { ...bg2 };
  const base = Object.fromEntries(ALL_TYPES.map((type) => [type, { status: 'covered', observedAt: iso(-HOUR), resources: healthyInventory().filter((r) => r.type === type) }]));
  let verdict = evaluateAccountReadiness({ account, inventory: { ...base, authenticationMethodsPolicy: { status: 'unavailable', resources: [] } }, now: at(0) });
  assert.deepEqual([verdict.dimensions.phishingResistantCredential.reason, verdict.overall], ['method-policy-unavailable', 'unknown']);
  verdict = evaluateAccountReadiness({ account, inventory: { ...base, authenticationMethodsPolicy: { status: 'covered', resources: [methodsPolicy('disabled')] } }, now: at(0) });
  assert.deepEqual([verdict.dimensions.phishingResistantCredential.reason, verdict.overall], ['method-disabled-by-tenant-policy', 'not-ready']);
  // An empty method list is a fact (nothing phishing resistant); absence is not.
  verdict = evaluateAccountReadiness({ account: { ...account, methodEvidence: { basis: 'observed', methods: [] } }, inventory: base, now: at(0) });
  assert.equal(verdict.dimensions.phishingResistantCredential.status, 'fail');
  verdict = evaluateAccountReadiness({ account: { ...account, methodEvidence: null }, inventory: base, now: at(0) });
  assert.equal(verdict.dimensions.phishingResistantCredential.status, 'unknown');

  // An excluded group whose membership was not read is not assumed to hold the account.
  const viaGroup = ca('Require compliant device', { includeUsers: ['All'], excludeGroups: [ID.exclusionGroup] });
  assert.equal(policyTreatment(viaGroup.payload, ID.bg1).treatment, 'unknown');
  assert.equal(policyTreatment(viaGroup.payload, ID.bg1, { groupMembers: () => true }).treatment, 'excluded');
  assert.equal(policyTreatment(viaGroup.payload, ID.bg1, { groupMembers: () => false }).treatment, 'applies');
  await ctx.collect(A, [...healthyInventory(), viaGroup], { completedAt: at(-30 * 60 * 1000) });
  let exclusion = (await ctx.readiness()).accounts[0].dimensions.policyExclusions;
  assert.deepEqual([exclusion.status, exclusion.reason], ['unknown', 'policy-treatment-unknown']);
  // A complete transitive membership read that lists the account settles it.
  const { rows: [snap] } = await ctx.client.query("SELECT id FROM snapshot WHERE tenant_ref = $1 ORDER BY completed_at DESC LIMIT 1", [A]);
  const { rows: [set] } = await ctx.client.query(
    `INSERT INTO relationship_edge_set (snapshot_id, tenant_ref, parent_type, parent_source_id, family, edge_type, direction, outcome, completed_at)
     VALUES ($1,$2,'group',$3,'transitiveMember','transitiveMember','transitive','complete',now()) RETURNING id`,
    [snap.id, A, ID.exclusionGroup],
  );
  await ctx.client.query('INSERT INTO relationship_edge (set_id, tenant_ref, target_source_id, edge_key) VALUES ($1,$2,$3,$3)', [set.id, A, ID.bg1]);
  exclusion = (await ctx.readiness()).accounts[0].dimensions.policyExclusions;
  assert.equal(exclusion.status, 'pass');
});

test('emergency-account usage opens one correlated alert per account', async (t) => {
  const ctx = await readyTenant(t);
  const { client, p } = ctx;
  await createEscalationRule(client, { tenantRef: A, control: BREAKGLASS_CONTROL, ackWithinMs: 15 * 60 * 1000, ownerPrincipalId: p.operator.id, createdBy: p.admin.id });

  // Before any audit log: the canary is not watching, and says so.
  let report = await ctx.readiness();
  assert.equal(report.canary.status, 'not-configured');

  await ctx.ingest(A, 'sign-in', [
    { id: 'si-bg1-1', occurredAt: iso(-3 * HOUR), actor: { kind: 'user', id: ID.bg1 } },
    { id: 'si-admin', occurredAt: iso(-3 * HOUR), actor: { kind: 'user', id: ID.admin } },
  ]);
  await ctx.ingest(A, 'audit', [
    { id: 'au-bg1-change', occurredAt: iso(-2 * HOUR), change: { targetType: 'conditionalAccessPolicy', targetId: ID.target, operation: 'Update', activity: 'Update conditional access policy', fields: ['state'], actorKind: 'user', actorId: ID.bg1 } },
    { id: 'au-admin-change', occurredAt: iso(-2 * HOUR), change: { targetType: 'group', targetId: ID.target, operation: 'Update', fields: ['description'], actorKind: 'user', actorId: ID.admin } },
  ]);
  // Tenant B's sign-in by the same object id never alerts tenant A.
  await ctx.ingest(B, 'sign-in', [{ id: 'si-b-bg1', occurredAt: iso(-HOUR), actor: { kind: 'user', id: ID.bg1 } }]);

  const first = await runBreakGlassCanary(client, { tenantRef: A, now: at(0) });
  assert.equal(first.usage.length, 1, 'one sign-in explains the change it made; the admin is not an emergency account');
  const { rows: alerts } = await client.query('SELECT * FROM alert WHERE control = $1 AND condition = $2', [BREAKGLASS_CONTROL, USAGE_CONDITION]);
  assert.equal(alerts.length, 1);
  const [alert] = alerts;
  assert.deepEqual([alert.tenant_ref, alert.resource_key, alert.state, alert.severity], [A, `user:${EMAILS.bg1}`, 'open', 'critical']);
  // Correlated: the audit sign-in, the change the account made after it, a correlation id.
  assert.equal(alert.detail.auditEventId, 'si-bg1-1');
  assert.equal(alert.detail.correlationId, `breakglass:${ID.bg1}:si-bg1-1`);
  assert.deepEqual(alert.detail.changes.map((change) => [change.auditEventId, change.targetType, change.operation]), [['au-bg1-change', 'conditionalAccessPolicy', 'update']]);
  assert.equal(alert.detail.expectedTest, false);
  // Task 83: the occurrence has its acknowledgement deadline and owner.
  assert.equal(alert.owner_principal_id, p.operator.id);
  assert.ok(alert.ack_deadline_at);
  assert.equal(new Date(alert.ack_deadline_at).getTime(), new Date(alert.occurrence_started_at).getTime() + 15 * 60 * 1000);

  // Re-running is idempotent; a second use updates the same alert.
  const again = await runBreakGlassCanary(client, { tenantRef: A, now: at(0) });
  assert.ok(again.usage.every((entry) => entry.duplicate));
  await ctx.ingest(A, 'sign-in', [{ id: 'si-bg1-2', occurredAt: iso(500), actor: { kind: 'user', id: ID.bg1 } }], { from: iso(0), until: iso(1000) });
  await runBreakGlassCanary(client, { tenantRef: A, now: at(2000) });
  const { rows: [updated] } = await client.query('SELECT * FROM alert WHERE id = $1', [alert.id]);
  assert.deepEqual([updated.firing_count, updated.detail.auditEventId, updated.occurrence], [2, 'si-bg1-2', 1]);

  // Acknowledging does not clear it; an operator resolves it after review, and the
  // next use reopens it as a new occurrence.
  await acknowledgeAlert(client, { tenantRef: A, alertId: alert.id, actor: p.operator.id });
  await resolveAlert(client, { tenantRef: A, alertId: alert.id, actor: p.operator.id, reason: 'reviewed with the on-call lead' });
  // A recorded sign-in test still alerts (the canary is proven by every test), as a warning.
  await ctx.lifecycle(A, 'bg1', 'validated', { occurredAt: at(5000) });
  await ctx.ingest(A, 'sign-in', [{ id: 'si-bg1-test', occurredAt: iso(4000), actor: { kind: 'user', id: ID.bg1 } }], { from: iso(1000), until: iso(6000) });
  await runBreakGlassCanary(client, { tenantRef: A, now: at(7000) });
  const { rows: [reopened] } = await client.query('SELECT * FROM alert WHERE id = $1', [alert.id]);
  assert.deepEqual([reopened.state, reopened.occurrence, reopened.severity, reopened.detail.expectedTest], ['reopened', 2, 'warning', true]);

  // No tenant B alert, though B saw the same object id sign in (it is not registered there).
  const { rows: [{ count }] } = await client.query('SELECT count(*)::int FROM alert WHERE tenant_ref = $1', [B]);
  assert.equal(count, 0);

  // The readiness report shows the canary watching and the alert.
  report = await ctx.readiness(A, at(7000));
  assert.equal(report.canary.status, 'watching');
  assert.ok(report.alerts.some((entry) => entry.id === alert.id && entry.condition === USAGE_CONDITION));

  // The worker sweep runs as the scheduler principal and is a no-op on repeat.
  await client.query("INSERT INTO principal (email, system_kind) VALUES ('scheduler@keel.local', 'scheduler') ON CONFLICT DO NOTHING");
  const swept = await sweepBreakGlassCanaries(client, { now: at(7000), log: () => {} });
  assert.ok(swept[A].usage.every((entry) => entry.duplicate));
});

test('a stale validation becomes due and raises a reminder that a new test clears', async (t) => {
  const ctx = await setup(t);
  await ctx.collect(A, healthyInventory());
  await ctx.register(A, 'bg1', { rotationIntervalDays: 180 });
  await ctx.register(A, 'bg2');
  for (const name of ['bg1', 'bg2']) await ctx.lifecycle(A, name, 'methods-attested', { methods: ['fido2'] });
  await ctx.lifecycle(A, 'bg1', 'validated', { occurredAt: at(-100 * DAY) });
  await ctx.lifecycle(A, 'bg1', 'credential-rotated', { occurredAt: at(-10 * DAY) });

  let report = await ctx.readiness();
  const [bg1, bg2] = report.accounts;
  assert.deepEqual([bg1.dimensions.lastValidation.status, bg1.dimensions.lastValidation.reason], ['due', 'validation-overdue']);
  assert.equal(bg1.dimensions.lastValidation.evidence.dueSince, iso(-10 * DAY));
  assert.deepEqual([bg2.dimensions.lastValidation.status, bg2.dimensions.lastValidation.reason], ['due', 'never-validated']);
  assert.deepEqual([bg1.overall, report.overall], ['not-ready', 'not-ready']);
  assert.deepEqual(bg1.reminders.map((reminder) => [reminder.kind, reminder.status]), [['validation', 'due'], ['rotation', 'scheduled']]);
  // A future-dated record is refused rather than postponing the reminder.
  await assert.rejects(ctx.lifecycle(A, 'bg1', 'validated', { occurredAt: at(2 * DAY), now: at(0) }), /past instant/);

  const canary = await runBreakGlassCanary(ctx.client, { tenantRef: A, now: at(0) });
  assert.equal(canary.status, 'audit-not-configured');
  const { rows: due } = await ctx.client.query(
    'SELECT resource_key, state, detail FROM alert WHERE control = $1 AND condition = $2 ORDER BY resource_key', [BREAKGLASS_CONTROL, VALIDATION_DUE_CONDITION],
  );
  assert.deepEqual(due.map((row) => [row.resource_key, row.state]), [[`user:${EMAILS.bg1}`, 'open'], [`user:${EMAILS.bg2}`, 'open']]);
  assert.equal(due[0].detail.dueAt, iso(-10 * DAY));

  // A new test resolves bg1's reminder; the readiness dimension passes again.
  await ctx.lifecycle(A, 'bg1', 'validated', { occurredAt: at(-60_000) });
  await runBreakGlassCanary(ctx.client, { tenantRef: A, now: at(1000) });
  const { rows: after } = await ctx.client.query(
    'SELECT resource_key, state FROM alert WHERE control = $1 AND condition = $2 ORDER BY resource_key', [BREAKGLASS_CONTROL, VALIDATION_DUE_CONDITION],
  );
  assert.deepEqual(after.map((row) => row.state), ['resolved', 'open']);
  report = await ctx.readiness(A, at(1000));
  assert.equal(report.accounts[0].dimensions.lastValidation.status, 'pass');
  // Ninety days on, the same test is stale again.
  report = await ctx.readiness(A, at(91 * DAY));
  assert.equal(report.accounts[0].dimensions.lastValidation.status, 'due');
});

test('unsupported and unread policy surfaces stay visible next to the verdict', async (t) => {
  const ctx = await readyTenant(t);
  for (const name of ['bg1', 'bg2']) await ctx.lifecycle(A, name, 'methods-attested', { methods: ['windowsHelloForBusiness'] });
  let report = await ctx.readiness();
  assert.equal(report.overall, 'ready');
  const byId = Object.fromEntries(report.surfaces.map((surface) => [surface.surface, surface]));
  for (const id of ['roleActivationRules', 'identityProtectionRiskPolicies', 'securityDefaults', 'applicationAccessRestrictions']) {
    assert.equal(byId[id].status, 'unsupported', id);
    assert.ok(byId[id].reason);
  }
  assert.equal(byId.conditionalAccess.status, 'evaluated');
  assert.deepEqual([byId.conditionalAccessRiskConditions.status, byId.conditionalAccessRiskConditions.policies], ['evaluated', 1]);
  // Report-only policies are listed, not counted as enforced.
  assert.ok(report.accounts[0].dimensions.policyExclusions.evidence.policies.some((entry) => entry.treatment === 'report-only'));

  // A newer collection that did not cover Conditional Access makes the surface and the
  // dimension unknown; it never falls back to "no policy applies".
  await ctx.collect(A, healthyInventory(), { types: ALL_TYPES.filter((type) => type !== 'conditionalAccessPolicy'), completedAt: at(-60_000) });
  await ctx.client.query(
    `UPDATE snapshot SET coverage_digest = coverage_digest || '{"conditionalAccessPolicy": {"outcome": "failed"}}'::jsonb
      WHERE tenant_ref = $1 AND completed_at = (SELECT max(completed_at) FROM snapshot WHERE tenant_ref = $1)`, [A],
  );
  report = await ctx.readiness();
  const surfaces = Object.fromEntries(report.surfaces.map((surface) => [surface.surface, surface]));
  assert.deepEqual([surfaces.conditionalAccess.status, surfaces.conditionalAccess.reason], ['unknown', 'evidence-unavailable']);
  assert.equal(report.accounts[0].dimensions.policyExclusions.status, 'unknown');
  assert.equal(report.overall, 'unknown');
});

test('the keel-breakglass command registers, records and reports through the same engine', async (t) => {
  const ctx = await setup(t);
  await ctx.collect(A, healthyInventory());
  const output = [];
  const run = (argv) => main({
    argv: [...argv, '--tenant-ref', A, '--db-url', 'postgres://fixture'],
    connectFn: async () => ({ query: (...args) => ctx.client.query(...args), end: async () => {} }),
    logger: { log: (line) => output.push(line) },
    now: () => at(0),
  });
  assert.equal(await run(['bogus']), 2);
  for (const name of ['bg1', 'bg2']) {
    assert.equal(await run(['register', '--actor', ctx.p.admin.id, '--account-id', ID[name], '--label', EMAILS[name], '--rotation-days', '180']), 0);
    assert.equal(await run(['record', '--actor', ctx.p.admin.id, '--account-id', ID[name], '--kind', 'validated', '--at', iso(-DAY), '--note', 'tested from the safe']), 0);
  }
  // Without method evidence the report is not ready, and exits 1.
  assert.equal(await run(['report']), 1);
  assert.equal(JSON.parse(output.at(-1)).overall, 'unknown');
  for (const name of ['bg1', 'bg2']) {
    assert.equal(await run(['record', '--actor', ctx.p.admin.id, '--account-id', ID[name], '--kind', 'methods-attested', '--methods', 'fido2, password']), 0);
  }
  assert.equal(await run(['report']), 0);
  const report = JSON.parse(output.at(-1));
  assert.equal(report.overall, 'ready');
  assert.ok(report.surfaces.some((surface) => surface.status === 'unsupported'));
  // A viewer cannot register through the command either.
  await assert.rejects(run(['register', '--actor', ctx.p.viewer.id, '--account-id', ID.bg1, '--label', 'x']), BreakGlassAuthorizationError);
  assert.equal(await run(['canary']), 0);
  assert.equal(JSON.parse(output.at(-1)).status, 'audit-not-configured');
});

test('lifecycle writes need a configuration grant; a legacy install reads as not configured', async (t) => {
  const ctx = await setup(t);
  await assert.rejects(
    registerBreakGlassAccount(ctx.client, { tenantRef: A, actor: ctx.p.viewer.id, accountId: ID.bg1, label: EMAILS.bg1 }),
    BreakGlassAuthorizationError,
  );
  await assert.rejects(ctx.register(A, 'bg1', { label: 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.c2lnbmF0dXJlc2lnbmF0dXJl' }), /plain name/);
  await assert.rejects(registerBreakGlassAccount(ctx.client, { tenantRef: A, actor: ctx.p.admin.id, accountId: 'bg1', label: 'bg1' }), /object id/);
  await assert.rejects(ctx.lifecycle(A, 'bg1', 'validated'), /no active emergency account/);
  await ctx.register(A, 'bg1');
  await assert.rejects(ctx.lifecycle(A, 'bg1', 'methods-attested', { methods: ['fido2', 'magic-link'] }), /unknown method kind/);
  // Evidence records each registration.
  const { rows: evidence } = await ctx.client.query("SELECT kind FROM evidence WHERE tenant_ref = $1 ORDER BY seq", [A]);
  assert.deepEqual(evidence.map((row) => row.kind), ['breakglass.registered']);
  // Lifecycle events are append-only.
  await ctx.lifecycle(A, 'bg1', 'validated', { occurredAt: at(-DAY) });
  await assert.rejects(ctx.client.query("UPDATE breakglass_lifecycle_event SET occurred_at = now()"), /append-only/);
  await assert.rejects(ctx.client.query("DELETE FROM breakglass_lifecycle_event"), /append-only/);

  // No accounts registered in tenant B: not configured, never ready.
  assert.deepEqual([(await ctx.readiness(B)).overall, (await ctx.readiness(B)).reason], ['not-configured', 'no-accounts-registered']);
  // A database from before task 94.
  await ctx.client.query('DROP TABLE breakglass_lifecycle_event; DROP TABLE breakglass_account');
  const legacy = await ctx.readiness(A);
  assert.deepEqual([legacy.overall, legacy.configured, legacy.canary.status], ['not-configured', false, 'not-configured']);
  assert.equal((await runBreakGlassCanary(ctx.client, { tenantRef: A })).status, 'not-configured');
  assert.equal(await sweepBreakGlassCanaries(ctx.client, { log: () => {} }), null);
});
