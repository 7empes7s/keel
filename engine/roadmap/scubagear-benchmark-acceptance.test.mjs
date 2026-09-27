/**
 * Roadmap task-126 boundary tests: CISA ScubaGear benchmark pack qualification.
 *
 * Exercises the production ScubaGear import (rights/manifest verification,
 * representative aad+exo profile, NIST SP 800-53 evidence links) and the
 * qualification.mjs gate it registers, against the real pinned reference data
 * at /var/lib/keel/reference-data/scubagear/ (read-only) plus isolated
 * temp-directory copies for the adversarial manifest-tamper cases, so the
 * shared pinned fixture is never mutated by a test run.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  QUALIFICATION_CONTRACT_VERSION,
  SCUBAGEAR_BENCHMARK_OPERATION,
  importScubaGearProfile,
  signEvidence,
  verifyEvidence,
} from '../../tools/release/qualification.mjs';

const ROOT = new URL('../../', import.meta.url).pathname;
const QUALIFICATION_CLI = join(ROOT, 'tools/release/qualification.mjs');
const REAL_PIN_PATH = join(ROOT, 'docs/roadmap/benchmark-content/scubagear-pin.json');
const REAL_PIN = JSON.parse(readFileSync(REAL_PIN_PATH, 'utf8'));

function runCli(args, env = {}) {
  try {
    const stdout = execFileSync(process.execPath, [QUALIFICATION_CLI, ...args], {
      cwd: ROOT, env: { ...process.env, ...env }, encoding: 'utf8',
    });
    return { status: 0, stdout, stderr: '' };
  } catch (error) {
    return { status: error.status, stdout: error.stdout ?? '', stderr: error.stderr ?? '' };
  }
}

// Isolated copy of the real, hash-verified reference data so adversarial
// tests can corrupt bytes without ever touching the shared pinned fixture.
function tamperableCopy() {
  const dir = mkdtempSync(join(tmpdir(), 'keel-scubagear-'));
  cpSync(REAL_PIN.localPath, join(dir, 'reference'), { recursive: true });
  const pinPath = join(dir, 'pin.json');
  writeFileSync(pinPath, JSON.stringify({
    ...REAL_PIN,
    localPath: join(dir, 'reference') + '/',
    localManifest: join(dir, 'reference', 'MANIFEST.sha256'),
  }, null, 2));
  return { dir, pinPath };
}

// ------------------------------------------------------- profile import
test('imports a representative, hash-verified aad+exo profile with NIST evidence links', () => {
  const profile = importScubaGearProfile({ pinPath: REAL_PIN_PATH, workloads: ['aad', 'exo'] });
  assert.equal(profile.commitSha, REAL_PIN.commitSha);
  assert.deepEqual(profile.workloads, ['aad', 'exo']);
  assert.ok(Object.isFrozen(profile));
  assert.ok(Object.isFrozen(profile.policies));
  assert.equal(profile.policies.length, 43, 'aad (31 mapped) + exo (12 mapped) checks');

  const byId = new Map(profile.policies.map((p) => [p.policyId, p]));
  assert.deepEqual(byId.get('MS.AAD.1.1v1').nistControlIds, ['CM-7']);
  assert.deepEqual(byId.get('MS.AAD.2.1v1').nistControlIds, ['AC-2(12)', 'AC-2(13)']);
  assert.deepEqual(byId.get('MS.EXO.1.1v2').nistControlIds, ['AC-4']);
  assert.equal(byId.get('MS.AAD.1.1v1').workload, 'aad');
  assert.equal(byId.get('MS.EXO.1.1v2').workload, 'exo');

  // A real ScubaGear check with no row in the NIST mapping CSV is never
  // surfaced as an evidence-linked import — this is a chain of citations,
  // not a blanket compliance certification.
  assert.ok(!byId.has('MS.AAD.5.5v1'), 'unmapped checks are not surfaced as NIST evidence links');
});

test('rejects a pin whose licensing status is not public domain', () => {
  const { dir, pinPath } = tamperableCopy();
  try {
    const badPin = JSON.parse(readFileSync(pinPath, 'utf8'));
    badPin.licensing = { ...badPin.licensing, status: 'proprietary' };
    writeFileSync(pinPath, JSON.stringify(badPin, null, 2));
    assert.throws(() => importScubaGearProfile({ pinPath, workloads: ['aad', 'exo'] }), /public domain/i);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// Required mutation check: importing a policy file without checking it
// against MANIFEST.sha256 would let a corrupted or substituted policy pass
// silently. A byte-flipped copy, still named identically and still listed
// in the manifest under its original (now-stale) hash, must be refused.
test('refuses a policy file whose bytes do not match MANIFEST.sha256, before import', () => {
  const { dir, pinPath } = tamperableCopy();
  try {
    const regoPath = join(dir, 'reference', 'Rego', 'AADConfig.rego');
    writeFileSync(regoPath, readFileSync(regoPath, 'utf8') + '\n# tampered\n');
    assert.throws(
      () => importScubaGearProfile({ pinPath, workloads: ['aad', 'exo'] }),
      /manifest|hash/i,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('refuses a manifest with no entry for an imported file', () => {
  const { dir, pinPath } = tamperableCopy();
  try {
    const manifestPath = join(dir, 'reference', 'MANIFEST.sha256');
    const withoutAad = readFileSync(manifestPath, 'utf8')
      .split('\n').filter((line) => !line.includes('AADConfig.rego')).join('\n');
    writeFileSync(manifestPath, withoutAad);
    assert.throws(
      () => importScubaGearProfile({ pinPath, workloads: ['aad', 'exo'] }),
      /manifest|hash/i,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('refuses a substituted mapping file whose bytes do not match the manifest', () => {
  const { dir, pinPath } = tamperableCopy();
  try {
    const mappingPath = join(dir, 'reference', 'mappings', 'scuba-to-nist-sp-800-53-r5-fedramp-high.csv');
    writeFileSync(mappingPath, 'scuba-control-id,nist-800-53-control-id\nMS.AAD.1.1v1,FORGED-1\n');
    assert.throws(
      () => importScubaGearProfile({ pinPath, workloads: ['aad', 'exo'] }),
      /manifest|hash/i,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ------------------------------------------------------------- qualification gate
{
  const key = 'test-hmac-key-not-a-secret';
  const now = new Date('2026-09-27T04:00:00.000Z');
  const profile = importScubaGearProfile({ pinPath: REAL_PIN_PATH, workloads: ['aad', 'exo'] });
  const importedIds = profile.policies.map((p) => p.policyId);
  const baseEvidence = {
    contractVersion: QUALIFICATION_CONTRACT_VERSION,
    gate: 'scubagear-benchmark-acceptance',
    tenantRef: 'sha256:tenant-a',
    build: 'a'.repeat(40),
    operation: SCUBAGEAR_BENCHMARK_OPERATION,
    credentialMode: 'collector',
    observedAt: '2026-09-27T03:00:00.000Z',
    evidenceLevel: 'fixture-tested',
    synthetic: true,
    subject: {
      sourceCommitSha: profile.commitSha,
      manifestVerified: true,
      workloadsImported: ['aad', 'exo'],
      policiesEvaluated: [
        { policyId: 'MS.AAD.1.1v1', nistControlIds: ['CM-7'], verdict: 'unknown' },
        { policyId: 'MS.EXO.1.1v2', nistControlIds: ['AC-4'], verdict: 'unknown' },
      ],
    },
  };
  const verify = (evidence, options = {}) => verifyEvidence(evidence, { hmacKey: key, now, ...options });

  test('a valid independently captured record verifies', () => {
    const signed = signEvidence(baseEvidence, key, 'keel-fixture-runner');
    assert.deepEqual(verify(signed), { ok: true, failures: [] });
  });

  test('wrong build, forged mapping, absent evaluated workload and write credentials fail closed', () => {
    const signed = signEvidence(baseEvidence, key, 'keel-fixture-runner');
    assert.equal(verify(signed, { build: 'b'.repeat(40) }).ok, false);
    for (const patch of [
      { credentialMode: 'restorer' },
      { subject: { ...baseEvidence.subject, policiesEvaluated: [baseEvidence.subject.policiesEvaluated[0]] } },
      { subject: { ...baseEvidence.subject, policiesEvaluated: baseEvidence.subject.policiesEvaluated.map(entry => ({ ...entry, nistControlIds: ['FORGED-1'] })) } },
    ]) assert.equal(verify(signEvidence({ ...baseEvidence, ...patch }, key, 'keel-fixture-runner')).ok, false);
  });

  test('altered signature and artifact digest are refused', () => {
    const signed = signEvidence(baseEvidence, key, 'keel-fixture-runner');
    signed.proof.runner.signature = '0'.repeat(64);
    assert.equal(verify(signed).ok, false);
    const evidence = JSON.parse(readFileSync(join(ROOT, 'docs/release/qualifications/scubagear-benchmark-acceptance.json'), 'utf8'));
    evidence.proof.artifact.sha256 = '0'.repeat(64);
    assert.equal(verify(evidence, { evidenceDir: join(ROOT, 'docs/release/qualifications') }).ok, false);
  });

  // Required mutation check: accepting missing external evidence.
  test('missing proof fails closed', () => {
    const result = verify(baseEvidence);
    assert.equal(result.ok, false);
    assert.ok(result.failures.some((f) => f.startsWith('missing proof')));
  });

  // Required mutation check: accepting mismatched tenant or operation.
  test('cross-tenant evidence is refused', () => {
    const signed = signEvidence(baseEvidence, key, 'keel-fixture-runner');
    const result = verify(signed, { tenantRef: 'sha256:tenant-b' });
    assert.equal(result.ok, false);
    assert.ok(result.failures.some((f) => f.includes('cross-tenant')));
  });

  test('a mismatched operation is refused', () => {
    const signed = signEvidence({ ...baseEvidence, operation: 'scubagear.something-else' }, key, 'keel-fixture-runner');
    const result = verify(signed);
    assert.equal(result.ok, false);
    assert.ok(result.failures.some((f) => f.includes('operation mismatch')));
  });

  test('stale observations fail', () => {
    const signed = signEvidence({ ...baseEvidence, observedAt: '2026-01-01T00:00:00.000Z' }, key, 'keel-fixture-runner');
    const result = verify(signed);
    assert.equal(result.ok, false);
    assert.ok(result.failures.some((f) => f.includes('stale')));
  });

  test('a source commit that does not match the pin is refused', () => {
    const signed = signEvidence({
      ...baseEvidence, subject: { ...baseEvidence.subject, sourceCommitSha: 'f'.repeat(40) },
    }, key, 'keel-fixture-runner');
    const result = verify(signed);
    assert.equal(result.ok, false);
    assert.ok(result.failures.some((f) => f.includes('source commit mismatch')));
  });

  test('missing manifest verification attestation is refused (missing prerequisite)', () => {
    const signed = signEvidence({
      ...baseEvidence, subject: { ...baseEvidence.subject, manifestVerified: false },
    }, key, 'keel-fixture-runner');
    const result = verify(signed);
    assert.equal(result.ok, false);
    assert.ok(result.failures.some((f) => f.includes('MANIFEST.sha256')));
  });

  test('missing the required aad/exo workloads is refused', () => {
    const signed = signEvidence({
      ...baseEvidence, subject: { ...baseEvidence.subject, workloadsImported: ['aad'] },
    }, key, 'keel-fixture-runner');
    const result = verify(signed);
    assert.equal(result.ok, false);
    assert.ok(result.failures.some((f) => f.includes('aad, exo')));
  });

  test('a policy id outside the verified imported profile is refused', () => {
    assert.ok(!importedIds.includes('MS.AAD.99.99v1'));
    const signed = signEvidence({
      ...baseEvidence,
      subject: {
        ...baseEvidence.subject,
        policiesEvaluated: [{ policyId: 'MS.AAD.99.99v1', nistControlIds: ['XX-1'], verdict: 'unknown' }],
      },
    }, key, 'keel-fixture-runner');
    const result = verify(signed);
    assert.equal(result.ok, false);
    assert.ok(result.failures.some((f) => f.includes('not part of the verified imported profile')));
  });

  // Required mutation check: elevating fixture evidence to live-qualified.
  test('--require-live rejects synthetic fixtures, fixture-tested levels and synthetic runners', () => {
    for (const [label, evidence] of [
      ['synthetic fixture', signEvidence(baseEvidence, key, 'keel-fixture-runner')],
      ['fixture-tested level', signEvidence({ ...baseEvidence, synthetic: false }, key, 'keel-release-runner')],
      ['synthetic runner', signEvidence({ ...baseEvidence, evidenceLevel: 'live-qualified', synthetic: false }, key, 'keel-fixture-runner')],
      // Isolates the standalone `synthetic` flag: evidenceLevel is already
      // 'live-qualified' and the runner is already non-synthetic, so only
      // the synthetic:true flag itself can fail this one.
      ['synthetic flag alone', signEvidence({ ...baseEvidence, evidenceLevel: 'live-qualified', synthetic: true }, key, 'keel-release-runner')],
    ]) {
      const result = verify(evidence, { requireLive: true });
      assert.equal(result.ok, false, label);
    }
    const live = signEvidence({ ...baseEvidence, evidenceLevel: 'live-qualified', synthetic: false }, key, 'keel-release-runner');
    assert.deepEqual(verify(live, { requireLive: true }), { ok: true, failures: [] });
  });

  // CLI end-to-end, mirroring foundation.test.mjs's release-readiness coverage.
  test('CLI: valid fixture evidence passes; require-live, proofless and cross-tenant all exit nonzero', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'keel-scubagear-cli-'));
    try {
      const cliBase = { ...baseEvidence, observedAt: new Date().toISOString() };
      const cliSigned = signEvidence(cliBase, key, 'keel-fixture-runner');
      const evidencePath = join(tmp, 'evidence.json');
      writeFileSync(evidencePath, JSON.stringify(cliSigned, null, 2));

      // task-119 added a convenience default: an unspecified --build falls back
      // to the real `git rev-parse HEAD`, which this fixture's placeholder build
      // ('a'.repeat(40)) will never match. Supply it explicitly via the env var
      // the CLI already reads, so this test keeps proving "no --build flag was
      // passed" without accidentally asserting against the real repo HEAD.
      const pass = runCli(['verify', '--gate', 'scubagear-benchmark-acceptance', '--evidence', evidencePath], {
        KEEL_QUALIFICATION_HMAC_KEY: key,
        KEEL_QUALIFICATION_BUILD: baseEvidence.build,
      });
      assert.equal(pass.status, 0, pass.stderr);
      assert.deepEqual(JSON.parse(pass.stdout), { ok: true, failures: [] });

      const requireLive = runCli(['verify', '--gate', 'scubagear-benchmark-acceptance', '--evidence', evidencePath, '--require-live'], {
        KEEL_QUALIFICATION_HMAC_KEY: key,
      });
      assert.equal(requireLive.status, 1, '--require-live rejects synthetic fixtures');
      assert.ok(requireLive.stdout.includes('synthetic'));

      const prooflessPath = join(tmp, 'proofless.json');
      writeFileSync(prooflessPath, JSON.stringify(cliBase, null, 2));
      const proofless = runCli(['verify', '--gate', 'scubagear-benchmark-acceptance', '--evidence', prooflessPath], {
        KEEL_QUALIFICATION_HMAC_KEY: key,
      });
      assert.equal(proofless.status, 1, 'missing proof exits nonzero');
      assert.ok(proofless.stdout.includes('missing proof'));

      const foreign = runCli(['verify', '--gate', 'scubagear-benchmark-acceptance', '--evidence', evidencePath, '--tenant', 'sha256:tenant-b'], {
        KEEL_QUALIFICATION_HMAC_KEY: key,
      });
      assert.equal(foreign.status, 1, 'cross-tenant evidence exits nonzero');
      assert.ok(foreign.stdout.includes('cross-tenant'));
      assert.ok(!pass.stdout.includes(key), 'key material is never printed');
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  // The committed evidence scaffold at docs/release/qualifications is itself
  // schema-valid and honestly marked fixture-tested/synthetic: it exists so
  // the wiring is provably correct, never to fake a live qualification.
  test('the committed evidence scaffold is schema-valid but not live-qualified', () => {
    const evidencePath = join(ROOT, 'docs/release/qualifications/scubagear-benchmark-acceptance.json');
    const evidence = JSON.parse(readFileSync(evidencePath, 'utf8'));
    assert.equal(evidence.gate, 'scubagear-benchmark-acceptance');
    assert.equal(evidence.evidenceLevel, 'fixture-tested');
    assert.equal(evidence.synthetic, true);
    if (evidence.proof?.artifact) {
      const artifactPath = join(ROOT, 'docs/release/qualifications', evidence.proof.artifact.path);
      const actual = createHash('sha256').update(readFileSync(artifactPath)).digest('hex');
      assert.equal(actual, evidence.proof.artifact.sha256, 'artifact digest must match committed bytes');
    }
    const evidenceDir = join(ROOT, 'docs/release/qualifications');
    const result = verifyEvidence(evidence, { gate: 'scubagear-benchmark-acceptance', now: new Date(), evidenceDir });
    assert.equal(result.ok, true, JSON.stringify(result.failures));
    assert.equal(
      verifyEvidence(evidence, {
        gate: 'scubagear-benchmark-acceptance', requireLive: true, now: new Date(), evidenceDir,
      }).ok,
      false,
      'the committed scaffold must never satisfy --require-live by itself',
    );
  });
}


