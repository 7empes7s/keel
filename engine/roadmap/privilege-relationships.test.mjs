/**
 * Roadmap task-58 boundary tests: application/service-principal owner, app-role
 * grant and supported Intune assignment observations. Exercises the production
 * relationships.mjs registry/collector/store, diffRelationships, collectSnapshot
 * and the coverage report against the isolated test database, an injected fake
 * reader and the REAL GraphReader (with a stubbed fetch) for pagination —
 * including the three required mutation checks:
 *
 * - Drop assignment filter from projection.
 * - Mark unsupported subtype complete.
 * - Ignore last child page.
 */
import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { after, test } from 'node:test';

import { CATALOG } from '../../tools/tenant-probe/catalog.mjs';
import { GraphReader } from '../../tools/tenant-probe/graph.mjs';
import { DESCRIPTORS } from '../collect/descriptors.mjs';
import '../collect/entraAdapter.mjs';
import { collectSnapshot } from '../collect/snapshot.mjs';
import {
  collectRelationships, recordRelationships, loadRelationshipState, RELATIONSHIP_FAMILIES,
  ASSIGNMENT_PARENT_TYPES,
} from '../collect/relationships.mjs';
import { diffRelationships } from '../govern/diffSnapshots.mjs';
import { buildCoverageReport } from '../coverage/report.mjs';
import { createSnapshot, completeSnapshot } from '../store/db.mjs';
import { createIsolatedTestDatabase } from '../test/dbTestHelper.mjs';

const APP = '11111111-aaaa-aaaa-aaaa-000000000001';
const SP = '22222222-bbbb-bbbb-bbbb-000000000002';
const POLICY = '33333333-cccc-cccc-cccc-000000000003';
const G1 = '44444444-dddd-dddd-dddd-000000000004';
const G2 = '55555555-dddd-dddd-dddd-000000000005';
const F1 = '66666666-eeee-eeee-eeee-000000000006';
const F2 = '77777777-eeee-eeee-eeee-000000000007';
const GRAPH_API = '00000003-0000-0000-c000-000000000000';
const ROLE_A = '88888888-ffff-ffff-ffff-000000000008';
const ROLE_B = '99999999-ffff-ffff-ffff-000000000009';
const U1 = 'aaaaaaaa-0000-0000-0000-000000000001';

const database = await createIsolatedTestDatabase(import.meta.url);
after(async () => { await database.cleanup(); });

async function freshSchema(t) {
  const client = await database.connect();
  t.after(async () => { await client.end(); });
  await client.query(readFileSync(new URL('../store/schema.sql', import.meta.url), 'utf8'));
  return client;
}

const ok = (items, extra = {}) => ({ items, pages: 1, status: 200, capped: false, error: null, ...extra });
const denied = { items: undefined, pages: 0, status: 403, capped: false, error: { status: 403, code: 'Authorization_RequestDenied', error: 'insufficient privileges' } };

function fakeReader(routes, calls = []) {
  return {
    async collect(version, path) {
      calls.push({ version, path });
      const route = routes[path];
      if (route === undefined) return ok([]);
      const value = typeof route === 'function' ? route() : route;
      return Array.isArray(value) ? ok(value) : value;
    },
  };
}

const grant = (resourceId, appRoleId, extra = {}) => ({ id: `grant-${appRoleId}`, resourceId, appRoleId, principalId: SP, ...extra });
const groupTarget = (groupId, { filterId = null, filterType = null, exclusion = false } = {}) => ({
  '@odata.type': exclusion ? '#microsoft.graph.exclusionGroupAssignmentTarget' : '#microsoft.graph.groupAssignmentTarget',
  groupId,
  deviceAndAppManagementAssignmentFilterId: filterId,
  deviceAndAppManagementAssignmentFilterType: filterType ?? 'none',
});
const assignment = (target, extra = {}) => ({ id: `a-${Math.random()}`, target, ...extra });

