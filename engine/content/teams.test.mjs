// Wave 1 package TEAMS: Teams container backup.
//
// Done-test: a fixture team with three channel kinds and tabs is captured, and messages
// are flagged "waiting on Microsoft", not silently missing. Everything runs against an
// in-memory fake Graph and an in-memory fake of the content store. No tenant is read.
import { strict as assert } from 'node:assert';
import { createHash } from 'node:crypto';
import { test } from 'node:test';

import {
  MESSAGES_WAITING, SITE_LIBRARY_COVERAGE, TEAMS_CONTENT_WORKLOAD, TeamsContentScopeError, assertTeamsContentRequest, backupTeams, readTeamContainers,
} from './teams.mjs';

const TENANT = '00000000-0000-4000-8000-0000000000c1';
const OTHER_TENANT = '00000000-0000-4000-8000-0000000000f2';
const TEAM = 'aaaaaaaa-0000-4000-8000-000000000001';
const TEAM_2 = 'aaaaaaaa-0000-4000-8000-000000000002';
const FOREIGN_TEAM = 'aaaaaaaa-0000-4000-8000-0000000000ff';
const GENERAL = '19:keelrtgeneral@thread.tacv2';
const PRIVATE = '19:keelrtprivate@thread.tacv2';
const SHARED = '19:keelrtshared@thread.tacv2';
const GUEST_SHARED = '19:keelrtguestshared@thread.tacv2';
const OWNER = 'bbbbbbbb-0000-4000-8000-000000000001';
const PARTNER = 'bbbbbbbb-0000-4000-8000-000000000005';
const GRAPH = 'https://graph.microsoft.com/v1.0';
const NOW = () => new Date('2026-10-14T12:00:00Z');

const enc = encodeURIComponent;
const ch = (teamId, channelId) => `/teams/${teamId}/channels/${enc(channelId)}`;
const folder = (name, driveId) => ({ id: `item-${name}`, name, webUrl: `https://contoso.sharepoint.com/sites/KEEL-RT-Containers/Shared%20Documents/${name}`, parentReference: { driveId, siteId: `site-${driveId}` } });

