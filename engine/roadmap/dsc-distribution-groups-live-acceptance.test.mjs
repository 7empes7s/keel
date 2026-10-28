// The live proof for the distribution list writes through Microsoft365DSC.
//
// Acceptance:
//  - a capture refuses a removal and a listed field before sending, creates one
//    KEEL-RT-capture- list with the restorer, reads it back with the collector, changes
//    its declared settings and reads them back with the fields KEEL never sends unchanged;
//    the signed record verifies and imports as two write captures that enable exactly
//    those writes, bound to the pinned Microsoft365DSC version;
//  - a capture writes nothing when the list already exists, and the CLI needs confirmation;
//  - a write that changed a field KEEL never sends is not proven;
//  - a tampered, unsigned, other-tenant or other-build record imports nothing.
//
// The capture runs against the fake DSC container with a test-only key. No tenant is read
// or written, and no record produced here is persisted as evidence.
import { strict as assert } from 'node:assert';
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
const capture = (tenant, overrides = {}) => captureDscWrites({
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
  const tenant = fakeDscTenant([fakeList({ Name: 'All Staff' })]);
  const { evidence } = await captured(tenant);
  assert.equal(tenant.writes.length, 2);
  for (const write of tenant.writes) {
    assert.match(write.Name, /^KEEL-RT-capture-/);
    assert.equal(write.Ensure, 'Present');
    assert.ok(!('ManagedBy' in write), 'owners are never sent');
  }
  // Reads used the collector config, writes the restorer's.
  const configs = tenant.jobs.map((job) => `${job.calls[0].method}:${job.tenantConfigPath}`);
  assert.ok(configs.filter((item) => item.startsWith('Get:')).every((item) => item.endsWith('exchange-collector.json')));
  assert.ok(configs.filter((item) => item.startsWith('Set:')).every((item) => item.endsWith('exchange-restorer.json')));
  const list = tenant.find(tenant.writes[0].Name);
  assert.equal(list.MemberJoinRestriction, 'ApprovalRequired');
  assert.equal(list.HiddenFromAddressListsEnabled, true, 'the capture list stays hidden from the address book');
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
    // Without the read-back enabled, it stays off.
    assert.equal(workloadWriteQualification(id, { evidence: seam.writes, tenantRef, now: verifyNow, runtime: seam.runtime, grants: seam.restorerGrants }).enabled, false);
  }
  const seams = await importSeams();
  assert.ok(seams.some((entry) => entry.file === DSC_WRITES_RECORD_FILE && entry.optional === true && entry.seam === ledgerEvidenceFromDscWritesAcceptance));
});

test('a capture writes nothing when its list exists; a change to a field KEEL never sends is not proven; the CLI needs confirmation', async () => {
  assert.equal(dscWritesCapturePlan().filter((step) => step.method === 'Set').length, 2);
  const exists = fakeDscTenant([fakeList({ Name: 'KEEL-RT-capture-fixed' })]);
  const { evidence } = await captured(exists, { suffix: () => 'fixed' });
  assert.equal(exists.writes.length, 0);
  assert.match(evidence.subject.skipped.at(-1).reason, /already exists/);
  assert.equal(ledgerEvidenceFromDscWritesAcceptance(evidence, seamOptions).ok, false);

  // The update also clears the list's owners: the update is recorded, never proven.
  const tenant = fakeDscTenant([], { behave: { afterSet: (properties, list) => { if (/updated$/.test(properties.DisplayName ?? '')) list.ManagedBy = []; } } });
  const bad = await captured(tenant);
  const update = bad.evidence.subject.writes.find((item) => item.operationId === 'exchange-distribution-groups.distribution-group.update');
  assert.equal(update.ok, false);
  assert.match(update.error, /ManagedBy/);
  const partial = ledgerEvidenceFromDscWritesAcceptance(bad.evidence, seamOptions);
  assert.deepEqual(partial.writes.map((item) => item.operationId), ['exchange-distribution-groups.distribution-group.add']);

  const lines = [];
  assert.equal(await liveMain(['capture'], { out: (line) => lines.push(line) }), 2);
  assert.match(lines.at(-1), /--confirm-live-tenant-write/);
});

test('a tampered, unsigned, other-tenant or other-build record imports nothing', async () => {
  const { evidence } = await captured(fakeDscTenant([]));
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
