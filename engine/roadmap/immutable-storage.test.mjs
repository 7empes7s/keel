/**
 * Roadmap task-69 boundary tests: qualify independent retention-locked
 * storage. Exercises the production engine/storage/s3Compatible.mjs,
 * engine/storage/qualification.mjs and tools/qualification/storageLock.mjs
 * against injected fake S3-compatible clients — including the three required
 * mutation checks:
 *
 * - Infer Object Lock from S3 compatibility.
 * - Mark upload success as immutable proof.
 * - Skip retention-mode check.
 *
 * No live provider, credential or real deletion is involved; every client is
 * the synthetic fixture, and fixture evidence never exceeds 'fixture-tested'.
 */
import { strict as assert } from 'node:assert';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';

import { sha256Hex } from '../export/manifest.mjs';
import { assertStorageAdapter } from '../storage/adapter.mjs';
import {
  createS3CompatibleAdapter,
  probeS3Capabilities,
  S3_PROVIDER,
  UPLOAD_NOT_IMMUTABLE_NOTE,
} from '../storage/s3Compatible.mjs';
import {
  evaluateStorageQualification,
  retentionClaimFor,
  STORAGE_QUALIFICATION_VERSION,
} from '../storage/qualification.mjs';
import {
  createFakeS3Client,
  runCli,
  runStorageLockQualification,
} from '../../tools/qualification/storageLock.mjs';

const tmp = mkdtempSync(join(tmpdir(), 'keel-immutable-storage-'));
after(() => rmSync(tmp, { recursive: true, force: true }));

const TENANT_REF = 'sha256:immutable-happy';
const BUCKET = 'keel-recovery-fixture';
const RESIDENCY = Object.freeze({
  region: 'eu-fixture-1',
  boundary: 'EU data boundary',
  credentialBoundary: 'storage credential reference: vault entry keel/immutable-storage (reference only)',
});
const KEY_RECOVERY = Object.freeze({
  heldBy: 'security officer',
  location: 'offline safe, sealed envelope #9',
  instructions: 'Retrieve envelope #9 from the offline safe; the passphrase is held separately by the security officer.',
});

function lockedClient(overrides = {}) {
  return createFakeS3Client({ objectLock: true, ...overrides });
}

function qualify(client, overrides = {}) {
  return runStorageLockQualification({
    client,
    bucket: BUCKET,
    tenantRef: TENANT_REF,
    credentialClass: 'retention-scoped',
    residency: RESIDENCY,
    keyRecovery: KEY_RECOVERY,
    ...overrides,
  });
}

