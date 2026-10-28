import { strict as assert } from 'node:assert';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';

import { CATALOG } from '../../tools/tenant-probe/catalog.mjs';
import { createIsolatedTestDatabase } from '../test/dbTestHelper.mjs';
import { schemaSql } from '../store/loadSchema.mjs';
import { catalogPath, catalogedCmdlets, isUnderItem, requiredFilter } from './catalogue.mjs';
import { ALIAS_PATHS, SKIPPED_PATHS, SKIP_REASONS } from './notGaps.mjs';
import { discover, discoverPowerShell, failureReason, notUsedReason, probePath, reclassifyCatalogue } from './discover.mjs';
import { holdsGrant, missingGrant, tokenRoles } from './grants.mjs';
import { discoverablePaths, parseMetadata } from './metadata.mjs';
import { loadLatestDiscovery, saveDiscoveryRun } from './store.mjs';
import { DiscoveryWriteRefused, assertReadOnly, readOnlyGraph } from './transport.mjs';
import { main as discoverCli } from '../../cli/keel-discover.mjs';
import { JOB_HANDLERS, JOB_TIMEOUT_MS } from '../../cli/keel-worker.mjs';
import { capabilityForJobKind } from '../authz/jobCapabilities.mjs';
import { enqueue } from '../jobs/queue.mjs';
import { nextDueAt, validateSchedule } from '../schedules/cadence.mjs';
import { initialSchedules } from '../store/scheduleSeed.mjs';
import { tenantRefFor } from '../store/tenantRef.mjs';

const TENANT_REF = 'sha256:discovery-test';
const fixed = () => new Date('2026-10-14T12:00:00.000Z');

/**
 * A $metadata document holding every catalogue path, built from CATALOG so a new
 * catalogue entry is in the fixture without editing it, plus the planted types:
 * an uncatalogued collection (bookingBusinesses) and a refused one (print/printers).
 * It uses the `graph` alias, a self-closing EntityType and BaseType inheritance,
 * as the real documents do.
 */
function fixtureMetadata(catalog = CATALOG) {
  const tree = new Map();
  const node = (map, name) => {
    if (!map.has(name)) map.set(name, { children: new Map(), ends: false, singleton: false });
    return map.get(name);
  };
  for (const entry of catalog) {
    // A kind read per object is reached through the list it reads first.
    const path = isUnderItem(entry.path) ? entry.parent?.path : entry.path;
    if (!path || isUnderItem(path)) continue;
    const segments = path.split('?')[0].split('/').filter(Boolean);
    let map = tree;
    let current;
    for (const segment of segments) {
      current = node(map, segment);
      map = current.children;
    }
    current.ends = true;
    current.singleton ||= Boolean(entry.singleton);
  }
  const types = [];
  const typeFor = (path, item) => {
    const name = `${path.replaceAll('/', '_')}Type`;
    const nav = [...item.children.entries()].map(([child, value]) => {
      const collection = value.children.size === 0 && !value.singleton;
      const type = typeFor(`${path}/${child}`, value);
      return `<NavigationProperty Name="${child}" Type="${collection ? `Collection(graph.${type})` : `graph.${type}`}" ContainsTarget="true" />`;
    });
    // A catalogued object holds settings; a path that only leads to one does not.
    const body = [item.ends ? '<Property Name="displayName" Type="Edm.String" />' : '', ...nav].join('');
    types.push(body ? `<EntityType Name="${name}" BaseType="graph.entity">${body}</EntityType>` : `<EntityType Name="${name}" BaseType="graph.entity" />`);
    return name;
  };
  const roots = [];
  for (const [name, item] of tree) {
    const type = typeFor(name, item);
    roots.push(item.children.size === 0 && !item.singleton
      ? `<EntitySet Name="${name}" EntityType="microsoft.graph.${type}"><NavigationPropertyBinding Path="x" Target="y" /></EntitySet>`
      : `<Singleton Name="${name}" Type="graph.${type}" />`);
  }
  return `<?xml version="1.0" encoding="utf-8"?>
<edmx:Edmx Version="4.0" xmlns:edmx="http://docs.oasis-open.org/odata/ns/edmx"><edmx:DataServices>
<Schema Namespace="microsoft.graph" Alias="graph" xmlns="http://docs.oasis-open.org/odata/ns/edm">
<EntityType Name="entity" Abstract="true"><Key><PropertyRef Name="id" /></Key><Property Name="id" Type="Edm.String" Nullable="false" /></EntityType>
<EntityType Name="printBase" BaseType="graph.entity"><NavigationProperty Name="printers" Type="Collection(graph.printer)" ContainsTarget="true" /></EntityType>
<EntityType Name="print" BaseType="graph.printBase"><NavigationProperty Name="owner" Type="graph.user" /></EntityType>
<EntityType Name="printer" BaseType="graph.entity" />
<EntityType Name="bookingBusiness" BaseType="graph.entity" />
<EntityType Name="deviceSettings" BaseType="graph.entity"><Property Name="intuneBrand" Type="Edm.String" /><NavigationProperty Name="reports" Type="Collection(graph.entity)" ContainsTarget="true" /></EntityType>
<EntityType Name="userSelf" BaseType="graph.entity"><NavigationProperty Name="messages" Type="Collection(graph.entity)" ContainsTarget="true" /></EntityType>
${types.join('\n')}
<EntityContainer Name="GraphService">
${roots.join('\n')}
<EntitySet Name="bookingBusinesses" EntityType="microsoft.graph.bookingBusiness" />
<EntitySet Name="agreements" EntityType="microsoft.graph.entity" />
<EntitySet Name="applicationTemplates" EntityType="microsoft.graph.entity" />
<EntitySet Name="subscriptions" EntityType="microsoft.graph.entity" />
<EntitySet Name="teams" EntityType="microsoft.graph.entity" />
<Singleton Name="print" Type="microsoft.graph.print" />
<Singleton Name="me" Type="graph.userSelf" />
</EntityContainer>
</Schema></edmx:DataServices></edmx:Edmx>`;
}