function fixture() {
  return {
    '/teams': { value: [{ id: TEAM, displayName: 'KEEL-RT-Containers' }, { id: FOREIGN_TEAM, displayName: 'KEEL-RT-Foreign' }], '@odata.nextLink': `${GRAPH}/teams?$skiptoken=page2` },
    '/teams?$skiptoken=page2': { value: [{ id: TEAM_2, displayName: 'KEEL-RT-Empty' }] },
    [`/teams/${TEAM}`]: {
      id: TEAM, displayName: 'KEEL-RT-Containers', description: 'Fixture team', visibility: 'private', isArchived: false, tenantId: TENANT,
      memberSettings: { allowCreateUpdateChannels: false }, guestSettings: { allowCreateUpdateChannels: false },
      messagingSettings: { allowUserEditMessages: true }, funSettings: { allowGiphy: false }, discoverySettings: { showInTeamsSearchAndSuggestions: false },
    },
    [`/teams/${TEAM}/installedApps?$expand=teamsAppDefinition`]: { value: [
      { id: 'inst-2', teamsAppDefinition: { teamsAppId: 'com.microsoft.teamspace.tab.planner', displayName: 'Planner', version: '1.0' } },
      { id: 'inst-1', teamsAppDefinition: { teamsAppId: 'com.microsoft.teamspace.tab.files.sharepoint', displayName: 'SharePoint', version: '1.0' } },
    ] },
    [`/teams/${TEAM}/channels`]: { value: [
      { id: GENERAL, displayName: 'General', membershipType: 'standard', tenantId: TENANT },
      { id: PRIVATE, displayName: 'KEEL-RT-Private', membershipType: 'private', tenantId: TENANT },
      { id: SHARED, displayName: 'KEEL-RT-Shared', membershipType: 'shared', tenantId: TENANT },
      { id: GUEST_SHARED, displayName: 'Partner channel', membershipType: 'shared', tenantId: OTHER_TENANT },
    ] },
    [ch(TEAM, GENERAL)]: { id: GENERAL, displayName: 'General', membershipType: 'standard', tenantId: TENANT, isFavoriteByDefault: true, email: 'general@contoso.com' },
    [ch(TEAM, PRIVATE)]: { id: PRIVATE, displayName: 'KEEL-RT-Private', membershipType: 'private', tenantId: TENANT },
    [ch(TEAM, SHARED)]: { id: SHARED, displayName: 'KEEL-RT-Shared', membershipType: 'shared', tenantId: TENANT },
    [`${ch(TEAM, PRIVATE)}/members`]: { value: [{ id: 'm1', userId: OWNER.toUpperCase(), tenantId: TENANT, roles: ['owner'], displayName: 'KEEL-RT-Owner' }] },
    [`${ch(TEAM, SHARED)}/members`]: { value: [
      { id: 'm2', userId: PARTNER, tenantId: OTHER_TENANT, roles: [], displayName: 'Partner' },
      { id: 'm1', userId: OWNER, tenantId: TENANT, roles: ['owner'], displayName: 'KEEL-RT-Owner' },
    ] },
    [`${ch(TEAM, GENERAL)}/tabs?$expand=teamsApp`]: { value: [
      { id: 'tab-wiki', displayName: 'Notes', configuration: { contentUrl: 'https://example.invalid/notes' }, teamsApp: { id: 'com.microsoft.teamspace.tab.wiki', displayName: 'Wiki', distributionMethod: 'store' } },
      { id: 'tab-planner', displayName: 'Plan', configuration: { entityId: 'plan-1' }, teamsApp: { id: 'com.microsoft.teamspace.tab.planner', displayName: 'Planner', distributionMethod: 'store' } },
    ] },
    [`${ch(TEAM, PRIVATE)}/tabs?$expand=teamsApp`]: { value: [] },
    [`${ch(TEAM, SHARED)}/tabs?$expand=teamsApp`]: { value: [{ id: 'tab-web', displayName: 'Site', configuration: { websiteUrl: 'https://example.invalid' }, teamsApp: { id: 'com.microsoft.teamspace.tab.web', displayName: 'Website' } }] },
    [`${ch(TEAM, GENERAL)}/filesFolder`]: folder('General', 'drive-main'),
    [`${ch(TEAM, PRIVATE)}/filesFolder`]: folder('KEEL-RT-Private', 'drive-private'),
    [`${ch(TEAM, SHARED)}/filesFolder`]: folder('KEEL-RT-Shared', 'drive-shared'),
    [`/teams/${FOREIGN_TEAM}`]: { id: FOREIGN_TEAM, displayName: 'KEEL-RT-Foreign', tenantId: OTHER_TENANT },
    [`/teams/${TEAM_2}`]: { id: TEAM_2, displayName: 'KEEL-RT-Empty', tenantId: TENANT },
    [`/teams/${TEAM_2}/installedApps?$expand=teamsAppDefinition`]: { value: [] },
    [`/teams/${TEAM_2}/channels`]: { value: [] },
  };
}

function fakeGraph(routes = fixture(), overrides = {}) {
  const calls = [];
  const transport = async (url) => {
    calls.push(url);
    const parsed = new URL(url);
    const key = `${parsed.pathname.replace('/v1.0', '')}${decodeURIComponent(parsed.search)}`;
    const override = overrides[key];
    if (override) return typeof override === 'function' ? override() : override;
    const body = routes[key];
    return body ? { status: 200, headers: {}, body } : { status: 404, headers: {}, body: { error: { code: 'NotFound' } } };
  };
  return { transport, calls };
}

// The in-memory fake of the content store interface (section 2 of the coverage plan).
function fakeStore() {
  const blobs = new Map();
  const index = [];
  return {
    index,
    async putItem(stream, meta) {
      const chunks = [];
      for await (const chunk of stream) chunks.push(Buffer.from(chunk));
      const data = Buffer.concat(chunks);
      const sha256 = createHash('sha256').update(data).digest('hex');
      const deduped = blobs.has(sha256);
      blobs.set(sha256, data);
      const ref = `mem:${sha256}`;
      index.push({ ...meta, ref, sha256, bytes: data.length });
      return { ref, sha256, bytes: data.length, deduped };
    },
    async getItem(ref) {
      const { Readable } = await import('node:stream');
      return Readable.from([blobs.get(ref.slice(4))]);
    },
    async listItems({ container }) {
      return index.filter((item) => !container || item.container === container);
    },
  };
}

