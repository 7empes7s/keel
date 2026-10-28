// The live proof for the distribution list writes through Microsoft365DSC.
//
// Acceptance:
//  - a capture refuses a removal and a listed field before sending, finds the seeded list
//    by its Guid and not an unknown Guid, creates one KEEL-RT-capture- list with the
//    restorer and reads it back with the collector, changes the seeded list's declared
//    settings and reads them back with its members, owners, moderators and everything
//    else KEEL never sends unchanged; the signed record verifies and imports as two write
//    captures that enable exactly those writes, bound to the pinned Microsoft365DSC version;
//  - a capture writes nothing when its list exists or the seeded list is not found by its
//    Guid, skips the update on a seeded list without members, and the CLI needs confirmation;
//  - a write that changed a field KEEL never sends (owners, members) is not proven;
//  - a tampered, unsigned, other-tenant or other-build record imports nothing.
//
// The capture runs against the fake DSC container with a test-only key. No tenant is read
// or written, and no record produced here is persisted as evidence.
import { strict as assert } from 'node:assert';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';

import { workloadWriteQualification } from '../coverage/qualification.mjs';
import { DSC_MODULE_VERSION } from '../powershell/dscJob.mjs';
import { DSC_WRITE_OPERATIONS } from '../restore/workloads/dscDistributionGroups.mjs';
import { tenantRefFor } from '../store/tenantRef.mjs';
import { fakeDscTenant, fakeList } from '../test/fakeDsc.mjs';
import { signEvidence, verifyEvidence } from '../../tools/release/qualification.mjs';
import { writeAcceptanceFiles } from '../../tools/qualification/sharepointLive.mjs';
import { DSC_WRITES_LIVE_GATE, DSC_WRITES_RECORD_FILE } from '../../tools/qualification/dscDistributionGroupsAcceptance.mjs';
import {
  captureDscWrites, dscWritesCapturePlan, ledgerEvidenceFromDscWritesAcceptance, main as liveMain,
} from '../../tools/qualification/dscDistributionGroupsLive.mjs';
import { importSeams } from '../../cli/keel-workload-collect.mjs';

const KEY = 'test-only';
const tenantRef = tenantRefFor('dsc-writes-live-fixture');
const build = 'fixture-build';
const observed = new Date('2026-10-28T08:00:00Z');
const verifyNow = new Date('2026-10-28T09:00:00Z');
const grants = { restorer: { permissions: ['Exchange.ManageAsApp'], roles: ['Exchange Administrator'] } };

const dir = mkdtempSync(join(tmpdir(), 'keel-dsc-writes-live-'));
after(() => rmSync(dir, { recursive: true, force: true }));

let suffixSeq = 0;
const SEED = 'KEEL-RT-capture-seed';
const seedList = (fields = {}) => fakeList({ Name: SEED, Members: ['m1@contoso.test'], ManagedBy: ['owner@contoso.test'], ModeratedBy: ['mod@contoso.test'], ModerationEnabled: true,
  ReportToManagerEnabled: true, BypassNestedModerationEnabled: true, MailTip: 'KEEL capture seed', BypassModerationFromSendersOrMembers: ['owner@contoso.test'], ...fields });
const seedOf = (tenant) => ({ name: SEED, guid: tenant.find(SEED)?.Guid ?? '00000000-0000-4000-8000-00000000dead' });
const capture = (tenant, overrides = {}) => captureDscWrites({
  seed: seedOf(tenant),
  collector: { ...tenant.powershell, tenantConfigPath: '/etc/keel/exchange-collector.json' }, restorer: tenant.powershell, tenantRef, build,
  credentials: { collector: 'app:keel-collector', restorer: 'app:keel-restorer' }, grants,
  now: () => observed, sleep: async () => {}, readBackDelayMs: 0, suffix: () => `c${suffixSeq += 1}`, ...overrides,
});
let counter = 0;
async function captured(tenant, overrides) {
  const result = await capture(tenant, overrides);
  const outPath = join(dir, `record-${counter += 1}.json`);
  return { ...result, ...writeAcceptanceFiles({ ...result, outPath, hmacKey: KEY }) };
}
const seamOptions = { tenantRef, build, now: verifyNow, hmacKey: KEY, evidenceDir: dir };

