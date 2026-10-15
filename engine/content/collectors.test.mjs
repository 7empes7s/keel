import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { CONTENT_COLLECTORS } from './collectors.mjs';
import { driveTransport, mailReader } from './collectorTransports.mjs';
import { backupOneDrives } from './onedrives.mjs';
import { createMemoryContentStore } from './store.mjs';
import { createMemorySyncState } from './syncState.mjs';
import { contentReadTransport, sharePointReadTransport } from './transport.mjs';
import { runContentCollection } from '../../cli/keel-content-collect.mjs';

const GRAPH = 'https://graph.microsoft.com';
const TENANT_ID = '00000000-0000-0000-0000-0000000000c1';
const HOST = 'keelrt.sharepoint.com';
const SITE = `${HOST},11111111-1111-1111-1111-111111111111,22222222-2222-2222-2222-222222222222`;
const LIST = '55555555-5555-5555-5555-555555555555';
const TEAM_COVERED = '66666666-6666-6666-6666-666666666666';
const TEAM_OTHER = '77777777-7777-7777-7777-777777777777';
const CHANNEL = '19:KEEL-RT-general@thread.tacv2';
const OTHER = `${HOST},33333333-3333-3333-3333-333333333333,44444444-4444-4444-4444-444444444444`;
const quiet = { log: () => {} };
// The mailFolder properties Graph v1.0 knows (wellKnownName is beta-only).
const MAIL_FOLDER_V1 = new Set(['id', 'displayName', 'parentFolderId', 'childFolderCount', 'unreadItemCount', 'totalItemCount', 'isHidden']);

const json = (body, status = 200, headers = {}) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
const deltaDone = (url) => json({ value: [], '@odata.deltaLink': `${url.split('?')[0]}?$deltatoken=KEEL-RT-done` });

/**
 * A fixture tenant behind a fake fetch: two KEEL-RT- users (one with a OneDrive and a
 * mailbox, one without either), one user outside the prefix, one KEEL-RT- site with a
 * document library. Every other list answers empty and every other delta answers done.
 */
