/**
 * Roadmap task-67 boundary tests: storage retention residency and the recovery
 * manifest. Exercises the production engine/storage/adapter.mjs,
 * engine/storage/local.mjs, engine/storage/recoveryManifest.mjs and
 * ops/keel-dump-manifest.mjs against the isolated test database (evidence
 * chain, snapshots) and tmp filesystem trees (dumps, exports, storage roots)
 * — including the three required mutation checks:
 *
 * - Accept mismatched dump checksum.
 * - Label local permissions immutable.
 * - Omit tenant pin.
 */
import { strict as assert } from 'node:assert';
import { appendFile, chmod, mkdir, mkdtemp, readFile, symlink, writeFile } from 'node:fs/promises';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { after, before, test } from 'node:test';

import { exportSnapshot } from '../export/configExport.mjs';
import { sha256Hex } from '../export/manifest.mjs';
import { appendEvidence } from '../govern/evidence.mjs';
import {
  assertNoEmbeddedCredential,
  assertStorageAdapter,
  defineStorageCapabilities,
} from '../storage/adapter.mjs';
import {
  createLocalStorageAdapter,
  localStorageCapabilities,
  RETENTION_LOCK_UNSUPPORTED_NOTE,
} from '../storage/local.mjs';
import {
  buildRecoveryManifest,
  currentSchemaPin,
  INCOMPLETE_EVIDENCE_CHECKPOINT,
  INCOMPLETE_KEY_RECOVERY,
  RECOVERY_MANIFEST_VERSION,
  verifyRecoveryManifest,
} from '../storage/recoveryManifest.mjs';
import { completeSnapshot, createSnapshot, insertResourceVersion } from '../store/db.mjs';
import { createIsolatedTestDatabase } from '../test/dbTestHelper.mjs';
import { fullSuccessfulCoverageDigest } from '../test/fullSuccessfulCoverage.mjs';
import { runCli, writeDumpManifest } from '../../ops/keel-dump-manifest.mjs';

const database = await createIsolatedTestDatabase(import.meta.url);
const tmp = mkdtempSync(join(tmpdir(), 'keel-storage-contract-'));
let client;

before(async () => {
  client = await database.connect();
  await client.query(readFileSync(new URL('../store/schema.sql', import.meta.url), 'utf8'));
});

after(async () => {
  await client?.end();
  await database.cleanup();
  rmSync(tmp, { recursive: true, force: true });
});

const BUILD = { revision: 'b'.repeat(40) };
let schemaPin;

before(async () => {
  schemaPin = await currentSchemaPin();
  assert.match(schemaPin, /^[0-9a-f]{64}$/, 'the schema pin is a real sha256 of schema.sql');
});

