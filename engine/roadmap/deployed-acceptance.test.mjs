/**
 * Roadmap task-113 boundary tests: authenticated deployed release acceptance.
 *
 * Exercises the production capture tool (tools/release/deployed-acceptance.mjs)
 * against a bounded local HTTP fixture portal through the real fetch, and the
 * production verifier (tools/release/qualification.mjs) on the record and raw
 * transcript the tool writes. Signatures use a test-only key, so nothing here
 * can verify against the real runner key, and the committed evidence file is
 * checked to stay pending until the operator captures live evidence.
 */

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  DEPLOYED_ACCEPTANCE_GATE, DEPLOYED_ACCEPTANCE_PROBES, RESTORE_REVIEW_PROBE_ID,
  configuredTenantRef, signEvidence, verifyEvidence, verifyEvidenceFile,
} from '../../tools/release/qualification.mjs';
import { buildDeployedAcceptance } from '../../tools/release/deployed-acceptance.mjs';
import { ACCESS_ASSERTION_HEADER } from '../../tools/release/readiness.mjs';
import { tenantRefFor } from '../store/tenantRef.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../..');
const KEY = 'test-only-deployed-acceptance';
const SESSION = 'fixture-session-assertion';
const BUILD = 'a'.repeat(40);
const tenantRef = tenantRefFor('deployed-acceptance-fixture');
const T0 = Date.parse('2026-10-03T08:00:00Z');

// Fixture portal behavior, switched per test.
let portal;
function defaultPortal() {
  return { requireSession: true, sessionValid: true, missing: new Set(), dropKeys: {} };
}
const BODIES = {
  '/api/coverage': () => ({ generatedAt: new Date(T0).toISOString(), snapshot: null, summary: {}, types: [] }),
  '/api/jobs': () => ({ generatedAt: new Date(T0).toISOString(), jobs: [] }),
  '/api/schedules': () => ({ schedules: [], deferrals: [], forecasts: [], generatedAt: new Date(T0).toISOString() }),
};
const requests = [];
let server;
let portalUrl;

before(async () => {
  server = createServer((req, res) => {
    const url = new URL(req.url, 'http://fixture');
    requests.push({ method: req.method, path: url.pathname + url.search, session: req.headers[ACCESS_ASSERTION_HEADER] ?? null });
    const json = (status, body) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
    const session = req.headers[ACCESS_ASSERTION_HEADER];
    if (portal.requireSession && !session) return json(401, { error: 'unauthenticated' });
    if (session && !portal.sessionValid) return json(403, { error: 'forbidden' });
    const route = url.pathname === `/api/actions/restore/dry-run/${RESTORE_REVIEW_PROBE_ID}` ? 'restore-review' : url.pathname;
    if (portal.missing.has(route)) { res.writeHead(404, { 'content-type': 'text/html' }); return res.end('<html>404</html>'); }
    if (route === 'restore-review') return json(404, { error: 'not_found' });
    const body = BODIES[url.pathname]?.();
    if (!body) { res.writeHead(404, { 'content-type': 'text/html' }); return res.end('<html>404</html>'); }
    for (const key of portal.dropKeys[url.pathname] ?? []) delete body[key];
    return json(200, body);
  });
  await new Promise((resolveListen) => server.listen(0, '127.0.0.1', resolveListen));
  portalUrl = `http://127.0.0.1:${server.address().port}`;
});
after(() => server.close());

function fakeGit({ deployedRevision = BUILD, deployedDirty = false } = {}) {
  return (args) => {
    const [, repo, command] = args;
    if (repo === '/fixture/deployed') {
      if (deployedRevision === null) throw new Error('not a git repository');
      return command === 'rev-parse' ? `${deployedRevision}\n` : (deployedDirty ? ' M file\n' : '');
    }
    return command === 'rev-parse' ? `${BUILD}\n` : '';
  };
}

