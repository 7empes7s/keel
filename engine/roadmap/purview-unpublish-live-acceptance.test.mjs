// The live proof for removing labels from a Purview label policy.
//
// Acceptance:
//  - a capture refuses a removal through the ordinary Purview call and an undeclared
//    parameter before sending, removes one KEEL-RT- label from one KEEL-RT- policy with
//    the restorer through the writer's own unpublish call, reads it back gone with the
//    collector, and puts the policy back as it started; the signed record verifies and
//    imports as one live write capture;
//  - when the label is not published at the start it is published first, so the policy
//    still ends as it started;
//  - a capture writes nothing without a KEEL-RT- policy and label; a failed put-back exits
//    with what to fix by hand; the CLI needs confirmation;
//  - a tampered, unsigned or other-build record, or one that wrote outside the fixtures,
//    imports nothing.
//
// The capture runs against a fake PowerShell container behind the real job transport,
// with the allowlist run-cmdlet.ps1 ships, and a test-only key. No tenant is touched.
import { strict as assert } from 'node:assert';
import { spawnSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';

import { workloadWriteQualification } from '../coverage/qualification.mjs';
import { tenantRefFor } from '../store/tenantRef.mjs';
import { signEvidence, verifyEvidence } from '../../tools/release/qualification.mjs';
import { writeAcceptanceFiles } from '../../tools/qualification/sharepointLive.mjs';
import { UNPUBLISH_LIVE_GATE, UNPUBLISH_RECORD_FILE, UNPUBLISH_WRITE } from '../../tools/qualification/purviewUnpublishAcceptance.mjs';
import {
  captureUnpublish, ledgerEvidenceFromUnpublishAcceptance, main as liveMain, unpublishCapturePlan,
} from '../../tools/qualification/purviewUnpublishLive.mjs';
import { importSeams } from '../../cli/keel-workload-collect.mjs';

const KEY = 'test-only';
const TENANT_ID = '00000000-0000-4000-8000-0000000000e9';
const tenantRef = tenantRefFor(TENANT_ID);
const build = 'fixture-build';
const observed = new Date('2026-10-30T10:00:00Z');
const verifyNow = new Date('2026-10-30T11:00:00Z');
const grants = { restorer: { permissions: ['Exchange.ManageAsApp'], roles: ['Compliance Administrator'] } };
const MODULE = '3.5.0';

const dir = mkdtempSync(join(tmpdir(), 'keel-unpublish-live-'));
after(() => rmSync(dir, { recursive: true, force: true }));

const id = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const label = (n, name) => ({
  ImmutableId: id(n), Guid: id(n), Name: name, DisplayName: name, Priority: n, Disabled: false, Tooltip: name, Comment: '',
  EncryptionEnabled: false, ContentType: 'File, Email', WhenChangedUTC: '2026-09-01T00:00:00Z',
});
const policy = (n, name, labels, extra = {}) => ({
  ImmutableId: id(n), Guid: id(n), Name: name, Enabled: true, Mode: 'Enforce', Priority: 0, Labels: labels,
  ExchangeLocation: ['keel-rt-user@contoso.test'], ModernGroupLocation: [], SharePointLocation: [], OneDriveLocation: [], Settings: [],
  WhenChangedUTC: '2026-09-01T00:00:00Z', ...extra,
});

function containerAllowlist(variable) {
  const script = readFileSync(new URL('../../ops/powershell/run-cmdlet.ps1', import.meta.url), 'utf8');
  const block = new RegExp(`\\$${variable} = @\\{([\\s\\S]*?)\\n\\}`).exec(script)[1];
  return Object.fromEntries([...block.matchAll(/'([A-Za-z-]+)'\s*=\s*@\(([^)]*)\)/g)]
    .map(([, name, entries]) => [name, [...entries.matchAll(/'([A-Za-z0-9]+)'/g)].map((match) => match[1])]));
}
const ALLOWED = containerAllowlist('AllowedPurview');

