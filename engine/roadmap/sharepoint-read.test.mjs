// Roadmap task-102: the SharePoint site configuration read adapter.
//
// Acceptance:
//  - site settings spread over several pages persist consistent observations;
//  - a permission failure is partial coverage;
//  - the fixture sees zero file or message endpoints;
//  - an unsupported field stays unknown;
//  - tenant scope cannot change because of a site URL.
// Mutation checks:
//  - crawl files to infer coverage;
//  - label a partial field read complete;
//  - trust an arbitrary site URL's tenant.
import { strict as assert } from 'node:assert';
import { after, test } from 'node:test';

import { listWorkloads, registerWorkload } from '../collect/registry.mjs';
import { buildWorkloadLedger, scopeProblems } from '../collect/workloadContract.mjs';
import {
  SHAREPOINT_DESCRIPTOR, SHAREPOINT_OPERATIONS, SITE_FIELDS, SITE_SETTINGS_FIELDS, SITE_SHARING_OPERATION,
  collectSharePointSites, readSharePointSites, readSiteSharing, sharingCapabilityName, recordSharePointRun, sharePointActivation, siteSharingActivation,
  SITE_SETTINGS_OPERATION, siteSettingsActivation,
} from '../collect/workloads/sharepoint.mjs';
import { CmdletError } from '../powershell/jobQueue.mjs';
import { MODULE_VERSIONS, fakeCmdletContainer } from '../test/fakeCmdletContainer.mjs';
import { buildCoverageReport } from '../coverage/report.mjs';
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

const HOST = 'contoso.sharepoint.com';
const GRAPH = 'https://graph.microsoft.com/v1.0';
const guid = (n) => `${String(n).padStart(8, '0')}-0000-4000-8000-${String(n).padStart(12, '0')}`;
const siteId = (n, host = HOST) => `${host},${guid(n)},${guid(n + 100)}`;
const site = (n, { host = HOST, urlHost = host, path = `/sites/site${n}` } = {}) => ({
  id: siteId(n, host), webUrl: `https://${urlHost}${path}`, displayName: `Site ${n}`,
});

const TENANT_SETTINGS = {
  sharingCapability: 'externalUserSharingOnly', sharingDomainRestrictionMode: 'allowList',
  sharingAllowedDomainList: ['fabrikam.com'], sharingBlockedDomainList: [], isResharingByExternalUsersEnabled: false,
};

function siteBody(id) {
  const n = Number(id.split(',')[1].slice(0, 8));
  return {
    id, name: `site${n}`, displayName: `Site ${n}`, webUrl: `https://${HOST}/sites/site${n}`,
    createdDateTime: '2025-01-01T00:00:00Z', lastModifiedDateTime: '2026-09-30T00:00:00Z', siteCollection: { hostname: HOST },
  };
}

/**
 * A fake Graph. `pages` is the discovery result, page by page. `deny` names site
 * numbers whose permissions read is refused; `denyTenant` refuses tenant settings.
 * The first discovery request is throttled once.
 */
function fakeGraph({ pages, deny = [], denyTenant = false }) {
  const requests = [];
  let throttled = false;
  const transport = async (url) => {
    requests.push(url);
    const { pathname, searchParams } = new URL(url);
    const path = decodeURIComponent(pathname).replace('/v1.0', '');
    if (path === '/admin/sharepoint/settings') {
      return denyTenant ? { status: 403, body: { error: { code: 'accessDenied' } } } : { status: 200, body: TENANT_SETTINGS };
    }
    if (path === '/sites/getAllSites') {
      if (!throttled) { throttled = true; return { status: 429, headers: { 'retry-after': '1' }, body: null }; }
      const page = Number(searchParams.get('$skiptoken') ?? 0);
      const next = page + 1 < pages.length ? `${GRAPH}/sites/getAllSites?$skiptoken=${page + 1}` : undefined;
      return { status: 200, body: { value: pages[page], ...(next ? { '@odata.nextLink': next } : {}) } };
    }
    const permissions = /^\/sites\/([^/]+)\/permissions$/.exec(path);
    if (permissions) {
      const n = Number(permissions[1].split(',')[1].slice(0, 8));
      if (deny.includes(n)) return { status: 403, body: { error: { code: 'accessDenied' } } };
      return {
        status: 200,
        body: { value: [{ id: `grant-${n}`, roles: ['read'], grantedToIdentitiesV2: [{ application: { id: 'app-1', displayName: 'Backup app' } }] }] },
      };
    }
    const properties = /^\/sites\/([^/]+)$/.exec(path);
    if (properties) return { status: 200, body: siteBody(properties[1]) };
    return { status: 404, body: { error: { code: 'itemNotFound' } } };
  };
  return { transport, requests };
}