/** Run the production capture tool and write its outputs to a fresh directory. */
async function capture({ live = true, git = {}, overrides = {}, portalPatch = {} } = {}) {
  portal = { ...defaultPortal(), ...portalPatch };
  let tick = T0;
  const { evidence, transcript } = await buildDeployedAcceptance({
    execFn: fakeGit(git), fetchFn: fetch, portalUrl,
    sourcePath: '/fixture/source', deployedPath: '/fixture/deployed',
    tenantRef, sessionAssertion: SESSION, hmacKey: KEY, live,
    now: () => new Date(tick += 1000), ...overrides,
  });
  const dir = mkdtempSync(join(tmpdir(), 'keel-deployed-acceptance-'));
  const path = join(dir, 'deployed-acceptance.json');
  writeFileSync(path, `${JSON.stringify(evidence, null, 2)}\n`);
  if (transcript) writeFileSync(join(dir, 'deployed-acceptance.capture.json'), transcript);
  return { evidence, transcript, dir, path };
}

const verifyOptions = (extra = {}) => ({
  gate: DEPLOYED_ACCEPTANCE_GATE, tenantRef, build: BUILD, requireLive: true,
  now: new Date(T0 + 60 * 60 * 1000), hmacKey: KEY, ...extra,
});

function verdict(path, extra) {
  return verifyEvidenceFile(path, verifyOptions(extra));
}

function cleanup(...captures) {
  for (const c of captures) rmSync(c.dir, { recursive: true, force: true });
}

/** Rewrite record and transcript consistently, then re-sign: isolates subject rules. */
function rewrite({ dir, path, evidence }, mutate, identity = 'keel-release-runner') {
  const transcriptPath = join(dir, 'deployed-acceptance.capture.json');
  const transcript = JSON.parse(readFileSync(transcriptPath, 'utf8'));
  const record = structuredClone(evidence);
  mutate(record, transcript);
  const text = `${JSON.stringify(transcript, null, 2)}\n`;
  writeFileSync(transcriptPath, text);
  record.proof = { artifact: { path: 'deployed-acceptance.capture.json', sha256: createHash('sha256').update(text).digest('hex') } };
  const signed = signEvidence(record, KEY, identity);
  writeFileSync(path, JSON.stringify(signed));
  return signed;
}

test('valid independently captured record verifies under --require-live', async () => {
  const c = await capture();
  const result = verdict(c.path);
  assert.deepEqual(result.failures, []);
  assert.equal(result.ok, true);
  // Read-only: every probe was a GET, each surface probed with and without the session.
  const probed = requests.splice(0);
  assert.ok(probed.every((r) => r.method === 'GET'));
  assert.equal(probed.length, DEPLOYED_ACCEPTANCE_PROBES.length * 2);
  assert.equal(probed.filter((r) => r.session === SESSION).length, DEPLOYED_ACCEPTANCE_PROBES.length);
  // No session material in the record or the transcript.
  assert.ok(!readFileSync(c.path, 'utf8').includes(SESSION));
  assert.ok(!c.transcript.includes(SESSION));
  cleanup(c);
});

test('altered signature and altered transcript digest fail', async () => {
  const c = await capture();
  const record = JSON.parse(readFileSync(c.path, 'utf8'));
  record.proof.runner.signature = record.proof.runner.signature.replace(/^./, (ch) => (ch === '0' ? '1' : '0'));
  writeFileSync(c.path, JSON.stringify(record));
  assert.match(verdict(c.path).failures.join('\n'), /signature mismatch/);

  const d = await capture();
  const transcriptPath = join(d.dir, 'deployed-acceptance.capture.json');
  writeFileSync(transcriptPath, readFileSync(transcriptPath, 'utf8').replace('"httpStatus": 200', '"httpStatus": 201'));
  assert.match(verdict(d.path).failures.join('\n'), /artifact digest mismatch/);

  // A digest claim that matches nothing on disk fails even with a valid signature.
  const e = await capture();
  rmSync(join(e.dir, 'deployed-acceptance.capture.json'));
  assert.match(verdict(e.path).failures.join('\n'), /capture transcript required/);
  // Re-signed record that disagrees with its transcript fails.
  const f = await capture();
  const tampered = structuredClone(f.evidence);
  tampered.subject.probes[0].unauthenticated.httpStatus = 401;
  tampered.subject.probes[0].authenticated.keys = ['generatedAt', 'snapshot', 'summary', 'types', 'extra'];
  writeFileSync(f.path, JSON.stringify(signEvidence(tampered, KEY)));
  assert.match(verdict(f.path).failures.join('\n'), /transcript probes differ/);
  cleanup(c, d, e, f);
});