/** A fake tenant behind the real job transport; `fail(cmdlet, parameters)` may return an error. */
function fakeTenant({ labels, policies, fail = () => null }) {
  const state = { labels: structuredClone(labels), policies: structuredClone(policies) };
  const sent = [];
  const envelope = (body, exitCode = 0) => ({ stdout: JSON.stringify(body), exitCode });
  function run(job) {
    const allowed = ALLOWED[job.cmdlet];
    if (job.module !== 'ExchangeOnlineManagement' || !allowed) return envelope({ ok: false, error: { message: `cmdlet ${job.cmdlet} is not allowed`, errorId: 'CmdletNotAllowed' } }, 1);
    for (const name of Object.keys(job.parameters ?? {})) {
      if (!allowed.includes(name)) return envelope({ ok: false, error: { message: `parameter ${name} is not allowed`, errorId: 'ParameterNotAllowed' } }, 1);
    }
    const parameters = job.parameters ?? {};
    if (job.cmdlet === 'Get-Label') return envelope({ ok: true, output: structuredClone(state.labels) });
    if (job.cmdlet === 'Get-LabelPolicy') return envelope({ ok: true, output: structuredClone(state.policies) });
    sent.push({ cmdlet: job.cmdlet, parameters: structuredClone(parameters), config: job.tenantConfigPath ?? null });
    const error = fail(job.cmdlet, parameters, sent.length);
    if (error) return envelope({ ok: false, error }, 1);
    if (job.cmdlet === 'Set-LabelPolicy') {
      const target = state.policies.find((item) => item.ImmutableId === parameters.Identity);
      if (parameters.AddLabels) target.Labels = [...target.Labels, ...parameters.AddLabels];
      if (parameters.RemoveLabels) target.Labels = target.Labels.filter((name) => !parameters.RemoveLabels.includes(name));
      target.WhenChangedUTC = '2026-10-30T10:00:00Z';
      return envelope({ ok: true, output: [] });
    }
    return envelope({ ok: false, error: { message: `${job.cmdlet} has no fake`, errorId: 'NoFake' } }, 1);
  }
  function spawnFn() {
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = () => {};
    let input = '';
    child.stdin = {
      write(chunk) { input += chunk; },
      end() {
        queueMicrotask(() => {
          const result = run(JSON.parse(input));
          if (result.stdout) child.stdout.emit('data', Buffer.from(result.stdout));
          child.emit('close', result.exitCode);
        });
      },
    };
    return child;
  }
  return { state, sent: () => sent, side: (config) => ({ spawnFn, timeoutMs: 200, tenantConfigPath: config }) };
}

const LABELS = [label(1, 'Confidential'), label(2, 'KEEL-RT-Public'), label(3, 'KEEL-RT-Secret')];
const POLICIES = (labels = ['Confidential', 'KEEL-RT-Secret']) => [
  policy(10, 'Global label policy', ['Confidential'], { ExchangeLocation: ['All'] }),
  policy(11, 'KEEL-RT-All', ['KEEL-RT-Secret'], { ExchangeLocation: ['All'] }),
  policy(12, 'KEEL-RT-Policy', labels),
];
const capture = (tenant, overrides = {}) => captureUnpublish({
  collector: tenant.side('/etc/keel/purview-collector.json'), restorer: tenant.side('/etc/keel/purview-restorer.json'),
  tenantRef, build, credentials: { collector: 'app:keel-collector', restorer: 'app:keel-restorer' }, grants, moduleVersion: MODULE,
  now: () => observed, ...overrides,
});
let counter = 0;
async function captured(tenant, overrides) {
  const result = await capture(tenant, overrides);
  const outPath = join(dir, `record-${counter += 1}.json`);
  return { ...result, ...writeAcceptanceFiles({ ...result, outPath, hmacKey: KEY }) };
}
const seamOptions = { tenantRef, build, now: verifyNow, hmacKey: KEY, evidenceDir: dir };