test('fake locked provider rejects deletion, reports retention, and qualifies fixture-tested', async () => {
  const { probe, harness, evaluation } = await qualify(lockedClient());

  // The probe OBSERVED Object Lock and encryption — nothing was inferred.
  assert.equal(probe.provider, S3_PROVIDER);
  assert.equal(probe.objectLock.supported, true);
  assert.equal(probe.objectLock.mode, 'COMPLIANCE');
  assert.equal(probe.objectLock.days, 30);
  assert.equal(probe.encryption.supported, true);
  assert.equal(probe.encryption.algorithm, 'AES256');

  // The canary was published, read back with checksum verification, and its
  // deletion was refused with the observed retention reported.
  assert.equal(harness.synthetic, true, 'builder fixtures are always synthetic');
  assert.equal(harness.publish.ok, true);
  assert.equal(harness.publish.immutableProof, false, 'upload success is never immutable proof');
  assert.deepEqual(harness.readback.attempts, [{ attempt: 1, outcome: 'checksum-verified' }]);
  assert.equal(harness.readback.checksumVerified, true);
  assert.equal(harness.deletionTest.refused, true);
  assert.equal(harness.deletionTest.code, 'AccessDenied');
  assert.equal(harness.retentionStatus.mode, 'COMPLIANCE');
  assert.ok(Date.parse(harness.retentionStatus.retainUntilDate) > Date.now(), 'a retention date is reported');
  assert.equal(harness.bypassTest.credentialCouldAlterRetention, false);
  assert.equal(harness.cleanup.removed, false, 'the locked canary remains until retention expires');
  assert.match(harness.canary.name, /^qualification\/canary-.*\.bin$/);
  assert.match(harness.canary.sha256, /^[0-9a-f]{64}$/);

  // The verdict is qualified but only fixture-tested — a fake proves code
  // behavior, not provider behavior (Global Constraint #6).
  assert.equal(evaluation.version, STORAGE_QUALIFICATION_VERSION);
  assert.equal(evaluation.qualified, true, JSON.stringify(evaluation.failures));
  assert.equal(evaluation.evidenceLevel, 'fixture-tested');
  assert.equal(evaluation.synthetic, true);
  assert.deepEqual(evaluation.failures, []);

  // The binding pins provider/bucket/mode/retention/credential boundary and
  // the canary artifact evidence.
  assert.equal(evaluation.binding.provider, S3_PROVIDER);
  assert.equal(evaluation.binding.bucket, BUCKET);
  assert.equal(evaluation.binding.mode, 'COMPLIANCE');
  assert.equal(evaluation.binding.defaultRetentionDays, 30);
  assert.equal(evaluation.binding.credentialBoundary, RESIDENCY.credentialBoundary);
  assert.equal(evaluation.binding.canary.name, harness.canary.name);
  assert.equal(evaluation.binding.canary.sha256, harness.canary.sha256);

  // An adapter constructed WITH the qualification may claim fixture-tested —
  // never live-qualified from synthetic evidence.
  const adapter = createS3CompatibleAdapter({
    bucket: BUCKET,
    client: lockedClient(),
    residency: RESIDENCY,
    probe,
    qualification: evaluation,
  });
  assert.equal(adapter.capabilities.retentionLock, 'fixture-tested');
  assert.equal(adapter.capabilities.immutability, 'fixture-tested');
  assert.equal(assertStorageAdapter(adapter), adapter);
});

test('reported COMPLIANCE cannot qualify when the client actually deletes the canary', async () => {
  // Keep real in-memory deletion independent of the provider's lock metadata.
  // All other qualification conditions pass, so no second failure can mask
  // a harness that hardcodes deletionTest.refused instead of observing it.
  const client = createFakeS3Client({ objectLock: false });
  const metadata = lockedClient();
  client.getObjectLockConfiguration = metadata.getObjectLockConfiguration;
  client.getObjectRetention = async () => ({
    mode: 'COMPLIANCE',
    retainUntilDate: new Date(Date.now() + 30 * 86400000).toISOString(),
  });
  const deletions = [];
  const deleteObject = client.deleteObject;
  client.deleteObject = async (request) => {
    const result = await deleteObject(request);
    deletions.push({ ...request });
    return result;
  };

  const { probe, harness, evaluation } = await qualify(client);
  assert.equal(probe.objectLock.supported, true);
  assert.equal(probe.objectLock.mode, 'COMPLIANCE');
  assert.equal(harness.retentionStatus.mode, 'COMPLIANCE');
  assert.equal(harness.publish.ok, true);
  assert.equal(harness.readback.checksumVerified, true);
  assert.equal(harness.bypassTest.credentialCouldAlterRetention, false);
  assert.deepEqual(deletions, [
    { bucket: BUCKET, key: harness.canary.name },
    { bucket: BUCKET, key: harness.canary.name },
  ]);
  await assert.rejects(client.getObject({ key: harness.canary.name }), { code: 'NotFound' });
  assert.equal(harness.deletionTest.refused, false);
  assert.equal(harness.cleanup.removed, true);
  assert.deepEqual(evaluation.failures, [
    'canary deletion was not refused — no retention lock is in effect',
  ]);
  assert.equal(evaluation.qualified, false);
  assert.equal(evaluation.binding, null);
  assert.equal(evaluation.evidenceLevel, null);
  assert.equal(retentionClaimFor({ evaluation, probe }), 'unknown');
  const adapter = createS3CompatibleAdapter({
    bucket: BUCKET, client, residency: RESIDENCY, probe, qualification: evaluation,
  });
  assert.equal(adapter.capabilities.retentionLock, 'unknown');
  assert.equal(adapter.capabilities.immutability, 'unknown');
});