function fixtureTenant({ librarySize = 14 } = {}) {
  const calls = [];
  const fetchImpl = async (href, init) => {
    calls.push({ url: href, headers: init.headers });
    const url = new URL(href);
    const path = decodeURIComponent(url.pathname);
    const token = url.searchParams.get('$deltatoken');
    if (path === '/v1.0/users') {
      return json({ value: [
        { id: 'u-alice', displayName: 'KEEL-RT-alice', userPrincipalName: 'KEEL-RT-alice@keelrt.example', mail: 'KEEL-RT-alice@keelrt.example' },
        { id: 'u-bob', displayName: 'KEEL-RT-bob', userPrincipalName: 'KEEL-RT-bob@keelrt.example', mail: null },
        { id: 'u-carol', displayName: 'carol', userPrincipalName: 'carol@keelrt.example', mail: 'carol@keelrt.example' },
      ] });
    }
    if (path === '/v1.0/users/u-alice/drive') return json({ id: 'KEEL-RT-drive-alice', driveType: 'business' });
    if (path === '/v1.0/users/u-bob/drive') return json({ error: { code: 'itemNotFound', message: 'no OneDrive' } }, 404);
    if (path === '/v1.0/users/u-carol/drive') throw new Error('a user outside the prefix was read');
    for (const [driveId, file] of [['KEEL-RT-drive-alice', 'KEEL-RT-notes.txt'], ['KEEL-RT-libdrive', 'KEEL-RT-report.txt']]) {
      if (path === `/v1.0/drives/${driveId}/root/delta`) {
        if (token) return deltaDone(href);
        return json({
          value: [
            { id: `${driveId}-root`, root: {}, name: 'root' },
            { id: `${driveId}-f1`, name: file, file: {}, size: driveId === 'KEEL-RT-libdrive' ? librarySize : 14, cTag: 'c1', eTag: 'e1', parentReference: { id: `${driveId}-root` } },
          ],
          '@odata.deltaLink': `${GRAPH}/v1.0/drives/${driveId}/root/delta?$deltatoken=KEEL-RT-1`,
        });
      }
      if (path === `/v1.0/drives/${driveId}/items/${driveId}-f1/content`) return new Response('KEEL-RT- bytes', { status: 200 });
    }
    if (path === '/v1.0/users/u-alice/mailboxSettings/userPurpose') return json({ value: 'user' });
    if (path === '/beta/users/u-alice/settings/exchange') return json({ error: { code: 'NotFound' } }, 404);
    if (path === '/v1.0/users/u-alice/mailFolders/delta') {
      if (token) return deltaDone(href);
      // Like Graph v1.0: a $select naming a property mailFolder does not have fails the whole read (#263).
      const unknown = (url.searchParams.get('$select') ?? '').split(',').filter((key) => key && !MAIL_FOLDER_V1.has(key));
      if (unknown.length) return json({ error: { code: 'BadRequest', message: `Could not find a property named '${unknown[0]}' on type 'microsoft.graph.mailFolder'.` } }, 400);
      return json({ value: [{ id: 'inbox', displayName: 'Inbox', changeKey: 'k1' }], '@odata.deltaLink': `${GRAPH}/v1.0/users/u-alice/mailFolders/delta?$deltatoken=KEEL-RT-1` });
    }
    if (path === '/v1.0/users/u-alice/mailFolders/inbox/messages/delta') {
      if (token) return deltaDone(href);
      return json({ value: [{ id: 'm1', changeKey: 'mk1' }], '@odata.deltaLink': `${GRAPH}/v1.0/users/u-alice/mailFolders/inbox/messages/delta?$deltatoken=KEEL-RT-1` });
    }
    if (path === '/v1.0/users/u-alice/messages/m1/$value') return new Response('Subject: KEEL-RT-\r\n\r\nhello', { status: 200 });
    if (path === '/v1.0/sites/root') return json({ siteCollection: { hostname: HOST } });
    if (path === '/v1.0/sites/getAllSites') {
      return json({ value: [
        { id: SITE, name: 'KEEL-RT-site', displayName: 'KEEL-RT-site', webUrl: `https://${HOST}/sites/KEEL-RT-site` },
        { id: OTHER, name: 'other', displayName: 'other', webUrl: `https://${HOST}/sites/other` },
      ] });
    }
    if (path.startsWith(`/v1.0/sites/${OTHER}`)) throw new Error('a site outside the prefix was read');
    if (path === `/v1.0/sites/${SITE}`) return json({ id: SITE, displayName: 'KEEL-RT-site', lastModifiedDateTime: '2026-10-14T00:00:00Z' });
    if (path === `/v1.0/sites/${SITE}/lists`) return json({ value: [{ id: LIST, displayName: 'KEEL-RT-docs', list: { template: 'documentLibrary' } }] });
    if (path === `/v1.0/sites/${SITE}/lists/${LIST}/drive`) return json({ id: 'KEEL-RT-libdrive', driveType: 'documentLibrary' });
    if (path === '/v1.0/teams') return json({ value: [{ id: TEAM_COVERED }, { id: TEAM_OTHER }] });
    for (const [team, siteId, driveId] of [[TEAM_COVERED, SITE, 'KEEL-RT-libdrive'], [TEAM_OTHER, OTHER, 'other-drive']]) {
      if (path === `/v1.0/teams/${team}`) return json({ id: team, displayName: team === TEAM_COVERED ? 'KEEL-RT-team' : 'other team', tenantId: TENANT_ID });
      if (path === `/v1.0/teams/${team}/channels`) return json({ value: [{ id: CHANNEL, membershipType: 'standard' }] });
      if (path === `/v1.0/teams/${team}/channels/${CHANNEL}`) return json({ id: CHANNEL, membershipType: 'standard', displayName: 'General' });
      if (path === `/v1.0/teams/${team}/channels/${CHANNEL}/filesFolder`) return json({ id: 'folder-general', name: 'General', parentReference: { driveId, siteId } });
    }
    if (path.endsWith('/delta')) return deltaDone(href);
    return json({ value: [] });
  };
  return { calls, fetchImpl, transport: contentReadTransport(async () => 'KEEL-RT-token', fetchImpl) };
}

