/**
 * Roadmap task-74 boundary tests: least-privilege onboarding prerequisite
 * planner. Exercises the production engine/bootstrap/prerequisites.mjs and
 * engine/bootstrap/plan.mjs plus the tools/tenant-probe/auth.mjs token guard
 * against adversarial fixtures through injected read adapters — the real
 * integration seam the planner uses instead of calling Graph — including the
 * three required mutation checks:
 *
 * - Treat admin consent as all workload authority.
 * - Recreate existing app unconditionally.
 * - Log token in prerequisite report.
 *
 * No live tenant is touched; every adapter below is a fake (Global Constraint
 * #2). Conditional Access is never enforced.
 */
import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import {
  BOOTSTRAP_CONTRACT_VERSION, BOOTSTRAP_ROLE_TEMPLATES, CONSENT_SATISFIES, FORBIDDEN_BROAD_GRANTS,
  GRANT_KINDS, GRAPH_RESOURCE_APP_ID, derivedGrantsFor, prerequisiteForWorkload,
  registerWorkloadPrerequisite,
} from '../bootstrap/prerequisites.mjs';
import { PLAN_STEP_KINDS, PLAN_STEP_STATES, planBootstrap } from '../bootstrap/plan.mjs';
import { CrossTenantObservationError } from '../contracts/observation.mjs';
import { assertTokenFree } from '../../tools/tenant-probe/auth.mjs';

const TENANT = 'sha256:bootstrap-plan-test';
const OTHER_TENANT = 'sha256:bootstrap-plan-other';
const NOW = new Date('2026-09-25T12:00:00.000Z');
const OPERATOR = 'operator-principal-1';

const COLLECTOR_SCOPES = [
  'User.Read.All', 'Group.Read.All', 'RoleManagement.Read.Directory', 'Policy.Read.All',
];
const INTUNE_SCOPES = [
  'DeviceManagementConfiguration.Read.All', 'DeviceManagementManagedDevices.Read.All',
];
const ALL_COLLECTOR_SCOPES = [...COLLECTOR_SCOPES, ...INTUNE_SCOPES].sort();

// A JWT-shaped fixture token. Never a real credential — used to prove the
// token guard fires and that adapter state can never leak it into a plan.
const FAKE_TOKEN = 'eyJhbGciOiJSUzI1NiJ9.eyJhdWQiOiJ0ZXN0In0.c2lnbmF0dXJl';

const collectorApp = (overrides = {}) => ({
  id: 'app-obj-1',
  appId: 'app-id-1',
  displayName: 'keel-collector',
  requiredResourceAccess: [{ resourceAppId: GRAPH_RESOURCE_APP_ID, scopes: [...ALL_COLLECTOR_SCOPES] }],
  keelPermissions: ['keel.collect'],
  ...overrides,
});
const collectorSp = { id: 'sp-1', appId: 'app-id-1', displayName: 'keel-collector' };
const consentFor = (spId, scopes) => scopes.map((scope) => ({
  principalId: spId, resourceAppId: GRAPH_RESOURCE_APP_ID, scope,
}));

/** Fake read-adapter set — the only window into tenant state the planner gets. */
function fakeAdapters({
  applications = [], servicePrincipals = [], appRoleAssignments = [],
  roleAssignments = [], roleEligibilitySchedules = [], subscribedSkus = [],
} = {}) {
  const calls = [];
  const wrap = (name, records) => async () => { calls.push(name); return records; };
  return {
    calls,
    listApplications: wrap('listApplications', applications),
    listServicePrincipals: wrap('listServicePrincipals', servicePrincipals),
    listAppRoleAssignments: wrap('listAppRoleAssignments', appRoleAssignments),
    listRoleAssignments: wrap('listRoleAssignments', roleAssignments),
    listRoleEligibilitySchedules: wrap('listRoleEligibilitySchedules', roleEligibilitySchedules),
    listSubscribedSkus: wrap('listSubscribedSkus', subscribedSkus),
  };
}

/** Fully onboarded collector state: correct registration, SP, consent, Intune role. */
function fullySatisfiedAdapters() {
  return fakeAdapters({
    applications: [collectorApp()],
    servicePrincipals: [collectorSp],
    appRoleAssignments: consentFor('sp-1', ALL_COLLECTOR_SCOPES),
    roleAssignments: [{ principalId: 'sp-1', displayName: 'Read Only Operator' }],
    subscribedSkus: [{ skuPartNumber: 'SPE_E5', servicePlans: [] }],
  });
}

const COLLECT_WORKLOADS = ['entra-collect', 'intune-collect'];
const stepsOf = (plan, kind) => plan.steps.filter((s) => s.kind === kind);

test('unidentified operator never matches null-principal standing or PIM eligibility records', async () => {
  for (const source of ['roleAssignments', 'roleEligibilitySchedules']) {
    const plan = await planBootstrap({
      tenantRef: TENANT, workloads: ['entra-restore'], operatorPrincipalId: null, now: NOW,
      readAdapters: fakeAdapters({
        [source]: [{ principalId: null, roleDefinitionId: BOOTSTRAP_ROLE_TEMPLATES.privilegedRoleAdministrator }],
      }),
    });
    const pim = stepsOf(plan, 'pim-activation')[0];
    assert.equal(pim.status, 'pending-manual', source);
    assert.match(pim.note, /Operator not identified/);
    assert.deepEqual(plan.manualPrerequisites, [
      { step: pim.id, kind: 'pim-activation', name: 'Privileged Role Administrator', action: 'pim-activate' },
    ], source);
  }
});