const CONTENT = /\/(drive|drives|items|children|content|lists|pages|messages|mailFolders|chats|attachments)(\/|\?|$)/i;
let clock = Date.parse('2026-10-03T21:00:00Z');
const now = () => new Date((clock += 1000));

function assertConfigurationOnly(requests) {
  assert.ok(requests.length > 0);
  for (const url of requests) {
    assert.doesNotMatch(url, CONTENT, `no file or message endpoint: ${url}`);
    const { pathname, search } = new URL(url);
    assert.deepEqual(scopeProblems({ kind: 'graph', method: 'GET', endpoint: `${decodeURIComponent(pathname).replace('/v1.0', '')}${search}` }), [], url);
  }
}

test('multi-page site settings persist one consistent observation per site', async (t) => {
  const client = await schemaClient(t);
  // Site 2 appears on two pages, as Graph can return it while the list shifts.
  const graph = fakeGraph({ pages: [[site(1), site(2)], [site(2), site(3)], [site(4)]] });
  const result = await readSharePointSites({ transport: graph.transport, tenantHost: HOST, now });
  assert.equal(result.outcome, 'complete');
  assert.equal(result.discovery.pages, 3);
  assert.equal(result.sites.length, 4, 'a site seen on two pages is one observation');
  for (const entry of result.sites) {
    for (const field of Object.keys(SITE_FIELDS)) assert.equal(entry.fieldCoverage[field].status, 'observed', `${entry.siteId} ${field}`);
  }
  assert.deepEqual(result.sites[0].fields.appPermissionGrants, [{ id: 'grant-1', roles: ['read'], applications: [{ id: 'app-1', displayName: 'Backup app' }] }]);
  assertConfigurationOnly(graph.requests);

  const tenantRef = `sha256:task-102-${crypto.randomUUID()}`;
  const run = await recordSharePointRun(client, { tenantRef, result });
  assert.equal(run.outcome, 'complete');
  const { rows } = await client.query('SELECT resource_key, fields, field_coverage FROM workload_observation WHERE collection_id = $1 ORDER BY resource_key', [run.id]);
  assert.deepEqual(rows.map((row) => row.resource_key), ['site:' + siteId(1), 'site:' + siteId(2), 'site:' + siteId(3), 'site:' + siteId(4), 'tenant'].sort());
  assert.equal(rows.find((row) => row.resource_key === 'tenant').fields.sharingCapability, 'externalUserSharingOnly');
  assert.ok(new Date(run.observed_from) < new Date(run.observed_to), 'every observation shares the run window');

  const report = await buildCoverageReport(client, { tenantRef, catalog: [], descriptors: [] });
  const entry = report.workloads.find((item) => item.workload === 'sharepoint-site-settings');
  assert.equal(entry.status, 'complete');
  assert.equal(entry.covered, true);
  assert.equal(entry.resources, 4);
});

