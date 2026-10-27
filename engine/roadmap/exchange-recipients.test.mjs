// Exchange recipients and mailbox permissions, read-only.
//
// Acceptance:
//  - the reads are declared in workloadContract.mjs, pass the scope validator, are run by
//    the read-only probe, and ship disabled (fixture proof never enables them);
//  - only the declared Get cmdlets run, with KEEL's fixed values and -Identity only as a
//    mailbox Guid read in the same run; the Node and container allowlists match; no writer;
//  - each object is one observation under its Guid; Full Access and booking rules sit
//    under their mailbox; Send As is kept per recipient; inherited and SELF rights are left out;
//  - a failed mailbox read leaves its permissions unread and the run partial, never empty;
//  - collection stays off until Exchange and every read are qualified;
//  - a Full Access right added between two reads is a change on the Changes page;
//  - the read capture tool can qualify both workloads;
//  - distribution lists sit in Exchange's "Groups and address lists", the mailboxes and
//    their access first in "Mailboxes".
//
// Everything runs against the isolated test database and a fake PowerShell container
// that plays the ops/powershell/run-cmdlet.ps1 contract through the real
// engine/powershell/jobQueue.mjs spawn path. No tenant is touched.
import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { after, test } from 'node:test';

import {
  DISTRIBUTION_GROUPS, DISTRIBUTION_GROUP_FAMILIES, EXCHANGE_DISTRIBUTION_GROUPS_WORKLOAD, EXCHANGE_RECIPIENTS_CMDLET_PARAMETERS,
  EXCHANGE_RECIPIENTS_WORKLOAD, ExchangeRecipientsScopeError, RECIPIENTS, RECIPIENT_FAMILIES, collectExchangeRecipients,
  exchangeRecipientsActivation, readExchangeDistributionGroups, readExchangeRecipients,
} from '../collect/workloads/exchangeRecipients.mjs';
import { EXCHANGE_OPERATIONS } from '../collect/workloads/exchange.mjs';
import { WORKLOAD_COLLECTORS } from '../collect/workloads/registry.mjs';
import { WORKLOAD_DESCRIPTORS, buildWorkloadLedger, descriptorProblems } from '../collect/workloadContract.mjs';
import { listWorkloads } from '../collect/registry.mjs';
import { WORKLOAD_WRITE_OPERATIONS } from '../coverage/qualification.mjs';
import { detectWorkloadDrift } from '../govern/workloadDrift.mjs';
import { compareInService, typeInfo } from '../insights/taxonomy.mjs';
import { runFixtureHarness } from '../../tools/qualification/workloads.mjs';
import { readModule, workloadReads } from '../../tools/qualification/workloadReadsAcceptance.mjs';
import { WORKLOAD_READERS } from '../../tools/qualification/workloadReadsLive.mjs';
import { createIsolatedTestDatabase } from '../test/dbTestHelper.mjs';
import {
  ALL_READS, GRANTS, RUNTIME, containerAllowlist, fakeCmdletContainer, ledgerWith,
} from '../test/fakeCmdletContainer.mjs';
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

const NOW = new Date('2026-10-27T12:00:00Z');
const MODULE = 'ExchangeOnlineManagement';
let tenantSeq = 0;
const nextTenant = () => `sha256:recipients-${tenantSeq += 1}`;
const guid = (n) => `${String(n).padStart(8, '0')}-0000-4000-8000-00000000c0c0`;
const ALLOWED = containerAllowlist('AllowedExchangeRecipients');
const SELF = 'NT AUTHORITY\\SELF';