const json = (status, body, headers = {}) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });

/**
 * The fixture tenant. Every collection answers with KEEL-RT- objects and a count,
 * except: /users takes no $count and pages, /groups has more pages than the cap,
 * /print/printers is refused, the PIM role settings lists answer 400 MissingProvider
 * without their scope filter (as Graph does), and anything not GET would be recorded.
 */
function fixtureTenant() {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, method: init?.method, body: init?.body, auth: init?.headers?.Authorization });
    const parsed = new URL(url);
    const path = parsed.pathname.replace(/^\/(v1\.0|beta)/, '');
    if (path === '/users') {
      if (parsed.searchParams.has('$count')) return json(400, { error: { code: 'Request_BadRequest', message: '$count is not supported' } });
      const page = Number(parsed.searchParams.get('page') ?? 0);
      return json(200, { value: [{ displayName: `KEEL-RT-user-${page}` }], ...(page < 2 ? { '@odata.nextLink': `https://graph.microsoft.com/v1.0/users?page=${page + 1}` } : {}) });
    }
    if (path === '/groups') {
      return json(200, { value: [{ displayName: 'KEEL-RT-group' }], '@odata.nextLink': 'https://graph.microsoft.com/v1.0/groups?$skiptoken=next' });
    }
    if (path === '/print/printers') {
      return json(403, { error: { code: 'Authorization_RequestDenied', message: "Missing role permissions on the request. API requires one of 'Printer.Read.All, Printer.ReadWrite.All'." } });
    }
    if (/^\/policies\/(roleManagementPolicies|roleManagementPolicyAssignments)$/.test(path) && parsed.searchParams.get('$filter') !== "scopeId eq '/' and scopeType eq 'DirectoryRole'") {
      return json(400, { error: { code: 'UnknownError', message: '{"errorCode":"MissingProvider","message":"The provider is missing."}' } });
    }
    if (path === '/bookingBusinesses') return json(200, { value: [{ displayName: 'KEEL-RT-booking-a' }, { displayName: 'KEEL-RT-booking-b' }], '@odata.count': 2 });
    if (path === '/sites/getAllSites') return json(200, { value: [{ displayName: 'KEEL-RT-site' }], '@odata.count': 1 });
    return json(200, { value: [{ displayName: 'KEEL-RT-object' }], '@odata.count': 1 });
  };
  return { calls, fetchImpl };
}

const CATALOGUED_CMDLETS = new Map([['ExchangeOnlineManagement', new Set(['Get-TransportRule', 'Get-Mailbox'])], ['MicrosoftTeams', new Set(['Get-CsTeamsMeetingPolicy'])]]);

let database;
let client;
before(async () => {
  database = await createIsolatedTestDatabase(import.meta.url);
  client = await database.connect();
  await client.query(schemaSql());
});
after(async () => {
  await client?.end();
  await database?.cleanup();
});

test('the metadata walk reaches every catalogue path and skips /me', () => {
  const paths = discoverablePaths(parseMetadata(fixtureMetadata()));
  const seen = new Set(paths.map((entry) => entry.path.toLowerCase()));
  for (const entry of CATALOG.filter((item) => !isUnderItem(item.path))) assert.ok(seen.has(entry.path.toLowerCase()), entry.path);
  // Inherited containment (print -> printBase.printers) is walked; non-containment (owner) is not.
  assert.ok(seen.has('/print/printers'));
  assert.ok(!seen.has('/print/owner'));
  assert.ok(![...seen].some((path) => path === '/me' || path.startsWith('/me/')));
  assert.deepEqual(paths.find((entry) => entry.path === '/bookingBusinesses'), { path: '/bookingBusinesses', kind: 'entitySet', entityType: 'bookingBusiness', collection: true });
  // A singleton that only groups types (print, policies) is walked, not listed.
  assert.ok(!seen.has('/print') && !seen.has('/policies'));
});

