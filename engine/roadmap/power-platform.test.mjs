// READ-PP: Power Platform and Power BI tenant settings, read-only.
//
// Acceptance:
//  - each read is declared in workloadContract.mjs as an admin REST read, passes the
//    scope validator and ships disabled (fixture proof never enables it);
//  - the transport sends only GETs of the declared shapes, with a token for the API it
//    calls; apps, flows, connections and Power BI content are refused before sending;
//  - each environment, DLP policy, connector and Power BI setting is one observation
//    keyed by its stable name, with declared fields only and nothing credential-shaped;
//  - nothing is sent until the environments read is live-qualified, and a family whose
//    own row is not enabled is skipped and makes the run partial.
// Mutation checks (each was run once and made this file fail):
//  - allow POST in the transport (the read-only assertion fails);
//  - key connectors by name only (two environments' shared connectors collide);
//  - run a family whose row is not enabled (the activation test fails).
//
// Everything runs against the isolated test database and a fake admin API with
// KEEL-RT- fixtures. No tenant is touched.
import { strict as assert } from 'node:assert';
import { after, test } from 'node:test';

import {
  FAMILY_NAMES, POWER_PLATFORM_DESCRIPTOR, POWER_PLATFORM_OPERATIONS, POWER_PLATFORM_WORKLOAD, PowerPlatformScopeError,
  assertPowerPlatformRequest, collectPowerPlatform, powerPlatformActivation, powerPlatformTransportFor, readOnlyPowerPlatformTransport,
  readPowerPlatform,
} from '../collect/workloads/powerPlatform.mjs';
import { WORKLOAD_COLLECTORS } from '../collect/workloads/registry.mjs';
import { WORKLOAD_DESCRIPTORS, buildWorkloadLedger, descriptorProblems, scopeProblems } from '../collect/workloadContract.mjs';
import { listWorkloads } from '../collect/registry.mjs';
import { buildCoverageReport } from '../coverage/report.mjs';
import { WORKLOAD_WRITE_OPERATIONS } from '../coverage/qualification.mjs';
import { planDeletionWaves, planWaves } from '../restore/wavePlanner.mjs';
import { runFixtureHarness } from '../../tools/qualification/workloads.mjs';
import { createIsolatedTestDatabase } from '../test/dbTestHelper.mjs';
import { schemaSql } from '../store/loadSchema.mjs';

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

const NOW = new Date('2026-10-14T12:00:00Z');
let tenantSeq = 0;
const nextTenant = () => `sha256:read-pp-${tenantSeq += 1}`;

const BAP = 'https://api.bap.microsoft.com';
const ENVIRONMENTS = '/providers/Microsoft.BusinessAppPlatform/scopes/admin/environments';
const POLICIES = '/providers/PowerPlatform.Governance/v2/policies';
const apisOf = (environment) => `/providers/Microsoft.PowerApps/scopes/admin/environments/${environment}/apis`;
const SETTINGS = '/v1/admin/tenantsettings';
const JWT = 'eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiJrZWVsLXJ0In0.c2lnbmF0dXJlLXZhbHVl';

