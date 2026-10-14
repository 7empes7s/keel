import { strict as assert } from 'node:assert';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';

import { CATALOG } from '../../tools/tenant-probe/catalog.mjs';
import { createIsolatedTestDatabase } from '../test/dbTestHelper.mjs';
import { schemaSql } from '../store/loadSchema.mjs';
import { catalogedCmdlets, isUnderItem } from './catalogue.mjs';
import { discover, discoverPowerShell, failureReason, probePath } from './discover.mjs';
import { missingGrant } from './grants.mjs';
import { discoverablePaths, parseMetadata } from './metadata.mjs';
import { loadLatestDiscovery, saveDiscoveryRun } from './store.mjs';
import { DiscoveryWriteRefused, assertReadOnly, readOnlyGraph } from './transport.mjs';
import { main as discoverCli } from '../../cli/keel-discover.mjs';

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
    if (isUnderItem(entry.path)) continue;
    const segments = entry.path.split('?')[0].split('/').filter(Boolean);
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
 * /print/printers is refused, and anything not GET would be recorded.
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

test('failure reasons and grant hints', () => {
  assert.equal(failureReason(403, { message: 'Insufficient privileges' }), 'missing-grant');
  assert.equal(failureReason(400, { message: 'Tenant does not have a SPO license.' }), 'not-licensed');
  assert.equal(failureReason(400, { message: 'Requires a filter' }), 'not-listable');
  assert.equal(failureReason(500, {}), 'error');
  assert.deepEqual(missingGrant('/deviceManagement/managedDevices', 'Forbidden'), { grant: 'DeviceManagementManagedDevices.Read.All', source: 'documented' });
  assert.deepEqual(missingGrant('/deviceManagement/deviceConfigurations', null), { grant: 'DeviceManagementConfiguration.Read.All', source: 'documented' });
  assert.deepEqual(missingGrant('/sites', 'Required scopes = [Sites.Read.All, Sites.ReadWrite.All]'), { grant: 'Sites.Read.All', source: 'graph' });
  assert.equal(missingGrant('/somethingNew', 'denied'), null);
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
});

test('the CLI runs from saved metadata, writes the inventory and stores nothing with --no-store', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'keel-discover-'));
  try {
    writeFileSync(join(dir, 'v1.0.xml'), fixtureMetadata());
    writeFileSync(join(dir, 'tenant.json'), JSON.stringify({ tenantId: 'fixture-tenant' }));
    const tenant = fixtureTenant();
    const lines = [];
    const code = await discoverCli(['run', '--config', join(dir, 'tenant.json'), '--versions', 'v1.0', '--metadata-dir', dir, '--no-store', '--out', join(dir, 'inventory.json')], {
      fetchImpl: tenant.fetchImpl, getTokenFn: async () => ({ accessToken: 'cli-token' }), now: fixed,
      connectFn: async () => { throw new Error('the database must not be touched'); },
      logger: { log: (line) => lines.push(line) },
    });
    assert.equal(code, 0);
    const inventory = JSON.parse(readFileSync(join(dir, 'inventory.json'), 'utf8'));
    assert.match(inventory.tenantRef, /^sha256:/);
    assert.equal(inventory.summary.uncatalogued, 1);
    assert.ok(lines.some((line) => line.includes('/bookingBusinesses (2 objects)')));
    assert.ok(lines.some((line) => line.includes('/print/printers: missing-grant (403), needs Printer.Read.All')));
    assert.ok(!tenant.calls.some((call) => call.url.includes('$metadata')));
    assert.equal(await discoverCli(['nonsense'], { logger: { log() {} } }), 2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