function withState(syncState) {
  return CONTENT_COLLECTORS.map((entry) => ({ workload: entry.workload, collect: (client, context) => entry.collect(client, { ...context, syncState }) }));
}

test('the registry runs mail, OneDrive, sites, Teams and Planner, with sites before Teams', () => {
  const order = CONTENT_COLLECTORS.map((entry) => entry.workload);
  assert.deepEqual(order, ['exchange-mail', 'onedrive', 'sharepoint-sites', 'teams', 'planner']);
  assert.ok(order.indexOf('sharepoint-sites') < order.indexOf('teams'), 'Teams channel files point at the team site backup of the same run');
});

test('a content-collect run backs up every workload of a KEEL-RT- fixture tenant and keeps delta state', async () => {
  const tenant = fixtureTenant();
  const store = createMemoryContentStore();
  const syncState = createMemorySyncState();
  // Each run reads an hour after the last, so nothing time-based can pass as unchanged.
  let clock = Date.parse('2026-10-14T12:00:00Z');
  const run = () => {
    clock += 3600_000;
    const at = clock;
    return runContentCollection(null, {
      tenantRef: 'sha256:KEEL-RT', tenantId: TENANT_ID, store, transport: tenant.transport,
      scope: { namePrefix: 'KEEL-RT-' }, collectors: withState(syncState), logger: quiet, now: () => new Date(at),
    });
  };

  const first = await run();
  assert.deepEqual(first.runs.map((r) => [r.workload, r.outcome]), [
    ['exchange-mail', 'succeeded'], ['onedrive', 'succeeded'], ['sharepoint-sites', 'succeeded'], ['teams', 'succeeded'], ['planner', 'succeeded'],
  ], JSON.stringify(first.runs.map((r) => r.reasons)));
  assert.equal(first.exitCode, 0);
  assert.ok(first.runs.find((r) => r.workload === 'exchange-mail').items >= 2, 'the folder and the message are stored');

  const files = await store.listItems({ container: 'drive:KEEL-RT-drive-alice' });
  assert.ok(files.some((item) => item.metadata.kind === 'drive-content' && item.bytes === 'KEEL-RT- bytes'.length), 'the OneDrive file is stored');
  const site = await store.listItems({ container: `site:${SITE}` });
  assert.ok(site.some((item) => item.workload === 'sharepoint-sites' && item.metadata.kind === 'drive-content'), 'the library file is stored with the site');

  // Delta state is saved per mailbox, per OneDrive, per library and per list, plus each
  // site's stored settings and which libraries were read in full.
  const keys = [...syncState.rows.keys()].map((key) => JSON.parse(key).slice(1));
  assert.deepEqual(keys.sort(), [
    ['exchange-mail', 'mailbox/u-alice'],
    ['onedrive', 'drive:KEEL-RT-drive-alice'],
    ['sharepoint-sites', `covered:${SITE}/KEEL-RT-libdrive`],
    ['sharepoint-sites', `items:${SITE}/${LIST}`],
    ['sharepoint-sites', `library:${SITE}/${LIST}/KEEL-RT-libdrive`],
    ['sharepoint-sites', `site:${SITE}`],
  ].sort());

  // A channel folder is covered by its site only when that site's library was read in full.
  const filesOf = async (team) => {
    const [item] = await store.listItems({ container: `team:${team}` });
    const document = JSON.parse(Buffer.concat(await (await store.getItem(item.ref)).toArray()).toString());
    return document.channels.items[0].files;
  };
  const covered = await filesOf(TEAM_COVERED);
  assert.equal(covered.status, 'covered-by-site');
  assert.equal(covered.coveredBy, `site:${SITE}`);
  assert.equal((await filesOf(TEAM_OTHER)).status, 'unconfirmed', 'the other team site was outside the prefix and never backed up');

  // The second run resumes from the saved delta links instead of reading everything again.
  tenant.calls.length = 0;
  const second = await run();
  assert.equal(second.exitCode, 0);
  const deltas = tenant.calls.map((call) => new URL(call.url)).filter((url) => url.pathname.endsWith('/delta') && url.pathname.includes('KEEL-RT-'));
  assert.ok(deltas.length >= 2);
  assert.ok(deltas.every((url) => url.searchParams.get('$deltatoken') === 'KEEL-RT-1'), deltas.map(String).join('\n'));
  const mailDeltas = tenant.calls.map((call) => new URL(call.url)).filter((url) => url.pathname.startsWith('/v1.0/users/u-alice/mailFolders'));
  assert.ok(mailDeltas.length > 0 && mailDeltas.every((url) => url.searchParams.get('$deltatoken') === 'KEEL-RT-1'));
  assert.ok(!tenant.calls.some((call) => call.url.endsWith('/content')), 'nothing already stored is downloaded again');
  assert.equal(second.runs.find((r) => r.workload === 'sharepoint-sites').items, 0, 'an unchanged site stores nothing on a repeat run');
  const itemDeltas = tenant.calls.map((call) => new URL(call.url)).filter((url) => url.pathname.endsWith('/items/delta'));
  assert.ok(itemDeltas.length > 0 && itemDeltas.every((url) => url.searchParams.get('$deltatoken') === 'KEEL-RT-done'), itemDeltas.map(String).join('\n'));
  // An unchanged team keeps its one stored version (#269).
  for (const team of [TEAM_COVERED, TEAM_OTHER]) {
    assert.equal((await store.listItems({ container: `team:${team}` })).length, 1, `${team} was stored again with no change`);
  }
  // The drive delta carries its Prefer options through the read-only transport.
  const driveDelta = tenant.calls.find((call) => call.url.includes('/drives/KEEL-RT-drive-alice/root/delta'));
  assert.match(driveDelta.headers.prefer, /deltashowremovedasdeleted/);
});

