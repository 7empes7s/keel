// The Restore page's choices for one workload backup: grouped by kind, with what KEEL
// can put back and how each object differs from the newest backup.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { PAGE_RESTORE_WORKLOADS, workloadChoices } from './restoreChoices.mjs';
import { WORKLOAD_RESTORES } from './dispatch.mjs';

const rule = (id, fields) => ({ resourceKey: `transportrule:${id}`, kind: 'transportRule', identity: id, fields: { Name: `KEEL-RT ${id}`, ...fields } });

test('every page workload plans from the backup and the chosen objects alone', () => {
  for (const workload of PAGE_RESTORE_WORKLOADS) {
    assert.ok(WORKLOAD_RESTORES[workload], `${workload} has a dry run`);
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