/** Persists a completed one-user snapshot, exports it, dumps, anchors evidence. */
async function makeRecoveryFixture(tenantRef) {
  const snapshotId = await createSnapshot(client, { tenantRef });
  await insertResourceVersion(client, {
    snapshotId,
    resource: {
      naturalKey: 'user:ana@example.test',
      resourceType: 'user',
      payload: { id: 'u1', userPrincipalName: 'ana@example.test', displayName: 'Fixture User' },
      payloadHash: 'fixture-hash',
      criticality: 'tier1',
      blastRadius: 'access-affecting',
      fidelity: 'read-only',
      provenance: { adapter: 'fixture', collectedAt: '2026-09-22T00:00:00.000Z', fidelity: 'read-only' },
    },
  });
  await completeSnapshot(client, {
    id: snapshotId,
    status: 'complete',
    coverageDigest: {
      ...fullSuccessfulCoverageDigest(),
      user: { outcome: 'complete', itemCount: 1 },
    },
  });

  const exportRoot = join(tmp, `export-${tenantRef.slice(7)}`);
  const { exportDir } = await exportSnapshot(client, { tenantRef, snapshotId, exportRoot });
  const exportManifestBytes = await readFile(join(exportDir, 'manifest.json'));
  const exportManifest = JSON.parse(exportManifestBytes.toString('utf8'));

  const dumpBytes = gzipSync('COPY public.fixture (id) FROM stdin;\n');
  const dumpPath = join(tmp, `dump-${tenantRef.slice(7)}.sql.gz`);
  await writeFile(dumpPath, dumpBytes);

  await appendEvidence(client, {
    tenantRef,
    kind: 'backup-complete',
    subject: { dump: 'fixture' },
    actor: 'fixture-operator',
    eventSink: () => {},
  });
  const { rows: [head] } = await client.query(
    'SELECT head_seq, head_hash, record_count FROM evidence_head WHERE tenant_ref = $1',
    [tenantRef],
  );
  const checkpoint = {
    headSeq: Number(head.head_seq),
    headHash: head.head_hash,
    recordCount: Number(head.record_count),
  };

  return {
    tenantRef,
    snapshotId,
    exportDir,
    exportManifest,
    dumpPath,
    dumpBytes,
    checkpoint,
    build: { ...BUILD, schemaPin },
    observationIds: Object.keys(exportManifest.types).map((type) => `${snapshotId}:${type}`),
    configExport: {
      manifestPath: join(exportDir, 'manifest.json'),
      manifestSha256: sha256Hex(exportManifestBytes),
    },
    residency: {
      provider: 'local-disk',
      region: 'on-prem datacenter A',
      boundary: 'single site',
      credentialBoundary: 'backup service account reference: keel-backup@service-accounts',
    },
    keyRecovery: {
      heldBy: 'security officer',
      location: 'offline safe, sealed envelope #7',
      instructions: 'Retrieve envelope #7 from the offline safe; the passphrase is held separately by the security officer.',
    },
  };
}

function manifestFrom(fixture, overrides = {}) {
  return buildRecoveryManifest({
    tenantRef: fixture.tenantRef,
    build: fixture.build,
    dump: { path: fixture.dumpPath, sha256: sha256Hex(fixture.dumpBytes), bytes: fixture.dumpBytes.length },
    observationIds: fixture.observationIds,
    configExport: fixture.configExport,
    evidenceCheckpoint: fixture.checkpoint,
    residency: fixture.residency,
    keyRecovery: fixture.keyRecovery,
    ...overrides,
  });
}

function verifyAgainst(fixture, manifest, overrides = {}) {
  return verifyRecoveryManifest(manifest, {
    expectedTenantRef: fixture.tenantRef,
    expectedBuild: fixture.build,
    configExportDir: fixture.exportDir,
    expectedCheckpoint: fixture.checkpoint,
    ...overrides,
  });
}

test('recovery manifest verifies against actual artifact bytes, observation IDs and the evidence checkpoint', async () => {
  const fixture = await makeRecoveryFixture('sha256:storage-happy');
  const manifest = manifestFrom(fixture);

  assert.equal(manifest.recoveryVersion, RECOVERY_MANIFEST_VERSION);
  assert.equal(manifest.tenantRef, fixture.tenantRef);
  assert.equal(manifest.build.revision, BUILD.revision);
  assert.equal(manifest.build.schemaPin, schemaPin);
  assert.equal(manifest.dump.sha256, sha256Hex(fixture.dumpBytes));
  assert.deepEqual(manifest.observationIds, fixture.observationIds);
  assert.ok(manifest.observationIds.includes(`${fixture.snapshotId}:user`));
  assert.equal(manifest.configExport.manifestSha256, fixture.configExport.manifestSha256);
  assert.deepEqual(manifest.evidenceCheckpoint, fixture.checkpoint);
  assert.equal(manifest.keyRecovery.location, 'offline safe, sealed envelope #7');

  const result = await verifyAgainst(fixture, manifest);
  assert.deepEqual(result, { ok: true, failures: [], recoveryComplete: true, incomplete: [] });
});

