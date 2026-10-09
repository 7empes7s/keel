/**
 * Roadmap task-115 boundary tests: native recovery credential qualification
 * (gate native-live-acceptance).
 *
 * Exercises the production verifier (tools/release/qualification.mjs →
 * engine/restore/nativeRecoveryEvidence.mjs) and the production capture tool
 * (tools/qualification/nativeRecovery.mjs). A "runner" capture here drives the
 * capture tool's --live path against an injected Microsoft-shaped fake, in a
 * temp directory, so the verifier sees a record exactly as the release runner
 * would write it. Nothing here touches a tenant, and nothing here writes the
 * repository's evidence file: that stays pending until real runner evidence.
 */
import { strict as assert } from 'node:assert';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { signEvidence, verifyEvidence, verifyEvidenceFile } from '../../tools/release/qualification.mjs';
import { assertCommittedLiveRecord, isPendingPlaceholder } from '../test/committedEvidence.mjs';
import { OFFLINE_FIXTURE, main as capture } from '../../tools/qualification/nativeRecovery.mjs';
import { NATIVE_LIVE_GATE, NATIVE_LIVE_MAX_ELAPSED_MS } from '../restore/nativeRecoveryEvidence.mjs';
import { tenantRefFor } from '../store/tenantRef.mjs';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const KEY = 'test-only-native-key';
const BUILD = 'fixture-build-115';
const TENANT_ID = 'native-runner-tenant';
const tenantRef = tenantRefFor(TENANT_ID);
const OBJECT_ID = '11111111-2222-4333-8444-555555555555';
const FIXTURE_UPN = 'keel-rehearsal-native@example.test';
const dirs = [];
after(() => { for (const dir of dirs) rmSync(dir, { recursive: true, force: true }); });

function clock(start = '2026-10-01T10:00:00.000Z') {
  let t = Date.parse(start);
  return () => { t += 1000; return new Date(t); };
}

/** A Microsoft-shaped directory: GET/DELETE /users/{id}, deleted items and restore. */
function microsoftFake({ name = FIXTURE_UPN, now, restoreStatus = 200, restoredId = OBJECT_ID, readBackMisses = 0 } = {}) {
  const writes = [];
  const reads = [];
  let misses = readBackMisses;
  let state = 'live';
  let deletedDateTime = null;
  let restored = false;
  const body = () => ({ id: OBJECT_ID, userPrincipalName: name, displayName: 'native fixture', accountEnabled: false });
  return {
    writes,
    reads,
    async read(_v, path) {
      reads.push(path);
      // Replication lag: the restored object 404s for the first few read-backs.
      if (path === `/users/${OBJECT_ID}` && restored && misses > 0) { misses -= 1; return { ok: false, status: 404, body: null }; }
      if (path === `/users/${OBJECT_ID}`) return state === 'live' ? { ok: true, status: 200, body: { ...body(), id: restored ? restoredId : OBJECT_ID } } : { ok: false, status: 404, body: null };
      if (path === `/directory/deletedItems/${OBJECT_ID}`) return state === 'deleted' ? { ok: true, status: 200, body: { ...body(), deletedDateTime } } : { ok: false, status: 404, body: null };
      return { ok: false, status: 404, body: null };
    },
    async write(_v, path, { method }) {
      writes.push(`${method} ${path}`);
      if (method === 'DELETE' && path === `/users/${OBJECT_ID}` && state === 'live') {
        state = 'deleted'; deletedDateTime = now().toISOString();
        return { ok: true, status: 204, body: null };
      }
      if (method === 'POST' && path === `/directory/deletedItems/${OBJECT_ID}/restore` && state === 'deleted') {
        if (restoreStatus !== 200) return { ok: false, status: restoreStatus, body: { error: { code: 'Authorization_RequestDenied' } } };
        state = 'live'; restored = true;
        return { ok: true, status: 200, body: body() };
      }
      return { ok: false, status: 400, body: null };
    },
  };
}

const liveArgv = (out) => ['capture', '--live', '--resource-type', 'user', '--object-id', OBJECT_ID,
  '--confirm-disposable-fixture', OBJECT_ID, '--target-config', '/etc/keel/restorer.json',
  '--docs-retrieved-at', '2026-09-30', '--permission', 'User.ReadWrite.All', '--out', out];

const quiet = { log() {}, error() {} };