// Recipients as Exchange answers them: the declared fields, plus internal properties a
// careless reader would keep.
const recipient = (n, name, over = {}) => ({
  Guid: guid(n), Name: name, DisplayName: name, Alias: name.toLowerCase(), PrimarySmtpAddress: `${name.toLowerCase()}@contoso.test`,
  EmailAddresses: [`SMTP:${name.toLowerCase()}@contoso.test`], ExternalDirectoryObjectId: guid(n + 500),
  RequireSenderAuthenticationEnabled: true, AcceptMessagesOnlyFromSendersOrMembers: [], RejectMessagesFromSendersOrMembers: [],
  HiddenFromAddressListsEnabled: false, GrantSendOnBehalfTo: [], MailTip: null, WhenChangedUTC: '2026-10-01T00:00:00Z',
  DistinguishedName: 'CN=internal', OrganizationId: 'internal', ...over,
});
// Every declared field a fixture does not set, as Exchange answers an unset one (null).
const unset = (family) => Object.fromEntries(family.fields.map((field) => [field, null]));
const mailboxOf = (n, name, type, over = {}) => recipient(n, name, {
  RecipientTypeDetails: type, MessageCopyForSentAsEnabled: false, MessageCopyForSendOnBehalfEnabled: false, ForwardingAddress: null,
  ForwardingSmtpAddress: null, DeliverToMailboxAndForward: false, ResourceCapacity: type === 'SharedMailbox' ? null : 4, ...over,
});
const SHARED = mailboxOf(1, 'KEEL-RT-recipients-shared', 'SharedMailbox', { GrantSendOnBehalfTo: ['keel-rt-carla'] });
const ROOM = mailboxOf(2, 'KEEL-RT-recipients-room', 'RoomMailbox');
const CONTACT = recipient(3, 'KEEL-RT-recipients-contact', { ExternalEmailAddress: 'SMTP:keel-rt-contact@example.com' });
const right = (user, accessRights, over = {}) => ({ Identity: 'KEEL-RT-recipients-shared', User: user, AccessRights: accessRights, IsInherited: false, Deny: false, ...over });
const BOOKING = {
  Identity: 'KEEL-RT-recipients-room', AutomateProcessing: 'AutoAccept', AllowConflicts: false, AllowRecurringMeetings: true, BookingWindowInDays: 90,
  MaximumDurationInMinutes: 120, MinimumDurationInMinutes: 0, EnforceSchedulingHorizon: true, ScheduleOnlyDuringWorkHours: false,
  ConflictPercentageAllowed: 0, MaximumConflictInstances: 0, ForwardRequestsToDelegates: true, ResourceDelegates: [], AllBookInPolicy: true,
  BookInPolicy: [], AllRequestInPolicy: false, RequestInPolicy: [], AllRequestOutOfPolicy: false, RequestOutOfPolicy: [],
  TentativePendingApproval: true, ProcessExternalMeetingMessages: false, AddOrganizerToSubject: true, DeleteSubject: true, DeleteComments: true,
  DeleteAttachments: true, RemovePrivateProperty: true, DeleteNonCalendarItems: true, OrganizerInfo: true, AddAdditionalResponse: false,
  AdditionalResponse: null, EnableResponseDetails: true, MailboxOwnerId: 'internal',
};

/** A tenant with one shared mailbox, one room, one contact and their rights. `state` may be changed between reads. */
function tenant(state = {}) {
  const live = {
    shared: [SHARED], room: [ROOM], equipment: [], contacts: [CONTACT],
    rights: {
      [guid(1)]: [
        right(SELF, ['FullAccess', 'ReadPermission']),
        right('keel-rt-carla', ['FullAccess']),
        right('admin-inherited', ['FullAccess'], { IsInherited: true }),
      ],
      [guid(2)]: [right(SELF, ['FullAccess'])],
    },
    sendAs: [
      { Identity: 'KEEL-RT-recipients-shared', Trustee: 'keel-rt-diego', AccessRights: ['SendAs'], AccessControlType: 'Allow', IsInherited: false },
      { Identity: 'KEEL-RT-recipients-shared', Trustee: SELF, AccessRights: ['SendAs'], AccessControlType: 'Allow', IsInherited: false },
      { Identity: 'keel-rt-carla', Trustee: 'inherited-admin', AccessRights: ['SendAs'], AccessControlType: 'Allow', IsInherited: true },
    ],
    booking: { [guid(2)]: [BOOKING] },
    fail: {},
    ...state,
  };
  const container = fakeCmdletContainer({
    module: MODULE,
    allowlist: ALLOWED,
    answer(cmdlet, parameters) {
      const failure = live.fail[`${cmdlet} ${parameters.Identity ?? parameters.RecipientTypeDetails ?? ''}`.trim()] ?? live.fail[cmdlet];
      if (failure) return { error: failure };
      switch (cmdlet) {
        case 'Get-Mailbox': return { SharedMailbox: live.shared, RoomMailbox: live.room, EquipmentMailbox: live.equipment }[parameters.RecipientTypeDetails];
        case 'Get-MailContact': return live.contacts;
        case 'Get-MailboxPermission': return live.rights[parameters.Identity] ?? [];
        case 'Get-RecipientPermission': return live.sendAs;
        case 'Get-CalendarProcessing': return live.booking[parameters.Identity] ?? [];
        case 'Get-DistributionGroup': return [{
          ...unset(DISTRIBUTION_GROUP_FAMILIES.distributionGroup),
          ...recipient(10, 'KEEL-RT-recipients-dl', { RecipientTypeDetails: 'MailUniversalDistributionGroup', ManagedBy: ['keel-rt-carla'] }),
        }];
        case 'Get-DynamicDistributionGroup': return [{
          ...unset(DISTRIBUTION_GROUP_FAMILIES.dynamicDistributionGroup),
          ...recipient(11, 'KEEL-RT-recipients-ddl', { RecipientFilter: "(Department -eq 'KEEL-RT')" }),
        }];
        case 'Get-UnifiedGroup': return [];
        default: return { error: { message: `unexpected ${cmdlet}`, category: null, errorId: 'x' } };
      }
    },
  });
  return { ...container, live };
}

