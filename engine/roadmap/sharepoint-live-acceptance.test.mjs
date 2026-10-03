// Roadmap task-120: SharePoint configuration workload qualification.
//
// Acceptance:
//  - a valid independently captured record verifies;
//  - altered signature/digest, wrong tenant/build/operation, stale evidence and a
//    missing prerequisite fail.
// Mutation checks:
//  - accept missing external evidence;
//  - accept mismatched tenant or operation;
//  - elevate fixture evidence to live-qualified.
//
// The capture tool runs against an in-memory fake Graph, and the record is signed
// with a test-only key. No tenant is read or written, and no record produced here
// is persisted as release evidence.
import { strict as assert } from 'node:assert';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { buildWorkloadLedger } from '../collect/workloadContract.mjs';
import { workloadWriteQualification } from '../coverage/qualification.mjs';
import { signEvidence, verifyEvidence, verifyEvidenceFile } from '../../tools/release/qualification.mjs';
import {
  SHAREPOINT_LIVE_GATE, SHAREPOINT_LIVE_READS, SHAREPOINT_LIVE_WRITE, requiredDocumentation, requiredGrants,
} from '../../tools/qualification/sharepointAcceptance.mjs';
import {
  TOGGLE_FIELD, captureSharePointAcceptance, ledgerEvidenceFromAcceptance, main as liveMain, writeAcceptanceFiles,
} from '../../tools/qualification/sharepointLive.mjs';
import { tenantRefFor } from '../store/tenantRef.mjs';

const repo = fileURLToPath(new URL('../..', import.meta.url));
const KEY = 'test-only';
const tenantRef = tenantRefFor('sharepoint-live-fixture');
const build = 'fixture-build';
const host = 'contoso.sharepoint.com';
const FIXTURE_ID = `${host},11111111-1111-1111-1111-111111111111,22222222-2222-2222-2222-222222222222`;
const OTHER_ID = `${host},33333333-3333-3333-3333-333333333333,44444444-4444-4444-4444-444444444444`;
const fixtureSiteUrl = `https://${host}/sites/KEEL-RT-20261003`;
const observed = new Date('2026-10-03T08:00:00Z');
const verifyNow = new Date('2026-10-03T09:00:00Z');

const dir = mkdtempSync(join(tmpdir(), 'keel-sp-live-'));
after(() => rmSync(dir, { recursive: true, force: true }));

/** An in-memory Graph: tenant settings, two sites (one KEEL-RT), site grants. */
function fakeGraph({ resharing = true, ignoreWrites = false, failRevert = false } = {}) {
  const settings = {
    '@odata.context': 'https://graph.microsoft.com/v1.0/$metadata#admin/sharepoint/settings/$entity',
    sharingCapability: 'externalUserSharingOnly', sharingDomainRestrictionMode: 'none',
    sharingAllowedDomainList: [], sharingBlockedDomainList: [], isResharingByExternalUsersEnabled: resharing,
  };
  const sites = {
    [FIXTURE_ID]: { id: FIXTURE_ID, webUrl: fixtureSiteUrl, displayName: 'KEEL rehearsal', name: 'KEEL-RT-20261003' },
    [OTHER_ID]: { id: OTHER_ID, webUrl: `https://${host}/sites/HR`, displayName: 'HR', name: 'HR' },
  };
  const calls = [];
  let throttled = false;
  let patches = 0;
  const transport = async (url, init) => {
    const { pathname, search } = new URL(url);
    const method = init?.method ?? 'GET';
    calls.push(`${method} ${pathname}${search}`);
    const path = decodeURIComponent(pathname);
    if (path === '/v1.0/admin/sharepoint/settings') {
      if (method === 'GET') return { status: 200, headers: {}, body: structuredClone(settings) };
      if (method === 'PATCH') {
        patches += 1;
        if (failRevert && patches === 2) return { status: 500, headers: {}, body: null };
        if (!ignoreWrites) Object.assign(settings, init.body);
        return { status: 204, headers: {}, body: null };
      }
    }
    if (path === '/v1.0/sites/getAllSites' && method === 'GET') {
      if (!throttled) { throttled = true; return { status: 429, headers: { 'retry-after': '1' }, body: null }; }
      return search
        ? { status: 200, headers: {}, body: { value: [sites[OTHER_ID]] } }
        : { status: 200, headers: {}, body: { value: [sites[FIXTURE_ID]], '@odata.nextLink': `${url}?$skiptoken=p2` } };
    }
    const site = /^\/v1\.0\/sites\/([^/]+)(\/permissions)?$/.exec(path);
    if (site && sites[site[1]] && method === 'GET') {
      return { status: 200, headers: {}, body: site[2] ? { value: [{ id: 'grant-1', roles: ['read'] }] } : sites[site[1]] };
    }
    return { status: 404, headers: {}, body: null };
  };
  return { transport, calls, settings };
}

