// Distribution list restore through Microsoft365DSC (the keel-dsc profile).
//
// Acceptance:
//  - two writes are declared (settings of a list that exists, a list that is gone), each
//    with its own proof, bound to the pinned Microsoft365DSC version, and ship disabled;
//    none is a trust or sign-in field;
//  - the Node and container allowlists match, the pinned version is the same in the
//    image, the container script and the transport, and the image is a separate profile;
//  - the transport refuses, unsent, an undeclared resource, method or property, a listed
//    (read-only) field in a Set, a Set that is not Ensure Present, a null or an object;
//  - a fixture restore re-creates a deleted KEEL-RT- list and puts back a changed list's
//    settings, verified by read-back; a second dry run plans nothing;
//  - owners, moderators, who may send, send on behalf, addresses, members, renames and
//    room lists are listed for an administrator, never written;
//  - on the test tenant only KEEL-RT- lists are written; a list whose name another list
//    now uses is never touched;
//  - letting outside senders mail a list needs the separate content-effect approval;
//  - a list changed since the dry run is stale; an unknown outcome is never resent.
//
// Runs against the isolated test database and a fake DSC container behind the real
// engine/powershell/jobQueue.mjs spawn path (engine/test/fakeDsc.mjs). No tenant is touched.
import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { after, test } from 'node:test';

import { grantRole } from '../authz/administration.mjs';
import { WORKLOAD_WRITE_OPERATIONS, workloadWriteQualification } from '../coverage/qualification.mjs';
import { DSC_IMAGE, DSC_MEMORY, DSC_MODULE_VERSION, DscError, DscScopeError, dscJob, runDsc } from '../powershell/dscJob.mjs';
import { WORKLOAD_RESTORES } from '../restore/workloads/dispatch.mjs';
import {
  DISTRIBUTION_GROUP_ADD, DISTRIBUTION_GROUP_UPDATE, DSC_RESOURCES, DSC_WRITE_OPERATIONS, LISTED_FIELDS, UPDATE_FIELDS,
  createDistributionGroupArtifact, dscRunner, executeDistributionGroupRestore, planDistributionGroupRestore, readLiveLists,
} from '../restore/workloads/dscDistributionGroups.mjs';
import { isTrustField } from '../restore/workloads/writeDeclarations.mjs';
import { approveContentEffects, contentEffectsDigest } from '../safety/contentEffects.mjs';
import { schemaSql } from '../store/loadSchema.mjs';
import { createIsolatedTestDatabase } from '../test/dbTestHelper.mjs';
import { fakeDscTenant, fakeList } from '../test/fakeDsc.mjs';

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

const TENANT = '00000000-0000-4000-8000-0000000000d5';
let tenantSeq = 0;
const nextTenant = () => `sha256:dsc-distribution-groups-${tenantSeq += 1}`;
let principalSeq = 0;
async function principal(client, label, role = null) {
  const { rows } = await client.query('INSERT INTO principal (email) VALUES ($1) RETURNING id', [`${label}-${principalSeq += 1}@example.test`]);
  if (role) await grantRole(client, { principalId: rows[0].id, role, grantedBy: rows[0].id, activeFrom: new Date(Date.now() - 60_000) });
  return rows[0].id;
}
const PS1 = readFileSync(new URL('../../ops/powershell/run-dsc.ps1', import.meta.url), 'utf8');
const DOCKERFILE = readFileSync(new URL('../../ops/powershell/Dockerfile.dsc', import.meta.url), 'utf8');
const MAIN_DOCKERFILE = readFileSync(new URL('../../ops/powershell/Dockerfile', import.meta.url), 'utf8');