const OWN_READS = Object.freeze([...RECIPIENTS.operations, ...DISTRIBUTION_GROUPS.operations]);
const OTHER_READS = Object.freeze(ALL_READS.filter((id) => !OWN_READS.includes(id)));

test('the reads are declared, in scope, probed, Get-only and ship disabled', async () => {
  const probe = readFileSync(new URL('../../ops/powershell/probe-workloads.ps1', import.meta.url), 'utf8');
  const exo = /# --- Exchange Online ---([\s\S]*?)# --- Security & Compliance/.exec(probe)[1];
  for (const workload of [DISTRIBUTION_GROUPS, RECIPIENTS]) {
    const declared = WORKLOAD_DESCRIPTORS.filter((descriptor) => descriptor.workload === workload.workload);
    assert.deepEqual(declared.map((descriptor) => descriptor.id), [...workload.operations]);
    for (const descriptor of declared) {
      assert.deepEqual(descriptorProblems(descriptor), [], descriptor.id);
      assert.equal(descriptor.operation.module, MODULE);
      assert.deepEqual(descriptor.rbac.roles, ['Exchange Administrator']);
      assert.ok(exo.includes(`-Workload 'exo' -Name '${descriptor.operation.probeName}'`), `${descriptor.operation.probeName} is probed`);
    }
    const { evidence, results } = await runFixtureHarness({ descriptors: declared, runtime: RUNTIME });
    assert.ok(results.every((result) => result.ok), JSON.stringify(results));
    const fixtured = buildWorkloadLedger({ descriptors: declared, evidence, grants: GRANTS, runtime: RUNTIME, tenantRef: 'sha256:t', now: NOW });
    assert.ok(fixtured.rows.every((row) => row.state === 'fixture-tested' && row.enabled === false));
    assert.equal(workload.descriptor.enabledByDefault, false);
    assert.equal(workload.descriptor.readOnly, true);
    assert.ok(listWorkloads().some((descriptor) => descriptor.workload === workload.workload));
    assert.ok(WORKLOAD_COLLECTORS.some((entry) => entry.workload === workload.workload && entry.powershellFamily === 'exchange'));
    assert.deepEqual(Object.values(WORKLOAD_WRITE_OPERATIONS).filter((operation) => operation.workload === workload.workload), [], 'no writer');
    // The read capture tool qualifies it, in the Exchange module, though it has no writes.
    assert.equal(readModule(workload.workload), MODULE);
    assert.deepEqual(workloadReads(workload.workload).map((read) => read.operationId), [...workload.operations]);
    assert.equal(typeof WORKLOAD_READERS[workload.workload], 'function');
  }
  const sorted = (allowlist) => Object.fromEntries(Object.entries(allowlist).map(([name, list]) => [name, [...list].sort()]).sort());
  assert.deepEqual(sorted(EXCHANGE_RECIPIENTS_CMDLET_PARAMETERS), sorted(ALLOWED), 'the Node and container allowlists are identical');
  assert.ok(Object.keys(ALLOWED).every((cmdlet) => cmdlet.startsWith('Get-')), 'reads only');

  const assertRead = RECIPIENTS.assertCmdlet;
  for (const cmdlet of ['Add-MailboxPermission', 'Add-RecipientPermission', 'Set-Mailbox', 'Set-CalendarProcessing', 'New-DistributionGroup', 'Get-MailboxFolderPermission', 'Get-MessageTrace']) {
    assert.throws(() => assertRead({ cmdlet }), ExchangeRecipientsScopeError, cmdlet);
  }
  assert.throws(() => assertRead({ cmdlet: 'Get-Mailbox', parameters: { RecipientTypeDetails: 'UserMailbox', ResultSize: 'Unlimited' } }), /takes only/);
  assert.throws(() => assertRead({ cmdlet: 'Get-Mailbox', parameters: { Identity: guid(1) } }), /does not take Identity/);
  assert.throws(() => assertRead({ cmdlet: 'Get-MailboxPermission', parameters: { Identity: 'ceo@contoso.test' } }), /mailbox Guid/);
  assert.throws(() => assertRead({ cmdlet: 'Get-MailContact', parameters: { ResultSize: '10' } }), /takes only Unlimited/);
  assert.ok(assertRead({ cmdlet: 'Get-MailboxPermission', parameters: { Identity: guid(1) } }));
  assert.throws(() => DISTRIBUTION_GROUPS.assertCmdlet({ cmdlet: 'Get-Mailbox' }), ExchangeRecipientsScopeError, 'each workload runs only its own reads');
});