test('finished-plan token guard rejects credential material in projected adapter fields', async () => {
  // These fields survive projection. Unlike discarded accessToken fields,
  // only the finished-plan guard prevents these malformed reader values
  // from being returned to a caller. All credentials are synthetic fixtures.
  const cases = [
    { applications: [collectorApp({ id: FAKE_TOKEN })] },
    { applications: [collectorApp({ id: { clientSecret: 'fixture-opaque-secret' } })] },
    { applications: [collectorApp()], servicePrincipals: [{ ...collectorSp, id: FAKE_TOKEN }] },
    { applications: [collectorApp()], servicePrincipals: [collectorSp],
      appRoleAssignments: consentFor('sp-1', [FAKE_TOKEN]) },
    { subscribedSkus: [{ skuPartNumber: FAKE_TOKEN }] },
  ];
  for (const fixture of cases) {
    await assert.rejects(
      () => planBootstrap({
        tenantRef: TENANT, workloads: COLLECT_WORKLOADS,
        readAdapters: fakeAdapters(fixture), now: NOW,
      }),
      (error) => {
        assert.ok(error instanceof TypeError);
        assert.match(error.message, /bootstrap plan.*(token-shaped|secret-named field)/);
        assert.ok(!error.message.includes(FAKE_TOKEN));
        assert.ok(!error.message.includes('fixture-opaque-secret'));
        return true;
      },
    );
  }
});

test('returned steps and nested plan records cannot be changed to bypass prerequisites', async () => {
  const plan = await planBootstrap({
    tenantRef: TENANT, workloads: [...COLLECT_WORKLOADS, 'entra-restore'], now: NOW,
    readAdapters: fakeAdapters({ applications: [collectorApp()], servicePrincipals: [collectorSp] }),
  });
  const before = JSON.stringify(plan);
  const assertDeeplyFrozen = (value) => {
    if (value === null || typeof value !== 'object') return;
    assert.ok(Object.isFrozen(value), 'every nested object and array is frozen');
    Object.values(value).forEach(assertDeeplyFrozen);
  };
  assertDeeplyFrozen(plan);
  for (const step of plan.steps) {
    assert.throws(() => { step.status = 'satisfied'; }, TypeError);
  }
  const registration = stepsOf(plan, 'registration').find((step) => step.identity === 'collector');
  assert.throws(() => { registration.reference.objectId = 'replacement-app'; }, TypeError);
  assert.throws(() => { registration.operatorRoles[0].templateId = 'replacement-role'; }, TypeError);
  assert.throws(() => { registration.requiredScopes.push('Directory.ReadWrite.All'); }, TypeError);
  assert.throws(() => { plan.manualPrerequisites[0].action = 'skip'; }, TypeError);
  assert.throws(() => { plan.source[0].url = 'https://invalid.example'; }, TypeError);
  assert.equal(JSON.stringify(plan), before, 'failed mutations leave the complete plan unchanged');
  assert.ok(plan.steps.some((step) => step.status === 'pending-manual'));
});

// ---------------------------------------------------------------------------
// Registry: versioned, source-linked, four distinguished grant kinds
// ---------------------------------------------------------------------------