test('dump checksum mismatch fails verification (mutation pin: accept mismatched dump checksum)', async () => {
  const fixture = await makeRecoveryFixture('sha256:storage-dump-mutation');
  const manifest = manifestFrom(fixture);

  // The artifact bytes change under a recorded checksum.
  await appendFile(fixture.dumpPath, 'tampered');
  let result = await verifyAgainst(fixture, manifest);
  assert.equal(result.ok, false);
  assert.equal(result.recoveryComplete, false);
  assert.ok(result.failures.some((f) => f.includes('dump checksum mismatch')));
  assert.ok(result.failures.some((f) => f.includes('dump length mismatch')));

  // A forged manifest entry over intact bytes is equally refused.
  await writeFile(fixture.dumpPath, fixture.dumpBytes);
  const forged = structuredClone(manifest);
  forged.dump.sha256 = '0'.repeat(64);
  result = await verifyAgainst(fixture, forged);
  assert.equal(result.ok, false);
  assert.ok(result.failures.some((f) => f.includes('dump checksum mismatch')));

  result = await verifyAgainst(fixture, manifest, { dumpPath: join(tmp, 'missing-dump.sql.gz') });
  assert.equal(result.ok, false);
  assert.ok(result.failures.some((f) => f.includes('dump artifact unreadable')));
});

test('local adapter reports retention lock unsupported — never immutable (mutation pin: label local permissions immutable)', async () => {
  const capabilities = localStorageCapabilities();
  assert.equal(capabilities.provider, 'local-disk');
  assert.equal(capabilities.retentionLock, 'unsupported');
  assert.equal(capabilities.immutability, 'unsupported');
  for (const claim of Object.values(capabilities.operations)) {
    assert.equal(claim, 'fixture-tested', 'a local fixture proves fixture-tested, nothing more');
  }

  const root = await mkdtemp(join(tmpdir(), 'keel-local-adapter-'));
  const adapter = createLocalStorageAdapter({ root });
  const status = await adapter.retentionStatus();
  assert.equal(status.retentionLock, 'unsupported');
  assert.equal(status.immutability, 'unsupported');
  assert.equal(status.note, RETENTION_LOCK_UNSUPPORTED_NOTE);
  assert.match(status.note, /do not constitute a retention lock or immutable storage/);

  // Filesystem permissions are access control, not retention: tightening the
  // mode bits must not change the answer.
  await chmod(root, 0o500);
  assert.equal((await adapter.retentionStatus()).retentionLock, 'unsupported');
  await chmod(root, 0o700);

  // Mutation pin: labeling local-disk retention lock or immutability as
  // anything stronger than unsupported/unknown is a construction error.
  for (const claim of ['declared', 'fixture-tested', 'live-qualified']) {
    assert.throws(() => defineStorageCapabilities({
      provider: 'local-disk',
      retentionLock: claim,
      immutability: 'unsupported',
      operations: {
        publish: 'fixture-tested', read: 'fixture-tested', list: 'fixture-tested',
        verify: 'fixture-tested', 'retention-status': 'fixture-tested',
      },
    }), /no retentionLock primitive/);
    assert.throws(() => defineStorageCapabilities({
      provider: 'local-disk',
      retentionLock: 'unsupported',
      immutability: claim,
      operations: {
        publish: 'fixture-tested', read: 'fixture-tested', list: 'fixture-tested',
        verify: 'fixture-tested', 'retention-status': 'fixture-tested',
      },
    }), /no immutability primitive/);
  }

  // The contract rejects non-claims and incomplete adapters.
  assert.throws(() => defineStorageCapabilities({
    provider: 'local-disk', retentionLock: 'rock-solid', immutability: 'unsupported', operations: {},
  }), TypeError);
  assert.throws(() => assertStorageAdapter({ capabilities: localStorageCapabilities() }), /lacks the publish operation/);
});