const paths = {
  appOwner: `/applications/${APP}/owners?$select=id`,
  spOwner: `/servicePrincipals/${SP}/owners?$select=id`,
  grants: `/servicePrincipals/${SP}/appRoleAssignments`,
  config: `/deviceManagement/deviceConfigurations/${POLICY}/assignments`,
  compliance: `/deviceManagement/deviceCompliancePolicies/${POLICY}/assignments`,
  settingsCatalog: `/deviceManagement/configurationPolicies/${POLICY}/assignments`,
  app: `/deviceAppManagement/mobileApps/${POLICY}/assignments`,
};

async function persist(client, tenantRef, observations) {
  const snapshotId = await createSnapshot(client, { tenantRef });
  await completeSnapshot(client, { id: snapshotId, status: 'complete', coverageDigest: {} });
  await recordRelationships(client, { snapshotId, tenantRef, observations });
  return loadRelationshipState(client, { tenantRef });
}

async function observe(client, tenantRef, routes, parents, families) {
  const observations = await collectRelationships(fakeReader(routes), { tenantRef, parents, families });
  return persist(client, tenantRef, observations);
}
const tick = () => new Promise((r) => setTimeout(r, 5));

// ------------------------------------------------ registry: pinned and explicit

test('every family pins endpoint, version and the credential it needs; Intune settings catalog is beta', async () => {
  for (const spec of Object.values(RELATIONSHIP_FAMILIES)) {
    assert.ok(spec.requires.length > 0, `${spec.family} declares a required Graph permission`);
    assert.match(spec.pathFor(APP), /^\/(groups|applications|servicePrincipals)\//);
    assert.equal(spec.version, 'v1.0');
  }
  const calls = [];
  await collectRelationships(fakeReader({}, calls), {
    tenantRef: 'sha256:t', families: ['assignment'],
    parents: ASSIGNMENT_PARENT_TYPES.map((type) => ({ type, sourceId: POLICY })),
  });
  const byPath = new Map(calls.map((c) => [c.path, c.version]));
  assert.equal(byPath.get(paths.config), 'v1.0');
  assert.equal(byPath.get(paths.compliance), 'v1.0');
  assert.equal(byPath.get(paths.settingsCatalog), 'beta');
  assert.equal(byPath.get(paths.app), 'v1.0');
  assert.equal(calls.length, 4, 'exactly the four registered assignment endpoints are read');
});

test('a family only reads parents of its own type', async () => {
  const calls = [];
  const obs = await collectRelationships(fakeReader({}, calls), {
    tenantRef: 'sha256:t', families: ['appOwner', 'appRoleGrant'],
    parents: [{ type: 'application', sourceId: APP }, { type: 'servicePrincipal', sourceId: SP }, { type: 'group', sourceId: G1 }],
  });
  assert.deepEqual(calls.map((c) => c.path).sort(), [paths.appOwner, paths.grants].sort());
  assert.equal(obs.length, 2);
});

// ---------------------------------------------------------------- pagination

test('the real reader walks every page of an assignment list; a page-cap cut is partial, not complete', async (t) => {
  const pages = {
    [`https://graph.microsoft.com/v1.0/deviceManagement/deviceConfigurations/${POLICY}/assignments`]: {
      value: [assignment(groupTarget(G1))], '@odata.nextLink': 'https://graph.microsoft.com/v1.0/page2',
    },
    'https://graph.microsoft.com/v1.0/page2': {
      value: [assignment(groupTarget(G2))], '@odata.nextLink': 'https://graph.microsoft.com/v1.0/page3',
    },
    'https://graph.microsoft.com/v1.0/page3': { value: [assignment({ '@odata.type': '#microsoft.graph.allDevicesAssignmentTarget' })] },
  };
  const realFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = realFetch; });
  globalThis.fetch = async (url) => {
    const body = pages[url];
    return { ok: Boolean(body), status: body ? 200 : 404, headers: new Headers(), statusText: 'x', json: async () => body };
  };
  const reader = new GraphReader(async () => 'test-token');
  const parents = [{ type: 'deviceConfiguration', sourceId: POLICY }];

  const full = (await collectRelationships(reader, { tenantRef: 'sha256:t', parents, families: ['assignment'] }))[0];
  assert.equal(full.outcome, 'complete');
  assert.equal(full.pagesCompleted, 3);
  assert.equal(full.targets.length, 3, 'the last page contributes its edge');
  assert.ok(full.targets.some((x) => x.targetId === 'all-devices'));

  const cut = (await collectRelationships(reader, { tenantRef: 'sha256:t', parents, families: ['assignment'], pageCap: 2 }))[0];
  assert.equal(cut.outcome, 'partial', 'a capped walk never claims completeness');
  assert.equal(cut.targets.length, 2);
  assert.equal(cut.error, 'pagination incomplete');
});