for (const published of [true, false]) {
  test(`a capture removes one KEEL-RT- label from a KEEL-RT- policy, puts the policy back and imports as one write capture (${published ? 'published' : 'not published'} at the start)`, async () => {
    const start = published ? ['Confidential', 'KEEL-RT-Public'] : ['Confidential'];
    const tenant = fakeTenant({ labels: LABELS, policies: POLICIES(start) });
    const { evidence, needsManualRevert } = await captured(tenant);
    assert.equal(needsManualRevert, null);
    const sent = tenant.sent();
    // Only the fixture policy (not the one publishing to All), only the fixture label, only by the restorer.
    assert.ok(sent.every((call) => call.parameters.Identity === id(12) && call.config === '/etc/keel/purview-restorer.json'));
    assert.deepEqual(sent.map(({ parameters: { Identity, ...rest } }) => rest), published
      ? [{ RemoveLabels: ['KEEL-RT-Public'] }, { AddLabels: ['KEEL-RT-Public'] }]
      : [{ AddLabels: ['KEEL-RT-Public'] }, { RemoveLabels: ['KEEL-RT-Public'] }]);
    assert.deepEqual([...tenant.state.policies[2].Labels].sort(), [...start].sort());
    assert.deepEqual(tenant.state.policies.slice(0, 2).map((item) => item.Labels), [['Confidential'], ['KEEL-RT-Secret']]);
    assert.deepEqual(evidence.subject.refusals.ordinaryCall, { cmdlet: 'Set-LabelPolicy', parameter: 'RemoveLabels', refused: true, sent: false, reason: evidence.subject.refusals.ordinaryCall.reason });
    assert.equal(evidence.subject.refusals.undeclaredParameter.refused, true);

    const verified = verifyEvidence(evidence, { ...seamOptions, gate: UNPUBLISH_LIVE_GATE, requireLive: true });
    assert.equal(verified.ok, true, verified.failures.join('; '));
    const seam = ledgerEvidenceFromUnpublishAcceptance(evidence, seamOptions);
    assert.equal(seam.ok, true, seam.failures.join('; '));
    assert.deepEqual(seam.writes.map((item) => item.operationId), [UNPUBLISH_WRITE]);
    assert.deepEqual(seam.runtime, { modules: { ExchangeOnlineManagement: MODULE } });
    const q = workloadWriteQualification(UNPUBLISH_WRITE, { evidence: seam.writes, tenantRef, now: verifyNow, runtime: seam.runtime, grants: seam.restorerGrants });
    assert.equal(q.state, 'live-qualified');
    // Still off: its read-back and adding labels must be qualified too.
    assert.equal(q.enabled, false);
    assert.ok(q.reasons.some((reason) => /purview.label-policy.update must be live-qualified first/.test(reason)));
    assert.equal(workloadWriteQualification(UNPUBLISH_WRITE, { evidence: seam.writes, tenantRef, now: verifyNow, runtime: { modules: { ExchangeOnlineManagement: '3.6.0' } }, grants: seam.restorerGrants }).state, 'disabled');
    const seams = await importSeams();
    assert.ok(seams.some((entry) => entry.file === UNPUBLISH_RECORD_FILE && entry.optional === true && entry.seam === ledgerEvidenceFromUnpublishAcceptance));
  });
}

test('a capture writes nothing without a KEEL-RT- policy and label; the CLI needs confirmation', async () => {
  const noPolicy = fakeTenant({ labels: LABELS, policies: POLICIES().slice(0, 2) });
  const none = await captured(noPolicy);
  assert.equal(noPolicy.sent().length, 0);
  assert.match(none.evidence.subject.skipped[0].reason, /no KEEL-RT- label policy/);
  assert.equal(ledgerEvidenceFromUnpublishAcceptance(none.evidence, seamOptions).ok, false);
  const noLabel = fakeTenant({ labels: [label(1, 'Confidential')], policies: POLICIES() });
  const empty = await captured(noLabel);
  assert.equal(noLabel.sent().length, 0);
  assert.match(empty.evidence.subject.skipped[0].reason, /no KEEL-RT- label/);

  assert.equal(unpublishCapturePlan().filter((step) => step.operationId === UNPUBLISH_WRITE).length, 1);
  const lines = [];
  assert.equal(await liveMain(['capture'], { out: (line) => lines.push(line) }), 2);
  assert.match(lines.at(-1), /--confirm-live-tenant-write/);
  const cli = spawnSync(process.execPath, [new URL('../../tools/qualification/purviewUnpublishLive.mjs', import.meta.url).pathname, 'plan'], { encoding: 'utf8' });
  assert.equal(cli.status, 0, cli.stderr);
  assert.equal(JSON.parse(cli.stdout).filter((step) => step.operationId === UNPUBLISH_WRITE).length, 1);
});

