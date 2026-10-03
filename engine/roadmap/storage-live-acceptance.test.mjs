/**
 * Roadmap task-114 boundary tests: independent storage recovery qualification
 * (gate storage-live-acceptance), scoped by the operator decision "local copy,
 * honest ceiling".
 *
 * Exercises the production verifier (tools/release/qualification.mjs →
 * engine/storage/storageLiveEvidence.mjs) and the production capture tool
 * (tools/qualification/storageLiveAcceptance.mjs). A "runner" capture drives
 * the tool's --live path against a real backup written to two temp
 * directories through the local storage adapter, with the host facts (volume
 * ids, account ids, write access) injected, so the verifier sees a record
 * exactly as the release runner would write it. Nothing here writes the
 * repository's evidence file: that stays pending until real runner evidence.
 */
import { strict as assert } from 'node:assert';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { signEvidence, verifyEvidence, verifyEvidenceFile } from '../../tools/release/qualification.mjs';
import { STORAGE_OFFLINE_FIXTURE, main as capture, writeStorageFixtureBackup } from '../../tools/qualification/storageLiveAcceptance.mjs';
import { STORAGE_LIVE_GATE } from '../storage/storageLiveEvidence.mjs';
import { tenantRefFor } from '../store/tenantRef.mjs';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const KEY = 'test-only-storage-key';
const BUILD = 'fixture-build-114';
const TENANT_ID = 'storage-runner-tenant';
const tenantRef = tenantRefFor(TENANT_ID);
const dirs = [];
after(() => { for (const dir of dirs) rmSync(dir, { recursive: true, force: true }); });

function clock(start = '2026-10-01T10:00:00.000Z') {
  let t = Date.parse(start);
  return () => { t += 1000; return new Date(t); };
}

const separateHost = {
  volumeOf: (p) => (p.endsWith('primary') ? '2049' : '2065'),
  ownerOf: () => 1001,
  readerAccount: () => 1002,
  readerName: () => 'keel-recovery',
  canWrite: () => false,
};

const liveArgv = (out, checkpoint, extra = []) => ['capture', '--live', '--primary-root', join(out, 'primary'), '--copy-root', join(out, 'copy'),
  '--manifest', STORAGE_OFFLINE_FIXTURE.manifest, '--dump', STORAGE_OFFLINE_FIXTURE.dump, '--export', STORAGE_OFFLINE_FIXTURE.export,
  '--recovery-principal', 'os-user:keel-recovery', '--recovery-credential-ref', 'vault:keel/recovery-login',
  '--recovery-key-ref', 'vault:keel/recovery-key', '--storage-read-ref', 'os-account:keel-recovery',
  '--tenant-authorization-ref', 'runbook:tenant-recovery-authorization', '--tenant-config', '/etc/keel/tenant.json',
  '--checkpoint-seq', String(checkpoint.headSeq), '--checkpoint-hash', checkpoint.headHash,
  '--checkpoint-count', String(checkpoint.recordCount), '--out', join(out, 'evidence'), ...extra];

/** One live-path capture against a freshly written backup + copy. */
async function runnerCapture({ host = {}, argv = null, mutateCopy = null, env = { KEEL_QUALIFICATION_HMAC_KEY: KEY }, deps = {} } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'keel-storage-114-'));
  dirs.push(dir);
  const now = clock();
  const { checkpoint } = await writeStorageFixtureBackup({
    primaryRoot: join(dir, 'primary'), copyRoot: join(dir, 'copy'), tenantRef, build: BUILD, generatedAt: '2026-10-01T09:00:00.000Z',
  });
  if (mutateCopy) mutateCopy(join(dir, 'copy'));
  const errors = [];
  const code = await capture({
    argv: argv ? argv(dir, checkpoint) : liveArgv(dir, checkpoint), env, out: { log() {}, error: (m) => errors.push(m) },
    deps: { now, build: BUILD, host: { ...separateHost, ...host }, readFile: () => JSON.stringify({ tenantId: TENANT_ID }), ...deps },
  });
  const evidenceDir = join(dir, 'evidence');
  const file = join(evidenceDir, `${STORAGE_LIVE_GATE}.json`);
  let evidence = null;
  try { evidence = JSON.parse(readFileSync(file, 'utf8')); } catch { /* refused before writing */ }
  return { dir: evidenceDir, root: dir, file, code, errors, evidence };
}