test('tenant pin is mandatory on build and verify (mutation pin: omit tenant pin)', async () => {
  const fixture = await makeRecoveryFixture('sha256:storage-tenant-pin');

  assert.throws(() => manifestFrom(fixture, { tenantRef: undefined }), TypeError);
  assert.throws(() => manifestFrom(fixture, { tenantRef: 'raw-tenant-id' }), /derived tenant reference/);

  const manifest = manifestFrom(fixture);
  const unpinned = structuredClone(manifest);
  delete unpinned.tenantRef;
  let result = await verifyAgainst(fixture, unpinned);
  assert.equal(result.ok, false);
  assert.ok(result.failures.some((f) => f.includes('lacks a tenant pin')));

  // A foreign tenant is refused (Global Constraint #4).
  result = await verifyAgainst(fixture, manifest, { expectedTenantRef: 'sha256:someone-else' });
  assert.equal(result.ok, false);
  assert.ok(result.failures.some((f) => f.includes('tenant pin mismatch')));
});

test('missing key recovery instructions yield incomplete recovery, not a byte failure', async () => {
  const fixture = await makeRecoveryFixture('sha256:storage-key-recovery');
  const manifest = manifestFrom(fixture, { keyRecovery: null });
  assert.equal(manifest.keyRecovery, null);

  const result = await verifyAgainst(fixture, manifest);
  assert.equal(result.ok, true, 'artifact bytes and pins still verify');
  assert.equal(result.recoveryComplete, false, 'recovery without key instructions is incomplete');
  assert.deepEqual(result.incomplete, [INCOMPLETE_KEY_RECOVERY]);

  const stripped = structuredClone(manifestFrom(fixture));
  stripped.keyRecovery = { heldBy: 'security officer', location: '', instructions: '' };
  const strippedResult = await verifyAgainst(fixture, stripped);
  assert.equal(strippedResult.ok, true);
  assert.deepEqual(strippedResult.incomplete, [INCOMPLETE_KEY_RECOVERY]);
});

test('build or schema incompatibility is refused', async () => {
  const fixture = await makeRecoveryFixture('sha256:storage-build-pin');
  const manifest = manifestFrom(fixture);

  let result = await verifyAgainst(fixture, manifest, {
    expectedBuild: { revision: 'c'.repeat(40), schemaPin },
  });
  assert.equal(result.ok, false);
  assert.ok(result.failures.some((f) => f.includes('build revision mismatch')));

  result = await verifyAgainst(fixture, manifest, {
    expectedBuild: { revision: BUILD.revision, schemaPin: '0'.repeat(64) },
  });
  assert.equal(result.ok, false);
  assert.ok(result.failures.some((f) => f.includes('schema pin mismatch')));

  // The build/schema link can never silently pass: without the verifier's own
  // pins the manifest is unverifiable, not accepted.
  result = await verifyRecoveryManifest(manifest, {
    expectedTenantRef: fixture.tenantRef,
    configExportDir: fixture.exportDir,
    expectedCheckpoint: fixture.checkpoint,
  });
  assert.equal(result.ok, false);
  assert.ok(result.failures.some((f) => f.includes('build/schema pin unverified')));

  assert.throws(() => manifestFrom(fixture, { build: { revision: BUILD.revision } }), /build\.schemaPin/);
  assert.throws(() => manifestFrom(fixture, { build: { revision: '', schemaPin } }), /build revision/);
});

test('observation IDs must be backed by the configuration export', async () => {
  const fixture = await makeRecoveryFixture('sha256:storage-observations');
  const manifest = manifestFrom(fixture);

  const foreign = structuredClone(manifest);
  foreign.observationIds = [...fixture.observationIds, `${fixture.snapshotId}:not-a-type`];
  let result = await verifyAgainst(fixture, foreign);
  assert.equal(result.ok, false);
  assert.ok(result.failures.some((f) => f.includes('observation id not backed by the configuration export')));

  assert.throws(() => manifestFrom(fixture, { observationIds: [] }), /at least one observation id/);
  assert.throws(() => manifestFrom(fixture, { observationIds: [''] }), /non-empty strings/);

  const unpinned = structuredClone(manifest);
  delete unpinned.observationIds;
  result = await verifyAgainst(fixture, unpinned);
  assert.equal(result.ok, false);
  assert.ok(result.failures.some((f) => f.includes('lists no observation ids')));
});