test('a permission failure is partial coverage, field by field', async (t) => {
  const client = await schemaClient(t);
  const graph = fakeGraph({ pages: [[site(1), site(2)]], deny: [2], denyTenant: true });
  const result = await readSharePointSites({ transport: graph.transport, tenantHost: HOST, now });
  assert.equal(result.outcome, 'partial', 'a denied field never reads as complete');
  const denied = result.sites.find((entry) => entry.siteId === siteId(2));
  assert.equal(denied.fieldCoverage.appPermissionGrants.status, 'denied');
  assert.equal(denied.fieldCoverage.appPermissionGrants.httpStatus, 403);
  assert.equal('appPermissionGrants' in denied.fields, false, 'a denied field has no value, not an empty list');
  assert.equal(denied.fieldCoverage.displayName.status, 'observed', 'the rest of the site is still observed');
  assert.equal(result.sites.find((entry) => entry.siteId === siteId(1)).fieldCoverage.appPermissionGrants.status, 'observed');
  assert.equal(result.tenant.fieldCoverage.sharingCapability.status, 'denied');
  assert.equal(result.fieldCounts.denied, 6, 'five tenant fields and one site field');

  const tenantRef = `sha256:task-102-${crypto.randomUUID()}`;
  await recordSharePointRun(client, { tenantRef, result });
  const report = await buildCoverageReport(client, { tenantRef, catalog: [], descriptors: [] });
  const entry = report.workloads.find((item) => item.workload === 'sharepoint-site-settings');
  assert.equal(entry.status, 'partial');
  assert.equal(entry.covered, false);
  assert.equal(entry.fieldCounts.denied, 6);

  // A failed discovery leaves the site set unknown, never empty.
  const down = await readSharePointSites({
    transport: async (url) => (url.includes('getAllSites') ? { status: 500, body: null } : graph.transport(url)), tenantHost: HOST, now,
  });
  assert.equal(down.outcome, 'failed');
  assert.equal(down.discovery.sites, null);
});

test('an unsupported field stays unknown and is never given a value', async () => {
  const graph = fakeGraph({ pages: [[site(1)]] });
  const result = await readSharePointSites({ transport: graph.transport, tenantHost: HOST, now });
  const [entry] = result.sites;
  for (const field of Object.keys(SITE_SETTINGS_FIELDS)) {
    assert.equal(entry.fieldCoverage[field].status, 'unknown', field);
    assert.match(entry.fieldCoverage[field].reason, /not live-qualified/);
    assert.equal(field in entry.fields, false, field);
  }
  // A supported field Graph did not return is unknown too: absent, not null-as-observed.
  const sparse = await readSharePointSites({
    transport: async (url) => {
      const reply = await graph.transport(url);
      if (/\/sites\/[^/]+$/.test(decodeURIComponent(new URL(url).pathname)) && !url.includes('getAllSites')) {
        const { createdDateTime, ...rest } = reply.body;
        return { ...reply, body: rest };
      }
      return reply;
    },
    tenantHost: HOST,
    now,
  });
  assert.equal(sparse.sites[0].fieldCoverage.createdDateTime.status, 'unknown');
  assert.equal(sparse.outcome, 'partial');
});

test('tenant scope comes from configuration, never from a site URL', async () => {
  const pages = [[
    site(1),
    site(2, { host: 'fabrikam.sharepoint.com' }),
    site(3, { urlHost: 'fabrikam.sharepoint.com' }),
    site(4, { host: 'fabrikam.sharepoint.com', urlHost: HOST }),
    { id: `${HOST},not-a-guid/drive,x`, webUrl: `https://${HOST}/sites/odd` },
    site(5, { host: 'contoso-my.sharepoint.com', path: '/personal/dana' }),
  ]];
  const graph = fakeGraph({ pages });
  const result = await readSharePointSites({ transport: graph.transport, tenantHost: HOST, now });
  assert.deepEqual(result.sites.map((entry) => entry.siteId), [siteId(1)]);
  assert.equal(result.outOfScope.length, 5);
  for (const n of [2, 3, 4, 5]) {
    assert.ok(!graph.requests.some((url) => decodeURIComponent(url).includes(guid(n))), `site ${n} is never read`);
  }
  assert.ok(!graph.requests.some((url) => decodeURIComponent(url).includes('not-a-guid')));
  assert.ok(graph.requests.every((url) => new URL(url).hostname === 'graph.microsoft.com'));
  await assert.rejects(readSharePointSites({ transport: graph.transport, tenantHost: 'https://evil.example/', now }), /tenantHost must be/);
});

test('discovery is bounded, and a capped read is partial', async () => {
  const graph = fakeGraph({ pages: [[site(1), site(2), site(3)]] });
  const result = await readSharePointSites({ transport: graph.transport, tenantHost: HOST, maxSites: 2, now });
  assert.equal(result.sites.length, 2);
  assert.equal(result.discovery.capped, true);
  assert.equal(result.outcome, 'partial');
});

