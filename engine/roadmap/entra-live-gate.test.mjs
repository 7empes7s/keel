// Issue #148: the Entra live gate, end to end, with fixtures only. No tenant,
// no Graph, no database: the restore artifact and its rollback journal are
// in-memory fixtures shaped like the rows keel-restore writes.
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { CATALOG } from '../../tools/tenant-probe/catalog.mjs';
import {
  EDGE_OPERATIONS, OPERATIONS, capabilityFor, edgeCapabilityKey, isSupportedClaim, recordFixtureProof, registerOperationCapability,
} from '../coverage/capabilities.mjs';
import { TYPE_DECISIONS, buildOperationLedger } from '../coverage/qualification.mjs';
import { ENFORCEMENT_STEP } from '../restore/conditionalAccessEnforcement.mjs';
import { tenantRefFor } from '../store/tenantRef.mjs';
import {
  ENTRA_LIVE_KIND, LiveGateRefusal, TEST_TENANT_REFS, applyCommittedEvidence, byReferenceProblems, captureLive, captureOffline,
  demotionRecord, main as entraLiveMain, nameFieldsFor, namesFixture, promoteRecord, unappliedDemotions, verifiedOutcome,
} from '../../tools/qualification/entraLive.mjs';
import { FIXTURE_PAYLOADS } from '../../tools/qualification/operations.mjs';
import {
  FIXTURE_GUIDANCE, buildLiveGatePlan, guidanceFor, main as planMain, renderMarkdown,
} from '../../tools/qualification/live-gate-plan.mjs';
import { guidToCloudSid, unpseudonymizedIds } from '../../tools/qualification/pseudonymize.mjs';

// The three break-glass lines every lockout-sensitive step shares.
const BREAK_GLASS_COMMON_COUNT = 3;

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
// A made-up directory id standing in for the test tenant; it names no real tenant.
const FIXTURE_TENANT_ID = '11111111-2222-4333-8444-555555555555';
const FIXTURE_TENANT_REF = tenantRefFor(FIXTURE_TENANT_ID);
const OTHER_TENANT_ID = '99999999-8888-4777-8666-555555555555';
const HMAC_KEY = 'fixture-only-hmac-key';
const BUILD = 'abc1234';
const NOW = new Date('2026-10-09T12:00:00Z');
const TEST_REFS = Object.freeze([FIXTURE_TENANT_REF]);

const ledgerRow = (resourceType, operation) => {
  const ledger = buildOperationLedger();
  return [...ledger.types.flatMap((type) => type.operations), ...ledger.edges]
    .find((row) => row.resourceType === resourceType && row.operation === operation);
};

/** Every registered write, computed independently of the generator. */
function registeredWrites() {
  const types = [...new Set(CATALOG.map((entry) => entry.type))];
  const objectOps = types.flatMap((type) => OPERATIONS
    .filter((operation) => isSupportedClaim(capabilityFor(type, operation).claim))
    .map((operation) => `${type}:${operation}`));
  const edgeOps = ['member', 'owner'].flatMap((family) => EDGE_OPERATIONS
    .filter((operation) => isSupportedClaim(capabilityFor(edgeCapabilityKey('group', family), operation).claim))
    .map((operation) => `${edgeCapabilityKey('group', family)}:${operation}`));
  return [...objectOps, ...edgeOps].sort();
}

/** A restore artifact and one journal entry, as keel-restore would have left them. */
function fixtureRestore(step, {
  outcome = 'succeeded', outcomeDetail = undefined, tenantId = FIXTURE_TENANT_ID, targetTenantId = tenantId, naturalKey = null, displayName = null,
  principalName = 'keel-rt-20260908-carla@fixture.example', roleName = 'KEEL-RT-148-role',
} = {}) {
  const restoreRef = '0f0e0d0c-0b0a-4908-8706-050403020100';
  const edge = step.resourceType.includes('#');
  const family = edge ? step.resourceType.split('#')[1] : null;
  const key = naturalKey ?? (/\s|</.test(step.select) ? `fixture-key-${step.resourceType}` : step.select);
  const name = displayName ?? (step.fixtureKind === 'named-object' ? `${key}` : null);
  // The object's own name, in every field its kind is named by (issue #478).
  const named = (value) => (value ? { displayName: value, ...Object.fromEntries(nameFieldsFor(step.resourceType).map((field) => [field, value])) } : {});
  const targetId = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
  // Graph returns the object id a second time, encoded as a security identifier.
  const securityIdentifier = guidToCloudSid(targetId);
  const entry = {
    id: 1,
    runId: `run-${restoreRef}`,
    naturalKey: edge ? `edge:${key}|${family}|${step.operation === 'edge-add' ? 'add' : 'remove'}|keel-rt-20260908-carla` : key,
    restoreRef,
    resourceType: edge ? 'group' : step.resourceType,
    operation: step.operation === ENFORCEMENT_STEP ? 'update' : step.operation,
    targetId,
    priorState: edge
      ? { kind: 'relationship-edge', parentNaturalKey: key, parentTargetId: targetId, family, targetId: 'bbbbbbbb-cccc-4ddd-8eee-ffffffffffff', present: step.operation === 'edge-remove' }
      : { id: targetId, securityIdentifier, ...named(name), description: 'before', tenantHint: `https://login.microsoftonline.com/${tenantId}/` },
    intendedState: edge ? null : { ...named(name), description: 'after' },
    postState: edge ? null : { id: targetId, ...named(name), description: 'after' },
    outcome,
    outcomeDetail: outcomeDetail !== undefined ? outcomeDetail : outcome === 'succeeded' ? null : 'status 400',
    recordedAt: new Date(NOW.getTime() - 60_000),
  };
  // The restore's snapshot: the object itself, plus (for an object that only
  // points at others) the principal and role it references.
  const snapshotId = 'snapshot-fixture';
  const versions = [
    { id: 'v-own', natural_key: entry.naturalKey, resource_type: entry.resourceType, payload: edge ? null : entry.priorState },
    { id: 'v-user', natural_key: 'principal-key', resource_type: 'user', payload: { userPrincipalName: principalName } },
    { id: 'v-role', natural_key: 'role-key', resource_type: 'roleDefinition', payload: { displayName: roleName } },
  ];
  const references = [
    { from_version: 'v-own', field_path: 'principalId', to_symbol: 'user:principal-key' },
    { from_version: 'v-own', field_path: 'roleDefinitionId', to_symbol: 'roleDefinition:role-key' },
  ];
  return {
    key,
    restoreRef,
    getArtifact: async (_client, { id }) => (id === restoreRef
      ? {
        id, tenantRef: tenantRefFor(tenantId), targetTenantId, snapshotId,
        conditionalAccessEnforcement: step.operation === ENFORCEMENT_STEP ? { naturalKey: key } : null,
      }
      : null),
    getJournal: async (_client, { restoreRef: ref }) => (ref === restoreRef ? [entry] : []),
    getSnapshot: async (_client, id) => (id === snapshotId ? { versions, references } : { versions: [], references: [] }),
  };
}

async function capture(step, options = {}) {
  const restore = fixtureRestore(step, options);
  return captureLive({
    client: {}, restoreRef: restore.restoreRef, resourceType: step.resourceType, operation: step.operation, fixture: restore.key,
    targetConfig: { tenantId: options.configTenantId ?? FIXTURE_TENANT_ID }, build: BUILD, hmacKey: HMAC_KEY,
    allowTenantSetting: step.fixtureKind === 'tenant-setting', allowByReference: options.allowByReference ?? step.fixtureKind === 'by-reference',
    testTenantRefs: options.testTenantRefs ?? TEST_REFS, getArtifact: restore.getArtifact, getJournal: restore.getJournal, getSnapshot: restore.getSnapshot,
  });
}

const promote = (result, options = {}) => promoteRecord(result.record, {
  hmacKey: HMAC_KEY, captureLog: result.captureLog, now: NOW, tenantRef: FIXTURE_TENANT_REF, testTenantRefs: TEST_REFS, ...options,
});

