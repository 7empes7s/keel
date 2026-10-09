// Issue #148: the Entra live gate, end to end, with fixtures only. No tenant,
// no Graph, no database: the restore artifact and its rollback journal are
// in-memory fixtures shaped like the rows keel-restore writes.
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { CATALOG } from '../../tools/tenant-probe/catalog.mjs';
import {
  EDGE_OPERATIONS, OPERATIONS, capabilityFor, edgeCapabilityKey, isSupportedClaim, recordFixtureProof, registerOperationCapability,
} from '../coverage/capabilities.mjs';
import { buildOperationLedger } from '../coverage/qualification.mjs';
import { ENFORCEMENT_STEP } from '../restore/conditionalAccessEnforcement.mjs';
import { tenantRefFor } from '../store/tenantRef.mjs';
import {
  ENTRA_LIVE_KIND, LiveGateRefusal, TEST_TENANT_REFS, applyCommittedEvidence, captureLive, captureOffline,
  demotionRecord, main as entraLiveMain, promoteRecord, unappliedDemotions,
} from '../../tools/qualification/entraLive.mjs';
import { buildLiveGatePlan, guidanceFor, main as planMain } from '../../tools/qualification/live-gate-plan.mjs';

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
function fixtureRestore(step, { outcome = 'succeeded', tenantId = FIXTURE_TENANT_ID, naturalKey = null, displayName = null } = {}) {
  const restoreRef = '0f0e0d0c-0b0a-4908-8706-050403020100';
  const edge = step.resourceType.includes('#');
  const family = edge ? step.resourceType.split('#')[1] : null;
  const key = naturalKey ?? (/\s|</.test(step.select) ? `fixture-key-${step.resourceType}` : step.select);
  const name = displayName ?? (step.fixtureKind === 'named-object' ? `${key}` : null);
  const targetId = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
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
      : { id: targetId, ...(name ? { displayName: name } : {}), description: 'before', tenantHint: `https://login.microsoftonline.com/${tenantId}/` },
    intendedState: edge ? null : { ...(name ? { displayName: name } : {}), description: 'after' },
    postState: edge ? null : { id: targetId, ...(name ? { displayName: name } : {}), description: 'after' },
    outcome,
    outcomeDetail: outcome === 'succeeded' ? null : 'status 400',
    recordedAt: new Date(NOW.getTime() - 60_000),
  };
  return {
    key,
    restoreRef,
    getArtifact: async (_client, { id }) => (id === restoreRef
      ? { id, tenantRef: tenantRefFor(tenantId), conditionalAccessEnforcement: step.operation === ENFORCEMENT_STEP ? { naturalKey: key } : null }
      : null),
    getJournal: async (_client, { restoreRef: ref }) => (ref === restoreRef ? [entry] : []),
  };
}

async function capture(step, options = {}) {
  const restore = fixtureRestore(step, options);
  return captureLive({
    client: {}, restoreRef: restore.restoreRef, resourceType: step.resourceType, operation: step.operation, fixture: restore.key,
    targetConfig: { tenantId: options.configTenantId ?? FIXTURE_TENANT_ID }, build: BUILD, hmacKey: HMAC_KEY,
    allowTenantSetting: step.fixtureKind === 'tenant-setting', allowByReference: step.fixtureKind === 'by-reference',
    testTenantRefs: options.testTenantRefs ?? TEST_REFS, getArtifact: restore.getArtifact, getJournal: restore.getJournal,
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
  assert.deepEqual([...picked.keys()].sort(), [
    'administrative-configuration', 'device-management', 'identity-application', 'lockout-sensitive', 'policy', 'policy-subtype', 'relationship',
  ]);

  for (const [family, step] of picked) {
    const before = ledgerRow(step.resourceType, step.operation);
    assert.equal(before.claim, 'fixture-tested', `${family}: starts fixture-tested`);
    assert.equal(before.live.result, 'none');

    const result = await capture(step);
    assert.equal(result.status, 'captured', `${family}: ${step.id}`);
    assert.equal(result.record.kind, ENTRA_LIVE_KIND);
    assert.equal(result.record.synthetic, false);
    assert.equal(result.record.tenantRef, FIXTURE_TENANT_REF);
    const written = `${JSON.stringify(result.record)}${result.captureLog}`;
    assert.ok(!written.includes(FIXTURE_TENANT_ID), `${family}: the raw tenant id is pseudonymized`);
    assert.ok(!written.includes('aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'), `${family}: object ids are pseudonymized`);

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
    getArtifact: restore.getArtifact, getJournal: restore.getJournal,
  }), /--allow-tenant-setting/);

  const missing = await captureLive({
    client: {}, restoreRef: restore.restoreRef, resourceType: setting.resourceType, operation: 'update', fixture: 'some-other-key',
    targetConfig: { tenantId: FIXTURE_TENANT_ID }, build: BUILD, hmacKey: HMAC_KEY, testTenantRefs: TEST_REFS,
    getArtifact: restore.getArtifact, getJournal: restore.getJournal, allowTenantSetting: true,
  });
  assert.equal(missing.status, 'not-exercised');

  await assert.rejects(capture({ ...group, resourceType: 'domain', operation: 'update' }), /not a registered write/);
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
});

test('committed demotions are applied, and committed records only verify with the key', () => {
  const dir = join(ROOT, 'docs/release/qualifications/entra-live');
  assert.deepEqual(unappliedDemotions({ dir }), []);
  for (const result of applyCommittedEvidence({ dir, hmacKey: null })) {
    assert.equal(result.promoted, false, `${result.file} must not verify without the key`);
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
  assert.ok(!before.steps.some((step) => step.id === 'servicePrincipal:update'));
  registerOperationCapability({ resourceType: 'servicePrincipal', operation: 'update', path: '/servicePrincipals', handler: 'fixture#handler', idOutcome: 'preserved' });
  recordFixtureProof('servicePrincipal', 'update', 'engine/roadmap/entra-live-gate.test.mjs');
  const after = buildLiveGatePlan();
  assert.equal(after.operationCount, before.operationCount + 1);
  const added = after.steps.find((step) => step.id === 'servicePrincipal:update');
  assert.ok(added);
  assert.match(added.promote, /servicePrincipal\.update\.json/);
});