// ------------------------------------------------------------ app grants & owners

test('app grant addition is edge drift of type appRoleGrant, separate from ownership', async (t) => {
  const client = await freshSchema(t);
  const tenantRef = 'sha256:grants';
  const parents = [{ type: 'servicePrincipal', sourceId: SP, naturalKey: 'servicePrincipal:crm' }];
  const families = ['servicePrincipalOwner', 'appRoleGrant'];
  const baseline = await observe(client, tenantRef, { [paths.grants]: [grant(GRAPH_API, ROLE_A)], [paths.spOwner]: [{ id: U1 }] }, parents, families);
  await tick();
  const observed = await observe(client, tenantRef, { [paths.grants]: [grant(GRAPH_API, ROLE_A), grant(GRAPH_API, ROLE_B)], [paths.spOwner]: [{ id: U1 }] }, parents, families);
  const { drift } = diffRelationships(baseline, observed);
  assert.equal(drift.length, 1, 'only the grant changed');
  assert.equal(drift[0].resourceType, 'appRoleGrant');
  assert.equal(drift[0].changeType, 'added');
  assert.equal(drift[0].targetId, GRAPH_API);
  assert.match(drift[0].naturalKey, new RegExp(ROLE_B));
});

test('a createdDateTime on a grant is volatile and never manufactures drift', async (t) => {
  const client = await freshSchema(t);
  const tenantRef = 'sha256:volatile';
  const parents = [{ type: 'servicePrincipal', sourceId: SP }];
  const a = await observe(client, tenantRef, { [paths.grants]: [grant(GRAPH_API, ROLE_A, { createdDateTime: '2026-01-01T00:00:00Z' })] }, parents, ['appRoleGrant']);
  await tick();
  const b = await observe(client, tenantRef, { [paths.grants]: [grant(GRAPH_API, ROLE_A, { createdDateTime: '2026-02-02T00:00:00Z' })] }, parents, ['appRoleGrant']);
  assert.deepEqual(diffRelationships(a, b).drift, []);
});

test('application and service-principal owners are read from their own endpoints', async (t) => {
  const client = await freshSchema(t);
  const tenantRef = 'sha256:owners';
  const state = await observe(client, tenantRef,
    { [paths.appOwner]: [{ id: U1 }], [paths.spOwner]: [] },
    [{ type: 'application', sourceId: APP }, { type: 'servicePrincipal', sourceId: SP }],
    ['appOwner', 'servicePrincipalOwner']);
  assert.equal(state.entries.get(`application:${APP}|appOwner`).targets.length, 1);
  assert.equal(state.entries.get(`servicePrincipal:${SP}|servicePrincipalOwner`).state, 'current');
  assert.deepEqual(state.entries.get(`servicePrincipal:${SP}|servicePrincipalOwner`).targets, []);
});

// ----------------------------------------------------------- Intune assignments

const configParent = [{ type: 'deviceConfiguration', sourceId: POLICY, naturalKey: 'deviceConfiguration:baseline' }];

