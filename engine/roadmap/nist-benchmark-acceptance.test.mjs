import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { importNistPack, evaluatePack } from '../benchmarks/packs.mjs';
import { loadNistProfile, nistPackInput, validateLicense } from '../../tools/qualification/benchmarkLicense.mjs';
import { signEvidence, verifyEvidence, verifyEvidenceFile } from '../../tools/release/qualification.mjs';
import { tenantRefFor } from '../store/tenantRef.mjs';
const tenantRef = tenantRefFor('nist-fixture');
const now = new Date('2026-09-27T12:00:00Z');
const context = { tenantRef, principal: { id: 'fixture' }, client: { async query() { return { rows: [{ role: 'admin', scope: '*' }, { role: 'viewer', scope: '*' }] }; } } };
const options = { gate: 'nist-benchmark-acceptance', tenantRef, build: 'fixture-build', now, hmacKey: 'test-only', requireLive: true };
function record() {
  const { pin } = loadNistProfile();
  return { contractVersion: 1, gate: options.gate, tenantRef, build: options.build,
    operation: 'nist-benchmark-evaluate', credentialMode: 'collector', observedAt: now.toISOString(),
    evidenceLevel: 'live-qualified', synthetic: false,
    subject: { sourceUrl: pin.sourceUrl, sourceDigest: pin.sha256, catalogVersion: pin.catalogVersion,
      profile: 'AC-IA-AU-CM', prerequisite: 'task-86', fixtureResults: [
        { controlId: 'keel-custom.role-assignment.admin-count-at-most', pass: 'pass', fail: 'fail', missing: 'unknown' },
        { controlId: 'keel-custom.named-location.no-untrusted-all-countries', pass: 'pass', fail: 'fail', missing: 'unknown' },
        { controlId: 'keel-custom.group.role-assignable-not-synced', pass: 'pass', fail: 'fail', missing: 'unknown' },
      ] } };
}
test('actual pinned catalog imports representative families; substituted bytes fail before import', async () => {
  const profile = loadNistProfile();
  assert.deepEqual([...new Set(profile.controls.map(c => c.id.split('-')[0]))].sort(), ['ac','au','cm','ia']);
  assert.equal(profile.controls.length, 68);
  const bytes = readFileSync(profile.pin.localPath);
  assert.throws(() => loadNistProfile({ catalogBytes: Buffer.concat([bytes, Buffer.from(' ')]) }), /digest/);
  const pack = await importNistPack(context);
  assert.equal(pack.rights.licensing.status, 'public-domain');
  assert.ok(pack.controls.every(c => c.frameworkRefs.every(r => r.relationship === 'evidence-link')));
  const result = await evaluatePack({ ...context, pack, now });
  assert.ok(result.results.every(r => r.verdict === 'unknown'));
  assert.equal(result.qualification, 'fixture-tested');
  await assert.rejects(importNistPack({ ...context, client: { async query() { return { rows: [] }; } } }), /forbidden/);
});
test('mapped original controls produce expected pass/fail/missing fixtures', async () => {
  const pack = await importNistPack(context);
  for (const risky of [false, true]) {
    const resources = { roleAssignment: Array.from({length: risky ? 6 : 1}, () => ({ roleDefinitionId: '62e90394-69f5-4237-9190-012177145e10' })),
      namedLocation: [{ isTrusted: true, includeUnknownCountriesAndRegions: risky }],
      group: [{ isAssignableToRole: true, onPremisesSyncEnabled: risky }] };
    const observations = Object.fromEntries(Object.entries(resources).map(([resourceType, values]) => [resourceType, {
      resources: values, observation: { tenantRef, resourceType, completeness: 'complete', window: { startedAt: now.toISOString(), endedAt: now.toISOString() } } }]));
    const result = await evaluatePack({ ...context, pack, observations, now });
    assert.deepEqual(result.results.map(r => r.verdict), Array(3).fill(risky ? 'fail' : 'pass'));
  }
});
test('independently signed runner record binds prerequisite, source, tenant, build and operation', () => {
  assert.equal(verifyEvidence(signEvidence(record(), 'test-only'), options).ok, true);
  for (const patch of [{ tenantRef: tenantRefFor('other') }, { build: 'other' }, { operation: 'write' },
    { observedAt: '2020-01-01T00:00:00Z' }, { credentialMode: 'restorer' },
    { subject: { ...record().subject, prerequisite: undefined } },
    { subject: { ...record().subject, sourceDigest: 'bad' } },
    { subject: { ...record().subject, fixtureResults: [] } },
    { synthetic: true }, { evidenceLevel: 'fixture-tested' }]) {
    assert.equal(verifyEvidence(signEvidence({ ...record(), ...patch }, 'test-only'), options).ok, false, JSON.stringify(patch));
  }
  const tampered = signEvidence(record(), 'test-only'); tampered.build = 'altered';
  assert.equal(verifyEvidence(tampered, options).ok, false);
  assert.equal(verifyEvidence(signEvidence(record(), 'test-only', 'keel-fixture-runner'), options).ok, false);
  assert.equal(verifyEvidence(null, options).ok, false);
  assert.equal(verifyEvidenceFile('/nonexistent/nist-evidence.json', options).ok, false);
  assert.equal(verifyEvidence(signEvidence(record(), 'test-only'), { ...options, tenantRef: null }).ok, false);
});