const environment = (name, overrides = {}) => ({
  id: `${ENVIRONMENTS}/${name}`, name, location: 'europe', type: 'Microsoft.BusinessAppPlatform/scopes/environments',
  properties: {
    displayName: `KEEL-RT-${name}`, description: 'KEEL-RT fixture environment', environmentSku: 'Sandbox', azureRegion: 'westeurope',
    isDefault: false, createdTime: '2026-09-01T00:00:00Z', states: { management: { id: 'Ready' } },
    linkedEnvironmentMetadata: { domainName: 'keel-rt', version: '9.2' }, protectionStatus: { keyManagedBy: 'Microsoft' },
    governanceConfiguration: { protectionLevel: 'Basic' }, retentionPeriod: 7,
    createdBy: { id: 'user-1', displayName: 'Someone', email: 'someone@example.test' },
    ...overrides,
  },
});
const POLICY = {
  name: '00000001-0000-4000-8000-00000000a001', displayName: 'KEEL-RT-dlp', defaultConnectorsClassification: 'General',
  connectorGroups: [{ classification: 'Confidential', connectors: [{ id: '/providers/Microsoft.PowerApps/apis/shared_office365', name: 'Office 365 Outlook', type: 'Microsoft.PowerApps/apis' }] }],
  environmentType: 'ExceptEnvironments', environments: [{ id: 'KEEL-RT-env-b', name: 'KEEL-RT-env-b', type: 'Microsoft.BusinessAppPlatform/scopes/environments' }],
  createdTime: '2026-09-02T00:00:00Z', lastModifiedTime: '2026-09-03T00:00:00Z', etag: '"1"', isLegacySchemaVersion: false,
  createdBy: { displayName: 'Someone' },
};
const connector = (name, overrides = {}) => ({
  name, id: `/providers/Microsoft.PowerApps/apis/${name}`, type: 'Microsoft.PowerApps/apis',
  properties: {
    displayName: name, description: 'KEEL-RT connector', tier: 'Standard', publisher: 'Microsoft', isCustomApi: false,
    capabilities: ['actions'], createdTime: '2026-09-01T00:00:00Z', changedTime: '2026-09-01T00:00:00Z',
    swagger: { paths: { '/x': {} } }, iconUri: 'https://example.test/icon.png', ...overrides,
  },
});
const SETTING = {
  settingName: 'KEEL-RT-AllowServicePrincipalsUseReadAdminAPIs', title: 'Service principals can use read-only admin APIs', enabled: true,
  canSpecifySecurityGroups: true, tenantSettingGroup: 'Admin API settings', enabledSecurityGroups: [{ graphId: 'g1', name: 'KEEL-RT-group' }],
  excludedSecurityGroups: [], properties: [], delegateToCapacity: false, delegateToDomain: false, delegateToWorkspace: false,
};

/** A fake set of admin APIs. `answers` maps a path to a body or { status }; environments page twice. */
function fakeApi(answers = {}) {
  const calls = [];
  const defaults = {
    [ENVIRONMENTS]: [{ value: [environment('KEEL-RT-env-a')], nextLink: `${BAP}${ENVIRONMENTS}?api-version=2020-10-01&$skiptoken=p2` },
      { value: [environment('KEEL-RT-env-b')] }],
    [POLICIES]: { value: [POLICY] },
    [apisOf('KEEL-RT-env-a')]: { value: [connector('shared_office365'), connector('shared_sharepointonline')] },
    [apisOf('KEEL-RT-env-b')]: { value: [connector('shared_office365')] },
    [SETTINGS]: { tenantSettings: [SETTING] },
  };
  const table = { ...defaults, ...answers };
  return {
    calls,
    async transport(url) {
      assertPowerPlatformRequest(url);
      const parsed = new URL(url);
      calls.push(`${parsed.hostname}${parsed.pathname}${parsed.searchParams.has('$skiptoken') ? '#2' : ''}`);
      let answer = table[parsed.pathname];
      if (Array.isArray(answer)) answer = answer[parsed.searchParams.has('$skiptoken') ? 1 : 0];
      if (!answer) return { status: 404, headers: {}, body: null };
      if (answer.status) return { status: answer.status, headers: {}, body: null };
      return { status: 200, headers: {}, body: structuredClone(answer) };
    },
  };
}