test('an Intune target change and a filter change are separate edge drift', async (t) => {
  const client = await freshSchema(t);
  const tenantRef = 'sha256:intune';
  const baseline = await observe(client, tenantRef, {
    [paths.config]: [assignment(groupTarget(G1, { filterId: F1, filterType: 'include' }))],
  }, configParent, ['assignment']);
  await tick();

  // (a) same group, different filter: ONE modified edge carrying both filters.
  const filterChanged = await observe(client, tenantRef, {
    [paths.config]: [assignment(groupTarget(G1, { filterId: F2, filterType: 'exclude' }))],
  }, configParent, ['assignment']);
  const filterDrift = diffRelationships(baseline, filterChanged).drift;
  assert.equal(filterDrift.length, 1);
  assert.equal(filterDrift[0].changeType, 'modified');
  assert.equal(filterDrift[0].resourceType, 'policyAssignment');
  assert.equal(filterDrift[0].beforeAttributes.filterId, F1);
  assert.equal(filterDrift[0].beforeAttributes.filterType, 'include');
  assert.equal(filterDrift[0].afterAttributes.filterId, F2);
  assert.equal(filterDrift[0].afterAttributes.filterType, 'exclude');
  assert.equal(filterDrift[0].targetId, G1);
  await tick();

  // (b) different target group: a removed edge and an added edge, no 'modified'.
  const targetChanged = await observe(client, tenantRef, {
    [paths.config]: [assignment(groupTarget(G2, { filterId: F1, filterType: 'include' }))],
  }, configParent, ['assignment']);
  const targetDrift = diffRelationships(filterChanged, targetChanged).drift;
  assert.deepEqual(targetDrift.map((d) => `${d.changeType}:${d.targetId}`).sort(), [`added:${G2}`, `removed:${G1}`]);
  assert.notDeepEqual(filterDrift.map((d) => d.changeType), targetDrift.map((d) => d.changeType), 'the two changes are distinguishable');
});

test('an include and an exclude of the same group are two edges; intent and settings are preserved', async (t) => {
  const client = await freshSchema(t);
  const tenantRef = 'sha256:modes';
  const state = await observe(client, tenantRef, {
    [paths.app]: [
      assignment(groupTarget(G1), { intent: 'required', settings: { notifications: 'showAll' } }),
      assignment(groupTarget(G1, { exclusion: true })),
    ],
  }, [{ type: 'mobileApp', sourceId: POLICY }], ['assignment']);
  const targets = state.entries.get(`mobileApp:${POLICY}|assignment`).targets;
  assert.equal(targets.length, 2, 'include and exclude do not collapse');
  const include = targets.find((x) => x.attributes.mode === 'include');
  assert.equal(include.attributes.intent, 'required');
  assert.match(include.attributes.settingsDigest, /^[0-9a-f]{64}$/);
  assert.equal(targets.find((x) => x.attributes.mode === 'exclude').attributes.settingsDigest, null);
});

test('an unrecognized target type is kept as unknown; an item with no target makes the read partial', async () => {
  const obs = await collectRelationships(fakeReader({
    [paths.config]: [
      assignment({ '@odata.type': '#microsoft.graph.configurationManagerCollectionAssignmentTarget', collectionId: 'SMS00001' }),
      { id: 'no-target' },
    ],
  }), { tenantRef: 'sha256:t', parents: configParent, families: ['assignment'] });
  assert.equal(obs[0].outcome, 'partial');
  assert.equal(obs[0].targets.length, 1);
  assert.equal(obs[0].targets[0].attributes.mode, 'unknown');
  assert.equal(obs[0].targets[0].targetId, 'sms00001');
});

// ------------------------------------------- failed / unsupported coverage

test('a missing permission is failed child coverage with the original Graph code, never empty', async (t) => {
  const client = await freshSchema(t);
  const tenantRef = 'sha256:denied';
  const state = await observe(client, tenantRef, { [paths.grants]: denied }, [{ type: 'servicePrincipal', sourceId: SP }], ['appRoleGrant']);
  const entry = state.entries.get(`servicePrincipal:${SP}|appRoleGrant`);
  assert.equal(entry.state, 'unknown');
  assert.equal(entry.targets, null, 'cardinality unknown, not zero');
  assert.equal(entry.failure.outcome, 'failed');
  assert.equal(entry.failure.graphCode, 'Authorization_RequestDenied');
  assert.equal(entry.failure.httpStatus, 403);
});

test('an unsupported Intune subtype is never read and never complete', async (t) => {
  const client = await freshSchema(t);
  const tenantRef = 'sha256:unsupported';
  const calls = [];
  const obs = await collectRelationships(fakeReader({}, calls), {
    tenantRef, families: ['assignment'],
    parents: [{ type: 'deviceEnrollmentConfiguration', sourceId: POLICY }],
  });
  assert.equal(calls.length, 0, 'no generic endpoint is guessed');
  assert.equal(obs[0].outcome, 'unsupported');
  assert.equal(obs[0].itemCount, null);
  const state = await persist(client, tenantRef, obs);
  const entry = state.entries.get(`deviceEnrollmentConfiguration:${POLICY}|assignment`);
  assert.equal(entry.state, 'unknown');
  assert.equal(entry.targets, null);
  const { drift, unverified } = diffRelationships(state, state);
  assert.deepEqual(drift, []);
  assert.equal(unverified[0].reason, 'unsupported-relationship');
});