test('distribution lists sit in Groups; mailboxes and their access come first in Mailboxes', () => {
  const groups = typeInfo(EXCHANGE_DISTRIBUTION_GROUPS_WORKLOAD);
  assert.equal(groups.known, true);
  assert.equal(groups.service, 'Exchange');
  assert.equal(groups.categoryName, 'Groups and address lists');
  const recipients = typeInfo(EXCHANGE_RECIPIENTS_WORKLOAD);
  assert.equal(recipients.known, true);
  assert.equal(recipients.categoryName, 'Mailboxes');
  assert.equal(recipients.priority, 'high');
  const order = ['exchange-role-groups', 'exchange-mail-flow', EXCHANGE_DISTRIBUTION_GROUPS_WORKLOAD, 'exchange-mailbox-settings', EXCHANGE_RECIPIENTS_WORKLOAD]
    .sort(compareInService);
  assert.deepEqual(order, [EXCHANGE_RECIPIENTS_WORKLOAD, 'exchange-mailbox-settings', EXCHANGE_DISTRIBUTION_GROUPS_WORKLOAD, 'exchange-role-groups', 'exchange-mail-flow']);
});

test('each recipient is one observation; rights and booking rules sit under their mailbox; defaults are left out', async () => {
  const exchange = tenant();
  const result = await readExchangeRecipients({ powershell: exchange.powershell, now: () => NOW });
  assert.deepEqual(exchange.calls, [
    { cmdlet: 'Get-Mailbox', parameters: { RecipientTypeDetails: 'SharedMailbox', ResultSize: 'Unlimited' } },
    { cmdlet: 'Get-Mailbox', parameters: { RecipientTypeDetails: 'RoomMailbox', ResultSize: 'Unlimited' } },
    { cmdlet: 'Get-Mailbox', parameters: { RecipientTypeDetails: 'EquipmentMailbox', ResultSize: 'Unlimited' } },
    { cmdlet: 'Get-MailContact', parameters: { ResultSize: 'Unlimited' } },
    { cmdlet: 'Get-MailboxPermission', parameters: { Identity: guid(1) } },
    { cmdlet: 'Get-MailboxPermission', parameters: { Identity: guid(2) } },
    { cmdlet: 'Get-RecipientPermission', parameters: { ResultSize: 'Unlimited' } },
    { cmdlet: 'Get-CalendarProcessing', parameters: { Identity: guid(2) } },
  ]);
  assert.equal(result.outcome, 'complete', JSON.stringify(result.unknownFields));
  assert.deepEqual(result.resources.map((resource) => resource.resourceKey), [
    `shared-mailbox:${guid(1)}`, `room-mailbox:${guid(2)}`, `mail-contact:${guid(3)}`,
    `mailbox-permission:${guid(1)}`, `mailbox-permission:${guid(2)}`, 'send-as:keel-rt-recipients-shared', `calendar-processing:${guid(2)}`,
  ]);
  const byKey = Object.fromEntries(result.resources.map((resource) => [resource.resourceKey, resource]));
  const shared = byKey[`shared-mailbox:${guid(1)}`];
  assert.deepEqual(Object.keys(shared.fields), [...RECIPIENT_FAMILIES.sharedMailbox.fields]);
  assert.equal(shared.fields.DistinguishedName, undefined, 'undeclared fields are dropped');
  assert.deepEqual(shared.fields.GrantSendOnBehalfTo, ['keel-rt-carla'], 'Send on behalf is a mailbox field');
  // Only the right an admin granted: not SELF, not inherited.
  assert.deepEqual(byKey[`mailbox-permission:${guid(1)}`].fields, {
    Mailbox: guid(1), Permissions: [{ User: 'keel-rt-carla', AccessRights: ['FullAccess'], Deny: false }],
  });
  assert.equal(byKey[`mailbox-permission:${guid(1)}`].parent, guid(1));
  // A mailbox with no granted rights is kept with an empty list, so a first grant is a change.
  assert.deepEqual(byKey[`mailbox-permission:${guid(2)}`].fields.Permissions, []);
  assert.deepEqual(byKey['send-as:keel-rt-recipients-shared'].fields, {
    Identity: 'KEEL-RT-recipients-shared', Trustees: [{ Trustee: 'keel-rt-diego', AccessRights: ['SendAs'], AccessControlType: 'Allow' }],
  });
  const booking = byKey[`calendar-processing:${guid(2)}`];
  assert.equal(booking.fields.Mailbox, guid(2));
  assert.equal(booking.fields.BookingWindowInDays, 90);
  assert.equal(booking.fields.MailboxOwnerId, undefined);
});