test('a library that finished with file warnings makes the sites run partial and says why', async () => {
  const tenant = fixtureTenant({ librarySize: 99 });
  const sites = CONTENT_COLLECTORS.find((entry) => entry.workload === 'sharepoint-sites');
  const syncState = createMemorySyncState();
  const result = await sites.collect(null, {
    tenantRef: 'sha256:KEEL-RT', store: createMemoryContentStore(), transport: tenant.transport, scope: { namePrefix: 'KEEL-RT-' },
    sleep: async () => {}, now: () => new Date(), syncState,
  });
  assert.equal(result.outcome, 'partial');
  assert.match(result.reasons.join('\n'), /KEEL-RT-docs library files: partial \(1 file warning\(s\), first: size-mismatch\)/);
  assert.ok(![...syncState.rows.keys()].some((key) => key.includes('covered:')), 'a partial library is not recorded as covering its Teams folders');
});

test('a team whose channel list cannot be read makes the Teams run partial and says which part and why', async () => {
  const tenant = fixtureTenant();
  const transport = contentReadTransport(async () => 'KEEL-RT-token', async (href, init) => {
    const path = decodeURIComponent(new URL(href).pathname);
    if (path === `/v1.0/teams/${TEAM_OTHER}/channels`) return json({ error: { code: 'NotFound', message: 'no thread' } }, 404);
    return tenant.fetchImpl(href, init);
  });
  const teams = CONTENT_COLLECTORS.find((entry) => entry.workload === 'teams');
  const result = await teams.collect(null, {
    tenantRef: 'sha256:KEEL-RT', tenantId: TENANT_ID, store: createMemoryContentStore(), transport,
    sleep: async () => {}, now: () => new Date(), syncState: createMemorySyncState(),
  });
  assert.equal(result.outcome, 'partial');
  assert.deepEqual(result.reasons, [`other team: 1 part(s) not read, first channel list: failed (GET /v1.0/teams/${TEAM_OTHER}/channels: HTTP 404)`]);
});

