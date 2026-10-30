// The Restore page's choices for one workload backup: grouped by kind, with what KEEL
// can put back and how each object differs from the newest backup.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { PAGE_RESTORE_WORKLOADS, PER_ITEM_WORKLOADS, perItemRequest, workloadChoices } from './restoreChoices.mjs';
import { WORKLOAD_RESTORES } from './dispatch.mjs';

const rule = (id, fields) => ({ resourceKey: `transportrule:${id}`, kind: 'transportRule', identity: id, fields: { Name: `KEEL-RT ${id}`, ...fields } });

test('every page workload plans from the backup and the chosen objects alone', () => {
  for (const workload of PAGE_RESTORE_WORKLOADS) {
    assert.ok(WORKLOAD_RESTORES[workload], `${workload} has a dry run`);
    if (PER_ITEM_WORKLOADS[workload]) {
      assert.match(WORKLOAD_RESTORES[workload].usage, /^--collection <id> --(mailbox|team) /, `${workload} needs a collection and one mailbox or team`);
      continue;
    }
    assert.match(WORKLOAD_RESTORES[workload].usage, /^--collection <id> (\[--target <key> \.\.\.\]|--target )/, `${workload} needs only a collection and targets`);
  }
  assert.throws(() => workloadChoices('sharepoint-site-settings', []), /does not start a restore/);
});

test('mail flow: changed first, a deleted rule cannot be added back, read-only kinds are by hand', () => {
  const chosen = [
    rule('a', { Mode: 'Enforce' }),
    rule('b', { Mode: 'Enforce' }),
    rule('c', { Mode: 'Enforce' }),
    { resourceKey: 'accepteddomain:d', kind: 'acceptedDomain', identity: 'd', fields: { Name: 'contoso.test' } },
  ];
  const newest = [rule('a', { Mode: 'Audit' }), rule('c', { Mode: 'Enforce' }), chosen[3]];
  const groups = workloadChoices('exchange-mail-flow', chosen, newest);
  const rules = groups.find((group) => group.kind === 'transportRule');
  assert.equal(rules.name, 'Mail flow (transport) rules');
  assert.equal(rules.restorable, true);
  assert.deepEqual(rules.items.map((item) => [item.name, item.change, item.restorable]), [
    ['KEEL-RT a', 'changed', true],
    ['KEEL-RT b', 'deleted', false],
    ['KEEL-RT c', 'same', true],
  ]);
  assert.match(rules.items[1].reason, /^Deleted since this backup/);
  const domains = groups.find((group) => group.kind === 'acceptedDomain');
  assert.equal(domains.restorable, false);
  assert.equal(domains.name, 'Accepted domains');
  assert.equal(groups[0].kind, 'transportRule', 'kinds KEEL can put back come first');
});

test('the newest backup itself has no change column; Teams Global reads as everyone and is tenant-wide', () => {
  const groups = workloadChoices('teams-org-policies', [
    { resourceKey: 'messagingpolicy:global', kind: 'messagingPolicy', fields: { Identity: 'Global' } },
    { resourceKey: 'messagingpolicy:tag:keel-rt-x', kind: 'messagingPolicy', fields: { Identity: 'Tag:KEEL-RT-x' } },
    { resourceKey: 'meetingpolicy:global', kind: 'meetingPolicy', fields: { Identity: 'Global' } },
  ]);
  const messaging = groups.find((group) => group.kind === 'messagingPolicy');
  assert.deepEqual(messaging.items.map((item) => [item.name, item.change, item.tenantWide]), [
    ['Global (everyone)', null, true],
    ['KEEL-RT-x', null, false],
  ]);
  const meeting = groups.find((group) => group.kind === 'meetingPolicy');
  assert.equal(meeting.restorable, false);
  assert.match(meeting.reason, /Teams admin center/);
});