test('a failed read is a gap, never an empty list', async () => {
  // The room read fails: its rights and booking rules are not read, and say why.
  const roomDown = tenant({ fail: { 'Get-Mailbox RoomMailbox': { message: 'The operation timed out', category: 'OperationTimeout', errorId: 'x' } } });
  const partial = await readExchangeRecipients({ powershell: roomDown.powershell, now: () => NOW });
  assert.equal(partial.outcome, 'partial');
  assert.deepEqual(partial.failures.map((failure) => failure.family).sort(), ['calendarProcessing', 'mailboxPermission', 'roomMailbox']);
  assert.ok(!roomDown.calls.some((call) => call.cmdlet === 'Get-MailboxPermission' || call.cmdlet === 'Get-CalendarProcessing'));

  // One mailbox's rights fail: only that mailbox is missing, the others are kept.
  const oneDown = tenant({ fail: { [`Get-MailboxPermission ${guid(2)}`]: { message: 'Access is denied', category: 'PermissionDenied', errorId: 'x' } } });
  const one = await readExchangeRecipients({ powershell: oneDown.powershell, now: () => NOW });
  assert.equal(one.outcome, 'partial');
  assert.equal(one.discovery.families.mailboxPermission.status, 'partial');
  assert.ok(one.resources.some((resource) => resource.resourceKey === `mailbox-permission:${guid(1)}`));
  assert.equal(one.failures[0].parent, `room-mailbox:${guid(2)}`);

  // Every read refused: failed, and denied.
  const denied = { message: 'Access is denied', category: 'PermissionDenied', errorId: 'x' };
  const refused = tenant({ fail: { 'Get-Mailbox': denied, 'Get-MailContact': denied, 'Get-RecipientPermission': denied } });
  const failed = await readExchangeRecipients({ powershell: refused.powershell, now: () => NOW });
  assert.equal(failed.outcome, 'failed');
  assert.ok(failed.failures.filter((failure) => !failure.error?.code?.startsWith?.('PARENT')).every((failure) => failure.status === 'denied' || failure.error?.code === 'PARENT_NOT_READ'));

  // A switch serialized as an object still counts; a granted row naming no user is a gap, not an empty list.
  const switches = tenant();
  switches.live.rights[guid(1)] = [right('keel-rt-carla', ['FullAccess'], { Deny: { IsPresent: true } }), right(SELF, ['FullAccess'], { IsInherited: { IsPresent: false } })];
  const read = await readExchangeRecipients({ powershell: switches.powershell, now: () => NOW });
  assert.deepEqual(read.resources.find((resource) => resource.resourceKey === `mailbox-permission:${guid(1)}`).fields.Permissions,
    [{ User: 'keel-rt-carla', AccessRights: ['FullAccess'], Deny: true }]);
  const odd = tenant();
  odd.live.rights[guid(1)] = [right({ Name: 'carla' }, ['FullAccess'])];
  odd.live.booking[guid(2)] = [];
  const gap = await readExchangeRecipients({ powershell: odd.powershell, now: () => NOW });
  assert.equal(gap.outcome, 'partial');
  assert.equal(gap.discovery.unidentified, 2);
  assert.ok(!gap.resources.some((resource) => [`mailbox-permission:${guid(1)}`, `calendar-processing:${guid(2)}`].includes(resource.resourceKey)));

  // An empty tenant is complete-empty, not a failure: no family is required.
  const empty = tenant({ shared: [], room: [], contacts: [], sendAs: [] });
  assert.equal((await readExchangeRecipients({ powershell: empty.powershell, now: () => NOW })).outcome, 'complete-empty');
});

