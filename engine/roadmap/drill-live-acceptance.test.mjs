/**
 * Roadmap task-116 boundary tests: bounded same-tenant drill and Keel recovery
 * acceptance. A drill record is produced by the production task-72 harness
 * (tools/rehearsal/qualification.mjs, live mode against a fake Graph tenant and
 * the isolated test database), read back through the production evidence row
 * loader, captured with captureDrillLiveAcceptance() and verified by the
 * production tools/release/qualification.mjs verifier and CLI.
 *
 * Every signature here uses a test-only key. No record produced here is
 * persisted as release evidence; the checked-in record stays pending.
 *
 * Required mutation checks:
 * - Accept missing external evidence.
 * - Accept mismatched tenant or operation.
 * - Elevate fixture evidence to live-qualified.
 */
import { strict as assert } from 'node:assert';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  DRILL_LIVE_GATE, DRILL_LIVE_OPERATION, captureDrillLiveAcceptance, loadLatestDrillEvidence, signEvidence,
  verifyEvidence, verifyEvidenceFile,
} from '../../tools/release/qualification.mjs';
import { buildDrillManifest, runBoundedDrill, validateDrillPlan } from '../../tools/rehearsal/qualification.mjs';
import { tenantRefFor } from '../../tools/rehearsal/roundTrip.mjs';
import { assertCommittedLiveRecord, isPendingPlaceholder } from '../test/committedEvidence.mjs';
import { createIsolatedTestDatabase } from '../test/dbTestHelper.mjs';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const KEY = 'test-only-drill-key';
const BUILD = 'fixture-build-116';
const PRODUCTION_URL = 'postgres://keel@db.internal:5432/keel';
const collector = JSON.parse(readFileSync(new URL('../../tools/rehearsal/fixtures/roundTrip-collector.json', import.meta.url), 'utf8'));
const restorer = JSON.parse(readFileSync(new URL('../../tools/rehearsal/fixtures/roundTrip-restorer.json', import.meta.url), 'utf8'));
const tenantRef = tenantRefFor(collector);
const START = new Date('2026-10-03T01:02:03.004Z');
const NOW = new Date('2026-10-03T03:00:00.000Z');
const options = { gate: DRILL_LIVE_GATE, tenantRef, build: BUILD, now: NOW, hmacKey: KEY, requireLive: true };

let dir;
let database;
let client;
let drillRow;
let collectorPath;
let restorerPath;

/** A fake tenant holding only what the drill creates; every write advances the clock. */
function fakeTenant({ purgeStatus = 204 } = {}) {
  const state = { group: null, softDeleted: false, hardDeleted: false, time: 0 };
  const getGroup = () => (state.group && !state.softDeleted
    ? { ok: true, status: 200, body: state.group }
    : { ok: false, status: 404, body: null });
  const reader = {
    collect: async (version, path) => ({ items: path.startsWith('/groups') && state.group && !state.softDeleted ? [state.group] : [] }),
    get: async (version, path) => {
      if (path.startsWith('/groups/')) return getGroup();
      if (path.startsWith('/directory/deletedItems/')) {
        return state.softDeleted && !state.hardDeleted
          ? { ok: true, status: 200, body: state.group }
          : { ok: false, status: 404, body: null };
      }
      throw new Error(`unexpected fake Graph read: ${path}`);
    },
  };
  const writer = {
    write: async (version, path, { method, body }) => {
      state.time += 1000;
      if (method === 'POST' && path === '/groups') {
        state.group = { ...body, id: 'drill-group-1' };
        return { ok: true, status: 201, body: state.group };
      }
      if (method === 'PATCH' && path === '/groups/drill-group-1') {
        state.group = { ...state.group, ...body };
        return { ok: true, status: 204, body: null };
      }
      if (method === 'DELETE' && path === '/groups/drill-group-1') {
        if (state.softDeleted) return { ok: false, status: 404, body: null };
        state.softDeleted = true;
        return { ok: true, status: 204, body: null };
      }
      if (method === 'DELETE' && path === '/directory/deletedItems/drill-group-1') {
        if (purgeStatus >= 300) return { ok: false, status: purgeStatus, body: { error: 'Authorization_RequestDenied' } };
        state.hardDeleted = true;
        return { ok: true, status: 204, body: null };
      }
      throw new Error(`unexpected fake Graph write: ${method} ${path}`);
    },
    read: async (version, path) => {
      if (path === '/groups/drill-group-1') return getGroup();
      throw new Error(`unexpected fake Graph writer read: ${path}`);
    },
  };
  return { state, reader, writer, clock: () => START.getTime() + state.time };
}