const documentation = () => requiredDocumentation().map((url) => ({ url, retrievedAt: '2026-10-02T12:00:00Z' }));

async function capture(graph = fakeGraph(), overrides = {}) {
  return captureSharePointAcceptance({
    collector: graph.transport, restorer: graph.transport, tenantHost: host, fixtureSiteUrl, tenantRef, build,
    credentials: { collector: 'app:keel-collector', restorer: 'app:keel-restorer' },
    grants: requiredGrants(), documentation: documentation(), now: () => observed, sleep: async () => {},
    readBackDelayMs: 0, ...overrides,
  });
}

let counter = 0;
async function capturedFiles(graph, overrides) {
  const result = await capture(graph, overrides);
  const outPath = join(dir, `record-${counter += 1}.json`);
  const { evidence, logPath } = writeAcceptanceFiles({ ...result, outPath, hmacKey: KEY });
  return { ...result, evidence, outPath, logPath };
}

const options = (extra = {}) => ({ gate: SHAREPOINT_LIVE_GATE, tenantRef, build, now: verifyNow, hmacKey: KEY, requireLive: true, ...extra });
const verifyIn = (evidence, extra) => verifyEvidence(evidence, { ...options(extra), evidenceDir: dir });
/** Applies a change and re-signs it with the trusted test key, as a dishonest capture would. */
const resign = (evidence, change) => signEvidence(change(structuredClone(evidence)), KEY);

test('a valid independently captured record verifies, and the capture touched only the KEEL-RT site', async () => {
  const graph = fakeGraph();
  const { evidence, outPath, record } = await capturedFiles(graph);
  const result = verifyEvidenceFile(outPath, options());
  assert.deepEqual(result, { ok: true, failures: [] });

  assert.deepEqual(record.subject.reads.map((read) => [read.operationId, read.ok]), SHAREPOINT_LIVE_READS.map((id) => [id, true]));
  assert.equal(record.subject.throttle.retryAfterResponses, 1, 'the throttled discovery page was retried and recorded');
  assert.equal(evidence.proof.runner.identity, 'keel-release-runner');
  // The fixture site was read by id; the other discovered site never was.
  assert.ok(graph.calls.some((call) => call.includes(encodeURIComponent(FIXTURE_ID))));
  assert.ok(!graph.calls.some((call) => call.includes(encodeURIComponent(OTHER_ID))));
  assert.ok(!graph.calls.some((call) => /drive|items|lists|messages/.test(call)), 'zero content calls');
  // Changed, read back, put back: the tenant ends where it started.
  assert.deepEqual(graph.calls.filter((call) => call.startsWith('PATCH')).length, 2);
  assert.equal(graph.settings[TOGGLE_FIELD], true);
  assert.equal(record.subject.write.readBackVerified, true);
  assert.equal(record.subject.write.restoredToOriginal, true);
  assert.equal(record.subject.write.preFingerprint, record.subject.write.finalFingerprint);
  // Credential references only.
  assert.doesNotMatch(readFileSync(outPath, 'utf8'), /bearer\s|authorization|access_?token/i);
});

test('an altered signature or capture-log digest fails', async () => {
  const { evidence, logPath } = await capturedFiles();
  const forged = structuredClone(evidence);
  forged.proof.runner.signature = forged.proof.runner.signature.replace(/^./, (c) => (c === '0' ? '1' : '0'));
  assert.match(verifyIn(forged).failures.join('\n'), /signature mismatch/);

  const edited = structuredClone(evidence);
  edited.subject.write.restoredToOriginal = true;
  edited.subject.reads[0].ok = true;
  edited.build = 'other-build';
  assert.equal(verifyIn(edited, { build: 'other-build' }).ok, false, 'any edit after signing breaks the signature');

  // The raw log is changed after the fact.
  writeFileSync(logPath, readFileSync(logPath, 'utf8').replace('"PATCH"', '"GET"'));
  assert.match(verifyIn(evidence).failures.join('\n'), /artifact digest mismatch/);

  // A swapped log with a matching proof digest is still not the one the signature covers.
  const swapped = structuredClone(evidence);
  writeFileSync(join(dir, 'swapped.capture.json'), '{}\n');
  swapped.proof.artifact = { path: 'swapped.capture.json', sha256: 'ca3d163bab055381827226140568f3bef7eaac187cebd76878e0b63e9e442356' };
  const swappedFailures = verifyIn(swapped).failures.join('\n');
  assert.doesNotMatch(swappedFailures, /artifact digest mismatch/, 'the swapped log matches its own digest');
  assert.match(swappedFailures, /capture log digest is not bound/);
});