/** The backup of one list, as the exchange-distribution-groups collector stores it. */
function observation(list, extra = {}) {
  const fields = {
    Name: list.Name, DisplayName: list.DisplayName, Alias: list.Alias, PrimarySmtpAddress: list.PrimarySmtpAddress,
    EmailAddresses: list.EmailAddresses, RecipientTypeDetails: list.Type === 'Security' ? 'MailUniversalSecurityGroup' : 'MailUniversalDistributionGroup',
    ExternalDirectoryObjectId: randomUUID(), ManagedBy: list.ManagedBy, MemberJoinRestriction: list.MemberJoinRestriction,
    MemberDepartRestriction: list.MemberDepartRestriction, RequireSenderAuthenticationEnabled: list.RequireSenderAuthenticationEnabled,
    AcceptMessagesOnlyFromSendersOrMembers: list.AcceptMessagesOnlyFromSendersOrMembers, RejectMessagesFromSendersOrMembers: list.RejectMessagesFromSendersOrMembers,
    HiddenFromAddressListsEnabled: list.HiddenFromAddressListsEnabled, GrantSendOnBehalfTo: list.GrantSendOnBehalfTo, ModerationEnabled: list.ModerationEnabled,
    ModeratedBy: list.ModeratedBy, BypassModerationFromSendersOrMembers: [], SendModerationNotifications: list.SendModerationNotifications,
    ReportToManagerEnabled: false, ReportToOriginatorEnabled: true, SendOofMessageToOriginatorEnabled: list.SendOofMessageToOriginatorEnabled,
    MailTip: null, WhenChangedUTC: '2026-10-27T10:00:00Z', ...extra,
  };
  return { resourceKey: `distribution-group:${list.Guid}`, identity: list.Guid, kind: 'distributionGroup', fields, fieldCoverage: {} };
}
const source = (observations) => ({ collectionId: randomUUID(), outcome: 'complete', observedTo: '2026-10-27T10:00:00Z', observations });

async function planned(client, tenantRef, tenant, recorded, options = {}) {
  const dsc = dscRunner(tenant.powershell);
  const lists = recorded.observations.filter((item) => item.kind === 'distributionGroup').map((item) => ({ guid: item.identity, name: item.fields.Name }));
  const plan = planDistributionGroupRestore({ source: recorded, live: await readLiveLists(dsc, lists), tenantId: TENANT, tenantRef, testTenantRefs: [tenantRef], ...options });
  const requestedBy = await principal(client, 'requester');
  const artifact = await createDistributionGroupArtifact(client, { tenantRef, plan, requestedBy });
  return { plan, artifact };
}
const enabled = () => Object.fromEntries(Object.keys(DSC_WRITE_OPERATIONS).map((id) => [id, { operationId: id, state: 'live-qualified', enabled: true, reasons: [] }]));
const execute = (client, tenantRef, artifact, tenant, qualifications = enabled()) => executeDistributionGroupRestore(client, {
  tenantRef, artifactId: artifact.id, tenantId: TENANT, dsc: dscRunner(tenant.powershell), qualifications, testTenantRefs: [tenantRef],
});

// ------------------------------------------------------------ declarations and allowlists

test('two writes are declared, bound to the pinned Microsoft365DSC version, and ship disabled', () => {
  assert.deepEqual(Object.keys(DSC_WRITE_OPERATIONS).sort(), [DISTRIBUTION_GROUP_ADD, DISTRIBUTION_GROUP_UPDATE].sort());
  for (const id of Object.keys(DSC_WRITE_OPERATIONS)) {
    const write = WORKLOAD_WRITE_OPERATIONS[id];
    assert.ok(write, `${id} is in the qualification table`);
    assert.equal(write.workload, 'exchange-distribution-groups');
    assert.equal(write.readBack, 'exchange-distribution-groups.distribution-groups');
    assert.equal(write.kind, 'cmdlet');
    assert.equal(write.module, 'Microsoft365DSC');
    assert.equal(write.grantsRequired, true);
    for (const field of write.fields) assert.equal(isTrustField(write.resourceType, field), false, `${id}: ${field} is not a trust field`);
    const off = workloadWriteQualification(id, { tenantRef: 'sha256:t' });
    assert.equal(off.enabled, false, `${id} is off without a live capture`);
    const fixtureOnly = workloadWriteQualification(id, { tenantRef: 'sha256:t', evidence: [{ operationId: id, kind: 'fixture', ok: true, synthetic: true }] });
    assert.equal(fixtureOnly.state, 'fixture-tested');
    assert.equal(fixtureOnly.enabled, false, `${id}: a fixture pass never switches it on`);
    // A live capture at another Microsoft365DSC version does not count.
    const other = workloadWriteQualification(id, {
      tenantRef: 'sha256:t', runtime: { modules: { Microsoft365DSC: DSC_MODULE_VERSION } },
      evidence: [{ operationId: id, kind: 'live-write-capture', synthetic: false, tenantRef: 'sha256:t', capturedAt: new Date().toISOString(), version: '2.25.1.1', ok: true, readBackVerified: true }],
    });
    assert.equal(other.state, 'disabled');
  }
  // Nothing listed for an administrator is writable.
  for (const field of LISTED_FIELDS) assert.ok(!DSC_RESOURCES.EXODistributionGroup.writable.includes(field), `${field} is never sent`);
});