function liveDrill(tenant) {
  return runBoundedDrill({
    mode: 'live',
    confirm: true,
    manifest: buildDrillManifest({ collectorConfig: collector, now: START }),
    collectorConfigPath: collectorPath,
    restorerConfigPath: restorerPath,
    dbUrl: process.env.KEEL_DB_TEST_URL,
    productionUrl: PRODUCTION_URL,
    writer: tenant.writer,
    reader: tenant.reader,
    client,
    clock: tenant.clock,
    log: () => {},
  });
}

/** The shape tools/recovery/reconstruct.mjs reconstructRecovery() returns, plus the run context. */
function reconstruction(overrides = {}) {
  return {
    ok: true,
    stage: 'recovered',
    failures: [],
    readOnly: true,
    writersDisabled: true,
    recoveryComplete: true,
    incomplete: [],
    recovered: { evidence: { chainOk: true, headSeq: 42, headHash: 'a'.repeat(64), recordCount: 42 } },
    tenantRef,
    buildRevision: BUILD,
    completedAt: '2026-10-03T02:00:00.000Z',
    ...overrides,
  };
}

const onboarding = { readSetup: 'complete', restoreSetup: 'complete', readSetupRunId: 'setup-run-read-1', restoreSetupRunId: 'setup-run-restore-1' };

function capture({ runner = 'keel-release-runner', row = drillRow, recon = reconstruction(), setup = onboarding, name = 'capture' } = {}) {
  const artifactRef = `${name}.capture.json`;
  return captureDrillLiveAcceptance({
    drillEvidence: row,
    reconstruction: recon,
    onboarding: setup,
    build: BUILD,
    observedAt: '2026-10-03T02:30:00.000Z',
    artifactPath: join(dir, artifactRef),
    artifactRef,
    runner: { identity: runner, key: KEY },
  }).evidence;
}

function verify(evidence, overrides = {}) {
  return verifyEvidence(evidence, { ...options, evidenceDir: dir, ...overrides });
}

/**
 * Rewrites a captured record consistently (subject, capture artifact, digest,
 * signature) so only the mutated property can make verification fail.
 */
function forge(evidence, mutate, { name = 'forged', identity = 'keel-release-runner' } = {}) {
  const copy = structuredClone(evidence);
  mutate(copy);
  const artifactRef = `${name}.capture.json`;
  const capture = JSON.parse(readFileSync(join(dir, evidence.proof.artifact.path), 'utf8'));
  capture.drillEvidence.subject = copy.subject?.drillRecord;
  capture.drillEvidence.tenant_ref = copy.tenantRef;
  capture.reconstruction = copy.subject?.reconstruction;
  const bytes = Buffer.from(JSON.stringify(capture));
  writeFileSync(join(dir, artifactRef), bytes);
  copy.proof = { artifact: { path: artifactRef, sha256: createHash('sha256').update(bytes).digest('hex') } };
  return signEvidence(copy, KEY, identity);
}

function assertFails(result, pattern) {
  assert.equal(result.ok, false);
  assert.ok(result.failures.some((failure) => pattern.test(failure)), `expected ${pattern}: ${result.failures.join(' | ')}`);
}

before(async () => {
  dir = mkdtempSync(join(tmpdir(), 'keel-drill-live-'));
  collectorPath = join(dir, 'collector.json');
  restorerPath = join(dir, 'restorer.json');
  writeFileSync(collectorPath, JSON.stringify(collector));
  writeFileSync(restorerPath, JSON.stringify(restorer));
  database = await createIsolatedTestDatabase(import.meta.url);
  client = await database.connect();
  await client.query(readFileSync(new URL('../store/schema.sql', import.meta.url), 'utf8'));
  const record = await liveDrill(fakeTenant());
  assert.equal(record.countsAsRecoveryDrill, true, record.error ?? '');
  drillRow = await loadLatestDrillEvidence(client, { tenantRef });
});

after(async () => {
  await client?.end();
  await database?.cleanup();
  rmSync(dir, { recursive: true, force: true });
});