test('live collection stays off until every operation is qualified', async (t) => {
  const client = await schemaClient(t);
  const tenantRef = `sha256:task-102-${crypto.randomUUID()}`;
  const graph = fakeGraph({ pages: [[site(1)]] });

  const disabled = await collectSharePointSites(client, { tenantRef, ledger: buildWorkloadLedger(), transport: graph.transport, tenantHost: HOST, now });
  assert.equal(disabled.run.outcome, 'disabled');
  assert.equal(graph.requests.length, 0, 'nothing is sent while unqualified');
  assert.equal(disabled.activation.reasons.length, SHAREPOINT_OPERATIONS.length);
  let report = await buildCoverageReport(client, { tenantRef, catalog: [], descriptors: [] });
  assert.equal(report.workloads[0].status, 'disabled');
  assert.match(report.workloads[0].reasons[0], /sharepoint\.tenant-settings is disabled/);

  // Fixture proof alone does not switch it on.
  const fixtureOnly = buildWorkloadLedger({
    evidence: SHAREPOINT_OPERATIONS.map((operationId) => ({ operationId, kind: 'fixture', synthetic: true, version: 'v1.0', ok: true, proofRef: 'harness' })),
  });
  assert.equal(sharePointActivation(fixtureOnly).enabled, false);

  const live = buildWorkloadLedger({
    tenantRef,
    now: new Date('2026-10-03T21:00:00Z'),
    grants: { permissions: ['SharePointTenantSettings.Read.All', 'Sites.Read.All', 'Sites.FullControl.All'], roles: ['SharePoint Administrator'] },
    evidence: SHAREPOINT_OPERATIONS.map((operationId) => ({
      operationId, kind: 'live-capture', synthetic: false, tenantRef, capturedAt: '2026-10-02T09:00:00Z', version: 'v1.0', ok: true, proofRef: `capture-${operationId}`,
    })),
  });
  assert.equal(sharePointActivation(live).enabled, true);
  const enabled = await collectSharePointSites(client, { tenantRef, ledger: live, transport: graph.transport, tenantHost: HOST, now });
  assert.equal(enabled.run.outcome, 'complete');
  report = await buildCoverageReport(client, { tenantRef, catalog: [], descriptors: [] });
  assert.equal(report.workloads[0].status, 'complete', 'the newest run is reported');
});

test('the workload adapter is registered apart from catalogue types and ships disabled', async () => {
  const [descriptor] = listWorkloads();
  assert.equal(descriptor, SHAREPOINT_DESCRIPTOR);
  assert.equal(descriptor.enabledByDefault, false);
  assert.throws(() => registerWorkload({ type: 'x', workload: 'y', enabledByDefault: true }, { collect() {} }), /must ship disabled/);
  assert.throws(() => registerWorkload(SHAREPOINT_DESCRIPTOR, { collect() {} }), /already registered/);
});

// Per-site sharing: one Get-PnPTenantSite for every site, gated on its own ledger row.
const PNP_SITES = [
  { Url: `https://${HOST}/sites/site1/`, SharingCapability: 'ExternalUserAndGuestSharing', Template: 'GROUP#0' },
  { Url: `https://${HOST}/sites/site2`, SharingCapability: 'Disabled', Template: 'SITEPAGEPUBLISHING#0' },
];

test('per-site sharing: one read for every site, matched by URL; an unlisted site is unknown', async () => {
  let calls = 0;
  const graph = fakeGraph({ pages: [[site(1), site(2), site(3)]] });
  const result = await readSharePointSites({
    transport: graph.transport, tenantHost: HOST, now,
    siteSharing: async () => { calls += 1; return new Map(PNP_SITES.map((body) => [body.Url.replace(/\/$/, '').toLowerCase(), body])); },
  });
  assert.equal(calls, 1, 'one read for all sites, never one per site');
  const byN = (n) => result.sites.find((entry) => entry.siteId === siteId(n));
  assert.equal(byN(1).fields.sharingCapability, 'ExternalUserAndGuestSharing');
  assert.deepEqual(byN(1).fieldCoverage.sharingCapability, { status: 'observed', operation: SITE_SHARING_OPERATION });
  assert.equal(byN(2).fields.sharingCapability, 'Disabled');
  assert.equal(byN(3).fieldCoverage.sharingCapability.status, 'unknown');
  assert.equal('sharingCapability' in byN(3).fields, false, 'never given a guessed value');
  assert.equal(result.outcome, 'complete', 'a site the read did not list is unknown, not a failure');
});