test('a capture creates and changes one KEEL-RT-capture- list, reads each back, and imports as two write captures', async () => {
  const tenant = fakeDscTenant([fakeList({ Name: 'All Staff' }), seedList()]);
  const seeded = structuredClone(tenant.find(SEED));
  const { evidence } = await captured(tenant);
  assert.equal(tenant.writes.length, 2);
  for (const write of tenant.writes) {
    assert.match(write.Name, /^KEEL-RT-capture-/);
    assert.equal(write.Ensure, 'Present');
    for (const field of ['ManagedBy', 'ModeratedBy', 'Members']) assert.ok(!(field in write), `${field} is never sent`);
  }
  assert.deepEqual(evidence.subject.identityRead, { byGuidFound: true, unknownGuidAbsent: true });
  // The seeded list was read by its Guid, with Name = that Guid.
  const guidRead = tenant.jobs.find((job) => job.calls[0].properties.Identity === seeded.Guid);
  assert.equal(guidRead.calls[0].properties.Name, seeded.Guid);
  // Reads used the collector config, writes the restorer's.
  const configs = tenant.jobs.map((job) => `${job.calls[0].method}:${job.tenantConfigPath}`);
  assert.ok(configs.filter((item) => item.startsWith('Get:')).every((item) => item.endsWith('exchange-collector.json')));
  assert.ok(configs.filter((item) => item.startsWith('Set:')).every((item) => item.endsWith('exchange-restorer.json')));
  const created = tenant.find(tenant.writes[0].Name);
  assert.equal(created.HiddenFromAddressListsEnabled, true, 'the capture list stays hidden from the address book');
  const seed = tenant.find(SEED);
  assert.equal(seed.MemberJoinRestriction, 'ApprovalRequired');
  assert.equal(tenant.writes[1].Name, SEED, 'the update runs on the seeded list');
  for (const field of ['Members', 'ManagedBy', 'ModeratedBy', 'ModerationEnabled']) assert.deepEqual(seed[field], seeded[field], `${field} is left alone`);
  assert.equal(tenant.find('All Staff').DisplayName, 'All Staff', 'nothing else is touched');

  const verified = verifyEvidence(evidence, { ...seamOptions, gate: DSC_WRITES_LIVE_GATE, requireLive: true });
  assert.equal(verified.ok, true, verified.failures.join('; '));
  assert.equal(evidence.subject.execution.moduleVersion, DSC_MODULE_VERSION);
  assert.equal(JSON.stringify(evidence).includes('contoso.test'), false, 'addresses are pseudonymized');

  const seam = ledgerEvidenceFromDscWritesAcceptance(evidence, seamOptions);
  assert.equal(seam.ok, true, seam.failures.join('; '));
  assert.deepEqual(seam.writes.map((item) => item.operationId).sort(), Object.keys(DSC_WRITE_OPERATIONS).sort());
  assert.deepEqual(seam.runtime, { modules: { Microsoft365DSC: DSC_MODULE_VERSION } });
  const readLedger = { tenantRef, rows: [{ id: 'exchange-distribution-groups.distribution-groups', state: 'live-qualified', enabled: true }] };
  for (const id of Object.keys(DSC_WRITE_OPERATIONS)) {
    const q = workloadWriteQualification(id, { readLedger, evidence: seam.writes, tenantRef, now: verifyNow, runtime: seam.runtime, grants: seam.restorerGrants });
    assert.equal(q.enabled, true, `${id}: ${JSON.stringify(q.reasons)}`);
    // Stored proofs at another version stay off even when the stored runtime agrees with them: the pin in code decides.
    const old = seam.writes.map((item) => ({ ...item, version: '2.25.1.1' }));
    assert.equal(workloadWriteQualification(id, { readLedger, evidence: old, tenantRef, now: verifyNow, runtime: { modules: { Microsoft365DSC: '2.25.1.1' } }, grants: seam.restorerGrants }).enabled, false);
    // Without the read-back enabled, it stays off.
    assert.equal(workloadWriteQualification(id, { evidence: seam.writes, tenantRef, now: verifyNow, runtime: seam.runtime, grants: seam.restorerGrants }).enabled, false);
  }
  const seams = await importSeams();
  assert.ok(seams.some((entry) => entry.file === DSC_WRITES_RECORD_FILE && entry.optional === true && entry.seam === ledgerEvidenceFromDscWritesAcceptance));
});