test('wrong tenant, build or operation fails, even when re-signed by the trusted runner', async () => {
  const { evidence } = await capturedFiles();
  assert.match(verifyIn(evidence, { tenantRef: tenantRefFor('another-tenant') }).failures.join('\n'), /cross-tenant/);
  assert.match(verifyIn(evidence, { build: 'another-build' }).failures.join('\n'), /build mismatch/);
  assert.match(verifyIn(evidence, { tenantRef: null }).failures.join('\n'), /expected tenant\/build/);
  for (const [change, pattern] of [
    [(e) => { e.operation = SHAREPOINT_LIVE_WRITE; return e; }, /operation mismatch/],
    [(e) => { e.operation = 'teams.configuration-qualification'; return e; }, /operation mismatch/],
    [(e) => { e.credentialMode = 'restorer'; return e; }, /credential mode/],
    [(e) => { e.gate = 'teams-live-acceptance'; return e; }, /gate mismatch/],
    [(e) => { e.subject.write.operationId = 'teams.settings.update'; return e; }, /no live capture of sharepoint.tenant-settings.update/],
    [(e) => { e.subject.reads[0].version = 'beta'; return e; }, /captured at beta/],
    [(e) => { e.subject.credentials.restorer = e.subject.credentials.collector; return e; }, /separate credentials/],
    [(e) => { e.subject.fixtureSite = { id: OTHER_ID, webUrl: `https://${host}/sites/HR` }; return e; }, /disposable KEEL-RT/],
    [(e) => { e.subject.fixtureSite.webUrl = 'https://fabrikam.sharepoint.com/sites/KEEL-RT-20261003'; return e; }, /not a well-formed site on the tenant host/],
  ]) {
    assert.match(verifyIn(resign(evidence, change)).failures.join('\n'), pattern);
  }
});

test('stale evidence fails: an old record, or old captures inside a fresh record', async () => {
  const { evidence } = await capturedFiles();
  assert.match(verifyIn(evidence, { now: new Date('2026-11-10T00:00:00Z') }).failures.join('\n'), /stale/);
  const staleRead = resign(evidence, (e) => { e.subject.reads[2].capturedAt = '2026-09-30T08:00:00Z'; return e; });
  assert.match(verifyIn(staleRead).failures.join('\n'), /sharepoint.site-properties: .*stale capture/);
  const staleWrite = resign(evidence, (e) => { e.subject.write.capturedAt = '2026-09-01T08:00:00Z'; return e; });
  assert.match(verifyIn(staleWrite).failures.join('\n'), /write: .*stale capture/);
  const undatedDocs = resign(evidence, (e) => { e.subject.documentation[0].retrievedAt = null; return e; });
  assert.match(verifyIn(undatedDocs).failures.join('\n'), /documentation not retrieved/);
});

test('a missing prerequisite fails', async () => {
  const { evidence } = await capturedFiles();
  for (const [change, pattern] of [
    [(e) => { e.subject.prerequisites = ['task-101', 'task-103']; return e; }, /missing prerequisite: task-102/],
    [(e) => { e.subject.reads = e.subject.reads.filter((r) => r.operationId !== 'sharepoint.site-permissions'); return e; }, /no live capture of sharepoint.site-permissions/],
    [(e) => { e.subject.reads[0].ok = false; return e; }, /sharepoint.tenant-settings: the read failed/],
    [(e) => { e.subject.grants.collector.permissions = e.subject.grants.collector.permissions.filter((p) => p !== 'Sites.FullControl.All'); return e; }, /collector lacks Sites.FullControl.All/],
    [(e) => { e.subject.grants.restorer.roles = []; return e; }, /restorer lacks role SharePoint Administrator/],
    [(e) => { e.subject.grants.collector.permissions.push('SharePointTenantSettings.ReadWrite.All'); return e; }, /collector holds the write permission/],
    [(e) => { e.subject.supportedFields = e.subject.supportedFields.filter((f) => f !== 'sharingBlockedDomainList'); return e; }, /not observed live: sharingBlockedDomainList/],
    [(e) => { delete e.subject.write; return e; }, /no live capture of sharepoint.tenant-settings.update/],
  ]) {
    assert.match(verifyIn(resign(evidence, change)).failures.join('\n'), pattern);
  }
});