test('a failed removal proves nothing; a failed put-back names the label to publish again by hand', async () => {
  const refused = fakeTenant({
    labels: LABELS, policies: POLICIES(['Confidential', 'KEEL-RT-Public']),
    fail: (cmdlet, parameters) => (parameters.RemoveLabels ? { message: 'Access denied', errorId: 'AccessDenied' } : null),
  });
  const failed = await captured(refused);
  assert.equal(failed.needsManualRevert, null, 'nothing changed, so nothing to fix');
  assert.equal(failed.evidence.subject.writes[0].ok, false);
  assert.equal(ledgerEvidenceFromUnpublishAcceptance(failed.evidence, seamOptions).ok, false);

  const stuck = fakeTenant({
    labels: LABELS, policies: POLICIES(['Confidential', 'KEEL-RT-Public']),
    fail: (cmdlet, parameters) => (parameters.AddLabels ? { message: 'Server busy', errorId: 'Busy' } : null),
  });
  const half = await captured(stuck);
  assert.deepEqual(half.needsManualRevert, { policy: 'KEEL-RT-Policy', label: 'KEEL-RT-Public', publish: true, unpublish: false });
  assert.equal(half.evidence.subject.writes[0].readBackVerified, true);
  assert.equal(half.evidence.subject.writes[0].putBack, false);
  assert.equal(ledgerEvidenceFromUnpublishAcceptance(half.evidence, seamOptions).ok, false);
});

test('a tampered, unsigned, other-build or out-of-fixture record imports nothing', async () => {
  const tenant = fakeTenant({ labels: LABELS, policies: POLICIES(['Confidential', 'KEEL-RT-Public']) });
  const { evidence } = await captured(tenant);
  assert.equal(ledgerEvidenceFromUnpublishAcceptance(evidence, { ...seamOptions, build: 'other-build' }).ok, false);
  const { proof, ...unsigned } = evidence;
  assert.equal(ledgerEvidenceFromUnpublishAcceptance({ ...unsigned, proof: { artifact: proof.artifact } }, seamOptions).ok, false);
  const resign = (mutate) => {
    const copy = structuredClone(evidence);
    delete copy.proof.runner;
    mutate(copy.subject);
    return signEvidence(copy, KEY, 'keel-release-runner');
  };
  for (const [mutate, reason] of [
    [(subject) => { subject.requests.find((r) => r.cmdlet === 'Set-LabelPolicy').policy = 'Global label policy'; }, /not a KEEL-RT- policy/],
    [(subject) => { subject.requests.find((r) => r.cmdlet === 'Set-LabelPolicy').labels = ['Confidential']; }, /not exactly one KEEL-RT- label/],
    [(subject) => { subject.requests.push({ credential: 'restorer', cmdlet: 'Remove-Label', outcome: 'ok' }); }, /not a cmdlet the label removal capture runs/],
    [(subject) => { subject.writes[0].putBack = false; }, /proves nothing/],
    [(subject) => { subject.refusals.ordinaryCall.sent = true; }, /ordinaryCall probe was not refused/],
    [(subject) => { subject.grants.restorer.roles = []; }, /lacks Compliance Administrator/],
  ]) {
    const result = verifyEvidence(resign(mutate), { ...seamOptions, gate: UNPUBLISH_LIVE_GATE, requireLive: true });
    assert.equal(result.ok, false);
    assert.match(result.failures.join('\n'), reason);
  }
});