async function runnerCapture({ graphOptions = {}, argv = null, env = { KEEL_QUALIFICATION_HMAC_KEY: KEY }, sleep = async () => {} } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'keel-native-115-'));
  dirs.push(dir);
  const now = clock();
  const graph = microsoftFake({ now, ...graphOptions });
  const errors = [];
  const code = await capture({
    argv: argv ?? liveArgv(dir), env, out: { log() {}, error: (m) => errors.push(m) },
    deps: { now, build: BUILD, graph, readFile: () => JSON.stringify({ tenantId: TENANT_ID }), sleep },
  });
  const file = join(dir, `${NATIVE_LIVE_GATE}.json`);
  let evidence = null;
  try { evidence = JSON.parse(readFileSync(file, 'utf8')); } catch { /* refused before writing */ }
  return { dir, file, code, graph, errors, evidence };
}

const verifyOpts = { gate: NATIVE_LIVE_GATE, tenantRef, build: BUILD, requireLive: true, now: new Date('2026-10-01T12:00:00Z'), hmacKey: KEY };

/** Write a modified record next to the real artifact, re-signed as the release runner unless told otherwise. */
function resave(run, patch, { identity = 'keel-release-runner', sign = true } = {}) {
  const { proof, ...rest } = run.evidence;
  const next = typeof patch === 'function' ? patch(structuredClone({ ...rest, proof: { artifact: proof.artifact } })) : { ...rest, proof: { artifact: proof.artifact }, ...patch };
  const record = sign ? signEvidence(next, KEY, identity) : next;
  const file = join(run.dir, 'variant.json');
  writeFileSync(file, JSON.stringify(record));
  return file;
}

function failsWith(file, pattern, opts = verifyOpts) {
  const result = verifyEvidenceFile(file, opts);
  assert.equal(result.ok, false, `expected failure matching ${pattern}`);
  assert.ok(result.failures.some((f) => pattern.test(f)), `no failure matched ${pattern}: ${result.failures.join(' | ')}`);
}

test('a valid independently captured runner record verifies under --require-live', async () => {
  const run = await runnerCapture();
  assert.equal(run.code, 0, run.errors.join(' '));
  assert.deepEqual(run.graph.writes, [`DELETE /users/${OBJECT_ID}`, `POST /directory/deletedItems/${OBJECT_ID}/restore`]);
  const result = verifyEvidenceFile(run.file, verifyOpts);
  assert.deepEqual(result.failures, []);
  const op = run.evidence.subject.operations.find((o) => o.outcome === 'automated');
  assert.equal(op.restoredObjectId, OBJECT_ID, 'object id result preserved');
  assert.equal(Date.parse(op.retentionDeadline) - Date.parse(op.deletedDateTime), 30 * 24 * 60 * 60 * 1000, 'retention deadline preserved');
  // Unavailable routes are manual handoffs, never automated support. Roadmap
  // task-152: Conditional Access policies are restored by KEEL (fixture-tested
  // only), so they are no longer a native-route handoff.
  const manual = run.evidence.subject.operations.filter((o) => o.outcome === 'manual-handoff').map((o) => o.resourceType).sort();
  assert.deepEqual(manual, ['namedLocation']);
  assert.doesNotMatch(readFileSync(run.file, 'utf8'), /BEGIN|accessToken|eyJ/);
});

test('an altered signature or capture digest fails', async () => {
  const run = await runnerCapture();
  const tampered = structuredClone(run.evidence);
  tampered.proof.runner.signature = tampered.proof.runner.signature.replace(/^./, (c) => (c === '0' ? '1' : '0'));
  const sigFile = join(run.dir, 'sig.json');
  writeFileSync(sigFile, JSON.stringify(tampered));
  failsWith(sigFile, /runner signature mismatch/);

  const signedEdit = structuredClone(run.evidence);
  signedEdit.subject.operations[0].restoredObjectId = 'other';
  const editFile = join(run.dir, 'edit.json');
  writeFileSync(editFile, JSON.stringify(signedEdit));
  failsWith(editFile, /runner signature mismatch/);

  // Altering the captured bytes breaks the digest; the signed record is untouched.
  const artifactPath = join(run.dir, `${NATIVE_LIVE_GATE}.artifact.json`);
  const original = readFileSync(artifactPath, 'utf8');
  writeFileSync(artifactPath, original.replace('"status": 204', '"status": 202'));
  failsWith(run.file, /artifact digest mismatch/);
  writeFileSync(artifactPath, original);

  // A different artifact with a matching (unsigned) digest still does not match the signed capture digest.
  const forged = original.replace(FIXTURE_UPN, 'keel-rehearsal-other@example.test');
  writeFileSync(join(run.dir, 'forged.artifact.json'), forged);
  const { createHash } = await import('node:crypto');
  const swap = structuredClone(run.evidence);
  swap.proof.artifact = { path: 'forged.artifact.json', sha256: createHash('sha256').update(forged).digest('hex') };
  const swapFile = join(run.dir, 'swap.json');
  writeFileSync(swapFile, JSON.stringify(swap));
  failsWith(swapFile, /signed capture digest does not name the proof artifact/);
});