test('missing external evidence fails: the checked-in pending record, an absent file, the release CLI', async () => {
  const pending = join(repo, 'docs/release/qualifications/sharepoint-live-acceptance.json');
  const record = JSON.parse(readFileSync(pending, 'utf8'));
  assert.equal(record.status, 'pending');
  assert.match(verifyEvidenceFile(pending, options()).failures.join('\n'), /pending/);
  assert.equal(verifyEvidenceFile(pending, options({ requireLive: false })).ok, false);
  assert.equal(verifyEvidenceFile(join(dir, 'absent.json'), options()).ok, false);
  // A record without its capture log, or without a runner signature, is not evidence.
  const { evidence, logPath } = await capturedFiles();
  rmSync(logPath);
  assert.match(verifyIn(evidence).failures.join('\n'), /capture artifact required/);
  const { proof, ...unsigned } = evidence;
  assert.match(verifyIn({ ...unsigned, proof: { artifact: proof.artifact } }).failures.join('\n'), /runner proof required/);
  // The exact release command exits nonzero on the checked-in record.
  assert.throws(() => execFileSync(process.execPath, [
    'tools/release/qualification.mjs', 'verify', '--require-live', '--gate', SHAREPOINT_LIVE_GATE,
    '--evidence', 'docs/release/qualifications/sharepoint-live-acceptance.json',
  ], { cwd: repo, stdio: 'pipe' }), (error) => error.status === 1 && /pending/.test(String(error.stdout)));
});

test('fixture evidence is never elevated to live-qualified, and only a verified record reaches the ledgers', async () => {
  const { evidence } = await capturedFiles();
  const fixtureRunner = signEvidence(structuredClone(evidence), KEY, 'keel-fixture-runner');
  assert.match(verifyIn(fixtureRunner).failures.join('\n'), /synthetic runner/);
  assert.match(verifyIn(fixtureRunner, { requireLive: false }).failures.join('\n'), /cannot claim live qualification/);
  const synthetic = resign(evidence, (e) => { e.synthetic = true; return e; });
  assert.equal(verifyIn(synthetic, { requireLive: false }).ok, false, 'a synthetic record claiming live fails without --require-live');
  const fixtureLevel = resign(evidence, (e) => { e.evidenceLevel = 'fixture-tested'; return e; });
  assert.match(verifyIn(fixtureLevel).failures.join('\n'), /needs evidenceLevel 'live-qualified'/);
  const syntheticRead = resign(evidence, (e) => { e.subject.reads[1].synthetic = true; return e; });
  assert.match(verifyIn(syntheticRead).failures.join('\n'), /site-discovery: synthetic/);
  const sameValue = resign(evidence, (e) => { e.subject.write.writeMode = 'same-value'; return e; });
  assert.match(verifyIn(sameValue).failures.join('\n'), /same-value write/);

  // The import seam: nothing from a fixture record, everything from a verified one.
  const seam = { tenantRef, build, now: verifyNow, hmacKey: KEY, evidenceDir: dir };
  for (const bad of [fixtureRunner, synthetic, fixtureLevel]) {
    const imported = ledgerEvidenceFromAcceptance(bad, seam);
    assert.equal(imported.ok, false);
    assert.deepEqual([imported.reads, imported.writes], [[], []]);
  }
  const unqualifiedLedger = buildWorkloadLedger({ evidence: [], tenantRef, now: verifyNow });
  assert.equal(workloadWriteQualification(SHAREPOINT_LIVE_WRITE, { readLedger: unqualifiedLedger, tenantRef, now: verifyNow }).enabled, false);

  const imported = ledgerEvidenceFromAcceptance(evidence, seam);
  assert.equal(imported.ok, true, imported.failures.join('; '));
  const ledger = buildWorkloadLedger({ evidence: imported.reads, grants: imported.grants, tenantRef, now: verifyNow });
  for (const id of SHAREPOINT_LIVE_READS) assert.equal(ledger.rows.find((row) => row.id === id).state, 'live-qualified', id);
  const writeState = workloadWriteQualification(SHAREPOINT_LIVE_WRITE, { readLedger: ledger, evidence: imported.writes, tenantRef, now: verifyNow });
  assert.equal(writeState.state, 'live-qualified');
  // The same record never qualifies another tenant.
  assert.equal(ledgerEvidenceFromAcceptance(evidence, { ...seam, tenantRef: tenantRefFor('another-tenant') }).ok, false);
});