test('the walk reaches four segments deep by default', () => {
  const xml = `<edmx:Edmx Version="4.0" xmlns:edmx="http://docs.oasis-open.org/odata/ns/edmx"><edmx:DataServices>
<Schema Namespace="microsoft.graph" Alias="graph">
<EntityType Name="policyRoot"><NavigationProperty Name="crossTenantAccessPolicy" Type="graph.ctap" ContainsTarget="true" /></EntityType>
<EntityType Name="ctap"><Property Name="displayName" Type="Edm.String" /><NavigationProperty Name="templates" Type="graph.templates" ContainsTarget="true" /></EntityType>
<EntityType Name="templates"><NavigationProperty Name="multiTenantOrganizationIdentitySynchronization" Type="graph.mtoSync" ContainsTarget="true" /></EntityType>
<EntityType Name="mtoSync"><Property Name="userSyncInbound" Type="Edm.String" /><NavigationProperty Name="deeper" Type="graph.mtoSync" ContainsTarget="true" /></EntityType>
<EntityContainer Name="GraphService"><Singleton Name="policies" Type="graph.policyRoot" /></EntityContainer>
</Schema></edmx:DataServices></edmx:Edmx>`;
  const parsed = parseMetadata(xml);
  const deep = '/policies/crossTenantAccessPolicy/templates/multiTenantOrganizationIdentitySynchronization';
  assert.deepEqual(discoverablePaths(parsed).map((entry) => entry.path), ['/policies/crossTenantAccessPolicy', deep]);
  assert.ok(!discoverablePaths(parsed, { maxDepth: 3 }).some((entry) => entry.path === deep));
});

test('on the fixture tenant every catalogued type is covered and the planted type is flagged', async () => {
  const tenant = fixtureTenant();
  const graph = readOnlyGraph(async () => 'fixture-token', { fetchImpl: tenant.fetchImpl, sleep: async () => {} });
  const run = await discover({ graph, metadata: { 'v1.0': fixtureMetadata() }, cataloguedCmdlets: CATALOGUED_CMDLETS, now: fixed, pageCap: 3 });

  for (const entry of run.catalogue) assert.ok(['covered', 'under-item'].includes(entry.coverage), `${entry.type}: ${entry.coverage}`);
  assert.equal(run.catalogue.length, CATALOG.length);

  const byName = new Map(run.items.map((item) => [item.name, item]));
  const planted = byName.get('/bookingBusinesses');
  assert.equal(planted.status, 'uncatalogued');
  assert.equal(planted.objects, 2);
  assert.equal(planted.objectsExact, true);
  assert.deepEqual(run.items.filter((item) => item.status === 'uncatalogued' && item.source.startsWith('graph:')).map((item) => item.name), ['/bookingBusinesses']);

  const refused = byName.get('/print/printers');
  assert.equal(refused.status, 'unreadable');
  assert.equal(refused.reason, 'missing-grant');
  assert.equal(refused.httpStatus, 403);
  assert.equal(refused.missingGrant, 'Printer.Read.All');
  assert.equal(refused.grantSource, 'graph');

  // /users takes no $count: counted by walking pages. /groups outruns the cap: a lower bound.
  assert.deepEqual([byName.get('/users').objects, byName.get('/users').objectsExact], [3, true]);
  assert.deepEqual([byName.get('/groups').objects, byName.get('/groups').objectsExact], [3, false]);
  assert.equal(byName.get('/users').status, 'catalogued');
  assert.deepEqual(byName.get('/users').catalogTypes, ['user']);
  assert.equal(byName.get('/teams').catalogTypes[0], 'teams-settings');

  // The PIM role settings lists need the catalogue's scope filter to answer at all.
  for (const name of ['/policies/roleManagementPolicies', '/policies/roleManagementPolicyAssignments']) {
    assert.deepEqual([byName.get(name).status, byName.get(name).objects], ['catalogued', 1], name);
  }
  assert.ok(tenant.calls.some((call) => call.url.includes('/policies/roleManagementPolicies?$filter=')));
  assert.ok(!tenant.calls.some((call) => /\/policies\/roleManagementPolicies(\?\$count|$)/.test(call.url)), 'never probed without its filter');

  assert.equal(run.summary.containers.sites.objects, 1);
  assert.deepEqual(run.summary.containers.groups, { objects: 3, exact: false });
  assert.equal(run.summary.uncatalogued, 1);
  assert.equal(run.summary.unreadable, 1);
  assert.equal(run.sources.find((source) => source.source === 'graph:v1.0').status, 'complete');

  // Read only: every request was a body-less GET to Graph, with the token.
  assert.ok(tenant.calls.length > CATALOG.length);
  for (const call of tenant.calls) {
    assert.equal(call.method, 'GET');
    assert.equal(call.body, undefined);
    assert.equal(new URL(call.url).origin, 'https://graph.microsoft.com');
    assert.equal(call.auth, 'Bearer fixture-token');
  }
});