test('wrong tenant, build or operation fails; tenant and build identity are required', async () => {
  const c = await capture();
  assert.match(verdict(c.path, { tenantRef: tenantRefFor('other-tenant') }).failures.join('\n'), /cross-tenant/);
  assert.match(verdict(c.path, { tenantRef: null }).failures.join('\n'), /expected tenant identity/);
  assert.match(verdict(c.path, { build: 'b'.repeat(40) }).failures.join('\n'), /build mismatch/);
  assert.match(verdict(c.path, { build: null }).failures.join('\n'), /expected candidate build/);

  rewrite(c, (record) => { record.operation = 'restore.execute'; });
  assert.match(verdict(c.path).failures.join('\n'), /operation mismatch/);
  rewrite(c, (record) => { record.operation = 'deployed-acceptance.read-probe'; record.credentialMode = 'restorer'; });
  assert.match(verdict(c.path).failures.join('\n'), /credential mode/);
  // Transcript captured for another tenant cannot back this tenant's record.
  rewrite(c, (record, transcript) => { record.credentialMode = 'operator-session'; transcript.tenantRef = tenantRefFor('other-tenant'); });
  assert.match(verdict(c.path).failures.join('\n'), /transcript tenant differs/);

  // Deployed checkout at another revision, or dirty, is not the candidate build.
  const d = await capture({ git: { deployedRevision: 'c'.repeat(40) } });
  assert.match(verdict(d.path).failures.join('\n'), /deployed revision does not match/);
  const e = await capture({ git: { deployedDirty: true } });
  assert.match(verdict(e.path).failures.join('\n'), /not clean/);
  cleanup(c, d, e);
});

test('stale evidence fails', async () => {
  const c = await capture();
  assert.match(verdict(c.path, { now: new Date(T0 + 8 * 24 * 60 * 60 * 1000) }).failures.join('\n'), /stale/);
  // A probe captured long before the record's observation time is outside its window.
  rewrite(c, (record, transcript) => {
    for (const target of [record.subject, transcript]) target.probes[2].authenticated.observedAt = new Date(T0 - 3 * 60 * 60 * 1000).toISOString();
  });
  assert.match(verdict(c.path).failures.join('\n'), /schedules: authenticated probe time is outside/);
  cleanup(c);
});

test('missing prerequisite fails: absent surface, broken contract or missing deployed identity', async () => {
  const c = await capture({ portalPatch: { missing: new Set(['/api/schedules']) } });
  assert.match(verdict(c.path).failures.join('\n'), /missing prerequisite task-44 \(schedules\).*status 404.*not JSON/);

  const d = await capture({ portalPatch: { dropKeys: { '/api/coverage': ['types'] } } });
  assert.match(verdict(d.path).failures.join('\n'), /missing prerequisite task-54 \(coverage-matrix\).*missing types/);

  const e = await capture({ portalPatch: { missing: new Set(['restore-review']) } });
  assert.match(verdict(e.path).failures.join('\n'), /restore-review.*error code 'missing'/);

  const f = await capture();
  rewrite(f, (record, transcript) => {
    record.subject.probes = record.subject.probes.filter((p) => p.surface !== 'collection-history');
    transcript.probes = transcript.probes.filter((p) => p.surface !== 'collection-history');
  });
  assert.match(verdict(f.path).failures.join('\n'), /missing prerequisite task-46 \(collection-history\): expected exactly one probe, found 0/);

  rewrite(f, (record, transcript) => {
    delete record.subject.deployment;
    delete transcript.deployment;
  });
  assert.match(verdict(f.path).failures.join('\n'), /missing prerequisite: deployed revision identity/);
  cleanup(c, d, e, f);
});