test('a valid independently captured drill and reconstruction record verifies', () => {
  const evidence = capture();
  assert.equal(evidence.evidenceLevel, 'live-qualified');
  assert.equal(evidence.operation, DRILL_LIVE_OPERATION);
  assert.equal(evidence.subject.drillRecord.mode, 'live');
  assert.match(evidence.subject.testObject.naturalKey, /^group:keel-rehearsal-/);
  assert.deepEqual(verify(evidence), { ok: true, failures: [] });
  // The consistent forge helper itself leaves a valid record valid.
  assert.equal(verify(forge(evidence, () => {})).ok, true);
});

test('an altered signature or digest fails', () => {
  const evidence = capture({ name: 'digest' });
  const badSignature = structuredClone(evidence);
  badSignature.proof.runner.signature = '0'.repeat(64);
  assertFails(verify(badSignature), /signature mismatch/);

  const tamperedField = structuredClone(evidence);
  tamperedField.subject.drillRecord.elapsedMs -= 1;
  assertFails(verify(tamperedField), /signature mismatch/);

  // Signed again, but the captured artifact bytes changed underneath.
  const artifactPath = join(dir, evidence.proof.artifact.path);
  const original = readFileSync(artifactPath);
  writeFileSync(artifactPath, Buffer.concat([original, Buffer.from(' ')]));
  assertFails(verify(evidence), /artifact digest mismatch/);
  writeFileSync(artifactPath, original);
  assert.equal(verify(evidence).ok, true);

  const wrongDigest = signEvidence({ ...structuredClone(evidence), proof: { artifact: { ...evidence.proof.artifact, sha256: 'f'.repeat(64) } } }, KEY);
  assertFails(verify(wrongDigest), /artifact digest mismatch/);

  // A re-signed subject that no longer equals the captured evidence row.
  const drifted = signEvidence({ ...structuredClone(evidence), subject: { ...evidence.subject,
    drillRecord: { ...evidence.subject.drillRecord, writes: evidence.subject.drillRecord.writes - 1 } } }, KEY);
  assertFails(verify(drifted), /differs from the captured evidence row/);
});

test('wrong tenant, build or operation fails', () => {
  const evidence = capture({ name: 'identity' });
  assertFails(verify(evidence, { tenantRef: tenantRefFor({ tenantId: 'foreign-tenant' }) }), /cross-tenant evidence refused/);
  assertFails(verify(evidence, { tenantRef: null }), /expected tenant and build/);
  assertFails(verify(evidence, { build: 'other-build' }), /build mismatch/);
  assertFails(verify(forge(evidence, (e) => { e.operation = 'recovery-drill.tenant-wide'; })), /operation mismatch/);
  assertFails(verify(forge(evidence, (e) => { e.credentialMode = 'restorer'; })), /credential mode/);
  // The drill row or reconstruction of another tenant inside this tenant's record.
  const foreign = tenantRefFor({ tenantId: 'foreign-tenant' });
  assertFails(verify(forge(evidence, (e) => { e.subject.drillRecord.tenantRef = foreign; })), /drill record tenant mismatch/);
  assertFails(verify(forge(evidence, (e) => { e.subject.reconstruction.tenantRef = foreign; })), /reconstruction tenant mismatch/);
  assertFails(verify(forge(evidence, (e) => { e.subject.reconstruction.buildRevision = 'other-build'; })), /reconstruction build mismatch/);
});

test('stale evidence fails', () => {
  const evidence = capture({ name: 'stale' });
  assertFails(verify(evidence, { now: new Date('2027-01-01T00:00:00Z') }), /stale/);
  assertFails(verify(evidence, { maxAgeHours: 1 }), /stale/);
  // A fresh observation time cannot refresh an old drill or reconstruction.
  assertFails(verify(forge(evidence, (e) => {
    const shift = (iso) => new Date(Date.parse(iso) - 90 * 24 * 3600_000).toISOString();
    e.subject.drillRecord.startedAt = shift(e.subject.drillRecord.startedAt);
    e.subject.drillRecord.finishedAt = shift(e.subject.drillRecord.finishedAt);
  })), /drill is stale/);
  assertFails(verify(forge(evidence, (e) => { e.subject.reconstruction.completedAt = '2026-06-01T00:00:00.000Z'; })), /reconstruction is stale/);
  assertFails(verify(forge(evidence, (e) => { e.observedAt = '2026-10-03T01:02:04.000Z'; })), /observed before the drill finished/);
});