test('mutation check: missing external evidence fails (no artifact, no runner, pending placeholder)', async () => {
  const run = await runnerCapture();
  failsWith(resave(run, (r) => { delete r.proof.artifact; return r; }), /raw capture (required|artifact is missing)/);
  failsWith(resave(run, {}, { sign: false }), /native recovery runner proof required/);
  rmSync(join(run.dir, `${NATIVE_LIVE_GATE}.artifact.json`));
  failsWith(run.file, /artifact unreadable/);
  failsWith(join(run.dir, 'absent.json'), /evidence unreadable/);

  // The repository's evidence file is a pending placeholder until the runner supplies evidence.
  const placeholder = join(ROOT, 'docs/release/qualifications/native-live-acceptance.json');
  if (!isPendingPlaceholder(placeholder)) {
    // A live capture has replaced the placeholder: it must still never verify without the key.
    assertCommittedLiveRecord(placeholder, { gate: NATIVE_LIVE_GATE, root: ROOT, verify: verifyEvidenceFile, verifyOptions: verifyOpts });
    return;
  }
  assert.equal(JSON.parse(readFileSync(placeholder, 'utf8')).status, 'pending');
  failsWith(placeholder, /external runner evidence pending/);
  failsWith(placeholder, /external runner evidence pending/, { ...verifyOpts, requireLive: false });
  const cli = spawnSync('node', ['tools/release/qualification.mjs', 'verify', '--require-live', '--gate', NATIVE_LIVE_GATE,
    '--evidence', 'docs/release/qualifications/native-live-acceptance.json', '--build', BUILD], { cwd: ROOT, encoding: 'utf8' });
  assert.equal(cli.status, 1);
  assert.match(cli.stdout, /external runner evidence pending/);
});

test('mutation check: a mismatched tenant, build or operation fails', async () => {
  const run = await runnerCapture();
  failsWith(run.file, /tenant mismatch|cross-tenant/, { ...verifyOpts, tenantRef: tenantRefFor('other-tenant') });
  failsWith(run.file, /requires the expected tenant and build identity/, { ...verifyOpts, tenantRef: null });
  failsWith(run.file, /build mismatch/, { ...verifyOpts, build: 'other-build' });
  // A record re-signed for another tenant or build no longer matches its raw capture.
  failsWith(resave(run, { tenantRef: tenantRefFor('other-tenant') }), /raw capture tenant differs/, { ...verifyOpts, tenantRef: tenantRefFor('other-tenant') });
  failsWith(resave(run, { build: 'other-build' }), /raw capture build differs/, { ...verifyOpts, build: 'other-build' });
  failsWith(resave(run, { operation: 'native-recovery.other' }), /operation mismatch/);
  failsWith(resave(run, (r) => { r.subject.operations[0].operation = 'create'; return r; }), /operation mismatch/);
  failsWith(resave(run, (r) => { r.subject.operations[0].resourceType = 'group'; return r; }), /no raw captured exchanges|Group.ReadWrite.All/);
  failsWith(resave(run, { credentialMode: 'collector' }), /restorer credential mode/);
  failsWith(resave(run, { gate: 'nist-benchmark-acceptance' }), /gate mismatch/);
});

test('stale evidence, stale documentation and a missing prerequisite fail', async () => {
  const run = await runnerCapture();
  failsWith(run.file, /stale/, { ...verifyOpts, now: new Date('2026-12-15T00:00:00Z') });
  failsWith(resave(run, (r) => { r.subject.operations[0].docs.retrievedAt = '2026-01-01'; return r; }), /documentation was not checked/);
  failsWith(resave(run, (r) => { r.subject.operations[0].docs.url = 'https://example.com/restore'; return r; }), /learn\.microsoft\.com/);
  failsWith(resave(run, (r) => { delete r.subject.prerequisite; return r; }), /task-64 prerequisite missing/);
  failsWith(resave(run, (r) => { r.subject.prerequisite.retentionDays = 93; return r; }), /retention days differ/);
  failsWith(resave(run, (r) => { r.subject.prerequisite.nativeRoutes.namedLocation = 'other'; return r; }), /native route for namedLocation/);
});