test('OneDrive backup reports users without a drive as skipped and fails only when nothing synced', async () => {
  const tenant = fixtureTenant();
  const store = createMemoryContentStore();
  const result = await backupOneDrives({ transport: tenant.transport, store, tenantRef: 'sha256:KEEL-RT', syncState: createMemorySyncState(), namePrefix: 'KEEL-RT-' });
  assert.equal(result.outcome, 'succeeded', JSON.stringify(result));
  assert.deepEqual(result.drives.map((drive) => drive.driveId), ['KEEL-RT-drive-alice']);
  assert.deepEqual(result.skipped, [{ userId: 'u-bob', name: 'KEEL-RT-bob@keelrt.example', reason: 'no OneDrive' }]);

  const denied = contentReadTransport(async () => 'KEEL-RT-token', async () => json({ error: { code: 'Authorization_RequestDenied' } }, 403));
  const failed = await backupOneDrives({ transport: denied, store, tenantRef: 'sha256:KEEL-RT', syncState: createMemorySyncState() });
  assert.equal(failed.outcome, 'failed');
  assert.match(failed.errors[0].error, /HTTP 403/);
});

test('the adapters keep every request a Graph GET and only pass read headers', async () => {
  const seen = [];
  let throttled = 1;
  const fetchImpl = async (href, init) => {
    seen.push({ href, init });
    if (href.includes('throttled') && throttled-- > 0) return json({}, 429, { 'retry-after': '2' });
    if (href.includes('missing')) return json({ error: { code: 'ErrorItemNotFound', message: 'gone' } }, 404);
    if (href.includes('/$value')) return new Response('x'.repeat(100), { status: 200 });
    return json({ value: [] });
  };
  const transport = contentReadTransport(async () => 'KEEL-RT-token', fetchImpl);
  await assert.rejects(transport(`${GRAPH}/v1.0/users`, { headers: { 'x-ms-whatever': '1' } }), /refused request header/);
  await assert.rejects(driveTransport(transport)({ method: 'DELETE', url: `${GRAPH}/v1.0/drives/d/items/i` }), /read-only/);

  const waits = [];
  const reader = mailReader(transport, { sleep: async (ms) => { waits.push(ms); } });
  assert.deepEqual(await reader.get('v1.0', '/users/throttled/messages'), { ok: true, status: 200, body: { value: [] } });
  assert.deepEqual(waits, [2000]);
  assert.deepEqual(await reader.get('v1.0', '/users/missing'), { ok: false, status: 404, code: 'ErrorItemNotFound', error: 'gone' });
  assert.equal((await reader.get('v1.0', 'https://evil.example/v1.0/users')).code, 'Refused');
  assert.equal((await reader.getStream('v1.0', '/users/u/messages/m/$value', { maxBytes: 10 })).tooLarge, true);
  assert.equal((await reader.getStream('v1.0', '/users/u/messages/m/$value', { maxBytes: 1000 })).bytes.length, 100);
  assert.equal((await reader.getStream('v1.0', '/users/missing/$value', { maxBytes: 1000 })).status, 404);
  // A failed download answers Graph's JSON error, and its stream is read and closed.
  const drive = driveTransport(contentReadTransport(async () => 'KEEL-RT-token', async () => json({ error: { code: 'resourceLocked' } }, 423)));
  const locked = await drive({ method: 'GET', url: `${GRAPH}/v1.0/drives/d/items/i/content` });
  assert.deepEqual([locked.status, locked.body], [423, { error: { code: 'resourceLocked' } }]);
  assert.ok(seen.every((call) => call.init.method === 'GET'));
});