test('a content call, another site, a write by the collector or credential material in the record fails', async () => {
  const { evidence } = await capturedFiles();
  const site = encodeURIComponent(FIXTURE_ID);
  for (const [request, pattern] of [
    [{ credential: 'collector', method: 'GET', version: 'v1.0', path: `/sites/${site}/drive/root/children`, status: 200 }, /content call/],
    [{ credential: 'collector', method: 'GET', version: 'v1.0', path: `/sites/${site}/lists`, status: 200 }, /content call/],
    [{ credential: 'collector', method: 'GET', version: 'v1.0', path: `/sites/${encodeURIComponent(OTHER_ID)}`, status: 200 }, /other than the KEEL-RT fixture/],
    [{ credential: 'collector', method: 'PATCH', version: 'v1.0', path: '/admin/sharepoint/settings', status: 204 }, /not an allowed write/],
    [{ credential: 'restorer', method: 'PATCH', version: 'v1.0', path: `/sites/${site}`, status: 204 }, /not an allowed write/],
    [{ credential: 'restorer', method: 'GET', version: 'v1.0', path: `/sites/${site}/permissions`, status: 200 }, /restorer reads only/],
    [{ credential: 'restorer', method: 'PATCH', version: 'v1.0', path: '/admin/sharepoint/settings', status: 204 }, /exactly 2 settings writes/],
  ]) {
    assert.match(verifyIn(resign(evidence, (e) => { e.subject.requests.push(request); return e; })).failures.join('\n'), pattern);
  }
  const leaked = resign(evidence, (e) => { e.subject.credentials.accessToken = 'x'; return e; });
  assert.match(verifyIn(leaked).failures.join('\n'), /credential material/);
  const jwt = resign(evidence, (e) => { e.subject.credentials.collector = 'eyJhbGciOi.eyJzdWIiOi.sig'; return e; });
  assert.match(verifyIn(jwt).failures.join('\n'), /credential material/);
});

test('the capture tool is offline by default, refuses non-fixture sites and widening, and reports a failed put-back', async () => {
  let sent = 0;
  const counting = async () => { sent += 1; return { status: 500, headers: {}, body: null }; };
  const lines = [];
  const env = { KEEL_SP_COLLECTOR_TOKEN: 'c', KEEL_SP_RESTORER_TOKEN: 'r' };
  const base = ['--tenant-host', host, '--fixture-site-url', fixtureSiteUrl];
  assert.equal(await liveMain(['plan', ...base], { out: (line) => lines.push(line), env, transportFor: () => counting }), 0);
  assert.equal(await liveMain(['capture', ...base, '--tenant-ref', tenantRef], { out: (line) => lines.push(line), env, transportFor: () => counting }), 2);
  assert.match(lines.at(-1), /--confirm-live-tenant-write/);
  await assert.rejects(liveMain(['plan', '--tenant-host', host, '--fixture-site-url', `https://${host}/sites/HR`], { out: () => {} }), /KEEL-RT/);
  await assert.rejects(capture(fakeGraph(), { fixtureSiteUrl: `https://${host}/sites/HR`, collector: counting, restorer: counting }), /KEEL-RT/);
  await assert.rejects(capture(fakeGraph(), { fixtureSiteUrl: `https://fabrikam.sharepoint.com/sites/KEEL-RT-1`, collector: counting, restorer: counting }), /tenant host/);
  await assert.rejects(liveMain(['capture', '--confirm-live-tenant-write', ...base, '--tenant-ref', tenantRef], { out: () => {}, env: {}, transportFor: () => counting }), /needs --collector-ref/);
  assert.equal(sent, 0, 'nothing was sent');

  // Starting from `false` the first write would widen sharing: refused unless allowed.
  const closed = fakeGraph({ resharing: false });
  const refused = await capture(closed);
  assert.equal(closed.calls.filter((call) => call.startsWith('PATCH')).length, 0);
  assert.match(refused.record.subject.write.error, /--allow-widening-toggle/);
  assert.equal(refused.needsManualRevert, false);

  // A platform that ignores the write is not qualified.
  const ignoring = await capturedFiles(fakeGraph({ ignoreWrites: true }));
  assert.match(verifyEvidenceFile(ignoring.outPath, options()).failures.join('\n'), /not read back as written/);

  // A failed put-back is loud and never verifies.
  const stuck = fakeGraph({ failRevert: true });
  const failed = await capture(stuck);
  assert.equal(failed.needsManualRevert, true);
  assert.match(failed.record.subject.write.error, /PUTTING THE SETTING BACK FAILED/);
  assert.equal(stuck.settings[TOGGLE_FIELD], false);
});