const verifyOpts = { gate: STORAGE_LIVE_GATE, tenantRef, build: BUILD, requireLive: true, now: new Date('2026-10-01T12:00:00Z'), hmacKey: KEY };

/** Write a modified record next to the real artifact, re-signed as the release runner unless told otherwise. */
function resave(run, patch, { identity = 'keel-release-runner', sign = true } = {}) {
  const { proof, ...rest } = run.evidence;
  const base = structuredClone({ ...rest, proof: { artifact: proof.artifact } });
  const next = typeof patch === 'function' ? patch(base) : { ...base, ...patch };
  const record = sign ? signEvidence(next, KEY, identity) : next;
  const file = join(run.dir, `variant-${Math.random().toString(16).slice(2)}.json`);
  writeFileSync(file, JSON.stringify(record));
  return file;
}

/** Rewrite the raw capture AND the record consistently (a dishonest runner), then re-sign. */
function forge(run, fn) {
  const artifactPath = join(run.dir, `${STORAGE_LIVE_GATE}.artifact.json`);
  const capture = JSON.parse(readFileSync(artifactPath, 'utf8'));
  fn(capture);
  const text = `${JSON.stringify(capture, null, 2)}\n`;
  const name = `forged-${Math.random().toString(16).slice(2)}.artifact.json`;
  writeFileSync(join(run.dir, name), text);
  const sha256 = createHash('sha256').update(text).digest('hex');
  return resave(run, (r) => {
    for (const part of ['storage', 'identity', 'recovery']) r.subject[part] = capture[part];
    r.subject.captureSha256 = sha256;
    r.proof.artifact = { path: name, sha256 };
    return r;
  });
}

function failsWith(file, pattern, opts = verifyOpts) {
  const result = verifyEvidenceFile(file, opts);
  assert.equal(result.ok, false, `expected failure matching ${pattern}`);
  assert.ok(result.failures.some((f) => pattern.test(f)), `no failure matched ${pattern}: ${result.failures.join(' | ')}`);
}

test('a valid independently captured local-copy record verifies under --require-live and reports the lock UNQUALIFIED', async () => {
  const run = await runnerCapture();
  assert.equal(run.code, 0, run.errors.join(' '));
  assert.deepEqual(verifyEvidenceFile(run.file, verifyOpts).failures, []);
  const { subject } = run.evidence;
  assert.deepEqual(subject.qualified.sort(), ['independent-recovery-read', 'manifest-verification']);
  for (const claim of ['retentionLock', 'immutability', 'lockCanary']) assert.equal(subject.unqualified[claim].status, 'UNQUALIFIED');
  assert.equal(subject.storage.retentionLock, 'unsupported');
  assert.equal(subject.storage.immutability, 'unsupported');
  assert.deepEqual(subject.identity.missingPrerequisites, []);
  assert.equal(subject.recovery.manifestVerification.recoveryComplete, true);
  // Ordinary backups are never deleted: the copy still holds every object afterwards.
  assert.deepEqual(subject.recovery.listing.before, subject.recovery.listing.after);
  assert.equal(subject.recovery.listing.after.count, 4);
  assert.doesNotMatch(readFileSync(run.file, 'utf8'), /BEGIN|accessToken|eyJ/);
});