test('an alias path counts as its backed-up kind and a skipped path is not a gap', async () => {
  const tenant = fixtureTenant();
  const graph = readOnlyGraph(async () => 'fixture-token', { fetchImpl: tenant.fetchImpl, sleep: async () => {} });
  const run = await discover({ graph, metadata: { 'v1.0': fixtureMetadata() }, cataloguedCmdlets: CATALOGUED_CMDLETS, now: fixed, pageCap: 3 });
  const byName = new Map(run.items.map((item) => [item.name, item]));

  assert.deepEqual([byName.get('/agreements').status, byName.get('/agreements').catalogTypes], ['catalogued', ['agreement']]);
  assert.deepEqual([byName.get('/applicationTemplates').status, byName.get('/applicationTemplates').reason], ['skipped', 'microsoft-published']);
  assert.deepEqual([byName.get('/subscriptions').status, byName.get('/subscriptions').reason], ['skipped', 'not-configuration']);
  // A skipped path is still read and counted; it just is not a gap.
  assert.equal(byName.get('/subscriptions').objects, 1);
  assert.equal(run.summary.skipped, 2);
  assert.equal(run.summary.uncatalogued, 1);

  // A refused skipped path stays unreadable: the reason it failed is kept.
  const refusing = readOnlyGraph(async () => 'fixture-token', {
    sleep: async () => {},
    fetchImpl: async (url, init) => (new URL(url).pathname.endsWith('/subscriptions') ? json(403, { error: { code: 'Forbidden', message: 'no' } }) : tenant.fetchImpl(url, init)),
  });
  const refused = await discover({ graph: refusing, metadata: { 'v1.0': fixtureMetadata() }, cataloguedCmdlets: CATALOGUED_CMDLETS, now: fixed, pageCap: 3 });
  assert.equal(refused.items.find((item) => item.name === '/subscriptions').status, 'unreadable');

  // The schema takes the new status and reasons.
  const runId = await saveDiscoveryRun(client, { tenantRef: 'sha256:discovery-skip-test', run });
  const stored = await client.query("SELECT name, status, reason FROM discovery_item WHERE run_id = $1 AND status = 'skipped' ORDER BY name", [runId]);
  assert.deepEqual(stored.rows, [{ name: '/applicationTemplates', status: 'skipped', reason: 'microsoft-published' }, { name: '/subscriptions', status: 'skipped', reason: 'not-configuration' }]);
});

test('every alias names a backed-up kind, and no alias or skipped path is itself catalogued', () => {
  const types = new Set(CATALOG.map((entry) => entry.type));
  const catalogued = new Set(CATALOG.map((entry) => catalogPath(entry.path).toLowerCase()));
  const aliases = Object.keys(ALIAS_PATHS).map((path) => path.toLowerCase());
  for (const [path, type] of Object.entries(ALIAS_PATHS)) {
    assert.ok(types.has(type), `${path}: ${type} is not in the catalogue`);
    assert.ok(!catalogued.has(path.toLowerCase()), `${path} is already a catalogue path`);
  }
  for (const [path, reason] of Object.entries(SKIPPED_PATHS)) {
    assert.ok(SKIP_REASONS.includes(reason), `${path}: ${reason}`);
    assert.ok(!catalogued.has(path.toLowerCase()), `${path} is skipped but backed up`);
    assert.ok(!aliases.includes(path.toLowerCase()), `${path} is both an alias and skipped`);
    assert.match(path, /^\/[A-Za-z]/);
  }
});

test('writes and foreign hosts are refused before anything is sent', async () => {
  for (const method of ['POST', 'PATCH', 'PUT', 'DELETE']) {
    assert.throws(() => assertReadOnly('https://graph.microsoft.com/v1.0/users', { method }), DiscoveryWriteRefused);
  }
  assert.throws(() => assertReadOnly('https://graph.microsoft.com/v1.0/users', { method: 'GET', body: '{}' }), DiscoveryWriteRefused);
  assert.throws(() => assertReadOnly('https://graph.example.test/v1.0/users'), DiscoveryWriteRefused);

  // A nextLink pointing elsewhere is refused, not followed with the token.
  const calls = [];
  const graph = readOnlyGraph(async () => 'token', {
    fetchImpl: async (url) => {
      calls.push(url);
      return json(200, { value: [{}], '@odata.nextLink': 'https://evil.example.test/steal' });
    },
  });
  await assert.rejects(probePath(graph, 'v1.0', { path: '/users', collection: true }), DiscoveryWriteRefused);
  assert.ok(calls.every((url) => url.startsWith('https://graph.microsoft.com/')));
});

test('throttled reads wait the full Retry-After and a metadata failure reads unknown', async () => {
  const waits = [];
  let first = true;
  const graph = readOnlyGraph(null, {
    sleep: async (ms) => { waits.push(ms); },
    fetchImpl: async () => {
      if (first) {
        first = false;
        return json(429, {}, { 'retry-after': '7' });
      }
      return json(200, { value: [], '@odata.count': 0 });
    },
  });
  const probe = await probePath(graph, 'v1.0', { path: '/domains', collection: true });
  assert.deepEqual([probe.readable, probe.objects, waits], [true, 0, [7000]]);

  const run = await discover({ graph, metadata: { beta: new Error('GET /beta/$metadata answered 503') }, cataloguedCmdlets: new Map(), now: fixed });
  assert.deepEqual(run.sources, [{ source: 'graph:beta', status: 'unknown', error: 'GET /beta/$metadata answered 503', metadataVersion: null, paths: 0 }]);
  assert.equal(run.items.length, 0);
  assert.ok(run.catalogue.every((entry) => entry.coverage === 'not-in-metadata'));
});

test('only a catalogue $filter with no parent placeholder is required on discovery reads', () => {
  assert.equal(requiredFilter("$filter=scopeId eq '/' and scopeType eq 'DirectoryRole'&$expand=rules"), "$filter=scopeId eq '/' and scopeType eq 'DirectoryRole'");
  assert.equal(requiredFilter("$filter=roleDefinitionId eq '{parent}'"), null);
  assert.equal(requiredFilter('$expand=settings'), null);
  assert.equal(requiredFilter(undefined), null);
});