test('per-site sharing: off until qualified, and a failed read is partial, never empty', async () => {
  const off = await readSharePointSites({ transport: fakeGraph({ pages: [[site(1)]] }).transport, tenantHost: HOST, now });
  assert.equal(off.outcome, 'complete', 'the rest of the read never waits for the sharing read');
  assert.equal(off.sites[0].fieldCoverage.sharingCapability.status, 'unknown');
  assert.match(off.sites[0].fieldCoverage.sharingCapability.reason, /not live-qualified/);

  const denied = await readSharePointSites({
    transport: fakeGraph({ pages: [[site(1)]] }).transport, tenantHost: HOST, now,
    siteSharing: async () => { throw new CmdletError('Get-PnPTenantSite: denied', { code: 'CMDLET_ERROR', cmdlet: 'Get-PnPTenantSite', message: 'Access is denied.', category: null, errorId: null }); },
  });
  assert.equal(denied.outcome, 'partial');
  assert.equal(denied.sites[0].fieldCoverage.sharingCapability.status, 'denied');
  assert.equal('sharingCapability' in denied.sites[0].fields, false);
});

test('per-site sharing runs only Get-PnPTenantSite, with no parameter, through the job transport', async () => {
  const live = fakeCmdletContainer({ module: 'PnP.PowerShell', allowlist: { 'Get-PnPTenantSite': ['Identity'] }, answer: () => PNP_SITES });
  const sites = await readSiteSharing(live.powershell);
  assert.deepEqual(live.calls.map((call) => [call.cmdlet, Object.keys(call.parameters ?? {})]), [['Get-PnPTenantSite', []]]);
  assert.equal(sites.get(`https://${HOST}/sites/site1`).SharingCapability, 'ExternalUserAndGuestSharing');
  assert.equal(MODULE_VERSIONS['PnP.PowerShell'] !== undefined, true);
});

test('per-site sharing is gated on its own ledger row, apart from the Graph reads', async (t) => {
  const client = await schemaClient(t);
  const tenantRef = 'sha256:site-sharing';
  const evidence = (ids) => ids.map((operationId) => ({
    operationId, kind: 'live-capture', synthetic: false, tenantRef, capturedAt: new Date().toISOString(), ok: true,
    version: operationId === SITE_SHARING_OPERATION ? MODULE_VERSIONS['PnP.PowerShell'] : 'v1.0', proofRef: `${operationId}@test`,
  }));
  const grants = { permissions: ['SharePointTenantSettings.Read.All', 'Sites.Read.All', 'Sites.FullControl.All'], roles: ['SharePoint Administrator'] };
  const runtime = { modules: { 'PnP.PowerShell': MODULE_VERSIONS['PnP.PowerShell'] } };
  const graphOnly = buildWorkloadLedger({ evidence: evidence(SHAREPOINT_OPERATIONS), grants, runtime, tenantRef });
  assert.equal(sharePointActivation(graphOnly).enabled, true);
  assert.equal(siteSharingActivation(graphOnly).enabled, false);
  const live = fakeCmdletContainer({ module: 'PnP.PowerShell', allowlist: { 'Get-PnPTenantSite': ['Identity'] }, answer: () => PNP_SITES });
  const first = await collectSharePointSites(client, { tenantRef, ledger: graphOnly, transport: fakeGraph({ pages: [[site(1)]] }).transport, tenantHost: HOST, now, powershell: live.powershell });
  assert.equal(live.calls.length, 0, 'nothing is sent until the sharing read is qualified');
  assert.equal(first.result.sites[0].fieldCoverage.sharingCapability.status, 'unknown');

  const both = buildWorkloadLedger({ evidence: evidence([...SHAREPOINT_OPERATIONS, SITE_SHARING_OPERATION]), grants, runtime, tenantRef });
  assert.equal(siteSharingActivation(both).enabled, true, siteSharingActivation(both).reasons.join('; '));
  const second = await collectSharePointSites(client, { tenantRef, ledger: both, transport: fakeGraph({ pages: [[site(1)]] }).transport, tenantHost: HOST, now, powershell: live.powershell });
  assert.equal(live.calls.length, 1);
  assert.equal(second.result.sites[0].fields.sharingCapability, 'ExternalUserAndGuestSharing');
  // Qualified but no PnP config of its own: nothing is sent, and the reason says why.
  const unconfigured = await collectSharePointSites(client, { tenantRef, ledger: both, transport: fakeGraph({ pages: [[site(1)]] }).transport, tenantHost: HOST, now, powershell: null });
  assert.equal(live.calls.length, 1);
  assert.equal(unconfigured.result.outcome, 'complete');
  assert.match(unconfigured.result.sites[0].fieldCoverage.sharingCapability.reason, /powershellConfigs\.sharepoint/);
  const { rows: [row] } = await client.query(
    `SELECT fields, field_coverage FROM workload_observation WHERE collection_id = $1 AND resource_key = $2`, [second.run.id, `site:${siteId(1)}`],
  );
  assert.equal(row.fields.sharingCapability, 'ExternalUserAndGuestSharing', 'stored with the run, so the backup holds it');
});