test('an altered signature, record or capture digest fails', async () => {
  const run = await runnerCapture();
  const tampered = structuredClone(run.evidence);
  tampered.proof.runner.signature = tampered.proof.runner.signature.replace(/^./, (c) => (c === '0' ? '1' : '0'));
  const sigFile = join(run.dir, 'sig.json');
  writeFileSync(sigFile, JSON.stringify(tampered));
  failsWith(sigFile, /runner signature mismatch/);

  const signedEdit = structuredClone(run.evidence);
  signedEdit.subject.identity.readerCanWrite = false;
  signedEdit.subject.recovery.listing.after.count = 99;
  const editFile = join(run.dir, 'edit.json');
  writeFileSync(editFile, JSON.stringify(signedEdit));
  failsWith(editFile, /runner signature mismatch/);

  const artifactPath = join(run.dir, `${STORAGE_LIVE_GATE}.artifact.json`);
  const original = readFileSync(artifactPath, 'utf8');
  writeFileSync(artifactPath, original.replace('"readerCanWrite": false', '"readerCanWrite": true'));
  failsWith(run.file, /artifact digest mismatch/);
  writeFileSync(artifactPath, original);

  // A swapped artifact with its own (unsigned-body) digest no longer names the signed capture digest.
  const forged = original.replace('"2065"', '"2049"');
  writeFileSync(join(run.dir, 'swap.artifact.json'), forged);
  const swap = structuredClone(run.evidence);
  swap.proof.artifact = { path: 'swap.artifact.json', sha256: createHash('sha256').update(forged).digest('hex') };
  const swapFile = join(run.dir, 'swap.json');
  writeFileSync(swapFile, JSON.stringify(swap));
  failsWith(swapFile, /signed capture digest does not name the proof artifact/);
  // Re-signed record whose subject disagrees with the raw capture.
  failsWith(resave(run, (r) => { r.subject.identity.writerAccounts = [7]; return r; }), /raw capture identity differs/);
});

test('mutation check: missing external evidence fails (no artifact, no runner, pending placeholder)', async () => {
  const run = await runnerCapture();
  failsWith(resave(run, (r) => { delete r.proof.artifact; return r; }), /raw capture artifact is missing/);
  failsWith(resave(run, {}, { sign: false }), /storage recovery runner proof required/);
  failsWith(resave(run, {}, { sign: false }), /storage recovery runner proof required/, { ...verifyOpts, requireLive: false });
  unlinkSync(join(run.dir, `${STORAGE_LIVE_GATE}.artifact.json`));
  failsWith(run.file, /raw capture artifact is missing/);
  failsWith(join(run.dir, 'absent.json'), /evidence unreadable/);

  const placeholder = join(ROOT, 'docs/release/qualifications/storage-live-acceptance.json');
  assert.equal(JSON.parse(readFileSync(placeholder, 'utf8')).status, 'pending');
  failsWith(placeholder, /external runner evidence pending/);
  failsWith(placeholder, /external runner evidence pending/, { ...verifyOpts, requireLive: false });
  const cli = spawnSync('node', ['tools/release/qualification.mjs', 'verify', '--require-live', '--gate', STORAGE_LIVE_GATE,
    '--evidence', 'docs/release/qualifications/storage-live-acceptance.json', '--build', BUILD], { cwd: ROOT, encoding: 'utf8' });
  assert.equal(cli.status, 1);
  assert.match(cli.stdout, /external runner evidence pending/);
});

test('mutation check: a mismatched tenant, build or operation fails', async () => {
  const run = await runnerCapture();
  const other = tenantRefFor('other-tenant');
  failsWith(run.file, /tenant mismatch|cross-tenant/, { ...verifyOpts, tenantRef: other });
  failsWith(run.file, /requires the expected tenant and build identity/, { ...verifyOpts, tenantRef: null });
  failsWith(run.file, /requires the expected tenant and build identity/, { ...verifyOpts, build: null });
  failsWith(run.file, /build mismatch/, { ...verifyOpts, build: 'other-build' });
  failsWith(resave(run, { tenantRef: other }), /raw capture tenant differs/, { ...verifyOpts, tenantRef: other });
  failsWith(resave(run, { build: 'other-build' }), /raw capture build differs/, { ...verifyOpts, build: 'other-build' });
  failsWith(resave(run, { operation: 'storage.other' }), /operation mismatch/);
  failsWith(resave(run, { operation: 'storage.other' }), /raw capture operation differs/);
  failsWith(resave(run, { credentialMode: 'restorer' }), /credential mode 'recovery-reader'/);
  failsWith(resave(run, { gate: 'native-live-acceptance' }), /gate mismatch/);

  // The backup itself must belong to this tenant: a copy pinned to another tenant does not verify.
  const foreign = await runnerCapture({ deps: { readFile: () => JSON.stringify({ tenantId: 'other-tenant' }) } });
  assert.equal(foreign.code, 1);
  failsWith(foreign.file, /recovery manifest did not verify.*tenant pin mismatch/, { ...verifyOpts, tenantRef: other });
});