test('failure reasons and grant hints', () => {
  assert.equal(failureReason(403, { message: 'Insufficient privileges' }), 'missing-grant');
  assert.equal(failureReason(400, { message: 'Tenant does not have a SPO license.' }), 'not-licensed');
  assert.equal(failureReason(400, { message: 'Requires a filter' }), 'not-listable');
  assert.equal(failureReason(500, {}), 'error');
  assert.deepEqual(missingGrant('/deviceManagement/managedDevices', 'Forbidden'), { grant: 'DeviceManagementManagedDevices.Read.All', source: 'documented', held: false });
  assert.deepEqual(missingGrant('/deviceManagement/deviceConfigurations', null), { grant: 'DeviceManagementConfiguration.Read.All', source: 'documented', held: false });
  assert.deepEqual(missingGrant('/sites', 'Required scopes = [Sites.Read.All, Sites.ReadWrite.All]'), { grant: 'Sites.Read.All', source: 'graph', held: false });
  assert.equal(missingGrant('/somethingNew', 'denied'), null);
  // Issue #663: the PIM for Groups read names its scopes in a shape Graph's own errors do not use.
  assert.deepEqual(missingGrant('/identityGovernance/privilegedAccess/group/resources',
    'Authorization failed due to missing permission scope PrivilegedEligibilitySchedule.Read.AzureADGroup,PrivilegedAccess.Read.AzureADGroup.'),
  { grant: 'PrivilegedAccess.Read.AzureADGroup', source: 'documented', held: false });
  assert.equal(missingGrant('/deviceManagement/virtualEndpoint/cloudPCs', 'accessDenied: Access is denied to the requested resource.').grant, 'CloudPC.Read.All');
});

test('a refusal for a grant the app already holds is refused-with-grant, never a grant hint', async () => {
  const held = ['DeviceManagementConfiguration.Read.All', 'Sites.ReadWrite.All'];
  assert.equal(holdsGrant(held, 'deviceManagementConfiguration.read.all'), true);
  assert.equal(holdsGrant(held, 'Sites.Read.All'), true, 'ReadWrite covers Read');
  assert.equal(holdsGrant(held, 'Printer.Read.All'), false);
  assert.equal(holdsGrant(null, 'Printer.Read.All'), false);
  assert.deepEqual(missingGrant('/deviceManagement/auditEvents', 'Forbidden', held), { grant: 'DeviceManagementConfiguration.Read.All', source: 'documented', held: true });
  assert.deepEqual(missingGrant('/sites', 'Required scopes = [Sites.Read.All, Sites.FullControl.All]', held), { grant: 'Sites.Read.All', source: 'graph', held: true });
  assert.deepEqual(missingGrant('/print/printers', "API requires one of 'Printer.Read.All, Printer.ReadWrite.All'", held), { grant: 'Printer.Read.All', source: 'graph', held: false });

  const forbidden = { get: async () => ({ status: 403, json: { error: { code: 'Forbidden', message: 'Application is not authorized to perform this operation.' } } }) };
  const entry = { path: '/deviceManagement/auditEvents', collection: true };
  const unknown = await probePath(forbidden, 'beta', entry);
  assert.deepEqual([unknown.reason, unknown.grant?.grant], ['missing-grant', 'DeviceManagementConfiguration.Read.All'], 'roles unknown: the documented hint stays');
  const holding = await probePath(forbidden, 'beta', entry, { heldGrants: held });
  assert.deepEqual([holding.reason, holding.grant, holding.httpStatus], ['refused-with-grant', null, 403]);
  assert.match(holding.message, /not authorized/, "Graph's own words are kept");

  const payload = Buffer.from(JSON.stringify({ roles: ['Printer.Read.All', 7] })).toString('base64url');
  assert.deepEqual(tokenRoles(`h.${payload}.s`), ['Printer.Read.All']);
  assert.equal(tokenRoles('opaque-token'), null);
  assert.equal(tokenRoles(`h.${Buffer.from('{}').toString('base64url')}.s`), null);
});

test('PowerShell Get cmdlets are classified from the host list, and a missing list is not-listed', async () => {
  const known = await catalogedCmdlets();
  assert.ok(known.get('ExchangeOnlineManagement').has('Get-TransportRule'));
  assert.ok(known.get('MicrosoftTeams').has('Get-CsTeamsMeetingPolicy'));
  for (const cmdlets of known.values()) for (const cmdlet of cmdlets) assert.match(cmdlet, /^Get-/);

  const { sources, items } = discoverPowerShell({ ExchangeOnlineManagement: ['Get-TransportRule', 'Get-JournalRule', 'Set-Mailbox', 'Get-Mailbox'] }, CATALOGUED_CMDLETS);
  const exo = items.filter((item) => item.source === 'powershell:ExchangeOnlineManagement');
  assert.deepEqual(exo.map((item) => [item.name, item.status]), [['Get-JournalRule', 'uncatalogued'], ['Get-Mailbox', 'catalogued'], ['Get-TransportRule', 'catalogued']]);
  assert.deepEqual(items.filter((item) => item.source === 'powershell:MicrosoftTeams').map((item) => [item.name, item.status]), [['Get-CsTeamsMeetingPolicy', 'not-listed']]);
  assert.equal(sources.find((source) => source.source === 'powershell:MicrosoftTeams').status, 'unknown');
});