test('missing prerequisite or missing external evidence fails', () => {
  const evidence = capture({ name: 'prereq' });
  assertFails(verify(capture({ name: 'onboard', setup: { ...onboarding, restoreSetup: 'pending' } })), /task-76/);
  assertFails(verify(capture({ name: 'onboard2', setup: null })), /task-76/);
  assertFails(verify(forge(evidence, (e) => { delete e.subject.prerequisites.drillHarness; })), /task-72 bounded drill harness/);
  assertFails(verify(forge(evidence, (e) => { delete e.subject.drillRecord; })), /task-72 live drill record/);
  assertFails(verify(forge(evidence, (e) => { delete e.subject.reconstruction; })), /task-68 read-only reconstruction/);
  assertFails(verify(forge(evidence, (e) => { e.subject.reconstruction.readOnly = false; })), /not read-only/);
  assertFails(verify(forge(evidence, (e) => { e.subject.reconstruction.checkpoint = null; })), /checkpoint/);

  // External evidence: the captured artifact must exist and be bound.
  const noArtifact = signEvidence({ ...structuredClone(evidence), proof: {} }, KEY);
  assertFails(verify(noArtifact), /missing external evidence/);
  const missingFile = signEvidence({ ...structuredClone(evidence), proof: { artifact: { path: 'absent.capture.json', sha256: '0'.repeat(64) } } }, KEY);
  assertFails(verify(missingFile), /missing external evidence/);
  const unsigned = structuredClone(evidence);
  delete unsigned.proof.runner;
  assertFails(verify(unsigned), /runner proof required/);
  assertFails(verify(unsigned, { requireLive: false }), /runner proof required/);
  assertFails(verify({ contractVersion: 1, gate: DRILL_LIVE_GATE, status: 'pending' }), /pending/);

  // The checked-in record: a pending placeholder fails the live gate, file and CLI alike. Once a live
  // capture replaces it, it must still never verify without the key.
  const checkedIn = join(ROOT, 'docs/release/qualifications/drill-live-acceptance.json');
  if (isPendingPlaceholder(checkedIn)) {
    assertFails(verifyEvidenceFile(checkedIn, { ...options, requireLive: true }), /pending/);
    const cli = spawnSync(process.execPath, ['tools/release/qualification.mjs', 'verify', '--require-live', '--gate', DRILL_LIVE_GATE,
      '--evidence', checkedIn, '--tenant', tenantRef, '--build', BUILD], { cwd: ROOT, encoding: 'utf8' });
    assert.equal(cli.status, 1, cli.stderr);
    assert.equal(JSON.parse(cli.stdout).ok, false);
  } else {
    assertCommittedLiveRecord(checkedIn, { gate: DRILL_LIVE_GATE, root: ROOT, verify: verifyEvidenceFile, verifyOptions: options });
  }
});

test('the drill must be live, bounded, cleaned up and scoped to the named disposable object', async () => {
  const evidence = capture({ name: 'scope' });
  // Offline plan validation is never a drill, whatever it says.
  const offline = validateDrillPlan({
    manifest: buildDrillManifest({ collectorConfig: collector, now: START }),
    collectorConfigPath: collectorPath, restorerConfigPath: restorerPath,
    dbUrl: process.env.KEEL_DB_TEST_URL, productionUrl: PRODUCTION_URL,
  });
  assert.equal(offline.ok, true);
  assert.throws(() => capture({ name: 'offline', row: { ...drillRow, subject: { ...offline, tenantRef } } }), /offline-validation/);
  assertFails(verify(forge(evidence, (e) => { e.subject.drillRecord.mode = 'offline'; })), /offline-validation/);

  // A residual left in the tenant is a failed post-state, never accepted.
  const residualTenant = fakeTenant({ purgeStatus: 403 });
  const residual = await liveDrill(residualTenant);
  assert.equal(residual.cleanup.status, 'failed');
  const residualRow = await loadLatestDrillEvidence(client, { tenantRef });
  assert.throws(() => capture({ name: 'residual', row: residualRow }), /cleanup-failed/);
  assertFails(verify(forge(evidence, (e) => {
    e.subject.drillRecord.cleanup = { ...e.subject.drillRecord.cleanup, verifiedAbsent: [] };
  })), /post-state not verified/);

  // Active users and tenant-wide policies are out of scope.
  assertFails(verify(forge(evidence, (e) => {
    e.subject.drillRecord.objects = ['user:alice@contoso.example'];
    e.subject.testObject.naturalKey = 'user:alice@contoso.example';
  })), /non-disposable/);
  assertFails(verify(forge(evidence, (e) => { e.subject.testObject = { resourceType: 'conditionalAccessPolicy', naturalKey: 'policy:all-users' }; })), /named disposable/);
  assertFails(verify(forge(evidence, (e) => { e.subject.drillRecord.scope = 'tenant-wide'; })), /unbounded-scope/);
  assertFails(verify(forge(evidence, (e) => { e.subject.drillRecord.bounds.maxWrites = 400; })), /ceilings/);
  assertFails(verify(forge(evidence, (e) => { e.subject.drillRecord.createdObjects = []; })), /no created object/);
  assertFails(verify(forge(evidence, (e) => { e.subject.drillRecord.elapsedMs += 1; })), /elapsed-not-observed/);
});