test('per-site sharing: the enum number ConvertTo-Json writes is stored by name; a refused sign-in is failed, not denied', async () => {
  assert.deepEqual([0, 1, 2, 3, '2', 'Disabled', 9, null, ''].map(sharingCapabilityName),
    ['Disabled', 'ExternalUserSharingOnly', 'ExternalUserAndGuestSharing', 'ExistingExternalUserSharingOnly', 'ExternalUserAndGuestSharing', 'Disabled', null, null, null]);
  const live = fakeCmdletContainer({ module: 'PnP.PowerShell', allowlist: { 'Get-PnPTenantSite': ['Identity'] }, answer: () => [
    { Url: `https://${HOST}/sites/site1`, SharingCapability: 2 }, { Url: `https://${HOST}/sites/site2`, SharingCapability: 7 },
  ] });
  const result = await readSharePointSites({ transport: fakeGraph({ pages: [[site(1), site(2)]] }).transport, tenantHost: HOST, now, siteSharing: () => readSiteSharing(live.powershell) });
  const byN = (n) => result.sites.find((entry) => entry.siteId === siteId(n));
  assert.equal(byN(1).fields.sharingCapability, 'ExternalUserAndGuestSharing');
  assert.equal(byN(2).fieldCoverage.sharingCapability.status, 'unknown', 'an unknown number is never stored');

  const refused = await readSharePointSites({
    transport: fakeGraph({ pages: [[site(1)]] }).transport, tenantHost: HOST, now,
    siteSharing: async () => { throw new CmdletError('connect', { code: 'CMDLET_ERROR', cmdlet: 'Get-PnPTenantSite', message: 'AADSTS700027: unauthorized_client', category: 'OpenError', errorId: 'ConnectFailed' }); },
  });
  assert.equal(refused.sites[0].fieldCoverage.sharingCapability.status, 'failed');
});

