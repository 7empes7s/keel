// The live proof for the custom Exchange admin role write.
//
// Acceptance:
//  - a capture refuses a role removal and an undeclared parameter before sending, recreates
//    one KEEL-RT-capture-role- role from the parent through the writer's own create-and-trim
//    step with the restorer, reads it back with the collector exactly as planned, and checks
//    the parent unchanged; the signed record verifies and imports as one write capture that
//    enables the write once the Exchange admin role read is enabled;
//  - it shows whether New-ManagementRole honoured -EnabledCmdlets, and proves the write
//    either way (extra entries are removed);
//  - a capture writes nothing when the parent is missing or the role exists; the CLI needs
//    confirmation;
//  - a tampered, unsigned, other-tenant or other-build record imports nothing.
//
// The capture runs against a fake Exchange container with a test-only key. No tenant is
// read or written, and no record produced here is persisted as evidence.
import { strict as assert } from 'node:assert';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';

import { workloadWriteQualification } from '../coverage/qualification.mjs';
import { EXCHANGE_ROLE_ADD } from '../restore/workloads/exchangeRoleDeclarations.mjs';
import { tenantRefFor } from '../store/tenantRef.mjs';
import { fakeExchangeRoles } from '../test/fakeExchangeRoles.mjs';
import { signEvidence, verifyEvidence } from '../../tools/release/qualification.mjs';
import { writeAcceptanceFiles } from '../../tools/qualification/sharepointLive.mjs';
import { ROLE_WRITES_LIVE_GATE, ROLE_WRITES_RECORD_FILE } from '../../tools/qualification/exchangeRoleDefinitionsAcceptance.mjs';
import {
  captureRoleWrites, chooseCaptureEntries, ledgerEvidenceFromRoleWritesAcceptance, main as liveMain, roleWritesCapturePlan,
} from '../../tools/qualification/exchangeRoleDefinitionsLive.mjs';
import { importSeams } from '../../cli/keel-workload-collect.mjs';

const KEY = 'test-only';
const TENANT_ID = '00000000-0000-4000-8000-0000000000e8';
const tenantRef = tenantRefFor(TENANT_ID);
const build = 'fixture-build';
const observed = new Date('2026-10-29T20:00:00Z');
const verifyNow = new Date('2026-10-29T21:00:00Z');
const grants = { restorer: { permissions: ['Exchange.ManageAsApp'], roles: ['Exchange Administrator'] } };
const MODULE = '3.5.0';

const dir = mkdtempSync(join(tmpdir(), 'keel-role-writes-live-'));
after(() => rmSync(dir, { recursive: true, force: true }));

const PARENT = { name: 'Address Lists', entries: {
  'Get-AddressList': ['Identity', 'ResultSize', 'SearchText'], 'Get-GlobalAddressList': ['Identity', 'DefaultOnly'],
  'New-AddressList': ['Name', 'RecipientFilter'], 'Remove-AddressList': ['Identity'],
} };
let suffixSeq = 0;
const capture = (tenant, overrides = {}) => captureRoleWrites({
  collector: { ...tenant.powershell, tenantConfigPath: '/etc/keel/exchange-collector.json' }, restorer: tenant.powershell,
  tenantRef, tenantId: TENANT_ID, build, credentials: { collector: 'app:keel-collector', restorer: 'app:keel-restorer' }, grants, moduleVersion: MODULE,
  now: () => observed, suffix: () => `c${suffixSeq += 1}`, ...overrides,
});
let counter = 0;
async function captured(tenant, overrides) {
  const result = await capture(tenant, overrides);
  const outPath = join(dir, `record-${counter += 1}.json`);
  return { ...result, ...writeAcceptanceFiles({ ...result, outPath, hmacKey: KEY }) };
}
const seamOptions = { tenantRef, build, now: verifyNow, hmacKey: KEY, evidenceDir: dir };

for (const ignoreEnabledCmdlets of [false, true]) {
  test(`a capture recreates one KEEL-RT-capture-role- role, reads it back and imports as one write capture${ignoreEnabledCmdlets ? ' (extra entries removed)' : ''}`, async () => {
    const tenant = fakeExchangeRoles({ roles: [PARENT, { name: 'Mail Recipients', entries: { 'Get-Mailbox': ['Identity'] } }], ignoreEnabledCmdlets });
    const before = structuredClone(tenant.state.get('address lists'));
    const { evidence } = await captured(tenant);
    const sent = tenant.sent();
    assert.equal(sent[0].cmdlet, 'New-ManagementRole');
    assert.match(sent[0].parameters.Name, /^KEEL-RT-capture-role-/);
    assert.equal(sent[0].parameters.Parent, 'Address Lists');
    assert.ok(sent.slice(1).every(({ parameters }) => parameters.Identity.startsWith(`${sent[0].parameters.Name}\\`)), 'only the new role is trimmed');
    const created = tenant.state.get(sent[0].parameters.Name.toLowerCase());
    assert.deepEqual(created.entries, chooseCaptureEntries(PARENT.entries));
    assert.deepEqual(tenant.state.get('address lists'), before, 'the parent is unchanged');
    assert.equal(evidence.subject.writes[0].enabledCmdletsHonoured, !ignoreEnabledCmdlets);
    assert.ok(evidence.subject.writes[0].trimmedParameters > 0);

    const verified = verifyEvidence(evidence, { ...seamOptions, gate: ROLE_WRITES_LIVE_GATE, requireLive: true });
    assert.equal(verified.ok, true, verified.failures.join('; '));
    const seam = ledgerEvidenceFromRoleWritesAcceptance(evidence, seamOptions);
    assert.equal(seam.ok, true, seam.failures.join('; '));
    assert.deepEqual(seam.writes.map((item) => item.operationId), [EXCHANGE_ROLE_ADD]);
    assert.deepEqual(seam.runtime, { modules: { ExchangeOnlineManagement: MODULE } });
    const readLedger = { tenantRef, rows: [{ id: 'exchange-role-groups.role-groups', state: 'live-qualified', enabled: true }] };
    const q = workloadWriteQualification(EXCHANGE_ROLE_ADD, { readLedger, evidence: seam.writes, tenantRef, now: verifyNow, runtime: seam.runtime, grants: seam.restorerGrants });
    assert.equal(q.enabled, true, JSON.stringify(q.reasons));
    // Another module version in use, or no read-back enabled: off.
    assert.equal(workloadWriteQualification(EXCHANGE_ROLE_ADD, { readLedger, evidence: seam.writes, tenantRef, now: verifyNow, runtime: { modules: { ExchangeOnlineManagement: '3.6.0' } }, grants: seam.restorerGrants }).enabled, false);
    assert.equal(workloadWriteQualification(EXCHANGE_ROLE_ADD, { evidence: seam.writes, tenantRef, now: verifyNow, runtime: seam.runtime, grants: seam.restorerGrants }).enabled, false);
    const seams = await importSeams();
    assert.ok(seams.some((entry) => entry.file === ROLE_WRITES_RECORD_FILE && entry.optional === true && entry.seam === ledgerEvidenceFromRoleWritesAcceptance));
  });
}