test('a fixture team with three channel kinds, tabs and apps is captured', async () => {
  const graph = fakeGraph();
  const result = await readTeamContainers({ transport: graph.transport, tenantId: TENANT, now: NOW });

  assert.equal(result.outcome, 'complete');
  assert.equal(result.discovery.pages, 2);
  assert.deepEqual(result.teams.map((entry) => entry.teamId), [TEAM, TEAM_2]);
  const [entry] = result.teams;
  assert.equal(entry.fields.displayName, 'KEEL-RT-Containers');
  assert.deepEqual(entry.fields.funSettings, { allowGiphy: false });
  assert.deepEqual(entry.installedApps.items.map((app) => app.displayName), ['SharePoint', 'Planner']);

  const kinds = Object.fromEntries(entry.channels.items.map((item) => [item.kind, item]));
  assert.deepEqual(Object.keys(kinds).sort(), ['private', 'shared', 'standard']);
  assert.equal(kinds.standard.fields.isFavoriteByDefault, true);
  assert.equal(kinds.standard.members.status, 'inherited');
  assert.deepEqual(kinds.private.members.items.map((member) => member.userId), [OWNER]);
  // A shared-channel member from another tenant keeps its own tenant id.
  assert.deepEqual(kinds.shared.members.items.map((member) => member.tenantId).sort(), [OTHER_TENANT, TENANT].sort());
  assert.deepEqual(kinds.standard.tabs.items.map((tab) => tab.app.displayName), ['Planner', 'Wiki']);
  assert.equal(kinds.shared.tabs.items[0].configuration.websiteUrl, 'https://example.invalid');
  assert.deepEqual(kinds.private.files.location, {
    driveId: 'drive-private', siteId: 'site-drive-private', itemId: 'item-KEEL-RT-Private', name: 'KEEL-RT-Private',
    webUrl: 'https://contoso.sharepoint.com/sites/KEEL-RT-Containers/Shared%20Documents/KEEL-RT-Private',
  });

  // Messages are flagged on every channel, never silently missing.
  for (const item of entry.channels.items) assert.deepEqual(item.messages, MESSAGES_WAITING);
  assert.equal(MESSAGES_WAITING.status, 'waiting-on-microsoft');

  // A channel hosted in another tenant and a team from another tenant are out of scope.
  assert.deepEqual(result.outOfScope.map((row) => row.reason).sort(), ['the channel is hosted in another tenant', 'the team belongs to another tenant']);
  assert.ok(!graph.calls.some((url) => url.includes(FOREIGN_TEAM) && !url.endsWith(FOREIGN_TEAM)), 'a foreign team is never read past its own record');
  assert.ok(!graph.calls.some((url) => url.includes(enc(GUEST_SHARED))), 'a foreign channel is never read');
});

test('only GET requests leave, and none of them reads messages or chats', async () => {
  const graph = fakeGraph();
  await readTeamContainers({ transport: graph.transport, tenantId: TENANT, now: NOW });
  assert.ok(graph.calls.length > 10);
  for (const url of graph.calls) {
    assert.doesNotThrow(() => assertTeamsContentRequest(url, 'GET'));
    assert.ok(!/messages|chats|replies|hostedContents/i.test(url), url);
  }
});

test('the scope guard refuses writes, messages, chats and widened queries', () => {
  const channelPath = `${GRAPH}${ch(TEAM, GENERAL)}`;
  for (const [url, method] of [
    [`${GRAPH}/teams/${TEAM}`, 'PATCH'],
    [`${GRAPH}/teams/${TEAM}/channels`, 'POST'],
    [`${channelPath}/tabs`, 'DELETE'],
    [`${channelPath}/messages`, 'GET'],
    [`${channelPath}/messages/delta`, 'GET'],
    [`${GRAPH}/teams/${TEAM}/channels/getAllMessages`, 'GET'],
    [`${GRAPH}/chats`, 'GET'],
    [`${GRAPH}/teams/${TEAM}?$expand=channels`, 'GET'],
    [`${channelPath}/tabs?$expand=teamsApp,messages`, 'GET'],
    [`${GRAPH}/teams?$filter=startswith(displayName,'x')`, 'GET'],
    [`https://example.invalid/v1.0/teams`, 'GET'],
  ]) {
    assert.throws(() => assertTeamsContentRequest(url, method), TeamsContentScopeError, `${method} ${url}`);
  }
  assert.ok(assertTeamsContentRequest(`${GRAPH}/teams?$skiptoken=abc`));
  assert.ok(assertTeamsContentRequest(`${channelPath}/tabs?$expand=teamsApp`));
});

