import { strict as assert } from 'node:assert';
import { after, before, test } from 'node:test';

import { permissionsSummary } from '../content/sharepointSites.mjs';
import { drivePermissionExposure } from '../content/permissionExposure.mjs';
import { createIsolatedTestDatabase } from '../test/dbTestHelper.mjs';
import { schemaSql } from '../store/loadSchema.mjs';
import { anonymityNamer } from './anonymity.mjs';
import { loadChangeFeed } from './feed.mjs';

// The change feed lists who can reach a site or OneDrive, compared between two content
// backups (#968): one row per change, named by the site, with its risk flags. The saved
// summaries come from the backup's own code, as a backup writes them.

const database = await createIsolatedTestDatabase(import.meta.url);
let client;
before(async () => {
  client = await database.connect();
  await client.query(schemaSql());
});
after(async () => {
  await client?.end();
  await database.cleanup();
});

// Every time is set relative to the run, so the test never rots (lessons 2026-10-04, 2026-10-08).
const NOW = new Date();
const hoursAgo = (hours) => new Date(NOW.getTime() - hours * 3_600_000);
const SITE = 'contoso.sharepoint.com,00000001-0000-4000-8000-000000000001,00000101-0000-4000-8000-000000000101';
const OTHER_SITE = 'contoso.sharepoint.com,00000002-0000-4000-8000-000000000002,00000202-0000-4000-8000-000000000202';
const ALL_USERS = { id: 5, title: 'Everyone except external users', loginName: 'c:0-.f|rolemanager|spo-grid-all-users/11111111-2222-4333-8444-555555555555', principalType: 4 };
const ADA = { id: 7, title: 'Ada Admin', loginName: 'i:0#.f|membership|ada@contoso.test', principalType: 1 };
const GUEST = { id: 8, title: 'Gail Guest', loginName: 'i:0#.f|membership|gail_fabrikam.test#ext#@contoso.onmicrosoft.com', principalType: 1 };

function permissions({ everyoneEdit = false, anyoneLinks = 0, guest = false, owners = [ADA] } = {}) {
  return {
    groups: [
      { id: 3, title: 'Finance Owners', members: owners },
      { id: 9, title: 'Finance Visitors', members: guest ? [GUEST] : [] },
      ...Array.from({ length: anyoneLinks }, (_, n) => ({ id: 200 + n, title: `SharingLinks.0b0c${n}.AnonymousView.f00d${n}`, members: [] })),
    ],
    siteCollectionAdmins: [],
    roleAssignments: [
      { principalId: 3, member: { id: 3, title: 'Finance Owners', principalType: 8 }, roles: [{ name: 'Full Control' }] },
      { principalId: 9, member: { id: 9, title: 'Finance Visitors', principalType: 8 }, roles: [{ name: 'Read' }] },
      ...(everyoneEdit ? [{ principalId: 5, member: ALL_USERS, roles: [{ name: 'Edit' }] }] : []),
    ],
  };
}

let serial = 0;
async function put(tenantRef, { workload, container, itemKey, metadata, at }) {
  serial += 1;
  await client.query(
    `INSERT INTO content_item (tenant_ref, workload, container, item_key, version, metadata, sha256, bytes, chunks, key_id, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, 10, '[]', 'k1', $8)`,
    [tenantRef, workload, container, itemKey, `v${serial}`, metadata, String(serial % 10).repeat(64), at],
  );
}
const siteBackup = (tenantRef, siteId, value, at, extra = {}) => put(tenantRef, {
  workload: 'sharepoint-sites', container: `site:${siteId}`, itemKey: 'site/permissions', at, metadata: { summary: permissionsSummary(value), ...extra },
});