test('unsupported backend stays not-qualified (mutation pin: infer Object Lock from S3 compatibility)', async () => {
  // The provider IS S3-compatible (the client speaks the dialect) but reports
  // no Object Lock. Compatibility must not be upgraded into lock support.
  const client = createFakeS3Client({ objectLock: false });
  const probe = await probeS3Capabilities(client, { bucket: BUCKET });
  assert.equal(probe.provider, S3_PROVIDER);
  assert.equal(probe.objectLock.supported, false);
  assert.match(probe.objectLock.reason, /ObjectLockConfigurationNotFoundError/);

  const { harness, evaluation } = await qualify(client);
  assert.equal(harness.publish.ok, false, 'nothing is published to an unobserved backend');
  assert.equal(evaluation.qualified, false);
  assert.ok(evaluation.failures.some((f) => f.includes('Object Lock was not observed') && f.includes('S3 compatibility alone')));
  assert.ok(evaluation.failures.some((f) => f.includes('deletion was not refused')));
  assert.equal(evaluation.binding, null);
  assert.equal(evaluation.evidenceLevel, null);

  // Capability claims stay honest: unsupported, never fixture/live-qualified.
  assert.equal(retentionClaimFor({ probe }), 'unsupported');
  const adapter = createS3CompatibleAdapter({ bucket: BUCKET, client, residency: RESIDENCY, probe });
  assert.equal(adapter.capabilities.retentionLock, 'unsupported');
  assert.equal(adapter.capabilities.immutability, 'unsupported');
});

test('upload success alone is not immutable proof (mutation pin: mark upload success as immutable proof)', async () => {
  const client = lockedClient();
  const probe = await probeS3Capabilities(client, { bucket: BUCKET });
  const adapter = createS3CompatibleAdapter({ bucket: BUCKET, client, residency: RESIDENCY, probe });

  const published = await adapter.publish('dumps/keel-db.sql.gz', Buffer.from('dump bytes'));
  assert.equal(published.sha256, sha256Hex(Buffer.from('dump bytes')));
  assert.equal(published.immutableProof, false, 'a successful publish carries no immutability claim');
  assert.equal(UPLOAD_NOT_IMMUTABLE_NOTE.length > 0, true);

  // Probe observed Object Lock, but without harness evidence there is no
  // behavioral proof: the claim stays 'unknown' and the verdict not-qualified.
  assert.equal(adapter.capabilities.retentionLock, 'unknown');
  assert.equal(retentionClaimFor({ probe }), 'unknown');
  assert.equal(retentionClaimFor({}), 'unknown');

  const evaluation = evaluateStorageQualification({
    tenantRef: TENANT_REF,
    probe,
    harness: null,
    residency: RESIDENCY,
    keyRecovery: KEY_RECOVERY,
  });
  assert.equal(evaluation.qualified, false);
  assert.ok(evaluation.failures.some((f) => f.includes('a successful upload is not proof of immutability')));

  // A harness-shaped record with the deletion test omitted is equally refused.
  const hollow = evaluateStorageQualification({
    tenantRef: TENANT_REF,
    probe,
    harness: {
      synthetic: true, provider: S3_PROVIDER, bucket: BUCKET, credentialClass: 'retention-scoped',
      canary: { name: 'qualification/canary-x.bin', sha256: published.sha256, bytes: 10 },
      publish: { ok: true },
      readback: { ok: true, checksumVerified: true, attempts: [] },
      retentionStatus: { mode: 'COMPLIANCE', retainUntilDate: new Date(Date.now() + 86400000).toISOString() },
      bypassTest: { credentialCouldAlterRetention: false },
    },
    residency: RESIDENCY,
    keyRecovery: KEY_RECOVERY,
  });
  assert.equal(hollow.qualified, false);
  assert.ok(hollow.failures.some((f) => f.includes('deletion was not refused')));
});