test('backup stores one item per team, unchanged teams dedupe, and channel folders go to the sites module', async () => {
  const store = fakeStore();
  const folders = [];
  const sites = { async backupDriveFolder(location) { folders.push(location); return SITE_LIBRARY_COVERAGE.backupDriveFolder(location); } };
  const first = await backupTeams({ transport: fakeGraph().transport, tenantId: TENANT, tenantRef: 'test-tenant', store, sites, now: NOW });

  assert.equal(first.items.length, 2);
  assert.deepEqual(store.index.map((item) => [item.workload, item.container, item.itemKey]), [
    [TEAMS_CONTENT_WORKLOAD, `team:${TEAM}`, 'team.json'],
    [TEAMS_CONTENT_WORKLOAD, `team:${TEAM_2}`, 'team.json'],
  ]);
  assert.deepEqual(store.index[0].metadata.channels, { standard: 1, private: 1, shared: 1 });
  assert.equal(store.index[0].metadata.tabs, 3);
  assert.equal(store.index[0].metadata.messages, 'waiting-on-microsoft');
  assert.deepEqual(first.messages, { ...MESSAGES_WAITING, channels: 3 });
  assert.deepEqual(folders.map((location) => location.driveId).sort(), ['drive-main', 'drive-private', 'drive-shared']);
  assert.ok(folders.every((location) => location.tenantRef === 'test-tenant' && location.container.startsWith(`team:${TEAM}/channel:19:`)));

  // The stored document reads back and carries the messages flag on each channel.
  const doc = JSON.parse(await (async () => {
    const chunks = [];
    for await (const chunk of await store.getItem(first.items[0].ref)) chunks.push(chunk);
    return Buffer.concat(chunks).toString('utf8');
  })());
  assert.equal(doc.schema, 'keel.teams.team/v1');
  assert.ok(doc.channels.items.every((item) => item.messages.status === 'waiting-on-microsoft' && item.files.status === 'covered-by-site' && item.files.coveredBy === `site:site-${item.files.location.driveId}`));

  const second = await backupTeams({ transport: fakeGraph().transport, tenantId: TENANT, tenantRef: 'test-tenant', store, sites, now: NOW });
  assert.deepEqual(second.items.map((item) => item.deduped), [true, true]);
  assert.deepEqual(second.items.map((item) => item.version), first.items.map((item) => item.version));
});

test('a later run that reads the same teams in another order stores no new version (#269)', async () => {
  const store = fakeStore();
  const first = await backupTeams({ transport: fakeGraph().transport, tenantId: TENANT, tenantRef: 'test-tenant', store, now: NOW });

  // Same tenant an hour later, with Graph returning every list in reverse order.
  const reversed = Object.fromEntries(Object.entries(fixture()).map(([key, body]) => [key, Array.isArray(body?.value) ? { ...body, value: [...body.value].reverse() } : body]));
  const later = () => new Date('2026-10-14T13:00:00Z');
  const second = await backupTeams({ transport: fakeGraph(reversed).transport, tenantId: TENANT, tenantRef: 'test-tenant', store, now: later });
  assert.deepEqual(second.items.map((item) => item.version), first.items.map((item) => item.version));
  assert.deepEqual(second.items.map((item) => item.deduped), [true, true]);
  assert.deepEqual(store.index.map((item) => item.metadata.observedAt), [
    '2026-10-14T12:00:00.000Z', '2026-10-14T12:00:00.000Z', '2026-10-14T13:00:00.000Z', '2026-10-14T13:00:00.000Z',
  ]);

  // A real change still gives that team, and only that team, a new version.
  const renamed = fixture();
  renamed[`/teams/${TEAM}`] = { ...renamed[`/teams/${TEAM}`], description: 'Fixture team, renamed' };
  const third = await backupTeams({ transport: fakeGraph(renamed).transport, tenantId: TENANT, tenantRef: 'test-tenant', store, now: later });
  assert.notEqual(third.items[0].version, first.items[0].version);
  assert.equal(third.items[1].version, first.items[1].version);
});