// ---------------------------------------------------- snapshot + report wiring

function tenantReader(routes) {
  return {
    async collect(version, path) {
      if (path === '/applications') return ok([{ id: APP, displayName: 'CRM', appId: 'app-1' }]);
      if (path.startsWith('/servicePrincipals?')) return ok([{ id: SP, appId: 'app-1', displayName: 'CRM' }]);
      if (path.startsWith('/deviceManagement/deviceEnrollmentConfigurations')) return ok([{ id: POLICY, displayName: 'Enroll', '@odata.type': '#microsoft.graph.deviceEnrollmentLimitConfiguration' }]);
      const route = routes[path];
      if (route !== undefined) return Array.isArray(route) ? ok(route) : route;
      return ok([]);
    },
  };
}

test('collectSnapshot reads app and SP families opt-in and the report stays partial, never complete', async (t) => {
  const client = await freshSchema(t);
  const tenantRef = 'sha256:snap58';
  const result = await collectSnapshot(client, {
    reader: tenantReader({ [paths.appOwner]: [{ id: U1 }], [paths.grants]: [grant(GRAPH_API, ROLE_A)] }),
    tenantRef, tenantId: 'tid',
    relationships: { families: ['appOwner', 'servicePrincipalOwner', 'appRoleGrant'] },
  });
  assert.equal(result.coverageDigest.application.outcome, 'complete', 'edge reads never alter a type outcome');
  assert.deepEqual(result.relationships, { complete: 2, 'complete-empty': 1 });
  const report = await buildCoverageReport(client, { tenantRef, catalog: CATALOG, descriptors: DESCRIPTORS });
  const application = report.types.find((x) => x.type === 'application');
  const servicePrincipal = report.types.find((x) => x.type === 'servicePrincipal');
  assert.equal(application.relationshipCompleteness, 'partial');
  assert.deepEqual(application.relationships.families.appOwner, { current: 1, stale: 0, unknown: 0 });
  assert.equal(servicePrincipal.relationshipCompleteness, 'partial');
  assert.ok(servicePrincipal.relationships.families.appRoleGrant);
  assert.equal(report.types.find((x) => x.type === 'group').relationshipCompleteness, 'unknown');
});

test('the report never claims relationships for an unsupported subtype', async (t) => {
  const client = await freshSchema(t);
  const tenantRef = 'sha256:unsup-report';
  const result = await collectSnapshot(client, {
    reader: tenantReader({}), tenantRef, tenantId: 'tid',
    relationships: { families: ['assignment'], parentTypes: ['deviceEnrollmentConfiguration'] },
  });
  assert.equal(result.relationships.unsupported, 1);
  const report = await buildCoverageReport(client, { tenantRef, catalog: CATALOG, descriptors: DESCRIPTORS });
  const enrollment = report.types.find((x) => x.type === 'deviceEnrollmentConfiguration');
  assert.equal(enrollment.relationshipCompleteness, 'unknown');
  assert.deepEqual(enrollment.relationships.families.assignment, { current: 0, stale: 0, unknown: 0, unsupported: 1 });
});

test('wrong-tenant observations are still rejected for the new families', async (t) => {
  const client = await freshSchema(t);
  const obs = await collectRelationships(fakeReader({ [paths.grants]: [grant(GRAPH_API, ROLE_A)] }), {
    tenantRef: 'sha256:other', parents: [{ type: 'servicePrincipal', sourceId: SP }], families: ['appRoleGrant'],
  });
  const snapshotId = await createSnapshot(client, { tenantRef: 'sha256:mine' });
  await assert.rejects(() => recordRelationships(client, { snapshotId, tenantRef: 'sha256:mine', observations: obs }), /another tenant/);
});