test('GOVERNANCE mode never qualifies (mutation pin: skip retention-mode check)', async () => {
  // Deletion is refused even under GOVERNANCE (the fixture credential holds
  // no bypass privilege) — but GOVERNANCE is bypassable in principle, so the
  // mode check, not the deletion observation, decides.
  const { harness, evaluation } = await qualify(lockedClient({ mode: 'GOVERNANCE' }));
  assert.equal(harness.deletionTest.refused, true, 'deletion was refused, yet this must not qualify');
  assert.equal(harness.retentionStatus.mode, 'GOVERNANCE');
  assert.equal(evaluation.qualified, false);
  assert.ok(evaluation.failures.some((f) => f.includes('"GOVERNANCE"') && f.includes('not COMPLIANCE')));
  assert.equal(evaluation.binding, null);
});

test('an account-admin credential cannot be confused with a retention-scoped credential', async () => {
  // Declared account-admin: refused even though every behavioral test passed.
  for (const credentialClass of ['account-admin', 'unknown']) {
    const { harness, evaluation } = await qualify(lockedClient(), { credentialClass });
    assert.equal(harness.deletionTest.refused, true);
    assert.equal(harness.bypassTest.credentialCouldAlterRetention, false);
    assert.equal(evaluation.qualified, false, `credentialClass ${credentialClass} must not qualify`);
    assert.ok(evaluation.failures.some((f) => f.includes('not \'retention-scoped\'')), JSON.stringify(evaluation.failures));
  }

  // Declared retention-scoped but OBSERVED able to alter retention: the
  // behavior contradicts the declaration and disqualifies the target — the
  // two credential classes cannot be confused by labeling.
  const { harness, evaluation } = await qualify(
    lockedClient({ credentialCanAlterRetention: true }),
    { credentialClass: 'retention-scoped' },
  );
  assert.equal(harness.bypassTest.credentialCouldAlterRetention, true);
  assert.equal(evaluation.qualified, false);
  assert.ok(evaluation.failures.some((f) => f.includes('able to alter retention')));

  // The harness itself refuses an out-of-vocabulary class.
  await assert.rejects(qualify(lockedClient(), { credentialClass: 'super-user' }), /credentialClass/);
});

test('every readback attempt verifies the object checksum; corruption is disqualifying', async () => {
  // A read that returns corrupted bytes is caught by the checksum — a retry
  // without verification would have accepted it.
  const corrupted = await qualify(lockedClient({ corruptReadOnAttempt: 1 }));
  assert.deepEqual(corrupted.harness.readback.attempts, [{ attempt: 1, outcome: 'checksum-mismatch' }]);
  assert.equal(corrupted.harness.readback.checksumVerified, false);
  assert.equal(corrupted.evaluation.qualified, false);
  assert.ok(corrupted.evaluation.failures.some((f) => f.includes('checksum-verified')));

  // Transient transport errors may be retried; the successful read is still
  // checksum-verified.
  const flaky = await qualify(lockedClient({ readErrorAttempts: 2 }));
  assert.deepEqual(
    flaky.harness.readback.attempts.map((a) => a.outcome),
    ['error: SlowDown', 'error: SlowDown', 'checksum-verified'],
  );
  assert.equal(flaky.harness.readback.checksumVerified, true);
  assert.equal(flaky.evaluation.qualified, true, JSON.stringify(flaky.evaluation.failures));

  // Corruption reported by the adapter verify path as well.
  const client = lockedClient({ corruptReadOnAttempt: 1 });
  const adapter = createS3CompatibleAdapter({ bucket: BUCKET, client, residency: RESIDENCY });
  const bytes = Buffer.from('verify me');
  await adapter.publish('verify/target', bytes);
  const check = await adapter.verify('verify/target', { sha256: sha256Hex(bytes) });
  assert.equal(check.ok, false);
  assert.ok(check.failures.some((f) => f.includes('checksum mismatch')));
});