test('distribution lists are read with their Exchange settings, members left to the Entra group backup', async () => {
  const exchange = tenant();
  const result = await readExchangeDistributionGroups({ powershell: exchange.powershell, now: () => NOW });
  assert.deepEqual(exchange.calls.map((call) => call.cmdlet), ['Get-DistributionGroup', 'Get-DynamicDistributionGroup', 'Get-UnifiedGroup']);
  assert.equal(result.outcome, 'complete', JSON.stringify(result.unknownFields));
  assert.deepEqual(result.resources.map((resource) => resource.resourceKey), [`distribution-group:${guid(10)}`, `dynamic-distribution-group:${guid(11)}`]);
  const [list] = result.resources;
  assert.deepEqual(Object.keys(list.fields), [...DISTRIBUTION_GROUP_FAMILIES.distributionGroup.fields]);
  assert.equal(list.fields.ExternalDirectoryObjectId, guid(510), 'the link to the Entra group that holds the members');
  assert.ok(!DISTRIBUTION_GROUP_FAMILIES.distributionGroup.fields.includes('Members'));
});

test('collection stays off until Exchange and every read are qualified, then a Full Access grant is a change', async (t) => {
  const client = await schemaClient(t);
  const tenantRef = nextTenant();
  const exchange = tenant();
  for (const ledger of [ledgerWith(tenantRef, OTHER_READS, { now: NOW }), ledgerWith(tenantRef, ALL_READS.filter((id) => !EXCHANGE_OPERATIONS.includes(id)), { now: NOW })]) {
    const disabled = await collectExchangeRecipients(client, { tenantRef, ledger, powershell: exchange.powershell, now: () => NOW });
    assert.equal(disabled.run.outcome, 'disabled');
  }
  assert.deepEqual(exchange.calls, [], 'nothing is sent while disabled');
  assert.match(exchangeRecipientsActivation(ledgerWith(tenantRef, OTHER_READS, { now: NOW })).reasons.join('; '), /exchange-recipients\.send-as is fixture-tested/);
  // Exchange itself is needed, not the other Exchange cmdlet workloads.
  const others = ALL_READS.filter((id) => /^(mailflow|exchange-extended|exchange-role-groups|exchange-distribution-groups)\./.test(id));
  assert.equal(exchangeRecipientsActivation(ledgerWith(tenantRef, ALL_READS.filter((id) => !others.includes(id)), { now: NOW })).enabled, true);

  const ledger = ledgerWith(tenantRef, ALL_READS, { now: NOW });
  const first = await collectExchangeRecipients(client, { tenantRef, ledger, powershell: exchange.powershell, now: () => new Date('2026-10-26T02:00:00Z') });
  assert.equal(first.run.outcome, 'complete');
  const { rows } = await client.query('SELECT resource_key, fields FROM workload_observation WHERE collection_id = $1 ORDER BY resource_key', [first.run.id]);
  assert.equal(rows.length, 7);
  assert.equal(rows.find((row) => row.resource_key === `mailbox-permission:${guid(1)}`).fields.parent, guid(1));

  exchange.live.rights[guid(1)] = [...exchange.live.rights[guid(1)], right('keel-rt-diego', ['FullAccess'])];
  const second = await collectExchangeRecipients(client, { tenantRef, ledger, powershell: exchange.powershell, now: () => new Date('2026-10-27T02:00:00Z') });
  const drift = await detectWorkloadDrift(client, { collectionId: second.run.id });
  assert.equal(drift.status, 'detected');
  const { rows: changes } = await client.query('SELECT resource_key, change_type, fields FROM workload_drift WHERE tenant_ref = $1', [tenantRef]);
  assert.deepEqual(changes.map((row) => [row.resource_key, row.change_type]), [[`mailbox-permission:${guid(1)}`, 'modified']]);
  assert.deepEqual(changes[0].fields.map((field) => field.path), ['Permissions']);
});