test('stale evidence, a stale backup and a missing prerequisite fail', async () => {
  const run = await runnerCapture();
  failsWith(run.file, /stale/, { ...verifyOpts, now: new Date('2026-12-15T00:00:00Z') });
  failsWith(forge(run, (c) => { c.recovery.manifestGeneratedAt = '2026-09-01T00:00:00.000Z'; }), /backup copy is stale/);
  failsWith(forge(run, (c) => { c.recovery.manifestGeneratedAt = '2026-10-02T00:00:00.000Z'; }), /newer than the observation/);
  failsWith(resave(run, (r) => { delete r.subject.prerequisite['task-68']; return r; }), /missing prerequisite: task-68/);
  failsWith(resave(run, (r) => { delete r.subject.prerequisite; return r; }), /missing prerequisite: task-69/);
  failsWith(resave(run, (r) => { r.subject.prerequisite['task-69'].retentionLock = 'live-qualified'; return r; }), /prerequisite task-69 differs/);
  // A missing task-68 credential prerequisite is named, and the record never verifies.
  const missing = await runnerCapture({ argv: (dir, cp) => liveArgv(dir, cp).filter((v, i, a) => v !== '--recovery-key-ref' && a[i - 1] !== '--recovery-key-ref') });
  failsWith(missing.file, /credential prerequisites missing: recovery-key-material/);
});

test('mutation check: fixture evidence is never elevated to live-qualified', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'keel-storage-114-offline-'));
  dirs.push(dir);
  const code = await capture({ argv: ['capture', '--out', dir], env: { KEEL_QUALIFICATION_HMAC_KEY: KEY }, out: { log() {}, error() {} }, deps: { now: clock(), build: BUILD } });
  assert.equal(code, 0);
  const file = join(dir, `${STORAGE_LIVE_GATE}.json`);
  const offline = JSON.parse(readFileSync(file, 'utf8'));
  assert.equal(offline.evidenceLevel, 'fixture-tested');
  assert.equal(offline.synthetic, true);
  assert.equal(offline.proof.runner.identity, 'keel-fixture-runner');
  const offlineOpts = { ...verifyOpts, tenantRef: tenantRefFor(STORAGE_OFFLINE_FIXTURE.tenantId) };
  // Code behaviour is proven offline; a live claim is not.
  assert.deepEqual(verifyEvidenceFile(file, { ...offlineOpts, requireLive: false }).failures, []);
  failsWith(file, /--require-live rejects synthetic fixtures/, offlineOpts);
  const run = { dir, evidence: offline };
  for (const [patch, identity] of [[{ evidenceLevel: 'live-qualified' }, 'keel-fixture-runner'],
    [{ evidenceLevel: 'live-qualified', synthetic: false }, 'keel-fixture-runner'],
    [{ evidenceLevel: 'live-qualified' }, 'keel-release-runner']]) {
    failsWith(resave(run, patch, { identity }), /storage fixture evidence cannot claim live qualification/, { ...offlineOpts, requireLive: false });
  }
});

test('retention lock and immutability are never claimed, and only the local copy is accepted', async () => {
  const run = await runnerCapture();
  failsWith(resave(run, (r) => { r.subject.qualified.push('retentionLock'); return r; }), /qualified claims must be exactly/);
  failsWith(resave(run, (r) => { r.subject.unqualified.immutability.status = 'live-qualified'; return r; }), /immutability must be reported UNQUALIFIED/);
  failsWith(resave(run, (r) => { delete r.subject.unqualified.lockCanary; return r; }), /lockCanary must be reported UNQUALIFIED/);
  failsWith(resave(run, (r) => { delete r.subject.unqualified; return r; }), /retentionLock must be reported UNQUALIFIED/);
  failsWith(forge(run, (c) => { c.storage.retentionLock = 'live-qualified'; }), /retentionLock and immutability as unsupported/);
  failsWith(forge(run, (c) => { c.storage.provider = 's3-compatible'; }), /provider 's3-compatible' is refused/);
});