test('forged canary checksum or missing retention expiry never qualifies', async () => {
  const { probe, harness, evaluation } = await qualify(lockedClient());
  assert.equal(evaluation.qualified, true, JSON.stringify(evaluation.failures));

  // Forged canary checksums: blank, non-hex, wrong length, uppercase — none
  // of them are observed sha256 evidence, so none may qualify (the HEX64
  // format check in evaluateStorageQualification is load-bearing).
  for (const sha256 of ['', 'not-a-checksum', 'z'.repeat(64), 'A'.repeat(64), '0'.repeat(63)]) {
    const forged = evaluateStorageQualification({
      tenantRef: TENANT_REF,
      probe,
      harness: { ...harness, canary: { ...harness.canary, sha256 } },
      residency: RESIDENCY,
      keyRecovery: KEY_RECOVERY,
    });
    assert.equal(forged.qualified, false, `canary sha256 ${JSON.stringify(sha256)} must not qualify`);
    assert.ok(forged.failures.some((f) => f.includes('sha256')), JSON.stringify(forged.failures));
    assert.equal(forged.binding, null);
    assert.equal(forged.evidenceLevel, null);
  }
  // A canary record without the checksum field at all is equally refused.
  const noChecksum = evaluateStorageQualification({
    tenantRef: TENANT_REF,
    probe,
    harness: { ...harness, canary: { name: harness.canary.name, bytes: harness.canary.bytes } },
    residency: RESIDENCY,
    keyRecovery: KEY_RECOVERY,
  });
  assert.equal(noChecksum.qualified, false);
  assert.ok(noChecksum.failures.some((f) => f.includes('sha256')));

  // No observed retention expiry: undefined, null and empty retainUntilDate
  // all fail — qualification requires an observed retention period, not just
  // a refused deletion (the retainUntilDate presence check is load-bearing).
  for (const retainUntilDate of [undefined, null, '']) {
    const undated = evaluateStorageQualification({
      tenantRef: TENANT_REF,
      probe,
      harness: { ...harness, retentionStatus: { ...harness.retentionStatus, retainUntilDate } },
      residency: RESIDENCY,
      keyRecovery: KEY_RECOVERY,
    });
    assert.equal(undated.qualified, false, `retainUntilDate ${JSON.stringify(retainUntilDate)} must not qualify`);
    assert.ok(undated.failures.some((f) => f.includes('retention period')), JSON.stringify(undated.failures));
    assert.equal(undated.binding, null);
    assert.equal(undated.evidenceLevel, null);
  }
  // A retention status missing the field entirely is refused the same way.
  const noStatus = evaluateStorageQualification({
    tenantRef: TENANT_REF,
    probe,
    harness: { ...harness, retentionStatus: { mode: 'COMPLIANCE' } },
    residency: RESIDENCY,
    keyRecovery: KEY_RECOVERY,
  });
  assert.equal(noStatus.qualified, false);
  assert.ok(noStatus.failures.some((f) => f.includes('retention period')));
});

test('residency.region is required independently of the other qualification evidence', async () => {
  const { probe, harness, evaluation } = await qualify(lockedClient());
  assert.equal(evaluation.qualified, true, JSON.stringify(evaluation.failures));

  for (const region of [undefined, null, '', 42]) {
    const residency = { ...RESIDENCY, region };
    if (region === undefined) delete residency.region;
    const verdict = evaluateStorageQualification({
      tenantRef: TENANT_REF, probe, harness, residency, keyRecovery: KEY_RECOVERY,
    });
    assert.equal(verdict.qualified, false, `region ${JSON.stringify(region)} must not qualify`);
    assert.equal(verdict.failures.length, 1, JSON.stringify(verdict.failures));
    assert.match(verdict.failures[0], /residency\.region is required/);
    assert.equal(verdict.binding, null);
    assert.equal(verdict.evidenceLevel, null);
    assert.equal(retentionClaimFor({ evaluation: verdict, probe }), 'unknown');
  }
});

test('canary publish must explicitly succeed even when all other evidence passes', async () => {
  const { probe, harness, evaluation } = await qualify(lockedClient());
  assert.equal(evaluation.qualified, true, JSON.stringify(evaluation.failures));

  for (const ok of [false, undefined, null, 'true', 1]) {
    const publish = { ...harness.publish, ok };
    if (ok === undefined) delete publish.ok;
    const verdict = evaluateStorageQualification({
      tenantRef: TENANT_REF, probe, harness: { ...harness, publish },
      residency: RESIDENCY, keyRecovery: KEY_RECOVERY,
    });
    assert.equal(verdict.qualified, false, `publish.ok ${JSON.stringify(ok)} must not qualify`);
    assert.equal(verdict.failures.length, 1, JSON.stringify(verdict.failures));
    assert.match(verdict.failures[0], /canary publish did not succeed/);
    assert.equal(verdict.binding, null);
    assert.equal(verdict.evidenceLevel, null);
    assert.equal(retentionClaimFor({ evaluation: verdict, probe }), 'unknown');
  }
});