test('prerequisite registry is versioned, source-linked and distinguishes the four grant kinds', () => {
  assert.deepEqual([...GRANT_KINDS], ['graph-permission', 'workload-rbac', 'pim-activation', 'keel-app-permission']);
  assert.deepEqual([...CONSENT_SATISFIES], ['graph-permission'],
    'admin consent satisfies Graph permission grants only');

  const entra = prerequisiteForWorkload('entra-collect');
  assert.equal(entra.contractVersion, BOOTSTRAP_CONTRACT_VERSION);
  assert.equal(entra.identity, 'collector');
  assert.ok(entra.graphPermissions.includes('RoleManagement.Read.Directory'));
  assert.match(entra.source.url, /^https:\/\/learn\.microsoft\.com\//);
  assert.ok(!Number.isNaN(Date.parse(entra.source.retrievedAt)), 'retrieval date recorded');

  const intune = prerequisiteForWorkload('intune-collect');
  assert.equal(intune.workloadRoles[0].displayName, 'Read Only Operator');
  assert.equal(intune.workloadRoles[0].resolution, 'workload-lookup',
    'per-tenant workload role ids are resolved at execution, never invented');

  const restore = prerequisiteForWorkload('entra-restore');
  assert.equal(restore.identity, 'restorer');
  assert.ok(restore.pimActivations.some((r) => r.templateId === BOOTSTRAP_ROLE_TEMPLATES.privilegedRoleAdministrator));

  assert.equal(prerequisiteForWorkload('not-a-workload'), null);
});

test('registration refuses forbidden broad grants, write scopes on the collector and unsourced entries', () => {
  const source = { url: 'https://learn.microsoft.com/en-us/graph/permissions-reference', retrievedAt: '2026-09-25' };
  assert.throws(
    () => registerWorkloadPrerequisite({ workload: 'test-broad', identity: 'restorer', graphPermissions: ['Directory.ReadWrite.All'], source }),
    /forbidden broad grant/,
  );
  assert.throws(
    // Credential separation: a collector registration can never carry a write
    // scope — read and write credentials must not collapse into one identity.
    () => registerWorkloadPrerequisite({ workload: 'test-collapse', identity: 'collector', graphPermissions: ['Group.ReadWrite.All'], source }),
    /collector identity is read-only/,
  );
  assert.throws(
    () => registerWorkloadPrerequisite({ workload: 'test-identity', identity: 'both', graphPermissions: [], source }),
    /collector\/restorer/,
  );
  assert.throws(
    () => registerWorkloadPrerequisite({ workload: 'test-source', identity: 'collector' }),
    /source/,
  );
  assert.throws(
    () => registerWorkloadPrerequisite({ workload: 'entra-collect', identity: 'collector', source }),
    /already registered/,
  );
  assert.throws(
    () => registerWorkloadPrerequisite({ workload: 'test-keel', identity: 'collector', keelAppPermissions: ['not-keel-scoped'], source }),
    /keel\.\*/,
  );
  for (const grant of FORBIDDEN_BROAD_GRANTS) {
    assert.ok(typeof grant === 'string' && grant.length > 0);
  }
});

// ---------------------------------------------------------------------------
// Planner boundary: tenant scoping, injected adapters, requested grants
// ---------------------------------------------------------------------------

test('planner refuses a raw tenant id, empty workloads and a missing read adapter', async () => {
  await assert.rejects(
    () => planBootstrap({ tenantRef: 'raw-tenant-id', workloads: COLLECT_WORKLOADS, readAdapters: fakeAdapters(), now: NOW }),
    TypeError,
    'a raw (unhashed) tenant id can never anchor a plan',
  );
  await assert.rejects(
    () => planBootstrap({ tenantRef: TENANT, workloads: [], readAdapters: fakeAdapters(), now: NOW }),
    /non-empty workload list/,
  );
  await assert.rejects(
    () => planBootstrap({ tenantRef: TENANT, workloads: COLLECT_WORKLOADS, readAdapters: {}, now: NOW }),
    /injected read adapter/,
    'the planner never calls Microsoft Graph directly',
  );
  await assert.rejects(
    () => planBootstrap({ tenantRef: TENANT, workloads: ['not-a-workload'], readAdapters: fakeAdapters(), now: NOW }),
    /no registered workload prerequisite/,
  );
});

test('planner reads state exclusively through the injected adapters', async () => {
  const adapters = fullySatisfiedAdapters();
  await planBootstrap({ tenantRef: TENANT, workloads: COLLECT_WORKLOADS, readAdapters: adapters, now: NOW });
  assert.deepEqual(adapters.calls.sort(), [
    'listAppRoleAssignments', 'listApplications', 'listRoleAssignments',
    'listRoleEligibilitySchedules', 'listServicePrincipals', 'listSubscribedSkus',
  ]);
});

test('cross-tenant adapter state refuses the plan instead of informing it', async () => {
  const adapters = fakeAdapters({ applications: [collectorApp({ tenantRef: OTHER_TENANT })] });
  await assert.rejects(
    () => planBootstrap({ tenantRef: TENANT, workloads: COLLECT_WORKLOADS, readAdapters: adapters, now: NOW }),
    CrossTenantObservationError,
  );
});

test('acceptance: a plan requesting unrelated broad grants is rejected before any state is read', async () => {
  for (const requestedGrants of [['Directory.ReadWrite.All'], ['User.ReadWrite.All'], ['keel.admin']]) {
    const adapters = fullySatisfiedAdapters();
    await assert.rejects(
      () => planBootstrap({ tenantRef: TENANT, workloads: COLLECT_WORKLOADS, readAdapters: adapters, requestedGrants, now: NOW }),
      /forbidden broad grant|not derived from any registered workload prerequisite/,
      `${requestedGrants} must be rejected`,
    );
    assert.equal(adapters.calls.length, 0, 'rejected before the tenant is even inspected');
  }
  // A subset of the derived grants is legitimate (scoped-down onboarding).
  const derived = derivedGrantsFor([prerequisiteForWorkload('entra-collect')]);
  assert.ok(derived.has('graph-permission:User.Read.All'));
  const plan = await planBootstrap({
    tenantRef: TENANT, workloads: COLLECT_WORKLOADS, readAdapters: fullySatisfiedAdapters(),
    requestedGrants: ['User.Read.All', 'keel.collect'], now: NOW,
  });
  assert.equal(plan.tenantRef, TENANT);
});

// ---------------------------------------------------------------------------
// Acceptance: reuse, explicit missing prerequisites, SKU is no substitute
// ---------------------------------------------------------------------------

test('acceptance: an existing correct registration is reused, never recreated', async () => {
  const plan = await planBootstrap({ tenantRef: TENANT, workloads: COLLECT_WORKLOADS, readAdapters: fullySatisfiedAdapters(), now: NOW });
  const registration = stepsOf(plan, 'registration')[0];
  assert.equal(registration.status, 'satisfied');
  assert.equal(registration.action, 'reuse-existing');
  assert.equal(registration.reference.appId, 'app-id-1');
  assert.equal(registration.servicePrincipalObjectId, 'sp-1');
  assert.ok(plan.steps.every((s) => s.action !== 'create-registration'),
    'no step recreates or replaces the existing registration');
  // Reference-only projection: exactly ids and display name, nothing else the
  // adapter returned (e.g. requiredResourceAccess internals) is carried.
  assert.deepEqual(Object.keys(registration.reference).sort(), ['appId', 'displayName', 'objectId']);
  assert.ok(plan.steps.every((s) => s.status === 'satisfied'), 'fully onboarded state closes every step');
  assert.deepEqual(plan.manualPrerequisites, []);
});

test('mutation pin (2): an existing but incomplete registration is updated, never recreated', async () => {
  const incomplete = collectorApp({
    requiredResourceAccess: [{ resourceAppId: GRAPH_RESOURCE_APP_ID, scopes: [...COLLECTOR_SCOPES] }],
  });
  const plan = await planBootstrap({
    tenantRef: TENANT, workloads: COLLECT_WORKLOADS,
    readAdapters: fakeAdapters({
      applications: [incomplete],
      servicePrincipals: [collectorSp],
      appRoleAssignments: consentFor('sp-1', ALL_COLLECTOR_SCOPES),
      roleAssignments: [{ principalId: 'sp-1', displayName: 'Read Only Operator' }],
    }),
    now: NOW,
  });
  const registration = stepsOf(plan, 'registration')[0];
  assert.equal(registration.status, 'pending-provisioning');
  assert.equal(registration.action, 'update-required-access',
    'the existing app is widened, not recreated');
  assert.deepEqual(registration.missingFromRegistration, INTUNE_SCOPES);
  assert.equal(registration.reference.appId, 'app-id-1');
  assert.ok(plan.steps.every((s) => s.action !== 'create-registration'));
});

test('missing consent, role and PIM prerequisites stay explicit named steps', async () => {
  const plan = await planBootstrap({
    tenantRef: TENANT, workloads: ['entra-restore'],
    readAdapters: fakeAdapters(), operatorPrincipalId: OPERATOR, now: NOW,
  });
  const registration = stepsOf(plan, 'registration')[0];
  assert.equal(registration.action, 'create-registration');
  assert.ok(registration.operatorRoles.some((r) => r.displayName === 'Application Administrator'),
    'creating a registration names its privileged operator role');

  const consent = stepsOf(plan, 'graph-permission')[0];
  assert.equal(consent.status, 'pending-consent');
  assert.ok(consent.missingScopes.includes('RoleManagement.ReadWrite.Directory'));

  const pim = stepsOf(plan, 'pim-activation')[0];
  assert.equal(pim.status, 'pending-manual');
  assert.equal(pim.name, 'Privileged Role Administrator');
  assert.deepEqual(plan.manualPrerequisites, [
    { step: pim.id, kind: 'pim-activation', name: 'Privileged Role Administrator', action: 'pim-activate' },
  ]);

  const keel = stepsOf(plan, 'keel-app-permission')[0];
  assert.equal(keel.status, 'pending-provisioning');
  assert.equal(keel.name, 'keel.restore');
});

test('mutation pin (1): complete admin consent is NOT all workload authority', async () => {
  // Every Graph scope consented; no Intune role assignment, no PIM standing.
  const plan = await planBootstrap({
    tenantRef: TENANT, workloads: COLLECT_WORKLOADS,
    readAdapters: fakeAdapters({
      applications: [collectorApp()],
      servicePrincipals: [collectorSp],
      appRoleAssignments: consentFor('sp-1', ALL_COLLECTOR_SCOPES),
    }),
    operatorPrincipalId: OPERATOR, now: NOW,
  });
  assert.equal(stepsOf(plan, 'graph-permission')[0].status, 'satisfied',
    'control: consent really is complete');

  const rbac = stepsOf(plan, 'workload-rbac')[0];
  assert.equal(rbac.status, 'pending-manual', 'consent cannot assign the Intune RBAC role');
  assert.equal(rbac.name, 'Read Only Operator');

  // The consent contract says so in the plan itself.
  assert.deepEqual(plan.consent.satisfiesKinds, ['graph-permission']);
  assert.deepEqual([...plan.consent.neverSatisfies].sort(), ['keel-app-permission', 'pim-activation', 'workload-rbac']);
  assert.match(plan.consent.statement, /only/);
  assert.deepEqual(plan.consent.scopesByIdentity.collector, []);
});

test('pim-activation: standing assignment or PIM eligibility satisfies; an unidentified operator is never assumed', async () => {
  const base = {
    applications: [collectorApp({
      displayName: 'keel-restorer', id: 'app-obj-2', appId: 'app-id-2',
      requiredResourceAccess: [{ resourceAppId: GRAPH_RESOURCE_APP_ID, scopes: ['Group.ReadWrite.All', 'Policy.ReadWrite.ConditionalAccess', 'RoleManagement.ReadWrite.Directory'] }],
      keelPermissions: ['keel.restore'],
    })],
    servicePrincipals: [{ id: 'sp-2', appId: 'app-id-2' }],
    appRoleAssignments: consentFor('sp-2', ['Group.ReadWrite.All', 'Policy.ReadWrite.ConditionalAccess', 'RoleManagement.ReadWrite.Directory']),
  };
  const eligible = await planBootstrap({
    tenantRef: TENANT, workloads: ['entra-restore'],
    readAdapters: fakeAdapters({
      ...base,
      roleEligibilitySchedules: [{ principalId: OPERATOR, roleDefinitionId: BOOTSTRAP_ROLE_TEMPLATES.privilegedRoleAdministrator }],
    }),
    operatorPrincipalId: OPERATOR, now: NOW,
  });
  assert.equal(stepsOf(eligible, 'pim-activation')[0].status, 'satisfied');

  const anonymous = await planBootstrap({
    tenantRef: TENANT, workloads: ['entra-restore'],
    readAdapters: fakeAdapters({
      ...base,
      roleEligibilitySchedules: [{ principalId: OPERATOR, roleDefinitionId: BOOTSTRAP_ROLE_TEMPLATES.privilegedRoleAdministrator }],
    }),
    now: NOW, // no operatorPrincipalId
  });
  const pim = stepsOf(anonymous, 'pim-activation')[0];
  assert.equal(pim.status, 'pending-manual', 'eligibility of an unidentified operator is never assumed');
  assert.match(pim.note, /Operator not identified/);
});

test('acceptance: a purchased SKU can never substitute for a permission', async () => {
  const plan = await planBootstrap({
    tenantRef: TENANT, workloads: COLLECT_WORKLOADS,
    readAdapters: fakeAdapters({
      applications: [collectorApp()],
      servicePrincipals: [collectorSp],
      subscribedSkus: [{ skuPartNumber: 'SPE_E5', servicePlans: [{ servicePlanName: 'AAD_PREMIUM_P2', provisioningStatus: 'Success' }] }],
    }),
    now: NOW,
  });
  const consent = stepsOf(plan, 'graph-permission')[0];
  assert.equal(consent.status, 'pending-consent', 'the E5 SKU does not close a single missing scope');
  assert.deepEqual(consent.missingScopes, ALL_COLLECTOR_SCOPES);
  assert.deepEqual(plan.licensing.observedSkus, ['SPE_E5'], 'the SKU is visible to the operator');
  assert.match(plan.licensing.note, /never satisfies or substitutes/);
});

// ---------------------------------------------------------------------------
// Mutation pin (3): secrets never enter the plan
// ---------------------------------------------------------------------------

test('mutation pin (3): token-shaped and secret-named values cannot enter the prerequisite report', () => {
  // The guard itself: JWT-shaped strings and secret-named fields throw.
  assert.throws(() => assertTokenFree({ token: FAKE_TOKEN }, 'report'), /token-shaped/);
  assert.throws(() => assertTokenFree({ nested: [{ authorization: 'Bearer opaque' }] }, 'report'), /secret-named field/);
  assert.throws(() => assertTokenFree({ clientSecret: 'not-even-a-jwt' }, 'report'), /secret-named field/);
  assert.doesNotThrow(() => assertTokenFree({ appId: 'app-id-1', scopes: ['User.Read.All'] }, 'report'));

  // The seam: adapter state poisoned with a token still yields a token-free
  // plan — the planner projects references only and the finished plan passes
  // the guard before it is returned.
  return planBootstrap({
    tenantRef: TENANT, workloads: COLLECT_WORKLOADS,
    readAdapters: fakeAdapters({
      applications: [collectorApp({ accessToken: FAKE_TOKEN, clientSecretValue: 'fixture-secret' })],
      servicePrincipals: [collectorSp],
      appRoleAssignments: consentFor('sp-1', ALL_COLLECTOR_SCOPES),
      roleAssignments: [{ principalId: 'sp-1', displayName: 'Read Only Operator' }],
    }),
    now: NOW,
  }).then((plan) => {
    const serialized = JSON.stringify(plan);
    assert.ok(!serialized.includes(FAKE_TOKEN), 'the token never appears in the plan');
    assert.ok(!serialized.includes('fixture-secret'), 'the secret value never appears in the plan');
    assert.ok(!serialized.includes('accessToken'), 'secret field names are not carried either');
    assert.equal(plan.credentials.startsWith('references-only'), true);
    assert.doesNotThrow(() => assertTokenFree(plan, 'bootstrap plan'));
  });
});

// ---------------------------------------------------------------------------
// Resumability and credential separation
// ---------------------------------------------------------------------------

test('the plan is resumable: stable planId and step ids as state converges', async () => {
  const before = await planBootstrap({
    tenantRef: TENANT, workloads: COLLECT_WORKLOADS, readAdapters: fakeAdapters(), now: NOW,
  });
  const after = await planBootstrap({
    tenantRef: TENANT, workloads: COLLECT_WORKLOADS, readAdapters: fullySatisfiedAdapters(),
    now: new Date('2026-09-25T13:00:00.000Z'),
  });
  assert.equal(before.planId, after.planId, 'planId is independent of step state and creation time');
  assert.deepEqual(before.steps.map((s) => s.id).sort(), after.steps.map((s) => s.id).sort(),
    'step identities are stable across re-planning — pending steps resume, satisfied steps close');
  const consentBefore = stepsOf(before, 'graph-permission')[0];
  const consentAfter = stepsOf(after, 'graph-permission')[0];
  assert.equal(consentBefore.id, consentAfter.id);
  assert.equal(consentBefore.status, 'pending-consent');
  assert.equal(consentAfter.status, 'satisfied');
  assert.equal(before.resume.resumable, true);
});

test('collector and restorer identities stay separate registrations with separate grants', async () => {
  const plan = await planBootstrap({
    tenantRef: TENANT, workloads: ['entra-collect', 'entra-restore'],
    readAdapters: fakeAdapters(), now: NOW,
  });
  assert.deepEqual(plan.identities, ['collector', 'restorer']);
  const registrations = stepsOf(plan, 'registration');
  assert.deepEqual(registrations.map((s) => s.name).sort(), ['keel-collector', 'keel-restorer'],
    'two registrations — read and write credentials never collapse into one app');

  const collector = registrations.find((s) => s.identity === 'collector');
  assert.ok(collector.requiredScopes.every((scope) => !scope.includes('ReadWrite')),
    'the collector registration carries no write scope');
  const restorerConsent = stepsOf(plan, 'graph-permission').find((s) => s.identity === 'restorer');
  assert.ok(restorerConsent.requiredScopes.includes('RoleManagement.ReadWrite.Directory'));
  const collectorConsent = stepsOf(plan, 'graph-permission').find((s) => s.identity === 'collector');
  assert.ok(!collectorConsent.requiredScopes.includes('RoleManagement.ReadWrite.Directory'));
});

test('plan contract: versioned, tenant-scoped, kind/state vocabulary is closed', async () => {
  const plan = await planBootstrap({ tenantRef: TENANT, workloads: COLLECT_WORKLOADS, readAdapters: fakeAdapters(), now: NOW });
  assert.equal(plan.contractVersion, BOOTSTRAP_CONTRACT_VERSION);
  assert.equal(plan.tenantRef, TENANT);
  assert.equal(plan.createdAt, NOW.toISOString());
  assert.deepEqual(plan.workloads, [...COLLECT_WORKLOADS].sort());
  assert.ok(plan.source.every((s) => s.url.startsWith('https://') && !Number.isNaN(Date.parse(s.retrievedAt))));
  for (const step of plan.steps) {
    assert.ok(PLAN_STEP_KINDS.includes(step.kind), `${step.kind} is a declared step kind`);
    assert.ok(PLAN_STEP_STATES.includes(step.status), `${step.status} is a declared step state`);
    assert.match(step.id, /^step-[0-9a-f]{16}$/);
  }
  assert.match(plan.planId, /^plan-[0-9a-f]{16}$/);
  assert.ok(Object.isFrozen(plan) && Object.isFrozen(plan.steps), 'the plan is immutable');
});

// ---------------------------------------------------------------------------
// Mutation pins: principal/resource scoping of satisfaction checks
//
// A satisfaction check that ignores WHO holds a grant or WHICH resource the
// grant is declared against lets one identity's (or one resource's) authority
// masquerade as another's — the exact over-claim this task exists to prevent.
// ---------------------------------------------------------------------------

test('cross-tenant records from ANY read adapter refuse the plan, never inform it', async () => {
  // Independent coverage per adapter: dropping assertSameTenant on any one
  // read (e.g. listRoleEligibilitySchedules silently accepting a cross-tenant
  // PIM eligibility record) must fail here.
  const crossTenantFixtures = {
    applications: [collectorApp({ tenantRef: OTHER_TENANT })],
    servicePrincipals: [{ ...collectorSp, tenantRef: OTHER_TENANT }],
    appRoleAssignments: [{ principalId: 'sp-1', resourceAppId: GRAPH_RESOURCE_APP_ID, scope: 'User.Read.All', tenantRef: OTHER_TENANT }],
    roleAssignments: [{ principalId: 'sp-1', displayName: 'Read Only Operator', tenantRef: OTHER_TENANT }],
    roleEligibilitySchedules: [{ principalId: OPERATOR, roleDefinitionId: BOOTSTRAP_ROLE_TEMPLATES.privilegedRoleAdministrator, tenantRef: OTHER_TENANT }],
    subscribedSkus: [{ skuPartNumber: 'SPE_E5', tenantRef: OTHER_TENANT }],
  };
  for (const [adapter, records] of Object.entries(crossTenantFixtures)) {
    await assert.rejects(
      () => planBootstrap({
        tenantRef: TENANT, workloads: COLLECT_WORKLOADS,
        readAdapters: fakeAdapters({ [adapter]: records }),
        operatorPrincipalId: OPERATOR, now: NOW,
      }),
      CrossTenantObservationError,
      `${adapter}: a cross-tenant record is refused, never silently accepted`,
    );
  }
});

test('workload-rbac: only THIS identity principal\'s assignment satisfies the step', async () => {
  // A different principal holding the matching-displayName Intune role must
  // not satisfy the collector's workload-rbac step — dropping the principalId
  // match in the satisfaction check must fail this test.
  const adaptersFor = (principalId) => fakeAdapters({
    applications: [collectorApp()],
    servicePrincipals: [collectorSp],
    appRoleAssignments: consentFor('sp-1', ALL_COLLECTOR_SCOPES),
    roleAssignments: [{ principalId, displayName: 'Read Only Operator' }],
  });

  const otherPrincipal = await planBootstrap({
    tenantRef: TENANT, workloads: COLLECT_WORKLOADS,
    readAdapters: adaptersFor('someone-elses-sp'), now: NOW,
  });
  const rbac = stepsOf(otherPrincipal, 'workload-rbac')[0];
  assert.equal(rbac.status, 'pending-manual',
    "another principal's matching-displayName role assignment never satisfies this identity's step");
  assert.deepEqual(otherPrincipal.manualPrerequisites.map((m) => m.kind), ['workload-rbac']);

  // Control: the same assignment held by THIS identity's service principal satisfies.
  const thisPrincipal = await planBootstrap({
    tenantRef: TENANT, workloads: COLLECT_WORKLOADS,
    readAdapters: adaptersFor('sp-1'), now: NOW,
  });
  assert.equal(stepsOf(thisPrincipal, 'workload-rbac')[0].status, 'satisfied',
    'control: the collector SP holding the role really does satisfy the step');
});

test('graph-permission: consent recorded for another principal or another resource app never satisfies', async () => {
  // Same defect class as the workload-rbac principal pin, on the consent
  // path: appRoleAssignments must match THIS identity's service principal AND
  // the Microsoft Graph resource app.
  const NON_GRAPH_RESOURCE = '00000002-0000-0ff1-ce00-000000000000'; // Office 365 Exchange Online
  const plan = await planBootstrap({
    tenantRef: TENANT, workloads: COLLECT_WORKLOADS,
    readAdapters: fakeAdapters({
      applications: [collectorApp()],
      servicePrincipals: [collectorSp],
      appRoleAssignments: [
        // Every derived scope consented — but to a different principal, and
        // (on a second grant set) against a non-Graph resource app.
        ...consentFor('someone-elses-sp', ALL_COLLECTOR_SCOPES),
        ...ALL_COLLECTOR_SCOPES.map((scope) => ({ principalId: 'sp-1', resourceAppId: NON_GRAPH_RESOURCE, scope })),
      ],
      roleAssignments: [{ principalId: 'sp-1', displayName: 'Read Only Operator' }],
    }),
    now: NOW,
  });
  const consent = stepsOf(plan, 'graph-permission')[0];
  assert.equal(consent.status, 'pending-consent',
    "grants for another principal or another resource app never count toward this identity's Graph consent");
  assert.deepEqual(consent.missingScopes, ALL_COLLECTOR_SCOPES);
  assert.deepEqual(consent.consentedScopes, []);
});

test('registration completeness counts only scopes declared against Microsoft Graph', async () => {
  // Every derived scope IS present in requiredResourceAccess — but under a
  // non-Graph resourceAppId. Dropping the resourceAppId filter in
  // requiredScopesFor would count them toward Graph permission completeness.
  const NON_GRAPH_RESOURCE = '00000002-0000-0ff1-ce00-000000000000';
  const foreignResourceApp = collectorApp({
    requiredResourceAccess: [{ resourceAppId: NON_GRAPH_RESOURCE, scopes: [...ALL_COLLECTOR_SCOPES] }],
  });
  const plan = await planBootstrap({
    tenantRef: TENANT, workloads: COLLECT_WORKLOADS,
    readAdapters: fakeAdapters({
      applications: [foreignResourceApp],
      servicePrincipals: [collectorSp],
      appRoleAssignments: consentFor('sp-1', ALL_COLLECTOR_SCOPES),
      roleAssignments: [{ principalId: 'sp-1', displayName: 'Read Only Operator' }],
    }),
    now: NOW,
  });
  const registration = stepsOf(plan, 'registration')[0];
  assert.equal(registration.status, 'pending-provisioning',
    'scopes declared for a non-Graph resource never count toward Graph registration completeness');
  assert.equal(registration.action, 'update-required-access');
  assert.deepEqual(registration.missingFromRegistration, ALL_COLLECTOR_SCOPES,
    'every derived scope is still missing from the Graph resource access');

  // Control: the same scopes under the Graph resource app complete the registration.
  const satisfied = await planBootstrap({
    tenantRef: TENANT, workloads: COLLECT_WORKLOADS, readAdapters: fullySatisfiedAdapters(), now: NOW,
  });
  assert.equal(stepsOf(satisfied, 'registration')[0].status, 'satisfied',
    'control: scopes under the Graph resource app really do satisfy');
});

// Requeued review: pin both role-template branches and app/SP completeness.
test('directory-role-template RBAC requires the matching template on the matching service principal', async () => {
  const workload = 'fixture-directory-role-collect';
  const templateId = BOOTSTRAP_ROLE_TEMPLATES.applicationAdministrator;
  const displayName = 'Fixture directory role';
  // Synthetic requirement exercises the supported registry branch without
  // claiming that a production collector needs this privileged role.
  registerWorkloadPrerequisite({
    workload, identity: 'collector',
    workloadRoles: [{ displayName, resolution: 'directory-role-template', templateId }],
    source: { url: 'https://learn.microsoft.com/en-us/entra/identity/role-based-access-control/permissions-reference', retrievedAt: '2026-09-25' },
  });
  const cases = [
    { name: 'absent assignment', assignments: [], status: 'pending-manual' },
    { name: 'matching name with wrong template', assignments: [{ principalId: 'sp-1', displayName, roleDefinitionId: BOOTSTRAP_ROLE_TEMPLATES.cloudApplicationAdministrator }], status: 'pending-manual' },
    { name: 'matching template on another principal', assignments: [{ principalId: 'other-sp', displayName, roleDefinitionId: templateId }], status: 'pending-manual' },
    { name: 'matching template with a different display name', assignments: [{ principalId: 'sp-1', displayName: 'Renamed directory role', roleDefinitionId: templateId }], status: 'satisfied' },
  ];
  for (const fixture of cases) {
    const plan = await planBootstrap({
      tenantRef: TENANT, workloads: [workload], now: NOW,
      readAdapters: fakeAdapters({ applications: [collectorApp()], servicePrincipals: [collectorSp], roleAssignments: fixture.assignments }),
    });
    const rbac = stepsOf(plan, 'workload-rbac')[0];
    assert.equal(rbac.resolution, 'directory-role-template');
    assert.equal(rbac.status, fixture.status, fixture.name);
    assert.deepEqual(plan.manualPrerequisites, fixture.status === 'satisfied' ? [] : [
      { step: rbac.id, kind: 'workload-rbac', name: displayName, action: 'assign-workload-role' },
    ], fixture.name);
  }
});

test('PIM standing and eligibility each require the requested role template and identified operator', async () => {
  const templateId = BOOTSTRAP_ROLE_TEMPLATES.privilegedRoleAdministrator;
  // Exercise each source independently: an eligible role must not hide a
  // broken standing-role check (or vice versa).
  for (const source of ['roleAssignments', 'roleEligibilitySchedules']) {
    for (const fixture of [
      { name: 'unrelated privileged role', principalId: OPERATOR, roleDefinitionId: BOOTSTRAP_ROLE_TEMPLATES.applicationAdministrator, status: 'pending-manual' },
      { name: 'required role held by someone else', principalId: 'other-operator', roleDefinitionId: templateId, status: 'pending-manual' },
      { name: 'required role held by this operator', principalId: OPERATOR, roleDefinitionId: templateId, status: 'satisfied' },
      { name: 'Global Administrator held by this operator', principalId: OPERATOR, roleDefinitionId: BOOTSTRAP_ROLE_TEMPLATES.globalAdministrator, status: 'satisfied' },
      { name: 'Global Administrator held by someone else', principalId: 'other-operator', roleDefinitionId: BOOTSTRAP_ROLE_TEMPLATES.globalAdministrator, status: 'pending-manual' },
      { name: 'Global Reader held by this operator', principalId: OPERATOR, roleDefinitionId: BOOTSTRAP_ROLE_TEMPLATES.globalReader, status: 'pending-manual' },
    ]) {
      const plan = await planBootstrap({
        tenantRef: TENANT, workloads: ['entra-restore'], operatorPrincipalId: OPERATOR, now: NOW,
        readAdapters: fakeAdapters({ [source]: [{ principalId: fixture.principalId, roleDefinitionId: fixture.roleDefinitionId }] }),
      });
      const pim = stepsOf(plan, 'pim-activation')[0];
      assert.equal(pim.templateId, templateId);
      assert.equal(pim.status, fixture.status, `${source}: ${fixture.name}`);
      assert.deepEqual(plan.manualPrerequisites, fixture.status === 'satisfied' ? [] : [
        { step: pim.id, kind: 'pim-activation', name: 'Privileged Role Administrator', action: 'pim-activate' },
      ], `${source}: ${fixture.name}`);
    }
  }
});

test('complete app registration stays pending until its matching service principal exists', async () => {
  const plans = [];
  for (const servicePrincipals of [
    [],
    [{ ...collectorSp, appId: 'unrelated-app-id' }],
    [collectorSp],
  ]) {
    const plan = await planBootstrap({
      tenantRef: TENANT, workloads: COLLECT_WORKLOADS, now: NOW,
      readAdapters: fakeAdapters({
        applications: [collectorApp()], servicePrincipals,
        appRoleAssignments: consentFor('sp-1', ALL_COLLECTOR_SCOPES),
        roleAssignments: [{ principalId: 'sp-1', displayName: 'Read Only Operator' }],
      }),
    });
    const registration = stepsOf(plan, 'registration')[0];
    const matched = servicePrincipals.some((sp) => sp.appId === collectorSp.appId);
    assert.equal(registration.status, matched ? 'satisfied' : 'pending-provisioning');
    assert.equal(registration.action, matched ? 'reuse-existing' : 'update-required-access');
    assert.equal(registration.servicePrincipalObjectId, matched ? 'sp-1' : null);
    assert.equal(registration.reference.objectId, 'app-obj-1', 'retain the existing application');
    assert.deepEqual(registration.missingFromRegistration, [], 'all requested scopes are already declared');
    assert.equal(stepsOf(plan, 'graph-permission')[0].status, matched ? 'satisfied' : 'pending-consent');
    assert.equal(stepsOf(plan, 'workload-rbac')[0].status, matched ? 'satisfied' : 'pending-manual');
    plans.push(plan);
  }
  for (const plan of plans.slice(1)) {
    assert.equal(plan.planId, plans[0].planId, 're-observation resumes the same plan');
    assert.deepEqual(plan.steps.map((step) => step.id), plans[0].steps.map((step) => step.id));
  }
});