const liveCapture = (operationId, tenantRef) => {
  const descriptor = WORKLOAD_DESCRIPTORS.find((item) => item.id === operationId);
  return { operationId, kind: 'live-capture', synthetic: false, tenantRef, capturedAt: '2026-10-13T00:00:00Z', version: descriptor.operation.version, ok: true, proofRef: `${operationId}@sha256:x` };
};
const GRANTS = Object.freeze({
  permissions: [...new Set(WORKLOAD_DESCRIPTORS.flatMap((descriptor) => descriptor.rbac.permissions))],
  roles: [...new Set(WORKLOAD_DESCRIPTORS.flatMap((descriptor) => descriptor.rbac.roles))],
});
const ledgerWith = (tenantRef, live) => buildWorkloadLedger({
  descriptors: WORKLOAD_DESCRIPTORS.filter((descriptor) => descriptor.workload === POWER_PLATFORM_WORKLOAD),
  evidence: live.map((id) => liveCapture(id, tenantRef)), grants: GRANTS, tenantRef, now: NOW,
});

// ---------------------------------------------------------------- tests

test('each Power Platform read is declared, in scope, read-only and ships disabled', async () => {
  const declared = WORKLOAD_DESCRIPTORS.filter((descriptor) => descriptor.workload === POWER_PLATFORM_WORKLOAD);
  assert.deepEqual(declared.map((descriptor) => descriptor.id), [...POWER_PLATFORM_OPERATIONS]);
  for (const descriptor of declared) {
    assert.deepEqual(descriptorProblems(descriptor), [], descriptor.id);
    assert.equal(descriptor.operation.kind, 'rest');
    assert.equal(descriptor.operation.method, 'GET');
    assert.match(descriptor.source.url, /^https:\/\/learn\.microsoft\.com\//);
  }

  // The contract refuses writes, other hosts and content paths of these APIs.
  const rest = (overrides) => ({ kind: 'rest', method: 'GET', host: 'api.bap.microsoft.com', endpoint: ENVIRONMENTS, version: 'v1', audience: 'x', ...overrides });
  assert.deepEqual(scopeProblems(rest({ method: 'POST' })), ['POST is not a read']);
  assert.notEqual(scopeProblems(rest({ host: 'management.azure.com' })).length, 0);
  for (const endpoint of [
    '/providers/Microsoft.PowerApps/scopes/admin/environments/e/apps', '/providers/Microsoft.ProcessSimple/scopes/admin/environments/e/flows',
    '/providers/Microsoft.PowerApps/scopes/admin/environments/e/connections', '/v1/admin/workspaces', '/v1/admin/items',
  ]) assert.notEqual(scopeProblems(rest({ endpoint })).length, 0, endpoint);

  // No proof: disabled. Fixture proof: fixture-tested, still disabled.
  const bare = buildWorkloadLedger({ grants: GRANTS, tenantRef: 'sha256:t', now: NOW });
  for (const id of POWER_PLATFORM_OPERATIONS) {
    const row = bare.rows.find((item) => item.id === id);
    assert.equal(row.state, 'disabled', id);
    assert.equal(row.enabled, false, id);
  }
  const { evidence, results } = await runFixtureHarness({ descriptors: declared });
  assert.ok(results.every((result) => result.ok), JSON.stringify(results));
  const fixtured = buildWorkloadLedger({ descriptors: declared, evidence, grants: GRANTS, tenantRef: 'sha256:t', now: NOW });
  assert.ok(fixtured.rows.every((row) => row.state === 'fixture-tested' && row.enabled === false));

  // Registered disabled, read-only, in the collector registry, with no write of any kind.
  assert.equal(POWER_PLATFORM_DESCRIPTOR.enabledByDefault, false);
  assert.equal(POWER_PLATFORM_DESCRIPTOR.readOnly, true);
  assert.ok(listWorkloads().some((descriptor) => descriptor.workload === POWER_PLATFORM_WORKLOAD));
  assert.equal(WORKLOAD_COLLECTORS.find((entry) => entry.workload === POWER_PLATFORM_WORKLOAD).powershellFamily, null);
  assert.deepEqual(Object.values(WORKLOAD_WRITE_OPERATIONS).filter((item) => item.workload === POWER_PLATFORM_WORKLOAD), []);
});

test('the transport sends only GETs of the declared shapes, with a token for the API it calls', async () => {
  const sent = [];
  const audiences = [];
  const fetchImpl = async (url, init) => {
    sent.push({ url, init });
    return new Response(JSON.stringify({ value: [] }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  const transport = readOnlyPowerPlatformTransport(async (audience) => { audiences.push(audience); return `token-for-${audience}`; }, fetchImpl);

  for (const [url, init] of [
    [`${BAP}${ENVIRONMENTS}?api-version=2020-10-01`, { method: 'POST' }],
    [`${BAP}${ENVIRONMENTS}?api-version=2020-10-01`, { method: 'GET', body: '{}' }],
    [`${BAP}/providers/Microsoft.BusinessAppPlatform/listtenantsettings?api-version=2020-10-01`, {}],
    ['https://api.powerapps.com/providers/Microsoft.PowerApps/scopes/admin/environments/e1/apps', {}],
    ['https://api.powerapps.com/providers/Microsoft.PowerApps/scopes/admin/environments/e1/connections', {}],
    ['https://api.fabric.microsoft.com/v1/admin/workspaces', {}],
    ['https://graph.microsoft.com/v1.0/users', {}],
    [`${BAP}${ENVIRONMENTS}?api-version=2020-10-01&$expand=properties.capacity`, {}],
    [`http://api.bap.microsoft.com${ENVIRONMENTS}`, {}],
  ]) await assert.rejects(transport(url, init), PowerPlatformScopeError, `${init.method ?? 'GET'} ${url}`);
  assert.deepEqual(sent, [], 'nothing refused was sent');
  assert.deepEqual(audiences, [], 'no token was fetched for a refused request');

  await transport(`${BAP}${ENVIRONMENTS}?api-version=2020-10-01`);
  await transport(`${BAP}${POLICIES}`);
  await transport('https://api.fabric.microsoft.com/v1/admin/tenantsettings');
  assert.deepEqual(sent.map((item) => item.init.method), ['GET', 'GET', 'GET']);
  assert.equal(sent[0].init.headers.authorization, 'Bearer token-for-https://service.powerapps.com/');
  assert.equal(sent[2].init.headers.authorization, 'Bearer token-for-https://api.fabric.microsoft.com/');
  assert.deepEqual(audiences, ['https://service.powerapps.com/', 'https://api.fabric.microsoft.com/'], 'one token per API, fetched once');

  // The production transport asks the tenant's certificate credentials for each API's scope.
  const scopes = [];
  const production = powerPlatformTransportFor({ tenantId: 't' }, {
    getTokenFn: async (_config, { scope }) => { scopes.push(scope); return { accessToken: 'x' }; }, fetchImpl,
  });
  await production('https://api.fabric.microsoft.com/v1/admin/tenantsettings');
  assert.deepEqual(scopes, ['https://api.fabric.microsoft.com/.default']);
});

test('every object is one observation keyed by its name, with declared fields only', async () => {
  const api = fakeApi({
    [apisOf('KEEL-RT-env-b')]: { value: [connector('shared_office365', { description: JWT })] },
  });
  const result = await readPowerPlatform({ transport: api.transport, now: () => NOW });
  assert.deepEqual(result.resources.map((resource) => resource.resourceKey), [
    'environment:KEEL-RT-env-a', 'environment:KEEL-RT-env-b',
    'dlp-policy:00000001-0000-4000-8000-00000000a001',
    'connector:KEEL-RT-env-a/shared_office365', 'connector:KEEL-RT-env-a/shared_sharepointonline', 'connector:KEEL-RT-env-b/shared_office365',
    'powerbi-setting:KEEL-RT-AllowServicePrincipalsUseReadAdminAPIs',
  ]);
  assert.equal(result.discovery.contentRead, false);
  assert.ok(api.calls.includes(`api.bap.microsoft.com${ENVIRONMENTS}#2`), 'the next page was followed');

  const env = result.resources.find((resource) => resource.identity === 'KEEL-RT-env-a');
  assert.equal(env.fields.environmentSku, 'Sandbox');
  assert.equal(env.fields.location, 'europe');
  assert.equal(env.fields.createdBy, undefined, 'the creator is not configuration and is dropped');
  const policy = result.resources.find((resource) => resource.kind === 'dlpPolicy');
  assert.equal(policy.fields.connectorGroups[0].classification, 'Confidential');
  assert.equal(policy.fields.environmentType, 'ExceptEnvironments');
  const office = result.resources.find((resource) => resource.resourceKey === 'connector:KEEL-RT-env-a/shared_office365');
  assert.equal(office.environment, 'KEEL-RT-env-a');
  assert.equal(office.fields.tier, 'Standard');
  assert.equal(office.fields.swagger, undefined, 'a connector definition is dropped unread');
  assert.equal(office.fields.iconUri, undefined);
  const setting = result.resources.find((resource) => resource.kind === 'powerBiSetting');
  assert.equal(setting.fields.enabled, true);
  assert.deepEqual(setting.fields.enabledSecurityGroups, [{ graphId: 'g1', name: 'KEEL-RT-group' }]);

  // A credential-shaped value is redacted, never stored, and makes the run partial.
  const tokenBearer = result.resources.find((resource) => resource.resourceKey === 'connector:KEEL-RT-env-b/shared_office365');
  assert.notEqual(tokenBearer.fields.description, JWT);
  assert.equal(tokenBearer.fieldCoverage.description.status, 'redacted');
  assert.ok(!JSON.stringify(result).includes(JWT));
  assert.equal(result.outcome, 'partial');

  const clean = await readPowerPlatform({ transport: fakeApi().transport, now: () => NOW });
  assert.equal(clean.outcome, 'complete');
  assert.deepEqual(clean.fieldCounts, { observed: clean.fieldCounts.observed });
});

test('failures, duplicates and unidentified answers are gaps; nothing read is a failed run', async () => {
  // One environment's connectors refused: that environment is a failure, the rest is kept.
  const denied = await readPowerPlatform({ transport: fakeApi({ [apisOf('KEEL-RT-env-b')]: { status: 403 } }).transport, now: () => NOW });
  assert.equal(denied.outcome, 'partial');
  assert.deepEqual(denied.failures.map((failure) => [failure.family, failure.environment, failure.error.httpStatus]), [['connector', 'KEEL-RT-env-b', 403]]);
  assert.equal(denied.resources.filter((resource) => resource.kind === 'connector').length, 2);

  // The environments read fails: connectors cannot be read either.
  const noEnvironments = await readPowerPlatform({ transport: fakeApi({ [ENVIRONMENTS]: { status: 401 } }).transport, now: () => NOW });
  assert.equal(noEnvironments.outcome, 'partial');
  assert.deepEqual(noEnvironments.failures.map((failure) => failure.family).sort(), ['connector', 'environment']);

  // Everything fails: failed.
  const all = await readPowerPlatform({
    transport: fakeApi({ [ENVIRONMENTS]: { status: 500 }, [POLICIES]: { status: 500 }, [SETTINGS]: { status: 500 } }).transport, now: () => NOW,
  });
  assert.equal(all.outcome, 'failed');

  // The same name twice with different settings is a conflict; an object with no name is unidentified.
  const odd = await readPowerPlatform({
    transport: fakeApi({ [POLICIES]: { value: [POLICY, { ...POLICY, displayName: 'KEEL-RT-other' }, { displayName: 'KEEL-RT-nameless' }] } }).transport,
    families: ['dlpPolicy'], now: () => NOW,
  });
  assert.equal(odd.resources.length, 1);
  assert.deepEqual(odd.discovery.conflicts, [{ resourceKey: `dlp-policy:${POLICY.name}`, fields: ['displayName'] }]);
  assert.equal(odd.discovery.unidentified, 1);
  assert.equal(odd.outcome, 'partial');

  // More environments than the bound: connectors are read for the first ones only, and the run says so.
  const capped = await readPowerPlatform({ transport: fakeApi().transport, maxEnvironments: 1, now: () => NOW });
  assert.equal(capped.discovery.environmentsCapped, true);
  assert.equal(capped.outcome, 'partial');
});

test('collection stays off until the environments read is qualified; other families need their own proof', async (t) => {
  const client = await schemaClient(t);
  const tenantRef = nextTenant();
  const api = fakeApi();

  // No live proof, or every read but environments live: disabled, nothing sent.
  for (const ledger of [ledgerWith(tenantRef, []), ledgerWith(tenantRef, POWER_PLATFORM_OPERATIONS.filter((id) => id !== 'powerplatform.environments'))]) {
    const disabled = await collectPowerPlatform(client, { tenantRef, ledger, transport: api.transport, now: () => NOW });
    assert.equal(disabled.run.outcome, 'disabled');
    assert.equal(disabled.result, null);
  }
  assert.deepEqual(api.calls, [], 'nothing is sent while disabled');
  assert.match(powerPlatformActivation(ledgerWith(tenantRef, [])).reasons[0], /powerplatform\.environments is disabled/);

  // Environments live only: enabled, the rest skipped and the run partial.
  const core = ledgerWith(tenantRef, ['powerplatform.environments']);
  const activation = powerPlatformActivation(core);
  assert.equal(activation.enabled, true);
  assert.deepEqual(activation.skipped.map((item) => item.family), ['dlpPolicy', 'connector', 'powerBiSetting']);
  const partial = await collectPowerPlatform(client, { tenantRef, ledger: core, transport: api.transport, now: () => NOW });
  assert.equal(partial.run.outcome, 'partial');
  assert.ok(api.calls.every((call) => call.startsWith(`api.bap.microsoft.com${ENVIRONMENTS}`)), 'an unqualified read is never sent');

  // Everything live: complete, one stored observation per object.
  const full = await collectPowerPlatform(client, { tenantRef, ledger: ledgerWith(tenantRef, POWER_PLATFORM_OPERATIONS), transport: fakeApi().transport, now: () => NOW });
  assert.equal(full.run.outcome, 'complete');
  assert.deepEqual(full.activation.families, [...FAMILY_NAMES]);
  const { rows } = await client.query('SELECT resource_key, fields, field_coverage FROM workload_observation WHERE collection_id = $1 ORDER BY resource_key', [full.run.id]);
  assert.equal(rows.length, 7);
  const stored = rows.find((row) => row.resource_key === 'connector:KEEL-RT-env-b/shared_office365');
  assert.equal(stored.fields.environment, 'KEEL-RT-env-b');
  assert.equal(stored.fields.kind, 'connector');
  assert.equal(stored.field_coverage.tier.status, 'observed');

  // Coverage lists the workload; its type never enters an Entra wave.
  const report = await buildCoverageReport(client, { tenantRef, catalog: [], descriptors: [], now: NOW });
  assert.equal(report.workloads.find((item) => item.workload === POWER_PLATFORM_WORKLOAD).status, 'complete');
  assert.throws(() => planWaves([{ naturalKey: 'x', resourceType: 'powerPlatformSettings', verb: 'update', payload: {} }]), /workload restore path/);
  assert.throws(() => planDeletionWaves([{ naturalKey: 'x', resourceType: 'powerPlatformSettings', verb: 'delete', payload: {} }]), /workload restore path/);
});

test('the scheduled run records a disabled run without asking for a token', async (t) => {
  const client = await schemaClient(t);
  const tenantRef = nextTenant();
  const entry = WORKLOAD_COLLECTORS.find((item) => item.workload === POWER_PLATFORM_WORKLOAD);
  const { run } = await entry.collect(client, { base: { tenantRef, ledger: ledgerWith(tenantRef, []), now: () => NOW }, config: { tenantId: 't' }, sleep: async () => {} });
  assert.equal(run.outcome, 'disabled');
  assert.match(run.digest.reasons[0], /powerplatform\.environments/);
});