test('expectedBinding.mode must match independently of observed COMPLIANCE retention', async () => {
  const expectedBinding = {
    provider: S3_PROVIDER, bucket: BUCKET, mode: 'COMPLIANCE',
    credentialBoundary: RESIDENCY.credentialBoundary,
  };
  const { probe, harness, evaluation } = await qualify(lockedClient(), { expectedBinding });
  assert.equal(evaluation.qualified, true, JSON.stringify(evaluation.failures));
  assert.equal(harness.retentionStatus.mode, 'COMPLIANCE');

  const verdict = evaluateStorageQualification({
    tenantRef: TENANT_REF, probe, harness,
    residency: RESIDENCY, keyRecovery: KEY_RECOVERY,
    expectedBinding: { ...expectedBinding, mode: 'GOVERNANCE' },
  });
  assert.equal(verdict.qualified, false);
  assert.equal(verdict.failures.length, 1, JSON.stringify(verdict.failures));
  assert.match(verdict.failures[0], /binding mismatch: expected mode "GOVERNANCE", harness ran against "COMPLIANCE"/);
  assert.equal(verdict.binding, null);
  assert.equal(verdict.evidenceLevel, null);
  assert.equal(retentionClaimFor({ evaluation: verdict, probe }), 'unknown');
});

test('encryption, residency and independent recovery material references are required', async () => {
  // No bucket encryption observed.
  const unencrypted = await qualify(lockedClient({ encryption: null }));
  assert.equal(unencrypted.probe.encryption.supported, false);
  assert.equal(unencrypted.evaluation.qualified, false);
  assert.ok(unencrypted.evaluation.failures.some((f) => f.includes('encryption was not observed')));

  // Missing residency / credential boundary.
  const noBoundary = await qualify(lockedClient(), { residency: { region: 'eu-fixture-1', boundary: 'EU data boundary' } });
  assert.equal(noBoundary.evaluation.qualified, false);
  assert.ok(noBoundary.evaluation.failures.some((f) => f.includes('residency.credentialBoundary is required')));

  // Missing independent key recovery material references.
  const noKeys = await qualify(lockedClient(), { keyRecovery: null });
  assert.equal(noKeys.evaluation.qualified, false);
  assert.ok(noKeys.evaluation.failures.some((f) => f.includes('keyRecovery.heldBy is required')));
  assert.ok(noKeys.evaluation.failures.some((f) => f.includes('keyRecovery.instructions is required')));

  // Credential-shaped metadata is refused by the evaluator, never recorded
  // (Global Constraint #7).
  const good = await qualify(lockedClient());
  const poisonedEval = evaluateStorageQualification({
    tenantRef: TENANT_REF,
    probe: good.probe,
    harness: good.harness,
    residency: { ...RESIDENCY, credentialBoundary: 'password=hunter2' },
    keyRecovery: KEY_RECOVERY,
  });
  assert.equal(poisonedEval.qualified, false);
  assert.ok(poisonedEval.failures.some((f) => f.includes('embed credential material')));

  // ...and adapter/harness construction refuses it outright as well.
  await assert.rejects(
    qualify(lockedClient(), { residency: { ...RESIDENCY, credentialBoundary: 'password=hunter2' } }),
    /embed credential material/,
  );
});