test('Purview labels are grouped by label and publishing policy', () => {
  const id = '11111111-1111-4111-8111-111111111111';
  const groups = workloadChoices('purview-labels', [
    { resourceKey: `label:${id}`, fields: { DisplayName: 'KEEL-RT Confidential' } },
    { resourceKey: `label-policy:${id}`, fields: { Name: 'KEEL-RT Publish' } },
  ]);
  assert.deepEqual(groups.map((group) => [group.name, group.items[0].name]), [
    ['Sensitivity label definitions', 'KEEL-RT Confidential'],
    ['Sensitivity label publishing policies', 'KEEL-RT Publish'],
  ]);
});

test('mailboxes: one per dry run, a deleted one cannot be picked, the organization rides with a mailbox', () => {
  const box = (upn, fields) => ({ resourceKey: `mailbox:${upn.toLowerCase()}`, identity: upn, fields });
  const chosen = [box('KEEL-RT-A@x.test', { mailboxSettings: { timeZone: 'UTC' } }), box('KEEL-RT-B@x.test', { mailboxSettings: {} }),
    box('KEEL-RT-C@x.test', { mailboxSettings: {} }), { resourceKey: 'organization', fields: { organization: { MailTipsLargeAudienceThreshold: 25 } } }];
  const newest = [box('KEEL-RT-A@x.test', { mailboxSettings: { timeZone: 'W. Europe Standard Time' } }), chosen[1]];
  const [mailboxes, organization] = workloadChoices('exchange-mailbox-settings', chosen, newest);
  assert.equal(mailboxes.name, 'Mailboxes');
  assert.deepEqual(mailboxes.items.map((item) => [item.name, item.change, item.restorable]), [
    ['KEEL-RT-A@x.test', 'changed', true],
    ['KEEL-RT-C@x.test', 'deleted', false],
    ['KEEL-RT-B@x.test', 'same', true],
  ]);
  assert.deepEqual(organization.items.map((item) => [item.key, item.change, item.tenantWide]), [['organization', null, true]]);
  assert.deepEqual(perItemRequest('exchange-mailbox-settings', 'mailbox:keel-rt-a@x.test'), { mailbox: 'keel-rt-a@x.test' });
  assert.equal(perItemRequest('exchange-mailbox-settings', 'organization'), null);
  assert.equal(perItemRequest('exchange-mailbox-settings', 'team:t-1'), null);
});

test('teams: named by display name, keys outside team: are not offered', () => {
  const id = '22222222-2222-4222-8222-222222222222';
  const [teams, ...rest] = workloadChoices('teams-settings', [
    { resourceKey: `team:${id}`, fields: { displayName: 'KEEL-RT Falcon' } },
    { resourceKey: 'teamdiscovery', fields: {} },
  ]);
  assert.equal(rest.length, 0);
  assert.deepEqual(teams.items.map((item) => [item.name, item.change, item.restorable]), [['KEEL-RT Falcon', null, true]]);
  assert.deepEqual(perItemRequest('teams-settings', `team:${id}`), { teamId: id });
});