test('the Node and container allowlists match, and the DSC profile is its own pinned image', () => {
  const list = (name) => [...new RegExp(`\\$${name} = @\\{\\s*'EXODistributionGroup' = @\\(([\\s\\S]*?)\\)\\s*\\}`).exec(PS1)[1].matchAll(/'([A-Za-z]+)'/g)].map((match) => match[1]);
  assert.deepEqual(list('AllowedDsc').sort(), [...DSC_RESOURCES.EXODistributionGroup.properties].sort());
  assert.deepEqual(list('Writable').sort(), [...DSC_RESOURCES.EXODistributionGroup.writable].sort());
  assert.match(PS1, new RegExp(`\\$PinnedModuleVersion = '${DSC_MODULE_VERSION.replaceAll('.', '\\.')}'`));
  assert.match(DOCKERFILE, new RegExp(`Install-Module -Name Microsoft365DSC -RequiredVersion ${DSC_MODULE_VERSION.replaceAll('.', '\\.')} `));
  assert.match(PS1, /Ensure'\] -cne 'Present'/, 'the container refuses a Set that is not Ensure Present');
  assert.ok(!/Microsoft365DSC/.test(MAIN_DOCKERFILE.replace(/^#.*$/gm, '')), 'the collection image never loads Microsoft365DSC');
  assert.equal(DSC_IMAGE, 'keel-dsc:latest');
  assert.equal(DSC_MEMORY, '1536m');
  // No trust, certificate or sign-in field is in either list, and credentials never come from the job.
  for (const name of DSC_RESOURCES.EXODistributionGroup.properties) assert.ok(!/certificate|trust|signin|issuer|password|applicationid|tenantid|secret/i.test(name), name);
});

test('the transport refuses, unsent, anything outside the allowlist', async () => {
  const tenant = fakeDscTenant([]);
  const dsc = dscRunner(tenant.powershell);
  const key = { Identity: 'KEEL-RT-dl', Name: 'KEEL-RT-dl' };
  const refused = [
    { resource: 'AADConditionalAccessPolicy', calls: [{ method: 'Get', properties: key }] },
    { resource: 'EXODistributionGroup', calls: [{ method: 'Remove', properties: key }] },
    { resource: 'EXODistributionGroup', calls: [{ method: 'Get', properties: { ...key, CertificatePath: '/tmp/x' } }] },
    { resource: 'EXODistributionGroup', calls: [{ method: 'Set', properties: { ...key, Ensure: 'Present', ManagedBy: ['someone'] } }] },
    { resource: 'EXODistributionGroup', calls: [{ method: 'Set', properties: { ...key, Ensure: 'Absent' } }] },
    { resource: 'EXODistributionGroup', calls: [{ method: 'Set', properties: { ...key } }] },
    { resource: 'EXODistributionGroup', calls: [{ method: 'Set', properties: { ...key, Ensure: 'Present', DisplayName: null } }] },
    { resource: 'EXODistributionGroup', calls: [{ method: 'Set', properties: { ...key, Ensure: 'Present', DisplayName: { script: 'x' } } }] },
    { resource: 'EXODistributionGroup', calls: [{ method: 'Get', properties: { Name: 'KEEL-RT-dl' } }] },
    { resource: 'EXODistributionGroup', calls: [] },
  ];
  for (const request of refused) await assert.rejects(() => dsc(request), DscScopeError, JSON.stringify(request));
  assert.equal(tenant.jobs.length, 0, 'nothing reached the container');
  // The descriptor carries data only, never PowerShell source.
  const job = dscJob({ resource: 'EXODistributionGroup', calls: [{ method: 'Get', properties: { ...key, Ensure: 'Present' } }] }, { resources: DSC_RESOURCES });
  assert.deepEqual(Object.keys(job).sort(), ['adapter', 'calls', 'mode', 'moduleVersion', 'resource']);
});

test('the transport answers one result per call, and a wrong module version or a refused job is an error, never an empty answer', async () => {
  const list = fakeList({ Name: 'KEEL-RT-dl-read' });
  const tenant = fakeDscTenant([list]);
  const answer = await dscRunner(tenant.powershell)({ resource: 'EXODistributionGroup', calls: [
    { method: 'Get', properties: { Identity: list.Guid, Name: list.Name } }, { method: 'Get', properties: { Identity: 'KEEL-RT-none', Name: 'KEEL-RT-none' } },
  ] });
  assert.equal(answer.moduleVersion, DSC_MODULE_VERSION);
  assert.equal(answer.results[0].state.Ensure, 'Present');
  assert.equal(answer.results[0].state.Name, 'KEEL-RT-dl-read');
  assert.equal(answer.results[1].state.Ensure, 'Absent');
  assert.equal(tenant.jobs[0].tenantConfigPath, '/etc/keel/exchange-restorer.json');
  assert.equal(tenant.jobs[0].moduleVersion, DSC_MODULE_VERSION);

  const older = fakeDscTenant([list], { moduleVersion: '2.25.1.1' });
  await assert.rejects(() => dscRunner(older.powershell)({ resource: 'EXODistributionGroup', calls: [{ method: 'Get', properties: { Identity: 'KEEL-RT-a', Name: 'KEEL-RT-a' } }] }),
    (error) => error instanceof DscError && error.detail.code === 'MODULE_VERSION');
  const refusing = { ...tenant.powershell, spawnFn: fakeDscTenant([]).powershell.spawnFn };
  await assert.rejects(() => runDsc({ resource: 'EXODistributionGroup', calls: [{ method: 'Get', properties: { Identity: 'KEEL-RT-a', Name: 'KEEL-RT-a' } }] },
    { resources: { EXODistributionGroup: DSC_RESOURCES.EXODistributionGroup }, ...refusing, spawnFn: (...args) => {
      const child = refusing.spawnFn(...args);
      const end = child.stdin.end;
      child.stdin.end = () => {
        child.stdout.emit('data', Buffer.from(JSON.stringify({ ok: false, error: { message: 'could not prepare the DSC connection', errorId: 'ConnectFailed' } })));
        child.emit('close', 1);
        end.call(child.stdin);
      };
      return child;
    } }), (error) => error instanceof DscError && error.detail.code === 'DSC_JOB_REFUSED' && error.detail.errorId === 'ConnectFailed');
});

// ------------------------------------------------------------ planning

test('the plan writes changed settings and re-creates a gone list; privileges, addresses and members are listed', () => {
  const tenantRef = nextTenant();
  const changed = fakeList({ Name: 'KEEL-RT-dl-sales', MemberJoinRestriction: 'Open', HiddenFromAddressListsEnabled: true, ManagedBy: ['mallory'] });
  const gone = fakeList({ Name: 'KEEL-RT-dl-gone', Type: 'Security', ManagedBy: ['alice'], GrantSendOnBehalfTo: ['bob'], ModerationEnabled: true, ModeratedBy: ['carol'] });
  const same = fakeList({ Name: 'KEEL-RT-dl-same' });
  const backup = source([
    observation({ ...changed, MemberJoinRestriction: 'ApprovalRequired', HiddenFromAddressListsEnabled: false, ManagedBy: ['alice'] }),
    observation(gone, { MailTip: 'Payroll only' }),
    observation(same),
    observation(fakeList({ Name: 'KEEL-RT-room-list' }), { RecipientTypeDetails: 'RoomList' }),
  ]);
  const live = {
    [changed.Guid]: { byGuid: { ok: true, state: { ...changed, Ensure: 'Present' } }, byName: null },
    [gone.Guid]: { byGuid: { ok: true, state: { Ensure: 'Absent' } }, byName: { ok: true, state: { Ensure: 'Absent' } } },
    [same.Guid]: { byGuid: { ok: true, state: { ...same, Ensure: 'Present' } }, byName: null },
  };
  const plan = planDistributionGroupRestore({ source: backup, live, tenantId: TENANT, tenantRef, testTenantRefs: [tenantRef] });
  assert.equal(plan.writer, 'microsoft365dsc');
  assert.deepEqual(plan.operations.map((op) => `${op.kind}:${op.properties.Name}`).sort(), ['add:KEEL-RT-dl-gone', 'update:KEEL-RT-dl-sales']);
  const update = plan.operations.find((op) => op.kind === 'update');
  assert.deepEqual(update.changes.map(({ field }) => field).sort(), ['HiddenFromAddressListsEnabled', 'MemberJoinRestriction']);
  assert.equal(update.properties.MemberJoinRestriction, 'ApprovalRequired');
  // The whole declared set is sent, so nothing declared is left to a resource default.
  for (const field of UPDATE_FIELDS) assert.ok(field in update.properties, `${field} is sent with its value`);
  assert.equal(update.properties.Identity, 'KEEL-RT-dl-sales');
  assert.ok(!('ManagedBy' in update.properties), 'owners are never sent');

  const add = plan.operations.find((op) => op.kind === 'add');
  assert.equal(add.properties.Type, 'Security');
  assert.equal(add.properties.Ensure, 'Present');
  assert.equal(add.properties.PrimarySmtpAddress, gone.PrimarySmtpAddress);
  for (const field of ['ManagedBy', 'GrantSendOnBehalfTo', 'ModeratedBy', 'Members']) assert.ok(!(field in add.properties), `${field} is not sent`);

  const reasons = plan.manual.map((item) => `${item.resourceKey.split(':')[1].slice(0, 8)}|${item.field}`);
  assert.ok(reasons.includes(`${changed.Guid.slice(0, 8)}|ManagedBy`), 'a changed owner is listed');
  for (const field of ['ManagedBy', 'GrantSendOnBehalfTo', 'ModeratedBy', 'Members', 'MailTip']) assert.ok(reasons.includes(`${gone.Guid.slice(0, 8)}|${field}`), `${field} of the gone list is listed`);
  assert.ok(plan.manual.some((item) => /new identity: permissions granted to this security group/.test(item.reason)));
  assert.ok(plan.manual.some((item) => /RoomList/.test(item.reason)), 'a room list is listed, never written');
  assert.ok(!plan.operations.some((op) => op.properties.Name === 'KEEL-RT-dl-same'), 'a list that matches is not written');
  assert.deepEqual(plan.contentEffects, []);
  assert.deepEqual(plan.refusals, []);
});

test('on the test tenant only KEEL-RT- lists are written, and a list whose name is now taken is never touched', () => {
  const tenantRef = nextTenant();
  const real = fakeList({ Name: 'All Staff' });
  const taken = fakeList({ Name: 'KEEL-RT-dl-taken' });
  const usurper = fakeList({ Name: 'KEEL-RT-dl-taken' });
  const backup = source([observation({ ...real, MemberJoinRestriction: 'Open' }), observation(taken)]);
  const live = {
    [real.Guid]: { byGuid: { ok: true, state: { ...real, Ensure: 'Present' } }, byName: null },
    [taken.Guid]: { byGuid: { ok: true, state: { Ensure: 'Absent' } }, byName: { ok: true, state: { ...usurper, Ensure: 'Present' } } },
  };
  const plan = planDistributionGroupRestore({ source: backup, live, tenantId: TENANT, tenantRef, testTenantRefs: [tenantRef] });
  assert.deepEqual(plan.operations, []);
  assert.equal(plan.refusals.length, 1);
  assert.match(plan.refusals[0].reason, /^not-a-fixture: .*All Staff/);
  assert.ok(plan.manual.some((item) => /another list now uses its name/.test(item.reason)));
  // Off the test tenant the same plan writes the real list.
  const customer = planDistributionGroupRestore({ source: backup, live, tenantId: TENANT, tenantRef, testTenantRefs: [] });
  assert.deepEqual(customer.operations.map((op) => op.properties.Name), ['All Staff']);
});

test('a read that fails plans nothing for that list, and too many lists need --target', () => {
  const tenantRef = nextTenant();
  const list = fakeList({ Name: 'KEEL-RT-dl-unread' });
  const plan = planDistributionGroupRestore({
    source: source([observation(list)]), live: { [list.Guid]: { byGuid: { ok: false, error: { message: 'timed out' } }, byName: null } },
    tenantId: TENANT, tenantRef, testTenantRefs: [tenantRef],
  });
  assert.deepEqual(plan.operations, []);
  assert.match(plan.manual[0].reason, /could not be read live/);
  const many = source(Array.from({ length: 51 }, (_, index) => observation(fakeList({ Name: `KEEL-RT-dl-${index}` }))));
  assert.throws(() => planDistributionGroupRestore({ source: many, live: {}, tenantId: TENANT, tenantRef, testTenantRefs: [tenantRef] }), /at most 50 lists/);
  assert.throws(() => planDistributionGroupRestore({ source: many, live: {}, tenantId: TENANT, tenantRef, targets: ['KEEL-RT-missing'] }), /no distribution list named/);
});

// ------------------------------------------------------------ execution

test('a fixture restore re-creates a deleted list and puts back a changed one, verified; a second dry run plans nothing', async (t) => {
  const client = await schemaClient(t);
  const tenantRef = nextTenant();
  const deleted = fakeList({ Name: 'KEEL-RT-dl-deleted', MemberJoinRestriction: 'ApprovalRequired', HiddenFromAddressListsEnabled: true });
  const changed = fakeList({ Name: 'KEEL-RT-dl-changed', MemberDepartRestriction: 'Open' });
  const backup = source([observation(deleted), observation(changed)]);
  const tenant = fakeDscTenant([{ ...changed, MemberDepartRestriction: 'Closed', SendOofMessageToOriginatorEnabled: true }]);

  // Without a qualification nothing is written.
  const first = await planned(client, tenantRef, tenant, backup);
  assert.equal(first.plan.operations.length, 2);
  const off = await execute(client, tenantRef, first.artifact, tenant, {});
  assert.equal(off.outcome, 'disabled');
  assert.deepEqual(tenant.writes, []);

  const { artifact } = await planned(client, tenantRef, tenant, backup);
  const result = await execute(client, tenantRef, artifact, tenant);
  assert.equal(result.outcome, 'verified', JSON.stringify(result.operations));
  assert.equal(tenant.writes.length, 2);
  for (const write of tenant.writes) assert.equal(write.Ensure, 'Present');
  const recreated = tenant.find('KEEL-RT-dl-deleted');
  assert.ok(recreated, 'the list is back');
  assert.notEqual(recreated.Guid, deleted.Guid, 'it has a new identity');
  assert.equal(recreated.MemberJoinRestriction, 'ApprovalRequired');
  assert.equal(recreated.HiddenFromAddressListsEnabled, true);
  assert.equal(recreated.PrimarySmtpAddress, deleted.PrimarySmtpAddress);
  const fixed = tenant.find(changed.Guid);
  assert.equal(fixed.MemberDepartRestriction, 'Open');
  assert.equal(fixed.SendOofMessageToOriginatorEnabled, false);

  // Evidence: one row per operation and one for the plan.
  const { rows } = await client.query(`SELECT subject FROM evidence WHERE tenant_ref = $1 AND kind = 'workload-restore' AND subject->>'artifactId' = $2`, [tenantRef, artifact.id]);
  assert.equal(rows.length, 3);

  // The re-created list now has another Guid, so a new dry run against the old backup
  // finds its name taken and plans nothing for it; the changed list matches.
  const again = await planned(client, tenantRef, tenant, backup);
  assert.deepEqual(again.plan.operations, []);
  assert.ok(again.plan.manual.some((item) => /another list now uses its name/.test(item.reason)));
});

test('letting outside senders mail a list needs the separate content-effect approval', async (t) => {
  const client = await schemaClient(t);
  const tenantRef = nextTenant();
  const list = fakeList({ Name: 'KEEL-RT-dl-open' });
  const tenant = fakeDscTenant([list]);
  const { plan, artifact } = await planned(client, tenantRef, tenant, source([observation({ ...list, RequireSenderAuthenticationEnabled: false })]));
  assert.deepEqual(plan.contentEffects.map(({ field, effect }) => `${field}:${effect}`), ['RequireSenderAuthenticationEnabled:externally-sharing']);
  const blocked = await execute(client, tenantRef, artifact, tenant);
  assert.equal(blocked.outcome, 'blocked-content-effect');
  assert.deepEqual(tenant.writes, []);
  const approver = await principal(client, 'approver', 'approver');
  await approveContentEffects(client, { tenantRef, artifactId: artifact.id, approverId: approver, effectsDigest: contentEffectsDigest(plan.contentEffects), justification: 'KEEL-RT- fixture restore' });
  assert.equal((await execute(client, tenantRef, artifact, tenant)).outcome, 'verified');
  assert.equal(tenant.find(list.Guid).RequireSenderAuthenticationEnabled, false);
});

test('a list changed since the dry run is stale; an unknown outcome is reconciled by reading and never resent', async (t) => {
  const client = await schemaClient(t);
  const tenantRef = nextTenant();
  const list = fakeList({ Name: 'KEEL-RT-dl-stale' });
  const tenant = fakeDscTenant([{ ...list, MemberJoinRestriction: 'Open' }]);
  const backup = source([observation(list)]);
  const { artifact } = await planned(client, tenantRef, tenant, backup);
  tenant.find(list.Guid).HiddenFromAddressListsEnabled = true;
  const stale = await execute(client, tenantRef, artifact, tenant);
  assert.equal(stale.operations[0].outcome, 'stale');
  assert.deepEqual(tenant.writes, []);

  // The Set applies, then the container dies with no answer: one write, verified by reading.
  const crashing = fakeDscTenant([{ ...list, MemberJoinRestriction: 'Open' }], { behave: { set: () => 'crash-after' } });
  const second = await planned(client, tenantRef, crashing, backup);
  const result = await execute(client, tenantRef, second.artifact, crashing);
  assert.equal(result.operations[0].outcome, 'verified');
  assert.match(result.operations[0].reasons[0], /outcome was unknown .* not resent/);
  assert.equal(crashing.writes.length, 1);

  // A Set the module refuses is failed, not retried.
  const failing = fakeDscTenant([{ ...list, MemberJoinRestriction: 'Open' }], { behave: { set: () => 'fail' } });
  const third = await planned(client, tenantRef, failing, backup);
  const failed = await execute(client, tenantRef, third.artifact, failing);
  assert.equal(failed.operations[0].outcome, 'failed');
  assert.equal(failing.writes.length, 1);
});

test('the dispatch entry plans from the recorded collection with the collector and promotes with the restorer', async (t) => {
  const client = await schemaClient(t);
  const tenantRef = nextTenant();
  const entry = WORKLOAD_RESTORES['exchange-distribution-groups'];
  assert.deepEqual([...entry.operations].sort(), [DISTRIBUTION_GROUP_ADD, DISTRIBUTION_GROUP_UPDATE].sort());
  const list = fakeList({ Name: 'KEEL-RT-dl-dispatch' });
  const tenant = fakeDscTenant([]);
  const recorded = source([observation(list)]);
  const loaded = [];
  const restore = (await import('../restore/workloads/dscDistributionGroups.mjs')).distributionGroupRestore({
    load: async (_client, args) => { loaded.push(args); return recorded; },
  });
  await assert.rejects(() => restore.plan(client, { tenantRef, tenantId: TENANT, request: {}, connection: { powershell: tenant.powershell } }), /--collection/);
  // Off the test tenant list (this ref is not a test tenant), so it is planned as a customer restore.
  const plan = await restore.plan(client, { tenantRef, tenantId: TENANT, request: { collectionId: recorded.collectionId, targets: ['KEEL-RT-dl-dispatch'] }, connection: { powershell: tenant.powershell } });
  assert.equal(loaded[0].workload, 'exchange-distribution-groups');
  assert.deepEqual(plan.operations.map((op) => op.kind), ['add']);
  const artifact = await restore.create(client, { tenantRef, plan, requestedBy: await principal(client, 'requester') });
  const result = await restore.execute(client, { tenantRef, artifactId: artifact.id, tenantId: TENANT, connection: { powershell: tenant.powershell }, qualifications: enabled() });
  assert.equal(result.outcome, 'verified');
  assert.ok(tenant.find('KEEL-RT-dl-dispatch'));
});