test('a capture writes nothing when its list exists; a change to a field KEEL never sends is not proven; the CLI needs confirmation', async () => {
  assert.equal(dscWritesCapturePlan().filter((step) => step.method === 'Set').length, 2);
  const exists = fakeDscTenant([fakeList({ Name: 'KEEL-RT-capture-fixed' }), seedList()]);
  const { evidence } = await captured(exists, { suffix: () => 'fixed' });
  assert.equal(exists.writes.length, 0);
  assert.match(evidence.subject.skipped.at(-1).reason, /already exists/);
  assert.equal(ledgerEvidenceFromDscWritesAcceptance(evidence, seamOptions).ok, false);

  // The seeded list is not there (so not found by its Guid): nothing is written, nothing proven.
  const noSeed = fakeDscTenant([]);
  const unseeded = await captured(noSeed);
  assert.equal(noSeed.writes.length, 0);
  assert.match(unseeded.evidence.subject.skipped.at(-1).reason, /not found by its Guid/);
  assert.equal(ledgerEvidenceFromDscWritesAcceptance(unseeded.evidence, seamOptions).ok, false);

  // A seeded list without members proves nothing about members: the update is skipped.
  const empty = fakeDscTenant([seedList({ Members: [] })]);
  const half = await captured(empty);
  assert.equal(empty.writes.length, 1);
  assert.match(half.evidence.subject.skipped.find((item) => item.operationId?.endsWith('.update')).reason, /has no Members/);
  assert.deepEqual(ledgerEvidenceFromDscWritesAcceptance(half.evidence, seamOptions).writes.map((item) => item.operationId), ['exchange-distribution-groups.distribution-group.add']);

  // A seeded list whose other settings are defaults could not show a Set resetting them: the update is skipped.
  const defaults = fakeDscTenant([seedList({ ReportToManagerEnabled: false })]);
  const unproven = await captured(defaults);
  assert.match(unproven.evidence.subject.skipped.find((item) => item.operationId?.endsWith('.update')).reason, /ReportToManagerEnabled/);

  // The update also clears the list's owners, its members, or resets a setting KEEL never sends: recorded, never proven.
  for (const [field, clear] of [['ManagedBy', (list) => { list.ManagedBy = []; }], ['Members', (list) => { list.Members = []; }], ['ReportToManagerEnabled', (list) => { list.ReportToManagerEnabled = false; }]]) {
    const tenant = fakeDscTenant([seedList()], { behave: { afterSet: (properties, list) => { if (/ updated /.test(properties.DisplayName ?? '')) clear(list); } } });
    const bad = await captured(tenant);
    const update = bad.evidence.subject.writes.find((item) => item.operationId === 'exchange-distribution-groups.distribution-group.update');
    assert.equal(update.ok, false, field);
    assert.match(update.error, new RegExp(field));
    const partial = ledgerEvidenceFromDscWritesAcceptance(bad.evidence, seamOptions);
    assert.deepEqual(partial.writes.map((item) => item.operationId), ['exchange-distribution-groups.distribution-group.add']);
  }

  const lines = [];
  assert.equal(await liveMain(['capture'], { out: (line) => lines.push(line) }), 2);
  assert.match(lines.at(-1), /--confirm-live-tenant-write/);
  // Run as the operator runs it, in a fresh process: its imports load on their own (no import cycle).
  const cli = spawnSync(process.execPath, [new URL('../../tools/qualification/dscDistributionGroupsLive.mjs', import.meta.url).pathname, 'plan'], { encoding: 'utf8' });
  assert.equal(cli.status, 0, cli.stderr);
  assert.equal(JSON.parse(cli.stdout).filter((step) => step.method === 'Set').length, 2);
});

test('a tampered, unsigned, other-tenant or other-build record imports nothing', async () => {
  const { evidence } = await captured(fakeDscTenant([seedList()]));
  const resign = (mutate) => {
    const copy = structuredClone(evidence);
    mutate(copy);
    const { proof: { runner, ...proof }, ...rest } = copy;
    return signEvidence({ ...rest, proof }, KEY, 'keel-release-runner');
  };
  const firstSet = (e) => e.subject.requests.find((request) => request.methods.includes('Set'));
  const cases = {
    unsigned: (() => { const { proof: { runner, ...proof }, ...rest } = structuredClone(evidence); return { ...rest, proof }; })(),
    readBackFalse: resign((e) => { for (const write of e.subject.writes) write.readBackVerified = false; }),
    collateral: resign((e) => { for (const write of e.subject.writes) write.collateralUnchanged = false; }),
    notFixture: resign((e) => { e.subject.writes[0].fixture = 'All Staff'; }),
    removal: resign((e) => { firstSet(e).ensure = 'Absent'; }),
    otherResource: resign((e) => { firstSet(e).resource = 'AADConditionalAccessPolicy'; }),
    collectorWrites: resign((e) => { firstSet(e).credential = 'collector'; }),
    restorerReads: resign((e) => { e.subject.requests.find((request) => request.methods.includes('Get')).credential = 'restorer'; }),
    setNotFixture: resign((e) => { firstSet(e).name = 'All Staff'; }),
    refusalSent: resign((e) => { e.subject.refusals.remove.sent = true; }),
    noRoles: resign((e) => { e.subject.grants.restorer.roles = []; }),
    synthetic: resign((e) => { e.subject.writes[1].synthetic = true; }),
    otherVersion: resign((e) => { e.subject.writes[1].version = '2.25.1.1'; }),
    otherPinnedVersion: resign((e) => { e.subject.execution.moduleVersion = '2.25.1.1'; for (const write of e.subject.writes) write.version = '2.25.1.1'; }),
    noGuidRead: resign((e) => { e.subject.identityRead.byGuidFound = false; }),
    unknownGuidFound: resign((e) => { e.subject.identityRead.unknownGuidAbsent = false; }),
    sameCredential: resign((e) => { e.subject.credentials.restorer = e.subject.credentials.collector; }),
    capturedTwice: resign((e) => { e.subject.writes.push({ ...e.subject.writes[0] }); }),
    noWrites: resign((e) => { e.subject.writes = []; }),
  };
  for (const [name, record] of Object.entries(cases)) {
    assert.equal(ledgerEvidenceFromDscWritesAcceptance(record, seamOptions).ok, false, name);
  }
  assert.equal(ledgerEvidenceFromDscWritesAcceptance(evidence, { ...seamOptions, tenantRef: tenantRefFor('other') }).ok, false);
  assert.equal(ledgerEvidenceFromDscWritesAcceptance(evidence, { ...seamOptions, build: 'other-build' }).ok, false);
});