test('SharePoint site structure: hubs, designs, scripts and sites are offered by title, and a site template\'s blob is not a change', () => {
  const id = (n) => `${n}${n}${n}${n}${n}${n}${n}${n}-${n}${n}${n}${n}-4${n}${n}${n}-8${n}${n}${n}-${n.repeat(12)}`;
  const site = (path, fields) => ({
    resourceKey: `site-template:https://contoso.sharepoint.com${path}`, kind: 'siteTemplate',
    fields: { url: `https://contoso.sharepoint.com${path}`, title: 'KEEL-RT Finance', lists: [{ Url: 'Shared Documents' }], templateXml: 'a', templateSha256: 'a', templateBytes: 1, ...fields },
  });
  const chosen = [
    { resourceKey: `hub-site:${id('1')}`, kind: 'hubSite', fields: { Title: 'KEEL-RT Hub', SiteUrl: 'https://contoso.sharepoint.com/sites/keel-rt-hub' } },
    { resourceKey: `site-design:${id('2')}`, kind: 'siteDesign', fields: { Title: 'KEEL-RT Design', IsDefault: false } },
    { resourceKey: `site-design:${id('3')}`, kind: 'siteDesign', fields: { Title: 'KEEL-RT Default', IsDefault: true } },
    { resourceKey: `site-script:${id('4')}`, kind: 'siteScript', fields: { Title: 'KEEL-RT Script', Content: '{}' } },
    site('/sites/keel-rt-finance'),
    site('/sites/keel-rt-legal', { title: 'KEEL-RT Legal' }),
  ];
  const newest = [
    chosen[0], chosen[2],
    { ...chosen[1], fields: { ...chosen[1].fields, Title: 'KEEL-RT Design 2' } },
    // A new PnP export rewrites the stored template; the summaries are the same.
    site('/sites/keel-rt-finance', { templateXml: 'b', templateSha256: 'b', templateBytes: 2 }),
    site('/sites/keel-rt-legal', { title: 'KEEL-RT Legal', lists: [] }),
  ];
  const groups = workloadChoices('sharepoint-structure', chosen, newest);
  // A site missing from the newest backup (out of scope, or its read failed) is not called deleted.
  const unread = workloadChoices('sharepoint-structure', chosen, newest.slice(0, 4)).find((group) => group.kind === 'siteTemplate');
  assert.deepEqual(unread.items.map((item) => [item.name, item.change, item.restorable]), [
    ['KEEL-RT Finance (/sites/keel-rt-finance)', 'same', true],
    ['KEEL-RT Legal (/sites/keel-rt-legal)', null, true],
  ]);
  assert.deepEqual(groups.map((group) => [group.kind, group.restorable]), [
    ['hubSite', true], ['siteDesign', true], ['siteScript', true], ['siteTemplate', true],
  ]);
  const by = (kind) => groups.find((group) => group.kind === kind);
  assert.equal(by('hubSite').name, 'SharePoint hub sites');
  assert.deepEqual(by('hubSite').items.map((item) => [item.name, item.change, item.tenantWide]), [['KEEL-RT Hub', 'same', false]]);
  assert.deepEqual(by('siteDesign').items.map((item) => [item.name, item.change, item.restorable, item.tenantWide]), [
    ['KEEL-RT Design', 'changed', true, false],
    ['KEEL-RT Default', 'same', true, true],
  ]);
  // A deleted script is added again (Add-PnPSiteScript).
  assert.deepEqual(by('siteScript').items.map((item) => [item.name, item.change, item.restorable]), [['KEEL-RT Script', 'deleted', true]]);
  assert.deepEqual(by('siteTemplate').items.map((item) => [item.name, item.change, item.restorable]), [
    ['KEEL-RT Legal (/sites/keel-rt-legal)', 'changed', true],
    ['KEEL-RT Finance (/sites/keel-rt-finance)', 'same', true],
  ]);
});

test('OneDrive: one site per person, named by its owner, never tenant-wide', () => {
  const url = (who) => `https://contoso-my.sharepoint.com/personal/${who}_contoso_test`;
  const od = (who, fields) => ({ resourceKey: `onedrive:${url(who)}`, fields: { url: url(who), ...fields } });
  const chosen = [od('keel-rt-alice', { Owner: 'keel-rt-alice@contoso.test', SharingCapability: 'Disabled' }), od('keel-rt-bob', { SharingCapability: 'Disabled' })];
  const newest = [od('keel-rt-alice', { Owner: 'keel-rt-alice@contoso.test', SharingCapability: 'ExternalUserSharingOnly' }), chosen[1]];
  const [sites, ...rest] = workloadChoices('onedrive-site-settings', chosen, newest);
  assert.equal(rest.length, 0);
  assert.equal(sites.kind, 'onedriveSite');
  assert.equal(sites.restorable, true);
  assert.deepEqual(sites.items.map((item) => [item.name, item.change, item.restorable, item.tenantWide]), [
    ['keel-rt-alice@contoso.test', 'changed', true, false],
    ['keel-rt-bob_contoso_test', 'same', true, false],
  ]);
});
