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
import { readFileSync } from 'node:fs';
import { after, test } from 'node:test';

import { listWorkloads, registerWorkload } from '../collect/registry.mjs';
import { buildWorkloadLedger, scopeProblems } from '../collect/workloadContract.mjs';
import {
  SHAREPOINT_DESCRIPTOR, SHAREPOINT_OPERATIONS, SITE_FIELDS, UNSUPPORTED_SITE_FIELDS,
  collectSharePointSites, readSharePointSites, recordSharePointRun, sharePointActivation,
} from '../collect/workloads/sharepoint.mjs';
import { buildCoverageReport } from '../coverage/report.mjs';
import { createIsolatedTestDatabase } from '../test/dbTestHelper.mjs';

const database = await createIsolatedTestDatabase(import.meta.url);
after(async () => { await database.cleanup(); });

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
  for (const field of UNSUPPORTED_SITE_FIELDS) {
    assert.equal(entry.fieldCoverage[field].status, 'unknown', field);
    assert.match(entry.fieldCoverage[field].reason, /not qualified/);
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