test('a site opened to everyone, with anyone links, a guest and no owner left: one row each, named and flagged', async () => {
  const tenant = 'sharing-feed';
  await siteBackup(tenant, SITE, permissions({ anyoneLinks: 1 }), hoursAgo(30), { siteName: 'Finance' });
  await siteBackup(tenant, SITE, permissions({ everyoneEdit: true, anyoneLinks: 3, guest: true, owners: [] }), hoursAgo(6), { siteName: 'Finance' });
  // A site backed up once has nothing to compare with.
  await siteBackup(tenant, OTHER_SITE, permissions({ everyoneEdit: true }), hoursAgo(6), { siteName: 'Marketing' });

  const { rows } = await loadChangeFeed(client, { tenantRef: tenant, now: NOW });
  const backup = rows.filter((row) => row.source === 'backup');
  // Rows found at the same time sort by id: anyone links, Everyone, guests, owners.
  assert.deepEqual(backup.map((row) => [row.object.name, row.service, row.typeName, row.change, row.activity]), [
    ['Finance', 'SharePoint', 'Site access', 'added', '2 new links anyone can open (3 in all).'],
    ['Finance', 'SharePoint', 'Site access', 'added', 'Everyone in the company can now edit.'],
    ['Finance', 'SharePoint', 'Site access', 'added', '1 new guest (1 in all).'],
    ['Finance', 'SharePoint', 'Site access', 'removed', 'No owner left: the last owner was removed.'],
  ]);
  const byActivity = (pattern) => backup.find((row) => pattern.test(row.activity));
  const everyone = byActivity(/Everyone/);
  assert.deepEqual(everyone.flags, [{ key: 'opened-to-everyone-edit', severity: 'critical', sentence: 'Opened to everyone in the company: everyone in the company can now edit Finance.' }]);
  assert.deepEqual([everyone.priority, everyone.priorityReason], ['critical', everyone.flags[0].sentence]);
  const links = byActivity(/anyone can open/);
  assert.deepEqual(links.flags, [{ key: 'anyone-links-added', severity: 'high', sentence: 'Anyone links added: 2 new links that need no sign-in on Finance.' }]);
  assert.equal(links.priority, 'high');
  assert.deepEqual([byActivity(/guest/).flags, byActivity(/owner/).flags], [[], []]);
  assert.equal(byActivity(/guest/).priority, 'normal');
  assert.equal(backup.length, 4);
  assert.ok(backup.every((row) => row.object.key === `site:${SITE}`));
  assert.ok(!backup.some((row) => row.object.name === 'Marketing'));
});

test('a site is named from the SharePoint read when its backup saved no name; narrowing raises nothing', async () => {
  const tenant = 'sharing-feed-names';
  const { rows: [read] } = await client.query(
    "INSERT INTO workload_collection (tenant_ref, workload, outcome, observed_from, observed_to, created_at) VALUES ($1, 'sharepoint-site-settings', 'complete', $2, $2, $2) RETURNING id",
    [tenant, hoursAgo(40)],
  );
  await client.query('INSERT INTO workload_observation (collection_id, resource_key, fields) VALUES ($1, $2, $3)', [read.id, `site:${SITE}`, { displayName: 'Finance team' }]);
  await siteBackup(tenant, SITE, permissions({ anyoneLinks: 1 }), hoursAgo(30));
  await siteBackup(tenant, SITE, permissions({ everyoneEdit: true, anyoneLinks: 1 }), hoursAgo(20));
  // Closed again: the grant removed and links gone. Only the removal is a row, unflagged.
  await siteBackup(tenant, SITE, permissions({ anyoneLinks: 0 }), hoursAgo(6));
  const { rows } = await loadChangeFeed(client, { tenantRef: tenant, now: NOW });
  const backup = rows.filter((row) => row.source === 'backup');
  assert.deepEqual(backup.map((row) => [row.object.name, row.change, row.flags.map((flag) => flag.key)]), [
    ['Finance team', 'removed', []],
    ['Finance team', 'added', ['opened-to-everyone-edit']],
  ]);
  assert.equal(backup[0].activity, 'Everyone in the company can no longer edit.');
});

test('a backup saved before the exposure counts produces no row, never a false "removed"', async () => {
  const tenant = 'sharing-feed-old';
  const { exposure: _none, ...older } = permissionsSummary(permissions({ everyoneEdit: true, anyoneLinks: 5 }));
  await put(tenant, { workload: 'sharepoint-sites', container: `site:${SITE}`, itemKey: 'site/permissions', metadata: { summary: { ...older, v: 1 } }, at: hoursAgo(30) });
  await siteBackup(tenant, SITE, permissions({ everyoneEdit: true, anyoneLinks: 5 }), hoursAgo(6), { siteName: 'Finance' });
  // And the other way: the new summary before, an old one after (a backup restored from a bundle).
  await siteBackup(tenant, OTHER_SITE, permissions(), hoursAgo(30), { siteName: 'Marketing' });
  await put(tenant, { workload: 'sharepoint-sites', container: `site:${OTHER_SITE}`, itemKey: 'site/permissions', metadata: { summary: { ...older, v: 1 } }, at: hoursAgo(6) });
  const { rows } = await loadChangeFeed(client, { tenantRef: tenant, now: NOW });
  assert.deepEqual(rows.filter((row) => row.source === 'backup'), []);
});