test('fixture evidence is never elevated to live-qualified', () => {
  const fixture = capture({ name: 'fixture', runner: 'keel-fixture-runner' });
  assert.equal(fixture.evidenceLevel, 'fixture-tested');
  assert.equal(fixture.synthetic, true);
  assert.equal(verify(fixture, { requireLive: false }).ok, true);
  assertFails(verify(fixture), /--require-live/);

  // Claiming live-qualified from a synthetic runner or a synthetic record fails even without --require-live.
  const elevated = forge(fixture, (e) => { e.evidenceLevel = 'live-qualified'; e.synthetic = false; }, { name: 'elevated', identity: 'keel-fixture-runner' });
  assertFails(verify(elevated, { requireLive: false }), /cannot claim live qualification/);
  const syntheticLive = forge(capture({ name: 'synthetic' }), (e) => { e.synthetic = true; }, { name: 'synthetic2' });
  assertFails(verify(syntheticLive, { requireLive: false }), /cannot claim live qualification/);
  assert.throws(() => capture({ name: 'unknown', runner: 'keel-laptop' }), /untrusted runner/);
});

test('the capture CLI writes a signed record and its artifact; the verify CLI checks them', () => {
  const rowPath = join(dir, 'drill-row.json');
  const reconPath = join(dir, 'reconstruction.json');
  const setupPath = join(dir, 'onboarding.json');
  const out = join(dir, 'cli-evidence.json');
  writeFileSync(rowPath, JSON.stringify(drillRow));
  writeFileSync(reconPath, JSON.stringify(reconstruction()));
  writeFileSync(setupPath, JSON.stringify(onboarding));
  const env = { ...process.env, KEEL_QUALIFICATION_HMAC_KEY: KEY };
  const captured = spawnSync(process.execPath, ['tools/release/qualification.mjs', 'capture-drill', '--out', out,
    '--drill-row', rowPath, '--reconstruction', reconPath, '--onboarding', setupPath, '--build', BUILD,
    '--runner', 'keel-fixture-runner'], { cwd: ROOT, encoding: 'utf8', env });
  assert.equal(captured.status, 0, captured.stderr);
  assert.equal(JSON.parse(captured.stdout).evidenceLevel, 'fixture-tested');
  const written = JSON.parse(readFileSync(out, 'utf8'));
  assert.equal(written.proof.artifact.path, 'cli-evidence.capture.json');

  const verifyArgs = ['tools/release/qualification.mjs', 'verify', '--gate', DRILL_LIVE_GATE, '--evidence', out,
    '--tenant', tenantRef, '--build', BUILD];
  const plain = spawnSync(process.execPath, verifyArgs, { cwd: ROOT, encoding: 'utf8', env });
  assert.equal(plain.status, 0, plain.stdout);
  const live = spawnSync(process.execPath, [...verifyArgs, '--require-live'], { cwd: ROOT, encoding: 'utf8', env });
  assert.equal(live.status, 1, live.stdout);

  const noKey = spawnSync(process.execPath, ['tools/release/qualification.mjs', 'capture-drill', '--out', join(dir, 'nokey.json'),
    '--drill-row', rowPath, '--reconstruction', reconPath, '--onboarding', setupPath, '--build', BUILD],
  { cwd: ROOT, encoding: 'utf8', env: { ...process.env, KEEL_QUALIFICATION_HMAC_KEY: '' } });
  assert.equal(noKey.status, 1);
  assert.match(noKey.stderr, /signing key/);
});