test('public-domain admission cannot be forged by uploading a status or altering generated rights', () => {
  const input = nistPackInput(tenantRef);
  assert.equal(validateLicense({ ...input, tenantRef, use: 'embedded' }).licensing.status, 'public-domain');
  assert.throws(() => validateLicense({ ...input, tenantRef, rights: { ...input.rights }, grants: [] }), /reviewed grant/);
  assert.throws(() => validateLicense({ ...input, tenantRef, source: input.source + ' ' }), /digest/);
  assert.throws(() => validateLicense({ ...input, tenantRef: tenantRefFor('foreign') }), /mismatch/);
});

test('an altered artifact digest fails even alongside a valid runner signature', () => {
  const dir = mkdtempSync('/tmp/keel-nist-proof-');
  try {
    writeFileSync(`${dir}/capture.json`, '{}');
    const evidence = signEvidence({ ...record(), proof: { artifact: { path: 'capture.json', sha256: '0'.repeat(64) } } }, 'test-only');
    assert.equal(verifyEvidence(evidence, { ...options, evidenceDir: dir }).ok, false);
    assert.equal(verifyEvidence({ gate: options.gate, status: 'pending' }, options).ok, false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('NIST fixture evidence cannot claim live qualification without the CLI require-live flag', () => {
  const offlineOptions = { ...options, requireLive: false };
  assert.equal(verifyEvidence(signEvidence(record(), 'test-only'), offlineOptions).ok, true);
  assert.equal(verifyEvidence(signEvidence({ ...record(), synthetic: true }, 'test-only'), offlineOptions).ok, false);
  assert.equal(verifyEvidence(signEvidence(record(), 'test-only', 'keel-fixture-runner'), offlineOptions).ok, false);
  assert.equal(verifyEvidence(signEvidence({ ...record(), synthetic: true, evidenceLevel: 'fixture-tested' },
    'test-only', 'keel-fixture-runner'), offlineOptions).ok, true);
});

test('nistLive capture runs the real seam and its record verifies only as the runner it was signed by', async () => {
  const { captureNistAcceptance } = await import('../../tools/qualification/nistLive.mjs');
  const live = await captureNistAcceptance({ ...context, build: options.build, now,
    runner: { identity: 'keel-release-runner', key: 'test-only' } });
  assert.equal(live.evidenceLevel, 'live-qualified');
  assert.equal(verifyEvidence(live, options).ok, true);
  const fixture = await captureNistAcceptance({ ...context, build: options.build, now,
    runner: { identity: 'keel-fixture-runner', key: 'test-only' } });
  assert.equal(fixture.synthetic, true);
  assert.equal(verifyEvidence(fixture, options).ok, false, 'a fixture-runner capture never satisfies --require-live');
  await assert.rejects(captureNistAcceptance({ ...context, client: { async query() { return { rows: [] }; } },
    build: options.build, now, runner: { identity: 'keel-release-runner', key: 'test-only' } }), /forbidden/);
});