test('tampered configuration export fails verification through the task-56 seam', async () => {
  const fixture = await makeRecoveryFixture('sha256:storage-export-link');
  const manifest = manifestFrom(fixture);

  // A forged export-manifest reference.
  const forged = structuredClone(manifest);
  forged.configExport.manifestSha256 = '0'.repeat(64);
  let result = await verifyAgainst(fixture, forged);
  assert.equal(result.ok, false);
  assert.ok(result.failures.some((f) => f.includes('configuration export manifest checksum mismatch')));

  // Corrupted resource bytes inside the export tree are caught by the task-56
  // verifyManifest and folded into the recovery verdict.
  const userFile = join(fixture.exportDir, 'user', `${sha256Hex('user:ana@example.test')}.json`);
  const original = await readFile(userFile);
  await appendFile(userFile, 'tampered');
  result = await verifyAgainst(fixture, manifest);
  assert.equal(result.ok, false);
  assert.ok(result.failures.some((f) => f.includes('configuration export: checksum mismatch')));
  await writeFile(userFile, original);

  result = await verifyAgainst(fixture, manifest, { configExportDir: join(tmp, 'nowhere') });
  assert.equal(result.ok, false);
  assert.ok(result.failures.some((f) => f.includes('configuration export manifest unreadable')));
});

test('evidence checkpoint mismatch is refused; an unverified anchor makes recovery incomplete', async () => {
  const fixture = await makeRecoveryFixture('sha256:storage-checkpoint');
  const manifest = manifestFrom(fixture);

  const moved = structuredClone(manifest);
  moved.evidenceCheckpoint = { headSeq: 99, headHash: '0'.repeat(64), recordCount: 99 };
  let result = await verifyAgainst(fixture, moved);
  assert.equal(result.ok, false);
  assert.ok(result.failures.some((f) => f.includes('evidence checkpoint mismatch')));

  const missing = structuredClone(manifest);
  delete missing.evidenceCheckpoint;
  result = await verifyAgainst(fixture, missing);
  assert.equal(result.ok, false);
  assert.ok(result.failures.some((f) => f.includes('lacks an evidence checkpoint')));

  // Without the verifier's current head the anchor is unverified: complete
  // bytes, incomplete recovery.
  result = await verifyRecoveryManifest(manifest, {
    expectedTenantRef: fixture.tenantRef,
    expectedBuild: fixture.build,
    configExportDir: fixture.exportDir,
  });
  assert.equal(result.ok, true);
  assert.equal(result.recoveryComplete, false);
  assert.deepEqual(result.incomplete, [INCOMPLETE_EVIDENCE_CHECKPOINT]);

  assert.throws(() => manifestFrom(fixture, { evidenceCheckpoint: null }), /evidence checkpoint/);
});

test('residency and key recovery metadata are references only — embedded credentials are refused', async () => {
  const fixture = await makeRecoveryFixture('sha256:storage-residency');

  assert.throws(() => manifestFrom(fixture, {
    residency: { ...fixture.residency, credentialBoundary: 'uses -----BEGIN RSA PRIVATE KEY----- material' },
  }), /embed credential material/);
  assert.throws(() => manifestFrom(fixture, {
    keyRecovery: { ...fixture.keyRecovery, instructions: 'authenticate with Bearer abcdef1234567890' },
  }), /embed credential material/);
  assert.throws(() => manifestFrom(fixture, {
    residency: { ...fixture.residency, boundary: 'password=hunter2' },
  }), /embed credential material/);
  assert.throws(() => assertNoEmbeddedCredential('token: abc', 'test.field'), /embed credential material/);

  // A manifest carrying credential material fails verification even when
  // every checksum matches.
  const poisoned = structuredClone(manifestFrom(fixture));
  poisoned.residency.credentialBoundary = 'password=hunter2';
  const result = await verifyAgainst(fixture, poisoned);
  assert.equal(result.ok, false);
  assert.ok(result.failures.some((f) => f.includes('embed credential material')));

  assert.throws(() => manifestFrom(fixture, { residency: { region: 'x' } }), /residency\.provider/);
});