test('the sites run reads site permissions through a GET-only SharePoint transport on the tenant host', async () => {
  const tenant = fixtureTenant();
  const sharePointCalls = [];
  const tokens = [];
  const sharePointFetch = async (href, init) => {
    sharePointCalls.push({ href, init });
    const path = decodeURIComponent(new URL(href).pathname);
    if (path === '/sites/KEEL-RT-site/_api/web') return json({ Id: 'w1', Url: `https://${HOST}/sites/KEEL-RT-site`, HasUniqueRoleAssignments: true });
    if (path === '/sites/KEEL-RT-site/_api/web/sitegroups') return json({ value: [{ Id: 3, Title: 'KEEL-RT-site Owners' }] });
    if (path === '/sites/KEEL-RT-site/_api/web/sitegroups/GetById(3)/users') return json({ value: [{ Id: 11, Title: 'KEEL-RT-alice' }] });
    if (path === '/sites/KEEL-RT-site/_api/web/roleassignments') {
      return json({ value: [{ PrincipalId: 3, Member: { Id: 3, Title: 'KEEL-RT-site Owners' }, RoleDefinitionBindings: [{ Id: 1073741829, Name: 'Full Control' }] }] });
    }
    return json({ value: [] });
  };
  const sharePointTransportFor = (tenantHost) => sharePointReadTransport(async () => { tokens.push(tenantHost); return 'KEEL-RT-sp-token'; }, sharePointFetch, { tenantHost });
  const sites = CONTENT_COLLECTORS.find((entry) => entry.workload === 'sharepoint-sites');
  const store = createMemoryContentStore();
  const result = await sites.collect(null, {
    tenantRef: 'sha256:KEEL-RT', store, transport: tenant.transport, sharePointTransportFor, scope: { namePrefix: 'KEEL-RT-' },
    sleep: async () => {}, now: () => new Date(), syncState: createMemorySyncState(),
  });
  assert.equal(result.outcome, 'succeeded', JSON.stringify(result.reasons));
  assert.deepEqual(tokens, [HOST]);
  assert.ok(sharePointCalls.length >= 7);
  for (const call of sharePointCalls) {
    assert.equal(call.init.method, 'GET');
    assert.equal(new URL(call.href).hostname, HOST);
    assert.equal(call.init.headers.accept, 'application/json;odata=nometadata');
    assert.equal(call.init.headers.authorization, 'Bearer KEEL-RT-sp-token');
  }
  const stored = (await store.listItems({ container: `site:${SITE}`, tenantRef: 'sha256:KEEL-RT', workload: 'sharepoint-sites' })).filter((item) => item.itemKey === 'site/permissions');
  assert.equal(stored.length, 1);
});

test('the SharePoint transport refuses writes, bodies, other hosts and paths outside /_api/', async () => {
  const sent = [];
  const transport = sharePointReadTransport(async () => 'KEEL-RT-token', async (href) => { sent.push(href); return json({ value: [] }); }, { tenantHost: HOST });
  await assert.rejects(transport(`https://${HOST}/sites/x/_api/web`, { method: 'POST' }), /read-only/);
  await assert.rejects(transport(`https://${HOST}/sites/x/_api/web`, { body: '{}' }), /read-only/);
  await assert.rejects(transport('https://fabrikam.sharepoint.com/sites/x/_api/web'), /reads keelrt.sharepoint.com only/);
  await assert.rejects(transport(`https://${HOST}/sites/x/Shared%20Documents/a.docx`), /REST API only/);
  await assert.rejects(transport('https://graph.microsoft.com/v1.0/sites/root'), /only/);
  assert.deepEqual(sent, []);
  assert.equal((await transport(`https://${HOST}/sites/x/_api/web`)).status, 200);
  assert.throws(() => sharePointReadTransport(async () => 't', undefined, { tenantHost: 'evil.example' }), /tenantHost/);
});