test('qualification binds exactly to provider/bucket/mode/credential boundary and canary evidence', async () => {
  const client = lockedClient();
  const probe = await probeS3Capabilities(client, { bucket: BUCKET });
  const { harness, evaluation } = await qualify(client, {
    expectedBinding: {
      provider: S3_PROVIDER,
      bucket: BUCKET,
      mode: 'COMPLIANCE',
      credentialBoundary: RESIDENCY.credentialBoundary,
    },
  });
  assert.equal(evaluation.qualified, true, JSON.stringify(evaluation.failures));

  // The same evidence against a different pinned bucket or boundary mismatches.
  const wrongBucket = evaluateStorageQualification({
    tenantRef: TENANT_REF, probe, harness,
    residency: RESIDENCY, keyRecovery: KEY_RECOVERY,
    expectedBinding: { bucket: 'someone-elses-bucket' },
  });
  assert.equal(wrongBucket.qualified, false);
  assert.ok(wrongBucket.failures.some((f) => f.includes('binding mismatch') && f.includes('bucket')));

  const wrongBoundary = evaluateStorageQualification({
    tenantRef: TENANT_REF, probe, harness,
    residency: RESIDENCY, keyRecovery: KEY_RECOVERY,
    expectedBinding: { credentialBoundary: 'a different credential boundary' },
  });
  assert.equal(wrongBoundary.qualified, false);
  assert.ok(wrongBoundary.failures.some((f) => f.includes('binding mismatch') && f.includes('credentialBoundary')));

  // The tenant pin is mandatory and validated (Global Constraint #4).
  const unpinned = evaluateStorageQualification({
    tenantRef: 'raw-tenant-id', probe, harness,
    residency: RESIDENCY, keyRecovery: KEY_RECOVERY,
  });
  assert.equal(unpinned.qualified, false);
  assert.ok(unpinned.failures.some((f) => f.includes('derived tenant reference')));
});

test('adapter publish/read/list/verify roundtrip against the fake backend', async () => {
  const client = lockedClient();
  const adapter = createS3CompatibleAdapter({
    bucket: BUCKET, prefix: 'recovery', client, residency: RESIDENCY,
    probe: await probeS3Capabilities(client, { bucket: BUCKET }),
  });
  const bytes = Buffer.from('recovery artifact bytes');

  const published = await adapter.publish('dumps/keel-db.sql.gz', bytes);
  assert.equal(published.key, 'recovery/dumps/keel-db.sql.gz');
  assert.equal(published.immutableProof, false);
  await adapter.publish('exports/manifest.json', Buffer.from('{}'));

  assert.deepEqual(await adapter.read('dumps/keel-db.sql.gz'), bytes);
  assert.deepEqual(await adapter.list(), ['dumps/keel-db.sql.gz', 'exports/manifest.json']);
  assert.deepEqual(await adapter.list('dumps'), ['dumps/keel-db.sql.gz']);
  assert.deepEqual(
    await adapter.verify('dumps/keel-db.sql.gz', { sha256: sha256Hex(bytes), bytes: bytes.length }),
    { ok: true, failures: [] },
  );

  // Absence and missing checksums are failures, never vacuous passes.
  assert.deepEqual(await adapter.verify('missing', { sha256: '0'.repeat(64) }), { ok: false, failures: ['missing storage object missing'] });
  assert.equal((await adapter.verify('dumps/keel-db.sql.gz', {})).ok, false);

  // Publish-once and hostile names are refused.
  await assert.rejects(adapter.publish('dumps/keel-db.sql.gz', bytes), /already published/);
  await assert.rejects(adapter.publish('../escape', bytes), /unsafe storage object name/);

  // retentionStatus reports the OBSERVED config with the honest claim.
  const status = await adapter.retentionStatus('dumps/keel-db.sql.gz');
  assert.equal(status.provider, S3_PROVIDER);
  assert.equal(status.retentionLock, 'unknown', 'no qualification evidence is bound to this adapter');
  assert.equal(status.objectLock.supported, true);
  assert.equal(status.objectLock.mode, 'COMPLIANCE');
  assert.equal(status.object.mode, 'COMPLIANCE');
  assert.ok(status.object.retainUntilDate);
  assert.equal(status.note, UPLOAD_NOT_IMMUTABLE_NOTE);

  // Construction guards: missing client methods and credential-shaped names.
  assert.throws(() => createS3CompatibleAdapter({ bucket: BUCKET, client: {} }), /lacks the putObject method/);
  assert.throws(() => createS3CompatibleAdapter({ bucket: 'bucket password=hunter2', client: lockedClient() }), /embed credential material/);
  assert.throws(() => createS3CompatibleAdapter({ bucket: BUCKET, prefix: '../x', client: lockedClient() }), /unsafe storage object name/);
});