test('mutation check: fixture evidence is never elevated to live-qualified', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'keel-native-115-offline-'));
  dirs.push(dir);
  const now = clock();
  const code = await capture({ argv: ['capture', '--out', dir], env: { KEEL_QUALIFICATION_HMAC_KEY: KEY }, out: quiet, deps: { now, build: BUILD } });
  assert.equal(code, 0);
  const file = join(dir, `${NATIVE_LIVE_GATE}.json`);
  const offline = JSON.parse(readFileSync(file, 'utf8'));
  assert.equal(offline.evidenceLevel, 'fixture-tested');
  assert.equal(offline.synthetic, true);
  assert.equal(offline.proof.runner.identity, 'keel-fixture-runner');
  const offlineOpts = { ...verifyOpts, tenantRef: tenantRefFor(OFFLINE_FIXTURE.tenantId) };
  // Code behaviour is proven offline; a live claim is not.
  assert.deepEqual(verifyEvidenceFile(file, { ...offlineOpts, requireLive: false }).failures, []);
  failsWith(file, /--require-live rejects synthetic fixtures/, offlineOpts);
  const run = { dir, evidence: offline };
  for (const [patch, identity] of [[{ evidenceLevel: 'live-qualified' }, 'keel-fixture-runner'],
    [{ evidenceLevel: 'live-qualified', synthetic: false }, 'keel-fixture-runner'],
    [{ evidenceLevel: 'live-qualified' }, 'keel-release-runner']]) {
    failsWith(resave(run, patch, { identity }), /fixture evidence cannot claim live qualification/, { ...offlineOpts, requireLive: false });
  }
  // Even an offline run with a release key never signs as the release runner.
  assert.notEqual(offline.proof.runner.identity, 'keel-release-runner');
});

test('the record must show a preserved id, a deadline-bounded restore, a disposable fixture and bounds', async () => {
  const run = await runnerCapture();
  const op = (fn) => resave(run, (r) => { fn(r.subject.operations[0], r); return r; });
  failsWith(op((o) => { o.restoredObjectId = 'new-id'; o.idPreserved = false; }), /object id was not preserved/);
  failsWith(op((o) => { o.retentionDeadline = '2027-01-01T00:00:00.000Z'; }), /retention deadline does not equal/);
  failsWith(op((o) => { delete o.deletedDateTime; }), /retention deadline unprovable/);
  failsWith(op((o) => { o.deletedDateTime = '2026-08-01T00:00:00.000Z'; o.retentionDeadline = '2026-08-31T00:00:00.000Z'; }), /after the retention deadline/);
  failsWith(op((o) => { o.fixture.name = 'alice@contoso.com'; }), /not a disposable/);
  failsWith(op((o) => { o.outcome = 'failed'; }), /not a qualified recovery/);
  failsWith(resave(run, (r) => { r.subject.operations = r.subject.operations.filter((o) => o.outcome !== 'automated'); return r; }), /nothing is qualified/);
  failsWith(resave(run, (r) => { r.subject.operations.find((o) => o.resourceType === 'namedLocation').outcome = 'automated'; return r; }),
    /Conditional Access recovery stays manual/);
  // Roadmap task-152: a Conditional Access policy restore is fixture-tested only;
  // this live gate never accepts an automated claim for it.
  failsWith(resave(run, (r) => {
    r.subject.operations.push({ ...structuredClone(r.subject.operations[0]), resourceType: 'conditionalAccessPolicy', route: 'conditional-access-deleted-items' });
    return r;
  }), /Conditional Access policy restore is fixture-tested only/);
  failsWith(resave(run, (r) => { r.subject.bounds.elapsedMs = NATIVE_LIVE_MAX_ELAPSED_MS + 1; return r; }), /elapsed time/);
  failsWith(resave(run, (r) => { r.subject.bounds.maxObjects = 50; return r; }), /at most 3 objects/);
  failsWith(resave(run, (r) => { r.subject.credential.privateKey = '-----BEGIN PRIVATE KEY-----'; return r; }), /credential material refused/);
  failsWith(resave(run, (r) => { r.subject.credential.auth = 'secret'; return r; }), /certificate authentication/);
});