test('the plan lists exactly the registered writes, each with every field the operator needs', () => {
  const plan = buildLiveGatePlan();
  const ids = plan.steps.filter((step) => step.operation !== ENFORCEMENT_STEP).map((step) => step.id).sort();
  assert.deepEqual(ids, registeredWrites());
  assert.equal(plan.operationCount, ids.length);
  assert.equal(new Set(plan.steps.map((step) => step.id)).size, plan.steps.length, 'no step is listed twice');
  assert.equal(plan.stepCount, plan.operationCount + 1, 'plus the Conditional Access enforcement step');
  // Issue #156's updates arrive through the ledger; device registration is manual and never listed.
  for (const id of ['organizationalBranding:update', 'organizationalBrandingLocalization:update', 'groupLifecyclePolicy:update', 'authenticationFlowsPolicy:update']) {
    assert.ok(ids.includes(id), `${id} is listed`);
  }
  assert.ok(!plan.steps.some((step) => step.resourceType === 'deviceRegistrationPolicy'), 'device registration is manual');
  for (const step of plan.steps) {
    assert.ok(step.testObject.length > 0, `${step.id}: test object`);
    assert.ok(step.commands.length >= 2, `${step.id}: commands`);
    assert.match(step.commands.at(-1), /entraLive\.mjs capture /, `${step.id}: ends with the capture`);
    assert.ok(step.cleanup.length > 0, `${step.id}: cleanup`);
    assert.equal(step.evidence.length, 2, `${step.id}: record and capture log`);
    assert.match(step.onFailure, /entraLive\.mjs demote /, `${step.id}: demotion`);
    if (step.operation === ENFORCEMENT_STEP) assert.equal(step.promote, null);
    else assert.match(step.promote, /entraLive\.mjs promote --evidence /, `${step.id}: promotion`);
    assert.doesNotMatch(JSON.stringify(step), /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i, `${step.id}: no raw id in the plan`);
  }
});