test('CLI qualifies a fixture, writes a bound evidence record, and refuses live runs', async () => {
  const quiet = { lines: [], errors: [] };
  const logger = { log(line) { quiet.lines.push(String(line)); }, error(line) { quiet.errors.push(String(line)); } };
  const out = join(tmp, 'qualification-record.json');

  const baseArgv = [
    'node', 'storageLock.mjs', 'qualify',
    '--bucket', BUCKET,
    '--tenant-ref', TENANT_REF,
    '--region', RESIDENCY.region,
    '--boundary', RESIDENCY.boundary,
    '--credential-boundary', RESIDENCY.credentialBoundary,
    '--credential-class', 'retention-scoped',
    '--key-held-by', KEY_RECOVERY.heldBy,
    '--key-location', KEY_RECOVERY.location,
    '--key-instructions', KEY_RECOVERY.instructions,
  ];

  // Happy fixture run: exit 0, record written atomically with 0600.
  let exit = await runCli({ argv: [...baseArgv, '--out', out, '--fixture'], logger });
  assert.equal(exit, 0, JSON.stringify(quiet.errors));
  assert.ok(quiet.lines.some((line) => line.includes('qualified (fixture-tested, synthetic fixture)')));
  assert.equal(statSync(out).mode & 0o777, 0o600);
  const record = JSON.parse(readFileSync(out, 'utf8'));
  assert.equal(record.version, STORAGE_QUALIFICATION_VERSION);
  assert.equal(record.tenantRef, TENANT_REF);
  assert.equal(record.evaluation.qualified, true);
  assert.equal(record.evaluation.evidenceLevel, 'fixture-tested');
  assert.equal(record.harness.synthetic, true);
  assert.equal(record.harness.deletionTest.refused, true);
  assert.equal(record.evaluation.binding.bucket, BUCKET);
  assert.doesNotMatch(readFileSync(out, 'utf8'), /PRIVATE KEY|password=/i, 'the record carries references only');

  // An unsupported fixture backend exits 1 but still records the negative verdict.
  const unsupportedOut = join(tmp, 'qualification-unsupported.json');
  exit = await runCli({
    argv: [...baseArgv, '--out', unsupportedOut, '--fixture', '--fixture-no-object-lock'],
    logger,
  });
  assert.equal(exit, 1);
  const negative = JSON.parse(readFileSync(unsupportedOut, 'utf8'));
  assert.equal(negative.evaluation.qualified, false);
  assert.ok(negative.evaluation.failures.some((f) => f.includes('Object Lock was not observed')));
  assert.equal(negative.harness.publish.ok, false);

  // Without --fixture (and no injected client factory) the CLI refuses: live
  // qualification belongs to the orchestrating session.
  exit = await runCli({ argv: [...baseArgv, '--out', join(tmp, 'live-refused.json')], logger });
  assert.equal(exit, 1);
  assert.ok(quiet.errors.some((line) => line.includes('orchestrating session')));

  // Hollow invocations refuse rather than writing an unbound record.
  exit = await runCli({ argv: ['node', 'storageLock.mjs', 'qualify', '--fixture'], logger });
  assert.equal(exit, 1);
  assert.ok(quiet.errors.some((line) => line.includes('missing --bucket')));

  exit = await runCli({
    argv: [...baseArgv.map((value) => (value === TENANT_REF ? 'raw-tenant' : value)), '--out', join(tmp, 'raw-tenant.json'), '--fixture'],
    logger,
  });
  assert.equal(exit, 1);
  assert.ok(quiet.errors.some((line) => line.includes('derived tenant reference')));

  exit = await runCli({ argv: ['node', 'storageLock.mjs', '--help'], logger });
  assert.equal(exit, 0);
  assert.ok(quiet.lines.some((line) => line.includes('--fixture')));
});