test('the capture tool refuses before any write unless the object is a confirmed disposable fixture', async () => {
  const notFixture = await runnerCapture({ graphOptions: { name: 'alice@contoso.com' } });
  assert.equal(notFixture.code, 1);
  assert.deepEqual(notFixture.graph.writes, []);
  assert.match(notFixture.errors.join(' '), /not a disposable/);
  assert.equal(notFixture.evidence, null);

  const dir = mkdtempSync(join(tmpdir(), 'keel-native-115-refuse-'));
  dirs.push(dir);
  const unconfirmed = liveArgv(dir).filter((v, i, a) => v !== '--confirm-disposable-fixture' && a[i - 1] !== '--confirm-disposable-fixture');
  const r1 = await runnerCapture({ argv: unconfirmed });
  assert.equal(r1.code, 2);
  assert.deepEqual(r1.graph.writes, []);
  const ca = liveArgv(dir).map((v) => (v === 'user' ? 'conditionalAccessPolicy' : v));
  const r2 = await runnerCapture({ argv: ca });
  assert.equal(r2.code, 2);
  assert.deepEqual(r2.graph.writes, []);
});

test('a failed restore is recorded as failed and never verifies', async () => {
  const run = await runnerCapture({ graphOptions: { restoreStatus: 403 } });
  assert.equal(run.code, 1);
  assert.equal(run.evidence.subject.operations[0].outcome, 'failed');
  failsWith(run.file, /not a qualified recovery/);
  failsWith(run.file, /nothing is qualified/);
});

test('a restore that returns a different object id is not a preserved-id recovery', async () => {
  const run = await runnerCapture({ graphOptions: { restoredId: 'aaaaaaaa-0000-4000-8000-000000000000' } });
  failsWith(run.file, /object id was not preserved/);
});

function readBackExchange(run) {
  const artifact = JSON.parse(readFileSync(join(run.dir, `${NATIVE_LIVE_GATE}.artifact.json`), 'utf8'));
  return artifact.operations[0].exchanges.find((e) => e.step === 'read-back');
}

test('a read-back that 404s once after restore is retried and the capture verifies', async () => {
  const sleeps = [];
  const run = await runnerCapture({ graphOptions: { readBackMisses: 1 }, sleep: async (ms) => { sleeps.push(ms); } });
  assert.equal(run.code, 0, run.errors.join(' | '));
  assert.deepEqual(sleeps, [2000]);
  const readBack = readBackExchange(run);
  assert.equal(readBack.status, 200);
  assert.deepEqual(readBack.attempts, [404, 200]);
  assert.equal(run.evidence.subject.operations[0].idPreserved, true);
  assert.equal(verifyEvidenceFile(run.file, verifyOpts).ok, true);
});

test('a read-back that keeps returning 404 stops after the bound with the same message', async () => {
  const sleeps = [];
  const run = await runnerCapture({ graphOptions: { readBackMisses: 99 }, sleep: async (ms) => { sleeps.push(ms); } });
  assert.equal(run.code, 1);
  assert.match(run.errors.join(' '), /read-back returned 404/);
  assert.equal(sleeps.length, 4);
  // One read-live plus five bounded read-backs against the live path.
  assert.equal(run.graph.reads.filter((p) => p === `/users/${OBJECT_ID}`).length, 6);
  assert.deepEqual(readBackExchange(run).attempts, [404, 404, 404, 404, 404]);
  assert.equal(run.evidence.subject.operations[0].outcome, 'failed');
  failsWith(run.file, /not a qualified recovery/);
});

test('existing gates keep their behaviour; an unknown gate still fails closed', () => {
  assert.equal(verifyEvidence({ gate: 'nist-benchmark-acceptance', status: 'pending' }, verifyOpts).ok, false);
  const unknown = verifyEvidence(signEvidence({ contractVersion: 1, gate: 'no-such-gate', tenantRef, build: BUILD, operation: 'x',
    credentialMode: 'restorer', observedAt: '2026-10-01T11:00:00Z', evidenceLevel: 'fixture-tested', synthetic: true }, KEY, 'keel-fixture-runner'),
  { ...verifyOpts, gate: null, requireLive: false });
  assert.ok(unknown.failures.some((f) => /no validator registered/.test(f)));
});