test('authorization behavior: open routes and a rejected session both fail', async () => {
  const c = await capture({ portalPatch: { requireSession: false } });
  assert.match(verdict(c.path).failures.join('\n'), /unauthenticated request was not refused \(status 200\)/);
  const d = await capture({ portalPatch: { sessionValid: false } });
  assert.match(verdict(d.path).failures.join('\n'), /authenticated status 403/);
  cleanup(c, d);
});

test('missing external evidence stays pending and never verifies', async () => {
  for (const overrides of [{ sessionAssertion: null }, { tenantRef: null }, { hmacKey: null }]) {
    const c = await capture({ overrides });
    assert.equal(c.evidence.status, 'pending');
    assert.equal(c.transcript, null);
    const result = verdict(c.path);
    assert.equal(result.ok, false);
    assert.match(result.failures[0], /external evidence pending/);
    assert.equal(verdict(c.path, { requireLive: false }).ok, false);
    cleanup(c);
  }
  const noIdentity = await capture({ git: { deployedRevision: null } });
  assert.deepEqual(noIdentity.evidence.pendingReasons, ['no deployed revision identity']);
  assert.equal(verdict(noIdentity.path).ok, false);
  cleanup(noIdentity);

  // A record stripped of every proof, or of its status, still fails.
  const c = await capture();
  const record = JSON.parse(readFileSync(c.path, 'utf8'));
  delete record.proof;
  writeFileSync(c.path, JSON.stringify(record));
  const failures = verdict(c.path).failures.join('\n');
  assert.match(failures, /missing proof/);
  assert.match(failures, /runner proof required/);
  cleanup(c);
  assert.equal(verifyEvidence(null, verifyOptions()).ok, false);
});

test('fixture evidence can never be elevated to live-qualified', async () => {
  // The tool's default identity is the fixture runner: usable without --require-live only.
  const c = await capture({ live: false });
  assert.equal(c.evidence.synthetic, true);
  assert.equal(c.evidence.proof.runner.identity, 'keel-fixture-runner');
  assert.equal(verdict(c.path, { requireLive: false }).ok, true);
  assert.match(verdict(c.path).failures.join('\n'), /rejects synthetic/);

  // Relabelling fixture evidence as live fails with or without --require-live.
  rewrite(c, (record) => { record.evidenceLevel = 'live-qualified'; }, 'keel-fixture-runner');
  assert.match(verdict(c.path, { requireLive: false }).failures.join('\n'), /fixture runner evidence cannot claim live/);
  rewrite(c, (record) => { record.evidenceLevel = 'live-qualified'; record.synthetic = true; });
  assert.match(verdict(c.path, { requireLive: false }).failures.join('\n'), /synthetic evidence cannot claim live/);
  cleanup(c);
});

test('the committed evidence file is pending and fails the live CLI verification', () => {
  const committed = join(ROOT, 'docs/release/qualifications/deployed-acceptance.json');
  const record = JSON.parse(readFileSync(committed, 'utf8'));
  assert.equal(record.status, 'pending');
  assert.notEqual(record.evidenceLevel, 'live-qualified');
  assert.equal(verifyEvidenceFile(committed, verifyOptions()).ok, false);

  const dir = mkdtempSync(join(tmpdir(), 'keel-deployed-tenant-'));
  const tenantFile = join(dir, 'tenant.json');
  writeFileSync(tenantFile, JSON.stringify({ tenantId: 'deployed-acceptance-fixture' }));
  assert.equal(configuredTenantRef(tenantFile), tenantRef);
  assert.equal(configuredTenantRef(join(dir, 'absent.json')), null);
  const run = spawnSync(process.execPath, [join(ROOT, 'tools/release/qualification.mjs'), 'verify', '--require-live',
    '--gate', DEPLOYED_ACCEPTANCE_GATE, '--evidence', committed],
  { cwd: ROOT, encoding: 'utf8', env: { ...process.env, KEEL_TENANT_CONFIG_PATH: tenantFile, KEEL_QUALIFICATION_BUILD: BUILD } });
  rmSync(dir, { recursive: true, force: true });
  assert.equal(run.status, 1);
  assert.match(run.stdout, /deployed acceptance external evidence pending/);
});