test('lockout-sensitive operations run last, and each names its break-glass precondition', () => {
  const { steps } = buildLiveGatePlan();
  const firstLockout = steps.findIndex((step) => step.lockoutSensitive);
  assert.ok(firstLockout > 0);
  assert.ok(steps.slice(firstLockout).every((step) => step.lockoutSensitive), 'nothing ordinary runs after a lockout-sensitive step');
  for (const type of ['conditionalAccessPolicy', 'authenticationMethodsPolicy', 'authorizationPolicy', 'unifiedRoleManagementPolicy', 'identitySecurityDefaultsEnforcementPolicy']) {
    const typed = steps.filter((step) => step.resourceType === type);
    assert.ok(typed.length > 0, `${type} is registered`);
    for (const step of typed) {
      assert.equal(step.lockoutSensitive, true, `${step.id} is lockout-sensitive`);
      assert.ok(step.breakGlass.some((line) => line.includes('keel-breakglass.mjs report')), `${step.id}: readiness check`);
      assert.equal(step.sharedRunAllowed, false, `${step.id}: runs alone`);
    }
  }
  const index = (id) => steps.findIndex((step) => step.id === id);
  assert.equal(steps.at(-1).resourceType, 'conditionalAccessPolicy', 'Conditional Access is last');
  assert.ok(index(`conditionalAccessPolicy:${ENFORCEMENT_STEP}`) === index('conditionalAccessPolicy:restore-soft-deleted') + 1, 'enforcement follows the soft-delete restore');
  assert.ok(index('group:create') < index('deviceCompliancePolicy:create'), 'the fixture group exists before policies are assigned to it');
  assert.ok(index('roleDefinition:create') < index('roleAssignment:create'), 'the custom role exists before it is assigned');
  for (const step of steps.filter((candidate) => !candidate.lockoutSensitive)) assert.equal(step.breakGlass, null);

  // The catalogue's tenant-lockout rating is never dropped silently.
  for (const type of ['roleDefinition', 'roleAssignment', 'roleEligibilitySchedule', 'namedLocation', 'authenticationStrengthPolicy']) {
    for (const step of steps.filter((candidate) => candidate.resourceType === type)) {
      assert.equal(step.lockoutSensitive, true, `${step.id} stays lockout-sensitive`);
      assert.equal(step.sharedRunAllowed, false, `${step.id} runs alone`);
      assert.ok(step.breakGlass.length > BREAK_GLASS_COMMON_COUNT, `${step.id} names its own precondition`);
    }
  }
  for (const step of steps.filter((candidate) => candidate.blastRadius === 'tenant-lockout' && !candidate.lockoutSensitive)) {
    assert.ok(FIXTURE_GUIDANCE[step.resourceType]?.lockout === false && FIXTURE_GUIDANCE[step.resourceType].lockoutReason,
      `${step.id}: a tenant-lockout type may only be downgraded explicitly, with a reason`);
  }
  for (const id of ['roleAssignment:create', 'roleEligibilitySchedule:create']) {
    assert.match(steps.find((step) => step.id === id).breakGlass.join(' '), /never a built-in privileged role and never a break-glass principal/i);
  }
  assert.doesNotMatch(FIXTURE_GUIDANCE.roleDefinition.fixture, /password/, 'the fixture role holds no credential permission');
  assert.match(renderMarkdown(buildLiveGatePlan()), /- Shared run: no \(runs alone/);
});

test('an unreviewed type gets a full step; one that can lock people out is treated as lockout-sensitive', () => {
  const harmless = guidanceFor('tokenLifetimePolicy');
  assert.equal(harmless.reviewed, false);
  assert.equal(harmless.lockout, false);
  const risky = guidanceFor('homeRealmDiscoveryPolicy');
  assert.equal(risky.reviewed, false);
  assert.equal(risky.lockout, true, 'tenant-lockout blast radius defaults to lockout-sensitive');
  assert.match(risky.breakGlass, /D-148a/);
  assert.equal(guidanceFor('adminConsentRequestPolicy').kind, 'tenant-setting');
});

test('one simulated capture per family promotes through qualifyLiveEvidence and the ledger flips', async () => {
  const { steps } = buildLiveGatePlan();
  const picked = new Map();
  for (const step of steps) {
    if (step.operation === ENFORCEMENT_STEP || step.alreadyLive) continue;
    const family = step.lockoutSensitive ? 'lockout-sensitive' : step.batch;
    if (!picked.has(family)) picked.set(family, step);
  }
  // The policy family's own gate (subtype and projection digest) runs first for strengths.
  picked.set('policy-subtype', steps.find((step) => step.id === 'authenticationStrengthPolicy:create'));
  // An object with no name of its own: its principal and role are checked in the snapshot.
  picked.set('by-reference', steps.find((step) => step.id === 'roleAssignment:create'));
  assert.deepEqual([...picked.keys()].sort(), [
    'administrative-configuration', 'by-reference', 'device-management', 'identity-application', 'lockout-sensitive', 'policy', 'policy-subtype', 'relationship',
  ]);

  for (const [family, step] of picked) {
    const before = ledgerRow(step.resourceType, step.operation);
    assert.equal(before.claim, 'fixture-tested', `${family}: starts fixture-tested`);
    assert.notEqual(before.live.result, 'qualified');

    const result = await capture(step);
    assert.equal(result.status, 'captured', `${family}: ${step.id}`);
    assert.equal(result.record.kind, ENTRA_LIVE_KIND);
    assert.equal(result.record.synthetic, false);
    assert.equal(result.record.tenantRef, FIXTURE_TENANT_REF);
    const written = `${JSON.stringify(result.record)}${result.captureLog}`;
    assert.ok(!written.includes(FIXTURE_TENANT_ID), `${family}: the raw tenant id is pseudonymized`);
    assert.ok(!written.includes('aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'), `${family}: object ids are pseudonymized`);
    assert.ok(!written.includes(guidToCloudSid('aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee')), `${family}: the object's SID is pseudonymized`);

    const promoted = promote(result);
    assert.deepEqual(promoted.failures, [], `${family}: ${step.id}`);
    assert.equal(promoted.promoted, true);
    const after = ledgerRow(step.resourceType, step.operation);
    assert.equal(after.claim, 'live-qualified', `${family}: the ledger flips`);
    assert.equal(after.live.result, 'qualified');
    assert.equal(after.live.proofRef, result.record.proofRef);
  }
});

test('synthetic evidence can never be promoted', async () => {
  const step = buildLiveGatePlan().steps.find((candidate) => candidate.id === 'namedLocation:update');
  const offline = await captureOffline({ resourceType: 'namedLocation', operation: 'update', build: BUILD, hmacKey: HMAC_KEY, tenantRef: FIXTURE_TENANT_REF });
  assert.equal(offline.record.synthetic, true);
  const refused = promoteRecord(offline.record, { hmacKey: HMAC_KEY, captureLog: offline.captureLog, now: NOW, tenantRef: FIXTURE_TENANT_REF, testTenantRefs: TEST_REFS });
  assert.equal(refused.promoted, false);
  assert.ok(refused.failures.some((failure) => /fixture runner|synthetic/.test(failure)));

  // Flipping the flag by hand breaks the signature.
  const edited = { ...offline.record, synthetic: false };
  const tampered = promoteRecord(edited, { hmacKey: HMAC_KEY, captureLog: offline.captureLog, now: NOW, tenantRef: FIXTURE_TENANT_REF, testTenantRefs: TEST_REFS });
  assert.equal(tampered.promoted, false);
  assert.ok(tampered.failures.includes('runner signature mismatch'));

  // A record without the key never verifies.
  const live = await capture(step);
  const unkeyed = promote(live, { hmacKey: null });
  assert.equal(unkeyed.promoted, false);
  assert.match(unkeyed.failures.join(), /no verification key/);
  assert.equal(capabilityFor('namedLocation', 'update').claim, 'fixture-tested', 'nothing above changed the claim');

  // The enforcement step is evidence only; it is never a ledger promotion.
  const enforcement = buildLiveGatePlan().steps.find((candidate) => candidate.operation === ENFORCEMENT_STEP);
  const enforced = await capture(enforcement);
  assert.equal(enforced.status, 'captured');
  assert.equal(promote(enforced).promoted, false);
});

test('a non-test tenant is refused at capture and at promotion', async () => {
  const step = buildLiveGatePlan().steps.find((candidate) => candidate.id === 'group:update');
  await assert.rejects(capture(step, { configTenantId: OTHER_TENANT_ID, tenantId: OTHER_TENANT_ID }), (error) => error instanceof LiveGateRefusal && /not the test tenant/.test(error.message));
  // The committed test-tenant list does not contain the fixture tenant either.
  await assert.rejects(capture(step, { testTenantRefs: TEST_TENANT_REFS }), /not the test tenant/);
  // A restore artifact from another tenant is refused even with a test-tenant config.
  await assert.rejects(capture(step, { tenantId: OTHER_TENANT_ID }), /different tenant/);

  const good = await capture(step);
  const elsewhere = promote(good, { tenantRef: tenantRefFor(OTHER_TENANT_ID) });
  assert.equal(elsewhere.promoted, false);
  assert.match(elsewhere.failures.join(), /not the test tenant/);
  const notListed = promote(good, { testTenantRefs: TEST_TENANT_REFS });
  assert.equal(notListed.promoted, false);
  assert.equal(capabilityFor('group', 'update').claim, 'fixture-tested');
});

test('a non-fixture object, an unconfirmed tenant setting and a missing write are refused or reported', async () => {
  const { steps } = buildLiveGatePlan();
  const group = steps.find((step) => step.id === 'group:update');
  await assert.rejects(capture(group, { naturalKey: 'finance-team', displayName: 'Finance team' }), /not a disposable KEEL-RT/);

  const setting = steps.find((step) => step.id === 'adminConsentRequestPolicy:update');
  const restore = fixtureRestore(setting);
  await assert.rejects(captureLive({
    client: {}, restoreRef: restore.restoreRef, resourceType: setting.resourceType, operation: 'update', fixture: restore.key,
    targetConfig: { tenantId: FIXTURE_TENANT_ID }, build: BUILD, hmacKey: HMAC_KEY, testTenantRefs: TEST_REFS,
    getArtifact: restore.getArtifact, getJournal: restore.getJournal, getSnapshot: restore.getSnapshot,
  }), /--allow-tenant-setting/);

  const missing = await captureLive({
    client: {}, restoreRef: restore.restoreRef, resourceType: setting.resourceType, operation: 'update', fixture: 'some-other-key',
    targetConfig: { tenantId: FIXTURE_TENANT_ID }, build: BUILD, hmacKey: HMAC_KEY, testTenantRefs: TEST_REFS,
    getArtifact: restore.getArtifact, getJournal: restore.getJournal, getSnapshot: restore.getSnapshot, allowTenantSetting: true,
  });
  assert.equal(missing.status, 'not-exercised');

  await assert.rejects(capture({ ...group, resourceType: 'domain', operation: 'update' }), /not a registered write/);
});

test('a write recorded as succeeded but not verified by its read-back is never promoted', async () => {
  const { steps } = buildLiveGatePlan();
  // A synced user: applyEngine restores it and writes nothing further, but still journals 'succeeded'.
  const user = steps.find((step) => step.id === 'user:restore-soft-deleted');
  const synced = await capture(user, { naturalKey: 'keel-rt-20260908-carla@fixture.example', outcomeDetail: 'restored; synced from on-premises, so nothing further is written' });
  assert.equal(synced.status, 'unverified');
  assert.equal(synced.record.ok, false);
  assert.equal(synced.record.readBackVerified, false);
  assert.equal(promote(synced).promoted, false);
  assert.equal(capabilityFor('user', 'restore-soft-deleted').claim, 'fixture-tested');

  const group = steps.find((step) => step.id === 'group:update');
  const residual = await capture(group, { outcomeDetail: 'not-remediable residual' });
  assert.equal(residual.status, 'unverified');
  // Hand-setting ok/readBackVerified breaks the signature; and even a signed record with that detail is refused.
  assert.match(promote(residual).failures.join(), /not verified/);

  const converged = await capture(group, { outcomeDetail: 'converged: only empty values differ' });
  assert.equal(converged.status, 'captured');
  assert.equal(verifiedOutcome('succeeded', 'absent'), true);
  assert.equal(verifiedOutcome('succeeded', 'soft-deleted'), true);
  assert.equal(verifiedOutcome('succeeded', 'anything else'), false);
  assert.equal(verifiedOutcome('uncertain', null), false);

  // A write with no recorded outcome is blocked, not a failure to demote.
  const pending = await capture(group, { outcome: 'pending', outcomeDetail: null });
  assert.equal(pending.status, 'pending');
  assert.equal(pending.record, null);
});

test('the restore must have written to the test tenant, and a by-reference object must point only at fixtures', async () => {
  const { steps } = buildLiveGatePlan();
  const group = steps.find((step) => step.id === 'group:update');
  await assert.rejects(capture(group, { targetTenantId: OTHER_TENANT_ID }), /wrote to a tenant that is not the test tenant/);
  await assert.rejects(capture(group, { targetTenantId: '' }), /wrote to a tenant that is not the test tenant/);

  const assignment = steps.find((step) => step.id === 'roleAssignment:create');
  await assert.rejects(capture(assignment, { allowByReference: false }), /--allow-by-reference/);
  await assert.rejects(capture(assignment, { principalName: 'breakglass-one@fixture.example' }), /principal is not a KEEL-RT fixture/);
  await assert.rejects(capture(assignment, { roleName: 'Global Administrator' }), /role is not the fixture role/);
  assert.equal((await capture(assignment)).status, 'captured');
  // Any KEEL-RT custom role is a fixture role, as fixtures are recreated under a fresh prefix (#232).
  assert.equal((await capture(assignment, { roleName: 'KEEL-RT-Q51-role' })).status, 'captured');
  assert.deepEqual(byReferenceProblems({ versions: [], references: [], naturalKey: 'x' }), ['the snapshot has no object x']);
});

test('a by-reference object resolves typed reference symbols to the referenced object (Q45)', () => {
  // As the collector stores them: every natural key and reference symbol is
  // typed, and a role is keyed by its template id, not its name.
  const roleTemplate = '7b5c1a2e-0d3f-4e6a-9b8c-1d2e3f4a5b6c';
  const appId = '3c4d5e6f-7a8b-4c9d-8e0f-1a2b3c4d5e6f';
  const own = `roleAssignment:roleDefinition:${roleTemplate}@servicePrincipal:${appId}@/`;
  const snapshot = ({ roleName = 'KEEL-RT-148-role', principalName = 'KEEL-RT-148-app' } = {}) => ({
    naturalKey: own,
    versions: [
      { id: 'v-own', natural_key: own, payload: {} },
      { id: 'v-role', natural_key: `roleDefinition:${roleTemplate}`, payload: { displayName: roleName } },
      { id: 'v-sp', natural_key: `servicePrincipal:${appId}`, payload: { displayName: principalName } },
      { id: 'v-user', natural_key: 'user:keel-rt-20260908-carla@fixture.example', payload: { userPrincipalName: 'keel-rt-20260908-carla@fixture.example' } },
    ],
    references: [
      { from_version: 'v-own', field_path: 'roleDefinitionId', to_symbol: `roleDefinition:${roleTemplate}` },
      { from_version: 'v-own', field_path: 'principalId', to_symbol: `servicePrincipal:${appId}` },
    ],
  });
  assert.deepEqual(byReferenceProblems(snapshot()), []);
  assert.deepEqual(byReferenceProblems(snapshot({ roleName: 'Global Administrator' })), ['the role is not the fixture role']);
  assert.deepEqual(byReferenceProblems(snapshot({ principalName: 'Payroll app' })), ['the principal is not a KEEL-RT fixture']);

  // A user principal, by its typed key.
  const user = snapshot();
  user.references[1] = { from_version: 'v-own', field_path: 'principalId', to_symbol: 'user:keel-rt-20260908-carla@fixture.example' };
  assert.deepEqual(byReferenceProblems(user), []);
  user.versions[3].payload = { userPrincipalName: 'breakglass-one@fixture.example' };
  user.versions[3].natural_key = 'user:breakglass-one@fixture.example';
  user.references[1].to_symbol = 'user:breakglass-one@fixture.example';
  assert.deepEqual(byReferenceProblems(user), ['the principal is not a KEEL-RT fixture']);

  // A role the snapshot does not hold (a built-in role) is never the fixture role.
  const builtIn = snapshot();
  builtIn.references[0].to_symbol = 'global:62e90394-69f5-4237-9190-012177145e10';
  assert.deepEqual(byReferenceProblems(builtIn), ['the role is not the fixture role']);

  // Any KEEL-RT custom role passes (#232), but never one the snapshot marks built in.
  assert.deepEqual(byReferenceProblems(snapshot({ roleName: 'KEEL-RT-Q51-role' })), []);
  const markedBuiltIn = snapshot({ roleName: 'KEEL-RT-Q51-role' });
  markedBuiltIn.versions[1].payload.isBuiltIn = true;
  assert.deepEqual(byReferenceProblems(markedBuiltIn), ['the role is not the fixture role']);
});

test('a fixture name is checked anchored, on its own key or prior state only', async () => {
  const group = buildLiveGatePlan().steps.find((step) => step.id === 'group:update');
  // The prefix must start the name, not appear inside it.
  await assert.rejects(capture(group, { naturalKey: 'prod-KEEL-RT-148-group', displayName: 'prod-KEEL-RT-148-group' }), /not a disposable/);
  // A KEEL-RT name only in the intended or post-write state is not enough.
  const restore = fixtureRestore(group, { naturalKey: 'finance-team', displayName: 'Finance team' });
  const journal = await restore.getJournal({}, { restoreRef: restore.restoreRef });
  journal[0].intendedState = { displayName: 'KEEL-RT-148-group' };
  journal[0].postState = { displayName: 'KEEL-RT-148-group' };
  await assert.rejects(captureLive({
    client: {}, restoreRef: restore.restoreRef, resourceType: 'group', operation: 'update', fixture: 'finance-team',
    targetConfig: { tenantId: FIXTURE_TENANT_ID }, build: BUILD, hmacKey: HMAC_KEY, testTenantRefs: TEST_REFS,
    getArtifact: restore.getArtifact, getJournal: async () => journal, getSnapshot: restore.getSnapshot,
  }), /not a disposable/);
});

test('a token or home realm policy is keyed by id but checked by its own display name (#295)', async () => {
  const { steps } = buildLiveGatePlan();
  const policyId = '12345678-1234-4234-8234-123456789abc';
  for (const resourceType of ['tokenLifetimePolicy', 'tokenIssuancePolicy', 'claimsMappingPolicy', 'homeRealmDiscoveryPolicy']) {
    assert.equal(guidanceFor(resourceType).kind, 'named-object', resourceType);
    for (const step of steps.filter((candidate) => candidate.resourceType === resourceType)) {
      assert.ok(!step.commands.at(-1).includes('--allow-by-reference'), `${step.id}: the plan never asks for --allow-by-reference`);
      // Any KEEL-RT name will do: queue items name fixtures under their own prefix.
      const result = await capture(step, { naturalKey: policyId, displayName: `KEEL-RT-W2-${resourceType}` });
      assert.equal(result.status, 'captured', step.id);
      assert.ok(!result.captureLog.includes(policyId), `${step.id}: the policy id is pseudonymized`);
      await assert.rejects(capture(step, { naturalKey: policyId, displayName: 'Contoso default token lifetime' }), /not a disposable/, step.id);
    }
  }
  // An id-keyed object with no name of its own stays by-reference.
  assert.equal(guidanceFor('oauth2PermissionGrant').kind, 'by-reference');
});

// Kinds whose write body has no name of its own, each with the reason.
const NAMELESS_WRITE_BODIES = Object.freeze({
  servicePrincipal: 'Graph copies an enterprise app\'s display name from its app registration; the write body carries only the appId',
});

test('every restorable named kind is checked by a name field its objects have (#478)', () => {
  const named = [...new Set(buildLiveGatePlan().steps
    .filter((step) => step.fixtureKind === 'named-object' && !step.resourceType.includes('#'))
    .map((step) => step.resourceType))].sort();
  assert.ok(named.includes('intuneBrandingProfile'));
  for (const resourceType of named) {
    const payload = FIXTURE_PAYLOADS[resourceType];
    assert.ok(payload, `${resourceType}: no fixture write body to check its name field against`);
    const fields = nameFieldsFor(resourceType);
    const present = fields.filter((field) => typeof payload[field] === 'string');
    if (NAMELESS_WRITE_BODIES[resourceType]) {
      assert.deepEqual(present, [], `${resourceType}: its write body now has a name; drop it from NAMELESS_WRITE_BODIES`);
      continue;
    }
    assert.ok(present.length > 0, `${resourceType}: none of ${fields.join(', ')} is in its objects; add its name field to OWN_NAME_FIELDS`);
    // Named like a fixture (any KEEL-RT prefix), it passes; as the harness names it, it does not.
    const renamed = { ...payload, ...Object.fromEntries(present.map((field) => [field, `KEEL-RT-478-${resourceType}`])) };
    assert.equal(namesFixture(resourceType, renamed), true, `${resourceType}: a KEEL-RT name is recognised`);
    assert.equal(namesFixture(resourceType, payload), false, `${resourceType}: a non-fixture name is refused`);
  }
});

test('a branding profile is checked by its profile name, not the organization name it shows (#478)', async () => {
  const step = buildLiveGatePlan().steps.find((candidate) => candidate.id === 'intuneBrandingProfile:create');
  const profileId = '12345678-1234-4234-8234-123456789abc';
  const run = (priorState) => {
    const restore = fixtureRestore(step, { naturalKey: profileId });
    return restore.getJournal({}, { restoreRef: restore.restoreRef }).then((journal) => {
      journal[0].priorState = { id: profileId, ...priorState };
      return captureLive({
        client: {}, restoreRef: restore.restoreRef, resourceType: step.resourceType, operation: step.operation, fixture: profileId,
        targetConfig: { tenantId: FIXTURE_TENANT_ID }, build: BUILD, hmacKey: HMAC_KEY, testTenantRefs: TEST_REFS,
        getArtifact: restore.getArtifact, getJournal: async () => journal, getSnapshot: restore.getSnapshot,
      });
    });
  };
  // Q123: the queue item names the organization 'KEEL-RT IT', which is not a fixture name.
  assert.equal((await run({ profileName: 'KEEL-RT-branding', displayName: 'KEEL-RT IT' })).status, 'captured');
  assert.equal((await run({ profileName: 'KEEL-RT-Q123-branding', displayName: 'Contoso IT' })).status, 'captured');
  await assert.rejects(run({ profileName: 'Contoso branding', displayName: 'KEEL-RT-IT' }), /not a disposable/);
  await assert.rejects(run({ profileName: 'prod-KEEL-RT-branding', displayName: 'Contoso IT' }), /not a disposable/);
});

test('an app relationship is a fixture only when both of its apps are (#478)', () => {
  const both = { sourceDisplayName: 'KEEL-RT-148-app-main', targetDisplayName: 'KEEL-RT-148-app-dep' };
  assert.equal(namesFixture('mobileAppRelationship', both), true);
  assert.equal(namesFixture('mobileAppRelationship', { ...both, targetDisplayName: 'Company Portal' }), false);
  assert.equal(namesFixture('mobileAppRelationship', { sourceDisplayName: 'KEEL-RT-148-app-main' }), false);
  assert.equal(namesFixture('groupPolicyUploadedDefinitionFile', { fileName: 'keel-rt-148-fixture.admx', displayName: 'Windows Update' }), true);
  assert.equal(namesFixture('groupPolicyUploadedDefinitionFile', { fileName: 'windowsupdate.admx', displayName: 'KEEL-RT-admx' }), false);
});

test('a delegated consent grant is checked by its client app and user, not a role (#295)', async () => {
  const step = buildLiveGatePlan().steps.find((candidate) => candidate.id === 'oauth2PermissionGrant:update');
  assert.equal(step.fixtureKind, 'by-reference');
  assert.equal(guidanceFor('oauth2PermissionGrant').reviewed, true);
  // As the collector stores them: the grant keyed by its id, its client a typed
  // service principal symbol and its user a typed user symbol. No role anywhere.
  // Graph's grant id is the client, resource and user object ids, base64url encoded.
  const guidBytes = (guid) => {
    const hex = Buffer.from(guid.replace(/-/g, ''), 'hex');
    return Buffer.concat([hex.subarray(0, 4).reverse(), hex.subarray(4, 6).reverse(), hex.subarray(6, 8).reverse(), hex.subarray(8)]);
  };
  const grantId = Buffer.concat(['4a1b2c3d-5e6f-4a7b-8c9d-0e1f2a3b4c5d', '5b2c3d4e-6f7a-4b8c-9d0e-1f2a3b4c5d6e', '6c3d4e5f-7a8b-4c9d-8e0f-2a3b4c5d6e7f']
    .map(guidBytes)).toString('base64url');
  // An id-keyed type's natural key is its raw id (engine/cir/naturalKey.mjs).
  const grantKey = grantId;
  const appId = '3c4d5e6f-7a8b-4c9d-8e0f-1a2b3c4d5e6f';
  const graphAppId = '00000003-0000-0000-c000-000000000000';
  const snapshot = ({ appName = 'KEEL-RT-W2-app', upn = 'keel-rt-20260908-carla@fixture.example', consentType = 'Principal' } = {}) => ({
    naturalKey: grantKey,
    resourceType: 'oauth2PermissionGrant',
    versions: [
      { id: 'v-own', natural_key: grantKey, payload: { consentType, scope: 'openid' } },
      { id: 'v-app', natural_key: `servicePrincipal:${appId}`, payload: { displayName: appName } },
      { id: 'v-graph', natural_key: `servicePrincipal:${graphAppId}`, payload: { displayName: 'Microsoft Graph' } },
      { id: 'v-user', natural_key: `user:${upn}`, payload: { userPrincipalName: upn } },
    ],
    references: [
      { from_version: 'v-own', field_path: 'clientId', to_symbol: `servicePrincipal:${appId}` },
      { from_version: 'v-own', field_path: 'resourceId', to_symbol: `servicePrincipal:${graphAppId}` },
      ...(consentType === 'Principal' ? [{ from_version: 'v-own', field_path: 'principalId', to_symbol: `user:${upn}` }] : []),
    ],
  });
  // A KEEL-RT client app and a keel-rt user pass, though the resource (Microsoft Graph) is no fixture.
  assert.deepEqual(byReferenceProblems(snapshot()), []);
  assert.deepEqual(byReferenceProblems(snapshot({ appName: 'KEEL-RT-Q80-app' })), []);
  assert.deepEqual(byReferenceProblems(snapshot({ appName: 'Keel Restorer' })), ['the client app is not a KEEL-RT fixture']);
  assert.deepEqual(byReferenceProblems(snapshot({ upn: 'breakglass-one@fixture.example' })), ['the user is not a KEEL-RT fixture']);
  assert.deepEqual(byReferenceProblems(snapshot({ consentType: 'AllPrincipals' })),
    ['the consent is not for one user (consentType Principal)', 'no user reference']);
  const noClient = snapshot();
  noClient.references = noClient.references.filter((ref) => ref.field_path !== 'clientId');
  assert.deepEqual(byReferenceProblems(noClient), ['no client app reference']);
  // Without the type, the same snapshot is still checked as a role assignment.
  assert.ok(byReferenceProblems({ ...snapshot(), resourceType: undefined }).includes('no role reference'));

  // Through the capture: the restore's snapshot holds the grant, its app and its user.
  const restore = fixtureRestore(step, { naturalKey: grantKey });
  const journal = await restore.getJournal({}, { restoreRef: restore.restoreRef });
  journal[0].targetId = grantId;
  journal[0].priorState = { id: grantId, consentType: 'Principal', scope: 'openid profile' };
  const grantSnapshot = (options) => {
    const rows = snapshot(options);
    return async () => ({ versions: rows.versions, references: rows.references });
  };
  const run = (options = {}, allowByReference = true) => captureLive({
    client: {}, restoreRef: restore.restoreRef, resourceType: step.resourceType, operation: step.operation, fixture: grantKey,
    targetConfig: { tenantId: FIXTURE_TENANT_ID }, build: BUILD, hmacKey: HMAC_KEY, allowByReference, testTenantRefs: TEST_REFS,
    getArtifact: restore.getArtifact, getJournal: restore.getJournal, getSnapshot: grantSnapshot(options),
  });
  await assert.rejects(run({}, false), /checks that its client app and user are fixtures/);
  const result = await run();
  assert.equal(result.status, 'captured');
  assert.equal(result.record.fixtureKind, 'by-reference');
  assert.equal(grantId.length, 64);
  assert.ok(!result.captureLog.includes(grantId), 'the grant id is pseudonymized');
  await assert.rejects(run({ appName: 'Keel Restorer' }), /client app is not a KEEL-RT fixture/);
  await assert.rejects(run({ consentType: 'AllPrincipals' }), /not for one user/);
});

test('an edge is captured by the checklist\'s fixture name although its key carries the typed parent (Q48)', async () => {
  // keel-restore journals an edge under its typed parent symbol: edge:group:<mail nickname>|...
  for (const id of ['group#member:edge-add', 'group#member:edge-remove', 'group#owner:edge-add', 'group#owner:edge-remove']) {
    const step = buildLiveGatePlan().steps.find((candidate) => candidate.id === id);
    const restore = fixtureRestore(step, { naturalKey: 'group:KEEL-RT-148-g5' });
    const run = (fixture) => captureLive({
      client: {}, restoreRef: restore.restoreRef, resourceType: step.resourceType, operation: step.operation, fixture,
      targetConfig: { tenantId: FIXTURE_TENANT_ID }, build: BUILD, hmacKey: HMAC_KEY, testTenantRefs: TEST_REFS,
      getArtifact: restore.getArtifact, getJournal: restore.getJournal, getSnapshot: restore.getSnapshot,
    });
    assert.equal((await run('KEEL-RT-148-g5')).status, 'captured', `${id}: bare fixture name`);
    assert.equal((await run('group:KEEL-RT-148-g5')).status, 'captured', `${id}: typed fixture name`);
    assert.equal((await run('KEEL-RT-148-g6')).status, 'not-exercised', `${id}: another group`);
  }
  // The type prefix is stripped, not the anchor: a group that only contains the prefix is refused.
  const step = buildLiveGatePlan().steps.find((candidate) => candidate.id === 'group#member:edge-add');
  const restore = fixtureRestore(step, { naturalKey: 'group:prod-KEEL-RT-148-g5' });
  await assert.rejects(captureLive({
    client: {}, restoreRef: restore.restoreRef, resourceType: step.resourceType, operation: step.operation, fixture: 'prod-KEEL-RT-148-g5',
    targetConfig: { tenantId: FIXTURE_TENANT_ID }, build: BUILD, hmacKey: HMAC_KEY, testTenantRefs: TEST_REFS,
    getArtifact: restore.getArtifact, getJournal: restore.getJournal, getSnapshot: restore.getSnapshot,
  }), /not a disposable/);
});

test('a deleted role assignment is checked by its composed key, which the snapshot never holds (Q48)', async () => {
  const step = buildLiveGatePlan().steps.find((candidate) => candidate.id === 'roleAssignment:delete');
  const roleTemplate = '7b5c1a2e-0d3f-4e6a-9b8c-1d2e3f4a5b6c';
  const key = (principal, scope = '/') => `roleAssignment:roleDefinition:${roleTemplate}@${principal}@${scope}`;
  const run = async ({ naturalKey, roleName = 'KEEL-RT-148-role', extraVersions = [] }) => {
    const restore = fixtureRestore(step, { naturalKey });
    const journal = await restore.getJournal({}, { restoreRef: restore.restoreRef });
    journal[0].outcomeDetail = 'absent';
    // The delete's snapshot was taken before the assignment existed: only the role and the user.
    const versions = [
      { id: 'v-role', natural_key: `roleDefinition:${roleTemplate}`, payload: { displayName: roleName } },
      { id: 'v-user', natural_key: 'user:keel-rt-20260908-carla@fixture.example', payload: { userPrincipalName: 'keel-rt-20260908-carla@fixture.example' } },
      { id: 'v-bg', natural_key: 'user:breakglass-one@fixture.example', payload: { userPrincipalName: 'breakglass-one@fixture.example' } },
      ...extraVersions,
    ];
    return captureLive({
      client: {}, restoreRef: restore.restoreRef, resourceType: step.resourceType, operation: step.operation, fixture: naturalKey,
      targetConfig: { tenantId: FIXTURE_TENANT_ID }, build: BUILD, hmacKey: HMAC_KEY, testTenantRefs: TEST_REFS, allowByReference: true,
      getArtifact: restore.getArtifact, getJournal: async () => journal, getSnapshot: async () => ({ versions, references: [] }),
    });
  };
  assert.equal((await run({ naturalKey: key('user:keel-rt-20260908-carla@fixture.example') })).status, 'captured');
  await assert.rejects(run({ naturalKey: key('user:breakglass-one@fixture.example') }), /principal is not a KEEL-RT fixture/);
  await assert.rejects(run({ naturalKey: key('user:keel-rt-20260908-carla@fixture.example'), roleName: 'Global Administrator' }), /role is not the fixture role/);
  await assert.rejects(run({ naturalKey: key('user:keel-rt-20260908-carla@fixture.example', 'administrativeUnit:Finance') }), /scope is not a KEEL-RT fixture/);
  await assert.rejects(run({ naturalKey: key('unknown:aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee') }), /principal is not a KEEL-RT fixture/);
  // A role under a fresh fixture prefix is accepted (#232).
  assert.equal((await run({ naturalKey: key('user:keel-rt-20260908-carla@fixture.example'), roleName: 'KEEL-RT-Q51-role' })).status, 'captured');
  // An administrative-unit scope is a raw path in the key, resolved by the unit's object id (#232).
  const unit = (name) => [{ id: 'v-au', natural_key: `administrativeUnit:${name}`, payload: { id: 'C0FFEE00-1111-4222-8333-444455556666', displayName: name } }];
  const auKey = key('user:keel-rt-20260908-carla@fixture.example', '/administrativeUnits/c0ffee00-1111-4222-8333-444455556666');
  assert.equal((await run({ naturalKey: auKey, extraVersions: unit('KEEL-RT-Q51-unit') })).status, 'captured');
  await assert.rejects(run({ naturalKey: auKey, extraVersions: unit('Finance') }), /scope is not a KEEL-RT fixture/);
  await assert.rejects(run({ naturalKey: auKey }), /scope is not a KEEL-RT fixture/);
  // The deleted assignment's own id never reaches the log raw, whatever suffix Graph gives it (#235).
  const guidBytes = (value) => {
    const be = Buffer.from(value.replace(/-/g, ''), 'hex');
    return Buffer.from([be[3], be[2], be[1], be[0], be[5], be[4], be[7], be[6], ...be.subarray(8)]);
  };
  const principal = 'c1a2b3c4-d5e6-4f70-8192-a3b4c5d6e7f8';
  const assignmentId = `${Buffer.concat([guidBytes(roleTemplate), guidBytes(principal)]).toString('base64url')}-1-e`;
  const withId = (id) => async ({ naturalKey }) => {
    const restore = fixtureRestore(step, { naturalKey });
    const journal = await restore.getJournal({}, { restoreRef: restore.restoreRef });
    Object.assign(journal[0], { outcomeDetail: 'absent', targetId: id, priorState: { id, principalId: principal, directoryScopeId: '/' }, postState: null });
    const versions = [
      { id: 'v-role', natural_key: `roleDefinition:${roleTemplate}`, payload: { displayName: 'KEEL-RT-148-role' } },
      { id: 'v-user', natural_key: 'user:keel-rt-20260908-carla@fixture.example', payload: { userPrincipalName: 'keel-rt-20260908-carla@fixture.example' } },
    ];
    return captureLive({
      client: {}, restoreRef: restore.restoreRef, resourceType: step.resourceType, operation: step.operation, fixture: naturalKey,
      targetConfig: { tenantId: FIXTURE_TENANT_ID }, build: BUILD, hmacKey: HMAC_KEY, testTenantRefs: TEST_REFS, allowByReference: true,
      getArtifact: restore.getArtifact, getJournal: async () => journal, getSnapshot: async () => ({ versions, references: [] }),
    });
  };
  const deleted = await withId(assignmentId)({ naturalKey: key('user:keel-rt-20260908-carla@fixture.example') });
  assert.equal(deleted.status, 'captured');
  assert.ok(!deleted.captureLog.includes(assignmentId.slice(0, 43)), 'the assignment id is pseudonymized');
  assert.deepEqual(unpseudonymizedIds(deleted.captureLog), []);
  // An id of a shape the pseudonymizer does not know is refused, never published.
  await assert.rejects(withId('Zm9vYmFyYmF6cXV4cXV1eHF1dXo')({ naturalKey: key('user:keel-rt-20260908-carla@fixture.example') }), /still holds the target's raw id \(27 characters\)/);
  // Only a delete may fall back to its key: a create must be in its own snapshot.
  assert.deepEqual(byReferenceProblems({ versions: [], references: [], naturalKey: key('user:x') }), [`the snapshot has no object ${key('user:x')}`]);
  assert.deepEqual(byReferenceProblems({ versions: [], references: [], naturalKey: 'x', deleted: true }), ['the snapshot has no object x']);
});

test('a target config that is not valid JSON is refused without echoing it', async () => {
  const errors = [];
  const code = await entraLiveMain({
    argv: ['capture', '--restore-ref', 'r', '--resource-type', 'group', '--operation', 'create', '--fixture', 'KEEL-RT-148-group',
      '--target-config', '/fixture.json', '--build', BUILD, '--out', mkdtempSync(join(tmpdir(), 'entra-out-')), '--db-url', 'postgres://fixture'],
    out: { log: () => {}, error: (line) => errors.push(line) }, env: { KEEL_QUALIFICATION_HMAC_KEY: HMAC_KEY },
    connectFn: async () => ({ end: async () => {} }), readFile: () => '{"clientSecret": "fixture-secret-value", broken',
  });
  assert.equal(code, 1);
  assert.equal(errors.join('\n'), "Keel can't read the restorer settings file (/fixture.json): it is not valid JSON. Fix the file on the Keel server, then try again.");
});

test('a failed live write is never promoted, and its demotion must be applied in code', async () => {
  const step = buildLiveGatePlan().steps.find((candidate) => candidate.id === 'roleDefinition:update');
  const failed = await capture(step, { outcome: 'failed' });
  assert.equal(failed.status, 'failed');
  assert.equal(failed.record.ok, false);
  assert.equal(promote(failed).promoted, false);
  assert.equal(capabilityFor('roleDefinition', 'update').claim, 'fixture-tested');

  const demotion = demotionRecord({ resourceType: 'roleDefinition', operation: 'update', restoreRef: 'some-restore', reason: 'Graph refused the update with 400 on the test tenant', now: NOW });
  assert.equal(demotion.kind, 'entra-live-demotion');
  assert.ok(demotion.builderSteps.some((line) => line.includes('TYPE_DECISIONS.roleDefinition.reason')));
  assert.throws(() => demotionRecord({ resourceType: 'roleDefinition', operation: 'update', reason: 'x' }), /plain words/);

  const dir = mkdtempSync(join(tmpdir(), 'entra-live-'));
  writeFileSync(join(dir, 'roleDefinition.update.demotion.json'), JSON.stringify(demotion));
  const pending = unappliedDemotions({ dir });
  assert.equal(pending.length, 2, 'still registered, and the reason is not recorded');
  const applied = unappliedDemotions({
    dir,
    decisions: { roleDefinition: { decision: 'automated', reason: `custom roles: create only; live gate #148: update failed live: ${demotion.reason}` } },
    claimOf: () => 'unsupported',
  });
  assert.deepEqual(applied, []);

  // The other way: the write stays registered because the cause is a KEEL bug
  // being fixed, and the type records the failed live run with its date and
  // the demotion's own words.
  const decisionWith = (failure) => ({ roleDefinition: { decision: 'automated', reason: 'custom roles: create and update', liveFailures: { update: failure } } });
  assert.deepEqual(unappliedDemotions({ dir, decisions: decisionWith({ failedAt: '2026-10-09', reason: demotion.reason, fix: 'x' }) }), []);
  const vague = unappliedDemotions({ dir, decisions: decisionWith({ failedAt: '2026-10-01', reason: 'it broke' }) });
  assert.equal(vague.length, 2, 'a paraphrased reason or another date is not the demotion');
  assert.match(vague[0], /does not quote the demotion reason/);
  assert.match(vague[1], /is not the demotion's date/);
  // The ledger shows the failure on the row, and the claim is untouched.
  const ledger = buildOperationLedger({ decisions: { ...TYPE_DECISIONS, ...decisionWith({ failedAt: '2026-10-09', reason: demotion.reason, fix: 'x' }) } });
  const row = ledger.types.find((type) => type.resourceType === 'roleDefinition').operations.find((op) => op.operation === 'update');
  assert.equal(row.claim, 'fixture-tested');
  assert.deepEqual(row.live, { result: 'failed', proofRef: null, failedAt: '2026-10-09', reason: demotion.reason, fix: 'x' });
  // A failure note for a write that is not registered describes nothing and is refused.
  assert.throws(() => buildOperationLedger({ decisions: { ...TYPE_DECISIONS, roleDefinition: { ...TYPE_DECISIONS.roleDefinition, liveFailures: { delete: { failedAt: '2026-10-09', reason: 'x' } } } } }),
    /liveFailures\.delete names an operation that is not a registered write/);
});

test('committed demotions are applied, and committed records only verify with the key', () => {
  const dir = join(ROOT, 'docs/release/qualifications/entra-live');
  assert.deepEqual(unappliedDemotions({ dir }), []);
  for (const result of applyCommittedEvidence({ dir, hmacKey: null })) {
    assert.equal(result.promoted, false, `${result.file} must not verify without the key`);
  }
  // A committed demotion whose cause is a KEEL bug with a fix under way keeps
  // its write registered, and its type records the failed live run, dated and
  // in the demotion's words. (The ledger row itself is checked in the
  // roleDefinition test above: the simulated promotions earlier in this file
  // may already have flipped a demoted write's in-process claim.) The run 1 and
  // run 2 demotions were removed once verified reruns replaced them (#148).
  const demotions = readdirSync(dir).filter((name) => name.endsWith('.demotion.json'));
  for (const name of demotions) {
    const demotion = JSON.parse(readFileSync(join(dir, name), 'utf8'));
    const failure = TYPE_DECISIONS[demotion.resourceType.split('#')[0]].liveFailures?.[demotion.operation];
    assert.ok(failure, `${name}: recorded under liveFailures`);
    assert.equal(failure.failedAt, demotion.decidedAt.slice(0, 10), `${name}: dated`);
    assert.ok(failure.reason.includes(demotion.reason), `${name}: in the demotion's words`);
    assert.ok(failure.fix, `${name}: names the fix`);
  }
});

test('the test tenant is the tenant every committed live gate was captured in', () => {
  const dir = join(ROOT, 'docs/release/qualifications');
  const refs = new Set();
  for (const name of readdirSync(dir).filter((file) => /^[a-z-]+\.json$/.test(file))) {
    const record = JSON.parse(readFileSync(join(dir, name), 'utf8'));
    if (record.status === 'pending' || record.evidenceLevel !== 'live-qualified' || typeof record.tenantRef !== 'string') continue;
    refs.add(record.tenantRef);
  }
  assert.ok(refs.size > 0, 'there are committed live records');
  assert.deepEqual([...refs], [...TEST_TENANT_REFS]);
});

test('the CLIs refuse without the signing key and print the plan', async () => {
  const errors = [];
  const out = { log: () => {}, error: (line) => errors.push(line) };
  const code = await entraLiveMain({
    argv: ['capture', '--restore-ref', 'r', '--resource-type', 'group', '--operation', 'create', '--fixture', 'KEEL-RT-148-group',
      '--target-config', '/nonexistent.json', '--build', BUILD, '--out', mkdtempSync(join(tmpdir(), 'entra-out-')), '--db-url', 'postgres://fixture'],
    out, env: {}, connectFn: async () => ({ end: async () => {} }), readFile: () => JSON.stringify({ tenantId: FIXTURE_TENANT_ID }),
  });
  assert.equal(code, 1);
  assert.match(errors.join('\n'), /KEEL_QUALIFICATION_HMAC_KEY is required/);

  const lines = [];
  assert.equal(planMain({ argv: ['--json'], out: { log: (line) => lines.push(line), error: () => {} } }), 0);
  const plan = JSON.parse(lines.join('\n'));
  assert.equal(plan.issue, 148);
  assert.equal(plan.steps.length, plan.stepCount);
});

// Last: it changes the registry for the rest of this file.
test('a newly registered write appears in the plan with no edit to the generator', () => {
  const before = buildLiveGatePlan();
  assert.ok(!before.steps.some((step) => step.id === 'application:delete'));
  registerOperationCapability({ resourceType: 'application', operation: 'delete', path: '/applications', handler: 'fixture#handler', idOutcome: 'terminal' });
  recordFixtureProof('application', 'delete', 'engine/roadmap/entra-live-gate.test.mjs');
  const after = buildLiveGatePlan();
  assert.equal(after.operationCount, before.operationCount + 1);
  const added = after.steps.find((step) => step.id === 'application:delete');
  assert.ok(added);
  assert.match(added.promote, /application\.delete\.json/);
});

// Q46: a branding file upload (#199, gap M6) is its own write, journaled
// under organizationalBranding#file. Last too: promotion changes the registry.
test('a branding file upload is captured and promoted as its own tenant-setting write', async () => {
  const naturalKey = 'organizationalBranding#file:fr-FR/favicon';
  const restoreRef = '0f0e0d0c-0b0a-4908-8706-050403020100';
  const snapshotId = 'snapshot-fixture';
  const before = 'a'.repeat(64);
  const after = 'b'.repeat(64);
  const entry = {
    id: 7, runId: `run-${restoreRef}`, naturalKey, restoreRef, resourceType: 'organizationalBranding#file', operation: 'update',
    targetId: null, blastRadius: 'cosmetic',
    priorState: { kind: 'branding-file', locale: 'fr-FR', asset: 'favicon', sha256: before },
    intendedState: { kind: 'branding-file', locale: 'fr-FR', asset: 'favicon', sha256: after, size: 1150, contentType: 'image/x-icon' },
    postState: { kind: 'branding-file', locale: 'fr-FR', asset: 'favicon', sha256: after, outcome: 'present' },
    outcome: 'succeeded', outcomeDetail: null, recordedAt: new Date(NOW.getTime() - 60_000),
  };
  const fixtures = {
    getArtifact: async (_client, { id }) => (id === restoreRef
      ? { id, tenantRef: FIXTURE_TENANT_REF, targetTenantId: FIXTURE_TENANT_ID, snapshotId, conditionalAccessEnforcement: null }
      : null),
    getJournal: async (_client, { restoreRef: ref }) => (ref === restoreRef ? [entry] : []),
    getSnapshot: async () => ({ versions: [], references: [] }),
  };
  const run = (options) => captureLive({
    client: {}, restoreRef, operation: 'update', targetConfig: { tenantId: FIXTURE_TENANT_ID }, build: BUILD, hmacKey: HMAC_KEY,
    testTenantRefs: TEST_REFS, ...fixtures, ...options,
  });

  assert.equal(guidanceFor('organizationalBranding#file').kind, 'tenant-setting');
  // Without the tenant-setting allowance it is refused, never captured.
  await assert.rejects(run({ resourceType: 'organizationalBranding#file', fixture: naturalKey }), /--allow-tenant-setting/);

  // Asked for as the localization, the capture says where the upload is.
  const asLocalization = await run({ resourceType: 'organizationalBrandingLocalization', fixture: 'fr-FR', allowTenantSetting: true });
  assert.equal(asLocalization.status, 'not-exercised');
  assert.match(asLocalization.reason, /--resource-type 'organizationalBranding#file' --operation update --allow-tenant-setting --fixture one of 'organizationalBranding#file:fr-FR\/favicon'/);

  const result = await run({ resourceType: 'organizationalBranding#file', fixture: naturalKey, allowTenantSetting: true });
  assert.equal(result.status, 'captured');
  assert.equal(result.record.fixtureKind, 'tenant-setting');
  assert.equal(result.record.naturalKey, naturalKey);
  assert.equal(result.record.proofRef, 'docs/release/qualifications/entra-live/organizationalBranding.file.update.json');
  assert.ok(!`${JSON.stringify(result.record)}${result.captureLog}`.includes(FIXTURE_TENANT_ID));

  assert.equal(capabilityFor('organizationalBranding#file', 'update').claim, 'fixture-tested');
  const promoted = promote(result);
  assert.deepEqual(promoted.failures, []);
  assert.equal(promoted.promoted, true);
  assert.equal(capabilityFor('organizationalBranding#file', 'update').claim, 'live-qualified');
});

test('issue #294: --live-evidence never promotes a record that has a sibling demotion', async () => {
  const step = buildLiveGatePlan().steps.find((candidate) => candidate.id === 'roleDefinition:update');
  const passed = await capture(step);
  assert.equal(passed.status, 'captured');
  const dir = mkdtempSync(join(tmpdir(), 'entra-live-'));
  writeFileSync(join(dir, 'roleDefinition.update.json'), JSON.stringify(passed.record));
  writeFileSync(join(dir, 'roleDefinition.update.capture.json'), passed.captureLog);
  writeFileSync(join(dir, 'roleDefinition.update.demotion.json'), JSON.stringify(
    demotionRecord({ resourceType: 'roleDefinition', operation: 'update', reason: 'the read-back passed but the live state is wider than the backup', now: NOW }),
  ));
  const apply = () => applyCommittedEvidence({ dir, hmacKey: HMAC_KEY, now: NOW, tenantRef: FIXTURE_TENANT_REF, testTenantRefs: TEST_REFS });

  const before = capabilityFor('roleDefinition', 'update').claim;
  const [demoted] = apply();
  assert.equal(demoted.promoted, false);
  assert.match(demoted.failures.join(' '), /roleDefinition\.update\.demotion\.json demotes this write/);
  assert.equal(demoted.after, before);
  assert.equal(capabilityFor('roleDefinition', 'update').claim, before, 'the claim is untouched');

  // A demotion dated before the record is an earlier failed run; the record is the
  // verified rerun of the fixed write and promotes (#148, the release ledger's rule).
  writeFileSync(join(dir, 'roleDefinition.update.demotion.json'), JSON.stringify(
    demotionRecord({ resourceType: 'roleDefinition', operation: 'update', reason: 'an earlier run failed before the fix', now: new Date(Date.parse(passed.record.observedAt) - 60 * 1000) }),
  ));
  const [rerun] = apply();
  assert.deepEqual(rerun.failures, []);
  assert.equal(rerun.promoted, true);
  assert.equal(rerun.after, 'live-qualified');

  // The same record, without the demotion, does promote: the demotion alone blocked it.
  rmSync(join(dir, 'roleDefinition.update.demotion.json'));
  const [promoted] = apply();
  assert.deepEqual(promoted.failures, []);
  assert.equal(promoted.promoted, true);
  assert.equal(promoted.after, 'live-qualified');
});

test('the three Entra writes the test tenant cannot run are recorded as tenant limits (#148)', () => {
  const ledger = buildOperationLedger();
  for (const type of ['identitySecurityDefaultsEnforcementPolicy', 'authenticationFlowsPolicy', 'roleAssignment']) {
    const failure = TYPE_DECISIONS[type].liveFailures?.update;
    assert.ok(failure, `${type} update has a live note`);
    assert.match(failure.reason, /^tenant limit: /, `${type}: says it is a tenant limit`);
    assert.equal(failure.fix, null, `${type}: a tenant limit names no fix`);
    const row = ledger.types.find((entry) => entry.resourceType === type).operations.find((op) => op.operation === 'update');
    assert.equal(row.decision, 'supported', `${type} update stays registered`);
    assert.equal(row.claim, 'fixture-tested', `${type} update claim is not lowered or raised`);
    assert.equal(row.live.result, 'failed');
  }
});