test('a capture writes nothing when the parent is missing or the role exists; the CLI needs confirmation', async () => {
  assert.equal(roleWritesCapturePlan().filter((step) => step.cmdlet === 'New-ManagementRole').length, 1);
  const noParent = fakeExchangeRoles({ roles: [{ name: 'Mail Recipients', entries: { 'Get-Mailbox': ['Identity'] } }] });
  const missing = await captured(noParent);
  assert.equal(noParent.sent().length, 0);
  assert.match(missing.evidence.subject.skipped.at(-1).reason, /parent role Address Lists was not found/);
  assert.equal(ledgerEvidenceFromRoleWritesAcceptance(missing.evidence, seamOptions).ok, false);
  const exists = fakeExchangeRoles({ roles: [PARENT, { name: 'KEEL-RT-capture-role-fixed', entries: { 'Get-AddressList': ['Identity'] } }] });
  const taken = await captured(exists, { suffix: () => 'fixed' });
  assert.equal(exists.sent().length, 0);
  assert.match(taken.evidence.subject.skipped.at(-1).reason, /already exists/);

  const lines = [];
  assert.equal(await liveMain(['capture'], { out: (line) => lines.push(line) }), 2);
  assert.match(lines.at(-1), /--confirm-live-tenant-write/);
  // Run as the operator runs it, in a fresh process: its imports load on their own (no import cycle).
  const cli = spawnSync(process.execPath, [new URL('../../tools/qualification/exchangeRoleDefinitionsLive.mjs', import.meta.url).pathname, 'plan'], { encoding: 'utf8' });
  assert.equal(cli.status, 0, cli.stderr);
  assert.equal(JSON.parse(cli.stdout).filter((step) => step.cmdlet === 'New-ManagementRole').length, 1);
});

test('a tampered, unsigned, other-tenant or other-build record imports nothing', async () => {
  const { evidence } = await captured(fakeExchangeRoles({ roles: [PARENT] }));
  const resign = (mutate) => {
    const copy = structuredClone(evidence);
    mutate(copy);
    const { proof: { runner, ...proof }, ...rest } = copy;
    return signEvidence({ ...rest, proof }, KEY, 'keel-release-runner');
  };
  const firstWrite = (e) => e.subject.requests.find((request) => request.cmdlet === 'New-ManagementRole');
  const cases = {
    unsigned: (() => { const { proof: { runner, ...proof }, ...rest } = structuredClone(evidence); return { ...rest, proof }; })(),
    readBackFalse: resign((e) => { e.subject.writes[0].readBackVerified = false; }),
    parentChanged: resign((e) => { e.subject.writes[0].collateralUnchanged = false; }),
    noTrim: resign((e) => { e.subject.writes[0].trimmedParameters = 0; }),
    notFixture: resign((e) => { e.subject.writes[0].fixture = 'Helpdesk'; }),
    writeNotFixture: resign((e) => { firstWrite(e).role = 'Organization Management'; }),
    collectorWrites: resign((e) => { firstWrite(e).credential = 'collector'; }),
    otherCmdlet: resign((e) => { firstWrite(e).cmdlet = 'Remove-ManagementRole'; }),
    refusalSent: resign((e) => { e.subject.refusals.removeRole.sent = true; }),
    noRoles: resign((e) => { e.subject.grants.restorer.roles = []; }),
    synthetic: resign((e) => { e.subject.writes[0].synthetic = true; }),
    otherVersion: resign((e) => { e.subject.writes[0].version = '3.6.0'; }),
    sameCredential: resign((e) => { e.subject.credentials.restorer = e.subject.credentials.collector; }),
    capturedTwice: resign((e) => { e.subject.writes.push({ ...e.subject.writes[0] }); }),
    noWrites: resign((e) => { e.subject.writes = []; }),
  };
  for (const [name, record] of Object.entries(cases)) {
    assert.equal(ledgerEvidenceFromRoleWritesAcceptance(record, seamOptions).ok, false, name);
  }
  assert.equal(ledgerEvidenceFromRoleWritesAcceptance(evidence, { ...seamOptions, tenantRef: tenantRefFor('other') }).ok, false);
  assert.equal(ledgerEvidenceFromRoleWritesAcceptance(evidence, { ...seamOptions, build: 'other-build' }).ok, false);
});