test('local adapter publish/read/list/verify roundtrip with atomic publish-once', async () => {
  const root = join(tmp, 'adapter-roundtrip');
  const adapter = createLocalStorageAdapter({ root });
  const bytes = Buffer.from('recovery artifact bytes');

  const published = await adapter.publish('dumps/keel-db.sql.gz', bytes);
  assert.equal(published.sha256, sha256Hex(bytes));
  assert.equal(published.bytes, bytes.length);
  assert.deepEqual(await adapter.read('dumps/keel-db.sql.gz'), bytes);
  assert.deepEqual(await adapter.list(), ['dumps/keel-db.sql.gz']);
  assert.deepEqual(await adapter.list('dumps'), ['dumps/keel-db.sql.gz']);
  assert.deepEqual(await adapter.list('missing-prefix'), []);
  assert.deepEqual(
    await adapter.verify('dumps/keel-db.sql.gz', { sha256: sha256Hex(bytes), bytes: bytes.length }),
    { ok: true, failures: [] },
  );

  // Corruption and absence are detected, never papered over.
  await appendFile(join(root, 'dumps', 'keel-db.sql.gz'), 'x');
  let check = await adapter.verify('dumps/keel-db.sql.gz', { sha256: sha256Hex(bytes) });
  assert.equal(check.ok, false);
  assert.ok(check.failures.some((f) => f.includes('checksum mismatch')));
  check = await adapter.verify('missing', { sha256: '0'.repeat(64) });
  assert.equal(check.ok, false);
  assert.ok(check.failures.some((f) => f.includes('missing storage object')));
  check = await adapter.verify('dumps/keel-db.sql.gz', {});
  assert.equal(check.ok, false, 'verify without a checksum refuses rather than vacuously passing');

  // Publish-once: an existing object is never clobbered.
  await assert.rejects(adapter.publish('dumps/keel-db.sql.gz', Buffer.from('replacement')), /already published/);

  // Hostile names cannot escape the storage root.
  for (const name of ['../escape', '/absolute', 'a/../../escape', '..', 'a//b', '', '.hidden/..x/../y']) {
    await assert.rejects(adapter.publish(name, bytes), /unsafe storage object name|path escape/, name);
  }

  // Symlinked path components are rejected; nothing is written through them.
  const outside = join(tmp, 'adapter-outside');
  await mkdir(outside, { recursive: true });
  await symlink(outside, join(root, 'linked'));
  await assert.rejects(adapter.publish('linked/evil', bytes), /symlink/);
  assert.deepEqual(await adapter.list(), ['dumps/keel-db.sql.gz']);

  // An injected rename failure at the publish cutover leaves nothing behind.
  const failing = createLocalStorageAdapter({
    root,
    dependencies: { rename: async () => { throw new Error('injected rename failure'); } },
  });
  await assert.rejects(failing.publish('atomic/fails', bytes), /injected rename failure/);
  await assert.rejects(adapter.read('atomic/fails'), /ENOENT/);
  assert.deepEqual((await adapter.list()).filter((name) => name.startsWith('atomic')), [],
    'a failed publish leaves no object and no temp file');
});