test('a run is stored and the latest run reads back with its items', async () => {
  const tenant = fixtureTenant();
  const graph = readOnlyGraph(async () => 't', { fetchImpl: tenant.fetchImpl });
  const run = await discover({
    graph, metadata: { 'v1.0': fixtureMetadata() }, cataloguedCmdlets: CATALOGUED_CMDLETS, now: fixed,
    powershellCommands: { ExchangeOnlineManagement: ['Get-JournalRule'] },
  });
  const first = await saveDiscoveryRun(client, { tenantRef: TENANT_REF, run });
  const second = await saveDiscoveryRun(client, { tenantRef: TENANT_REF, run: { ...run, finishedAt: '2026-10-14T13:00:00.000Z' } });
  assert.notEqual(String(first), String(second));

  const latest = await loadLatestDiscovery(client, { tenantRef: TENANT_REF });
  assert.equal(latest.id, String(second));
  assert.equal(latest.items.length, run.items.length);
  assert.deepEqual(latest.summary, run.summary);
  assert.deepEqual(latest.catalogue, run.catalogue);
  const flagged = await loadLatestDiscovery(client, { tenantRef: TENANT_REF, statuses: ['uncatalogued'] });
  assert.deepEqual(flagged.items.map((item) => item.name).sort(), ['/bookingBusinesses', 'Get-JournalRule']);
  assert.equal(await loadLatestDiscovery(client, { tenantRef: 'sha256:other-tenant' }), null);
  await assert.rejects(saveDiscoveryRun(client, { tenantRef: 'raw-tenant-id', run }), TypeError);
  const refusedWithGrant = run.items.map((item) => (item.name === '/print/printers' ? { ...item, reason: 'refused-with-grant', missingGrant: null, grantSource: null } : item));
  assert.ok(await saveDiscoveryRun(client, { tenantRef: TENANT_REF, run: { ...run, items: refusedWithGrant } }), 'the schema accepts refused-with-grant');
});