test('a OneDrive: new anyone links and an Everyone grant across its files, with the owner code-named when names are hidden', async () => {
  const tenant = 'sharing-feed-onedrive';
  const drive = 'drive:b!abc';
  const record = (itemKey, grants, at, extra = {}) => put(tenant, {
    workload: 'onedrive', container: drive, itemKey, at,
    metadata: { kind: 'drive-record', ownerName: 'Ada Admin', name: itemKey, exposure: drivePermissionExposure(grants), ...extra },
  });
  const anyone = (id) => ({ id, roles: ['read'], link: { scope: 'anonymous', type: 'view' } });
  const everyone = { id: 'e1', roles: ['read'], grantedToV2: { siteGroup: { loginName: 'c:0-.f|rolemanager|spo-grid-all-users/1111' } } };
  await record('budget.xlsx', [], hoursAgo(30));
  await record('plans', [], hoursAgo(30));
  await record('budget.xlsx', [anyone('L1')], hoursAgo(6));
  await record('plans', [anyone('L1'), anyone('L2'), everyone], hoursAgo(6));
  // A file whose earlier record has no exposure (an older backup) adds nothing.
  await put(tenant, { workload: 'onedrive', container: drive, itemKey: 'old.docx', at: hoursAgo(30), metadata: { kind: 'drive-record', ownerName: 'Ada Admin' } });
  await record('old.docx', [anyone('L9')], hoursAgo(6));

  const { rows } = await loadChangeFeed(client, { tenantRef: tenant, now: NOW });
  const backup = rows.filter((row) => row.source === 'backup');
  assert.deepEqual(backup.map((row) => [row.object.name, row.service, row.typeName, row.activity, row.flags.map((flag) => flag.key)]), [
    ['Ada Admin’s OneDrive', 'OneDrive', 'OneDrive access', '2 new links anyone can open.', ['anyone-links-added']],
    ['Ada Admin’s OneDrive', 'OneDrive', 'OneDrive access', 'Everyone in the company can now view.', ['opened-to-everyone']],
  ]);
  assert.equal(backup[1].flags[0].sentence, 'Opened to everyone in the company: everyone in the company can now view Ada Admin’s OneDrive.');

  const namer = anonymityNamer({ enabled: true, salt: 'test-salt' });
  const hidden = (await loadChangeFeed(client, { tenantRef: tenant, now: NOW, namer })).rows.filter((row) => row.source === 'backup');
  const text = JSON.stringify(hidden);
  assert.ok(!text.includes('Ada Admin'), text);
  assert.equal(hidden[0].object.name, `${namer('ada admin')}’s OneDrive`);
});

test('a backup that could not read a group\'s members produces no row, nor does the next full one', async () => {
  const tenant = 'sharing-feed-partial';
  const MEMBERS = { id: 4, title: 'Finance Members', principalType: 8 };
  // Everyone in the company is a member of an Edit group, beside one owner and one guest.
  const site = ({ ownersRead = true, membersRead = true } = {}) => ({
    groups: [
      { id: 3, title: 'Finance Owners', members: ownersRead ? [ADA] : null },
      { id: 4, title: 'Finance Members', members: membersRead ? [ALL_USERS, GUEST] : null },
    ],
    siteCollectionAdmins: [],
    roleAssignments: [
      { principalId: 3, member: { id: 3, title: 'Finance Owners', principalType: 8 }, roles: [{ name: 'Full Control' }] },
      { principalId: 4, member: MEMBERS, roles: [{ name: 'Edit' }] },
    ],
  });
  assert.equal(permissionsSummary(site({ membersRead: false })).exposure.checked, false);
  // Full, then one group unread, then full again: nothing changed on either site.
  for (const [siteId, failed] of [[SITE, { membersRead: false }], [OTHER_SITE, { ownersRead: false }]]) {
    await siteBackup(tenant, siteId, site(), hoursAgo(30), { siteName: 'Finance' });
    await siteBackup(tenant, siteId, site(failed), hoursAgo(20), { siteName: 'Finance' });
    await siteBackup(tenant, siteId, site(), hoursAgo(6), { siteName: 'Finance' });
  }
  const { rows } = await loadChangeFeed(client, { tenantRef: tenant, now: NOW });
  assert.deepEqual(rows.filter((row) => row.source === 'backup').map((row) => row.activity), []);
});