test('per-site admin settings come from the same PnP answer, under their own ledger row', async (t) => {
  const client = await schemaClient(t);
  const tenantRef = 'sha256:site-settings';
  const PNP = [{
    Url: `https://${HOST}/sites/site1`, SharingCapability: 2, LockState: 'Unlock', ConditionalAccessPolicy: 1, SensitivityLabel: '11111111-0000-4000-8000-000000000001',
    DenyAddAndCustomizePages: 2, RestrictedAccessControl: true, RestrictedAccessControlGroups: ['g2', 'g1'], StorageQuota: 26214400, ExternalUserExpirationInDays: 60,
  }];
  const evidence = (ids) => ids.map((operationId) => ({
    operationId, kind: 'live-capture', synthetic: false, tenantRef, capturedAt: new Date().toISOString(), ok: true,
    version: [SITE_SHARING_OPERATION, SITE_SETTINGS_OPERATION].includes(operationId) ? MODULE_VERSIONS['PnP.PowerShell'] : 'v1.0', proofRef: `${operationId}@test`,
  }));
  const grants = { permissions: ['SharePointTenantSettings.Read.All', 'Sites.Read.All', 'Sites.FullControl.All'], roles: ['SharePoint Administrator'] };
  const runtime = { modules: { 'PnP.PowerShell': MODULE_VERSIONS['PnP.PowerShell'] } };
  const live = fakeCmdletContainer({ module: 'PnP.PowerShell', allowlist: { 'Get-PnPTenantSite': ['Identity'] }, answer: () => PNP });
  const collect = (ledger) => collectSharePointSites(client, { tenantRef, ledger, transport: fakeGraph({ pages: [[site(1)]] }).transport, tenantHost: HOST, now, powershell: live.powershell });

  // Sharing proven, settings not: one call, sharing read, settings stay unknown with the reason.
  const sharingOnly = buildWorkloadLedger({ evidence: evidence([...SHAREPOINT_OPERATIONS, SITE_SHARING_OPERATION]), grants, runtime, tenantRef });
  assert.equal(siteSettingsActivation(sharingOnly).enabled, false);
  const first = await collect(sharingOnly);
  assert.equal(live.calls.length, 1);
  assert.equal(first.result.sites[0].fields.sharingCapability, 'ExternalUserAndGuestSharing');
  for (const field of Object.keys(SITE_SETTINGS_FIELDS)) {
    assert.equal(first.result.sites[0].fieldCoverage[field].status, 'unknown', field);
    assert.equal(field in first.result.sites[0].fields, false, field);
  }

  // Settings proven, sharing not: still one call, and only the settings are kept.
  const settingsOnly = buildWorkloadLedger({ evidence: evidence([...SHAREPOINT_OPERATIONS, SITE_SETTINGS_OPERATION]), grants, runtime, tenantRef });
  assert.equal(siteSettingsActivation(settingsOnly).enabled, true, siteSettingsActivation(settingsOnly).reasons.join('; '));
  const second = await collect(settingsOnly);
  assert.equal(live.calls.length, 2);
  const entry = second.result.sites[0];
  assert.equal(entry.fieldCoverage.sharingCapability.status, 'unknown');
  assert.deepEqual(Object.fromEntries(Object.keys(SITE_SETTINGS_FIELDS).map((field) => [field, entry.fields[field]])), {
    lockState: 'Unlock', conditionalAccessPolicy: 'AllowLimitedAccess', sensitivityLabel: '11111111-0000-4000-8000-000000000001',
    denyAddAndCustomizePages: 'Enabled', restrictedAccessControl: true, restrictedAccessControlGroups: ['g1', 'g2'], storageQuota: 26214400,
    externalUserExpirationInDays: 60,
  });
  assert.ok(Object.keys(SITE_SETTINGS_FIELDS).every((field) => entry.fieldCoverage[field].operation === SITE_SETTINGS_OPERATION));
  assert.equal(second.result.outcome, 'complete');
});

test('the live capture proves the per-site settings only when every one of them was returned', async () => {
  const { readSharePointSiteSharing } = await import('../../tools/qualification/workloadReadsLive.mjs');
  const full = { Url: `https://${HOST}/sites/site1`, SharingCapability: 2, LockState: 'Unlock', ConditionalAccessPolicy: 0, SensitivityLabel: 'x',
    DenyAddAndCustomizePages: 2, RestrictedAccessControl: false, RestrictedAccessControlGroups: [], StorageQuota: 1, ExternalUserExpirationInDays: 0 };
  const capture = (sites) => readSharePointSiteSharing({
    powershell: fakeCmdletContainer({ module: 'PnP.PowerShell', allowlist: { 'Get-PnPTenantSite': ['Identity'] }, answer: () => sites }).powershell,
  });
  const proven = await capture([full]);
  assert.deepEqual(proven.discovery.families['site-settings'], { status: 'read', objects: 1 });
  const { LockState, ...noLock } = full;
  const short = await capture([noLock]);
  assert.equal(short.discovery.families['site-sharing'].status, 'read', 'the sharing field is proven on its own');
  assert.equal(short.discovery.families['site-settings'].status, 'partial');
  assert.match(short.failures[0].error.message, /lockState/);
});