test('the CLI runs from saved metadata, writes the inventory and stores nothing with --no-store', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'keel-discover-'));
  try {
    writeFileSync(join(dir, 'v1.0.xml'), fixtureMetadata());
    writeFileSync(join(dir, 'tenant.json'), JSON.stringify({ tenantId: 'fixture-tenant' }));
    const tenant = fixtureTenant();
    const lines = [];
    const listed = [];
    const code = await discoverCli(['run', '--config', join(dir, 'tenant.json'), '--versions', 'v1.0', '--metadata-dir', dir, '--no-store', '--out', join(dir, 'inventory.json')], {
      fetchImpl: tenant.fetchImpl, getTokenFn: async () => ({ accessToken: 'cli-token' }), now: fixed,
      // By default each module is listed live; one that cannot be keeps its reason.
      listCommandsFn: async (options) => {
        listed.push(options);
        return { commands: { MicrosoftTeams: ['Get-CsTeamsMeetingPolicy', 'Get-CsTeamsFixturePolicy'] }, errors: { ExchangeOnlineManagement: 'Exchange Online: could not connect: denied' } };
      },
      connectFn: async () => { throw new Error('the database must not be touched'); },
      logger: { log: (line) => lines.push(line) },
    });
    assert.equal(code, 0, 'a PowerShell module that could not be listed does not fail the run');
    assert.deepEqual(listed, [{ tenantConfigPath: join(dir, 'tenant.json'), familyConfigPaths: {} }]);
    assert.ok(lines.includes('PowerShell MicrosoftTeams: listed 2 Get cmdlets.'));
    assert.ok(lines.includes('PowerShell ExchangeOnlineManagement: not listed (Exchange Online: could not connect: denied).'));
    const inventory = JSON.parse(readFileSync(join(dir, 'inventory.json'), 'utf8'));
    assert.deepEqual(inventory.sources.filter((source) => source.source.startsWith('powershell:')).map((source) => [source.source, source.status, source.error]), [
      ['powershell:ExchangeOnlineManagement', 'unknown', 'Exchange Online: could not connect: denied'],
      ['powershell:MicrosoftTeams', 'complete', null],
      ['powershell:PnP.PowerShell', 'unknown', 'no command list was supplied for this module'],
    ]);
    assert.ok(inventory.items.some((item) => item.name === 'Get-CsTeamsFixturePolicy' && item.status === 'uncatalogued'));
    assert.match(inventory.tenantRef, /^sha256:/);
    assert.equal(inventory.summary.uncatalogued, 2, '/bookingBusinesses and the listed Teams cmdlet');
    assert.ok(lines.some((line) => line.includes('/bookingBusinesses (2 objects)')));
    assert.ok(lines.some((line) => line.includes('/print/printers: missing-grant (403), needs Printer.Read.All')));
    assert.ok(!tenant.calls.some((call) => call.url.includes('$metadata')));
    assert.equal(await discoverCli(['nonsense'], { logger: { log() {} } }), 2);

    // Issue #542: the scope file's powershellConfigs reach the listing, as in the collect,
    // so Exchange and Security & Compliance connect with a config that names the organization.
    writeFileSync(join(dir, 'scope.json'), JSON.stringify({ powershellConfigs: { exchange: '/etc/keel/exchange-collector.json', purview: '/etc/keel/purview-collector.json' } }));
    const familyFiles = { '/etc/keel/exchange-collector.json': { tenantId: 'fixture-tenant', organization: 'contoso.onmicrosoft.com' }, '/etc/keel/purview-collector.json': { organization: 'contoso.onmicrosoft.com' } };
    const scoped = [];
    assert.equal(await discoverCli(['run', '--config', join(dir, 'tenant.json'), '--scope', join(dir, 'scope.json'), '--versions', 'v1.0', '--metadata-dir', dir, '--no-store'], {
      fetchImpl: fixtureTenant().fetchImpl, getTokenFn: async () => ({ accessToken: 'cli-token' }), now: fixed,
      readFile: (path) => (familyFiles[path] ? JSON.stringify(familyFiles[path]) : readFileSync(path, 'utf8')),
      listCommandsFn: async (options) => { scoped.push(options); return { commands: {}, errors: {} }; },
      connectFn: async () => { throw new Error('the database must not be touched'); },
      logger: { log() {} },
    }), 0);
    assert.deepEqual(scoped, [{
      tenantConfigPath: join(dir, 'tenant.json'),
      familyConfigPaths: { exchange: '/etc/keel/exchange-collector.json', purview: '/etc/keel/purview-collector.json' },
    }]);

    // A token whose roles already hold the grant: the refusal is not blamed on a missing grant.
    const roles = Buffer.from(JSON.stringify({ roles: ['Printer.Read.All'] })).toString('base64url');
    const held = [];
    assert.equal(await discoverCli(['run', '--config', join(dir, 'tenant.json'), '--versions', 'v1.0', '--metadata-dir', dir, '--no-store', '--no-powershell'], {
      fetchImpl: fixtureTenant().fetchImpl, getTokenFn: async () => ({ accessToken: `h.${roles}.s` }), now: fixed,
      listCommandsFn: async () => { throw new Error('--no-powershell lists nothing'); },
      connectFn: async () => { throw new Error('the database must not be touched'); },
      logger: { log: (line) => held.push(line) },
    }), 0);
    const printers = held.find((line) => line.includes('/print/printers:'));
    assert.match(printers, /\/print\/printers: refused-with-grant \(403\); Graph said: Authorization_RequestDenied: Missing role permissions/);
    assert.ok(!printers.includes('needs'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('discover is a valid weekly schedule, a schema job kind, a collect capability and a worker dispatch', async () => {
  const seed = initialSchedules(new Date('2026-10-15T18:00:00Z')).find((row) => row.jobKind === 'discover');
  assert.deepEqual(seed.cadence, { every: 'week', n: 1, atTime: '04:00' });
  assert.equal(seed.cronOverride, '0 4 * * 1');
  assert.equal(seed.nextDueAt.toISOString(), '2026-10-19T04:00:00.000Z', 'the next Monday, 04:00 UTC');
  const row = { job_kind: 'discover', tier: null, cadence: seed.cadence, cron_override: seed.cronOverride };
  assert.doesNotThrow(() => validateSchedule(row));
  assert.equal(nextDueAt(row, seed.nextDueAt).toISOString(), '2026-10-26T04:00:00.000Z');
  assert.throws(() => validateSchedule({ ...row, tier: 'tier1' }), /invalid schedule tier/);
  assert.throws(() => validateSchedule({ ...row, cron_override: '0 */6 * * *' }), /schedule_minimum_interval/, 'more often than daily is refused');

  assert.equal(capabilityForJobKind('discover'), 'collect');
  const job = await enqueue(client, { kind: 'discover', params: { tenantRef: 'sha256:x' }, requestedBy: 'scheduler-test', idempotencyKey: `disc-${Date.now()}` });
  assert.equal(job.kind, 'discover', 'the schema CHECK accepts the kind');

  const handler = JOB_HANDLERS.discover;
  assert.ok(handler.script.endsWith('cli/keel-discover.mjs'));
  assert.notEqual(handler.acceptsDbUrl, false, 'the worker passes its database to the run');
  assert.deepEqual(handler.argsFor({ tenantRef: 'sha256:x' }), ['run', '--tenant-ref', 'sha256:x']);
  assert.deepEqual(handler.argsFor({ config: '/etc/keel/tenant.json' }), ['run', '--config', '/etc/keel/tenant.json']);
  assert.throws(() => handler.argsFor({ tenantRef: 'sha256:x', versions: 'beta' }), /may contain only/);
  assert.throws(() => handler.argsFor({ tenantRef: 'sha256:x', 'no-store': true }), /may contain only/);
  assert.ok(JOB_TIMEOUT_MS.discover > JOB_TIMEOUT_MS.default);
});

test('a scheduled run for another tenant is refused before any request; the matching tenant runs', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'keel-discover-'));
  try {
    writeFileSync(join(dir, 'v1.0.xml'), fixtureMetadata());
    writeFileSync(join(dir, 'tenant.json'), JSON.stringify({ tenantId: 'fixture-tenant' }));
    const tenant = fixtureTenant();
    const options = {
      fetchImpl: tenant.fetchImpl, getTokenFn: async () => ({ accessToken: 'cli-token' }), now: fixed,
      connectFn: async () => { throw new Error('the database must not be touched'); },
      logger: { log() {} },
    };
    const base = ['run', '--config', join(dir, 'tenant.json'), '--versions', 'v1.0', '--metadata-dir', dir, '--no-store'];
    await assert.rejects(discoverCli([...base, '--tenant-ref', 'sha256:another'], options), /another tenant/);
    assert.equal(tenant.calls.length, 0, 'nothing was sent');
    assert.equal(await discoverCli([...base, '--tenant-ref', tenantRefFor('fixture-tenant')], options), 0);
    assert.ok(tenant.calls.length > 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// The refusals the live tenant gives for types it does not use (Q99, Q104): a licence
// 403, AADB2C99039 for API connectors, Intune's 501 and a 404 for a singleton never set up.
function tenantWithout(fetchImpl) {
  return async (url, init) => {
    const path = new URL(url).pathname.replace(/^\/(v1\.0|beta)/, '');
    if (path.startsWith('/identityGovernance/lifecycleWorkflows/')) {
      return json(403, { error: { code: 'AccessDenied', message: 'Insufficient license for this tenant. Entra ID Governance is required.' } });
    }
    if (path === '/identity/apiConnectors') return json(400, { error: { code: 'AADB2C99039', message: 'Self service sign up is not enabled for this tenant.' } });
    if (path === '/deviceManagement/exchangeConnectors') return json(501, { error: { code: 'NotSupported', message: 'Not supported' } });
    if (path === '/deviceManagement/applePushNotificationCertificate') return json(404, { error: { code: 'ResourceNotFound', message: 'Not found' } });
    if (path === '/deviceManagement/mobileThreatDefenseConnectors') {
      return json(403, { error: { code: 'Forbidden', message: "Application is not authorized to perform this operation. Application must have one of the following scopes: DeviceManagementServiceConfig.Read.All" } });
    }
    return fetchImpl(url, init);
  };
}

test('a backed-up type the tenant does not use is not-used with its reason; a refused read stays unreadable', async () => {
  const tenant = fixtureTenant();
  const graph = readOnlyGraph(async () => 't', { fetchImpl: tenantWithout(tenant.fetchImpl), sleep: async () => {} });
  const run = await discover({ graph, metadata: { 'v1.0': fixtureMetadata() }, cataloguedCmdlets: CATALOGUED_CMDLETS, now: fixed });
  const byType = new Map(run.catalogue.map((entry) => [entry.type, entry]));
  const view = (type) => [byType.get(type).coverage, byType.get(type).reason];
  for (const type of ['lifecycleWorkflow', 'lifecycleWorkflowCustomTaskExtension', 'lifecycleManagementSettings']) {
    if (byType.has(type)) assert.deepEqual(view(type), ['not-used', 'not-licensed'], type);
  }
  assert.ok(byType.has('lifecycleWorkflow'));
  assert.deepEqual(view('identityApiConnector'), ['not-used', 'feature-off']);
  assert.deepEqual(view('deviceManagementExchangeConnector'), ['not-used', 'feature-off']);
  assert.deepEqual(view('applePushNotificationCertificate'), ['not-used', 'not-set-up']);
  // A missing permission is still a problem, and names the permission.
  assert.deepEqual(view('mobileThreatDefenseConnector'), ['unreadable', 'missing-grant']);
  assert.match(byType.get('mobileThreatDefenseConnector').missingGrant, /^DeviceManagement\w+\.Read\.All$/);
  assert.equal(run.summary.catalogue.unreadable, 1);

  // A run stored before the rule existed reads back with it applied.
  const old = run.catalogue.map((entry) => (entry.coverage === 'not-used' ? { ...entry, coverage: 'unreadable', reason: 'not-listable' } : entry));
  const id = await saveDiscoveryRun(client, { tenantRef: 'sha256:discovery-not-used', run: { ...run, catalogue: old } });
  assert.ok(id);
  const latest = await loadLatestDiscovery(client, { tenantRef: 'sha256:discovery-not-used', statuses: ['uncatalogued'] });
  assert.deepEqual(latest.catalogue, run.catalogue);
  assert.deepEqual(reclassifyCatalogue(old, []), old, 'without the refusals nothing is guessed');
});

test('notUsedReason only excuses the refusals the backup also treats as not used', () => {
  assert.equal(notUsedReason({}, { httpStatus: 403, message: 'Forbidden: Insufficient license' }), 'not-licensed');
  assert.equal(notUsedReason({}, { httpStatus: 400, message: 'AADB2C99039: self service sign up is not enabled' }), 'feature-off');
  assert.equal(notUsedReason({}, { httpStatus: 501, message: 'NotSupported' }), 'feature-off');
  assert.equal(notUsedReason({ absentWhenNotFound: true }, { httpStatus: 404, message: null }), 'not-set-up');
  assert.equal(notUsedReason({}, { httpStatus: 404, message: null }), null, 'a 404 on a list is a wrong read');
  assert.equal(notUsedReason({}, { httpStatus: 403, message: 'Authorization_RequestDenied' }), null);
  assert.equal(notUsedReason({}, { httpStatus: 400, message: 'BadRequest: Resource not found for the segment' }), null);
  assert.equal(notUsedReason({}, null), null);
});