test('ops CLI preserves the legacy dump manifest and links a verifiable recovery manifest', async () => {
  const fixture = await makeRecoveryFixture('sha256:storage-cli');
  const quiet = { errors: [], lines: [] };
  const logger = {
    log(line) { quiet.lines.push(String(line)); },
    error(line) { quiet.errors.push(String(line)); },
  };

  // Legacy behavior, unchanged shape: { path, checksum, timestamp }.
  const legacyPath = join(tmp, 'cli-legacy-manifest.json');
  let exit = await runCli({
    argv: ['node', 'keel-dump-manifest.mjs', fixture.dumpPath, '--manifest', legacyPath],
    logger,
  });
  assert.equal(exit, 0, JSON.stringify(quiet.errors));
  const legacy = JSON.parse(await readFile(legacyPath, 'utf8'));
  assert.deepEqual(Object.keys(legacy).sort(), ['checksum', 'path', 'timestamp']);
  assert.equal(legacy.checksum, sha256Hex(fixture.dumpBytes));

  // The writeDumpManifest export keeps its exact prior contract.
  const direct = await writeDumpManifest(fixture.dumpPath, join(tmp, 'cli-direct-manifest.json'));
  assert.equal(direct.checksum, legacy.checksum);

  // Link a full recovery manifest through the CLI.
  const recoveryPath = join(tmp, 'cli-recovery.json');
  exit = await runCli({
    argv: [
      'node', 'keel-dump-manifest.mjs', fixture.dumpPath,
      '--recovery', recoveryPath,
      '--tenant-ref', fixture.tenantRef,
      '--build-revision', BUILD.revision,
      '--schema-pin', schemaPin,
      '--config-export-dir', fixture.exportDir,
      ...fixture.observationIds.flatMap((id) => ['--observation', id]),
      '--evidence-head', `${fixture.checkpoint.headSeq}:${fixture.checkpoint.headHash}:${fixture.checkpoint.recordCount}`,
      '--key-held-by', 'security officer',
      '--key-location', 'offline safe, sealed envelope #7',
      '--key-instructions', 'Retrieve envelope #7 from the offline safe.',
      '--residency-provider', 'local-disk',
      '--residency-region', 'on-prem datacenter A',
    ],
    logger,
  });
  assert.equal(exit, 0, JSON.stringify(quiet.errors));
  const written = JSON.parse(await readFile(recoveryPath, 'utf8'));
  assert.equal(written.tenantRef, fixture.tenantRef);
  assert.equal(written.dump.sha256, sha256Hex(fixture.dumpBytes));
  assert.deepEqual(written.observationIds, fixture.observationIds);
  assert.deepEqual(
    await verifyAgainst(fixture, written),
    { ok: true, failures: [], recoveryComplete: true, incomplete: [] },
  );

  // --verify against intact artifacts exits 0.
  const verifyArgv = () => [
    'node', 'keel-dump-manifest.mjs',
    '--verify', recoveryPath,
    '--dump', fixture.dumpPath,
    '--tenant-ref', fixture.tenantRef,
    '--build-revision', BUILD.revision,
    '--schema-pin', schemaPin,
    '--config-export-dir', fixture.exportDir,
    '--evidence-head', `${fixture.checkpoint.headSeq}:${fixture.checkpoint.headHash}:${fixture.checkpoint.recordCount}`,
  ];
  exit = await runCli({ argv: verifyArgv(), logger });
  assert.equal(exit, 0, JSON.stringify(quiet.errors));
  assert.ok(quiet.lines.some((line) => line.includes('recovery complete')));

  // Tampered dump bytes fail verification with exit 1.
  await appendFile(fixture.dumpPath, 'tampered');
  exit = await runCli({ argv: verifyArgv(), logger });
  assert.equal(exit, 1);
  assert.ok(quiet.errors.some((line) => line.includes('dump checksum mismatch')));
  await writeFile(fixture.dumpPath, fixture.dumpBytes);

  // A foreign tenant pin is refused by the CLI too.
  exit = await runCli({
    argv: [...verifyArgv().slice(0, 4), '--dump', fixture.dumpPath, '--tenant-ref', 'sha256:foreign',
      '--build-revision', BUILD.revision, '--schema-pin', schemaPin, '--config-export-dir', fixture.exportDir],
    logger,
  });
  assert.equal(exit, 1);
  assert.ok(quiet.errors.some((line) => line.includes('tenant pin mismatch')));

  // Missing required link flags refuse rather than writing a hollow manifest.
  exit = await runCli({
    argv: ['node', 'keel-dump-manifest.mjs', fixture.dumpPath, '--recovery', join(tmp, 'cli-hollow.json')],
    logger,
  });
  assert.equal(exit, 1);
  assert.ok(quiet.errors.length > 0);

  exit = await runCli({ argv: ['node', 'keel-dump-manifest.mjs', '--help'], logger });
  assert.equal(exit, 0);
  assert.ok(quiet.lines.some((line) => line.includes('--verify')));
});