test('identity separation, a separate volume and an unchanged copy are required', async () => {
  const sameVolume = await runnerCapture({ host: { volumeOf: () => '2049' } });
  failsWith(sameVolume.file, /same volume/);
  const readerIsWriter = await runnerCapture({ host: { readerAccount: () => 1001 } });
  failsWith(readerIsWriter.file, /recovery reader is also a backup writer/);
  const readerWrites = await runnerCapture({ host: { canWrite: () => true } });
  failsWith(readerWrites.file, /recovery reader can write to the copy/);
  const run = await runnerCapture();
  failsWith(forge(run, (c) => { c.identity.independent = false; }), /independent channel/);
  failsWith(forge(run, (c) => { c.identity.principalId = ''; }), /anonymous recovery identity is refused/);
  failsWith(forge(run, (c) => { c.recovery.listing.after = { count: 3, sha256: 'b'.repeat(64) }; }), /ordinary backups must never be deleted/);
  failsWith(forge(run, (c) => { c.recovery.reads = c.recovery.reads.filter((r) => r.role !== 'dump'); }), /read of the dump/);
  failsWith(resave(run, (r) => { r.subject.identity.credentialRef = '-----BEGIN PRIVATE KEY-----'; return r; }), /credential material refused/);
});

test('the capture refuses an unauthenticated or anonymous identity before reading the copy', async () => {
  const wrongAccount = await runnerCapture({ host: { readerName: () => 'keel' } });
  assert.equal(wrongAccount.code, 1);
  assert.match(wrongAccount.errors.join(' '), /independent authenticator refused/);
  assert.equal(wrongAccount.evidence, null);
  const noPrincipal = await runnerCapture({ argv: (dir, cp) => liveArgv(dir, cp).filter((v, i, a) => v !== '--recovery-principal' && a[i - 1] !== '--recovery-principal') });
  assert.equal(noPrincipal.code, 2);
  assert.equal(noPrincipal.evidence, null);
});

test('a tampered copy is recorded as a failed verification and never qualifies', async () => {
  const run = await runnerCapture({ mutateCopy: (copy) => writeFileSync(join(copy, STORAGE_OFFLINE_FIXTURE.dump), 'tampered') });
  assert.equal(run.code, 1);
  assert.equal(run.evidence.subject.recovery.manifestVerification.ok, false);
  failsWith(run.file, /recovery manifest did not verify.*dump checksum mismatch/);
  failsWith(run.file, /read of keel\.sql\.gz does not match/);
  // The copy keeps every object even when verification fails.
  assert.equal(run.evidence.subject.recovery.listing.after.count, 4);
  const incomplete = await runnerCapture({ argv: (dir, cp) => liveArgv(dir, { ...cp, headSeq: cp.headSeq + 1 }) });
  failsWith(incomplete.file, /recovery manifest did not verify|recovery is incomplete/);
});

test('existing gates keep their behaviour; an unknown gate still fails closed', () => {
  assert.equal(verifyEvidence({ gate: 'native-live-acceptance', status: 'pending' }, verifyOpts).ok, false);
  const unknown = verifyEvidence(signEvidence({ contractVersion: 1, gate: 'no-such-gate', tenantRef, build: BUILD, operation: 'x',
    credentialMode: 'recovery-reader', observedAt: '2026-10-01T11:00:00Z', evidenceLevel: 'fixture-tested', synthetic: true }, KEY, 'keel-fixture-runner'),
  { ...verifyOpts, gate: null, requireLive: false });
  assert.ok(unknown.failures.some((f) => /no validator registered/.test(f)));
});