test('by default, channel folders point at the team site backup and are not copied twice', async () => {
  const store = fakeStore();
  const result = await backupTeams({ transport: fakeGraph().transport, tenantId: TENANT, tenantRef: 'test-tenant', store, now: NOW });
  const files = result.teams[0].channels.items.map((item) => item.files);
  assert.deepEqual(files.map((file) => file.status), ['covered-by-site', 'covered-by-site', 'covered-by-site']);
  for (const file of files) {
    assert.deepEqual(file.backup, { coveredBy: `site:${file.location.siteId}`, driveId: file.location.driveId, itemId: file.location.itemId });
  }
  assert.ok(store.index.every((item) => item.itemKey === 'team.json'));
});

test('a folder is never backed-up without a pointer to the backup that covers it', async () => {
  const sites = { async backupDriveFolder() { return { items: 3 }; } };
  const result = await backupTeams({ transport: fakeGraph().transport, tenantId: TENANT, tenantRef: 'test-tenant', store: fakeStore(), sites, now: NOW });
  const statuses = result.teams[0].channels.items.map((item) => item.files.status);
  assert.deepEqual(statuses, ['unconfirmed', 'unconfirmed', 'unconfirmed']);
  assert.equal(await SITE_LIBRARY_COVERAGE.backupDriveFolder({ siteId: null, driveId: 'drive-main', itemId: 'x' }), null);
});

test('with the sites module turned off, channel folders are recorded as waiting on SharePoint', async () => {
  const result = await backupTeams({ transport: fakeGraph().transport, tenantId: TENANT, tenantRef: 'test-tenant', store: fakeStore(), sites: null, now: NOW });
  const statuses = result.teams[0].channels.items.map((item) => item.files.status);
  assert.deepEqual(statuses, ['waiting-on-sites', 'waiting-on-sites', 'waiting-on-sites']);
});

test('a denied or missing part is recorded on that part; a failed discovery is never empty', async () => {
  const graph = fakeGraph(fixture(), {
    [`${ch(TEAM, SHARED)}/tabs?$expand=teamsApp`]: { status: 403, headers: {}, body: {} },
    [`${ch(TEAM, PRIVATE)}/filesFolder`]: { status: 404, headers: {}, body: {} },
  });
  const partial = await readTeamContainers({ transport: graph.transport, tenantId: TENANT, now: NOW });
  assert.equal(partial.outcome, 'partial');
  const kinds = Object.fromEntries(partial.teams[0].channels.items.map((item) => [item.kind, item]));
  assert.equal(kinds.shared.tabs.status, 'denied');
  assert.equal(kinds.shared.tabs.items, null);
  assert.equal(kinds.private.files.status, 'not-provisioned');

  const down = await readTeamContainers({ transport: fakeGraph(fixture(), { '/teams': { status: 500, headers: {}, body: {} } }).transport, tenantId: TENANT, now: NOW });
  assert.equal(down.outcome, 'failed');
  assert.equal(down.discovery.teams, null);
  assert.deepEqual(down.teams, []);
});

test('throttling is retried after Retry-After, and a next page outside the request is refused', async () => {
  let throttled = 0;
  const waits = [];
  const graph = fakeGraph(fixture(), {
    [`/teams/${TEAM}/channels`]: () => (throttled++ === 0 ? { status: 429, headers: { 'retry-after': '2' }, body: {} } : { status: 200, headers: {}, body: fixture()[`/teams/${TEAM}/channels`] }),
  });
  const result = await readTeamContainers({ transport: graph.transport, tenantId: TENANT, sleep: async (ms) => { waits.push(ms); }, now: NOW });
  assert.deepEqual(waits, [2000]);
  assert.equal(result.teams[0].channels.items.length, 3);

  const routes = fixture();
  routes['/teams'] = { value: [], '@odata.nextLink': `${GRAPH}/chats?$skiptoken=x` };
  const refused = await readTeamContainers({ transport: fakeGraph(routes).transport, tenantId: TENANT, now: NOW });
  assert.equal(refused.outcome, 'failed');
});

test('the tenant id must be a directory id', async () => {
  await assert.rejects(() => readTeamContainers({ transport: async () => ({}), tenantId: 'contoso' }), TypeError);
  await assert.rejects(() => backupTeams({ transport: async () => ({}), tenantId: TENANT, tenantRef: 'x', store: {} }), TypeError);
});
