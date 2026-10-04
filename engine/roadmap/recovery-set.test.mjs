/**
 * Roadmap task-114 boundary tests: the operator recovery-set tool
 * (ops/keel-recovery-set.mjs) that turns one existing, verified nightly dump
 * into a complete storage-live-acceptance recovery set.
 *
 * A set is built from fixtures — a gzip dump with the backup job's legacy
 * manifest, and a completed snapshot plus an evidence chain in the isolated
 * test database — and then handed, unchanged, to the two production
 * consumers: `ops/keel-dump-manifest.mjs --verify` (run as a process) and the
 * capture tool's --live path (tools/qualification/storageLiveAcceptance.mjs,
 * host facts injected as in storage-live-acceptance.test.mjs), whose record
 * must pass `qualification.mjs` verification. Refusals: missing or empty key
 * instructions, secret-looking key metadata, a tampered export, a wrong
 * build, an unverified dump and a non-empty output directory. Nothing here
 * writes the repository's evidence files.
 */
import { strict as assert } from 'node:assert';
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { runCli as recoverySet, RECOVERY_SET_NAMES } from '../../ops/keel-recovery-set.mjs';
import { writeDumpManifest } from '../../ops/keel-dump-manifest.mjs';
import { main as capture } from '../../tools/qualification/storageLiveAcceptance.mjs';
import { verifyEvidenceFile } from '../../tools/release/qualification.mjs';
import { appendEvidence } from '../govern/evidence.mjs';
import { STORAGE_LIVE_GATE } from '../storage/storageLiveEvidence.mjs';
import { completeSnapshot, createSnapshot, insertResourceVersion } from '../store/db.mjs';
import { tenantRefFor } from '../store/tenantRef.mjs';
import { createIsolatedTestDatabase } from '../test/dbTestHelper.mjs';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const KEY = 'test-only-recovery-set-key';
const BUILD = 'fixture-build-114-set';
const TENANT_ID = 'recovery-set-tenant';
const tenantRef = tenantRefFor(TENANT_ID);
const DUMP_NAME = 'keel-db.sql.gz';

const database = await createIsolatedTestDatabase(import.meta.url);
const tmp = mkdtempSync(join(tmpdir(), 'keel-recovery-set-'));
let client;
let snapshotId;
let fixture;

/** A non-git "deployed checkout" holding this build's schema, so --build is the operator's word. */
function fixtureCheckout() {
  const checkout = join(tmp, 'checkout');
  mkdirSync(join(checkout, 'engine', 'store'), { recursive: true });
  cpSync(join(ROOT, 'engine', 'store', 'schema.sql'), join(checkout, 'engine', 'store', 'schema.sql'));
  return checkout;
}

/** The nightly backup directory as backup.sh leaves it: a verified dump and its legacy manifest. */
async function fixtureBackup() {
  const backupDir = join(tmp, 'backups', '2026-10-01');
  mkdirSync(backupDir, { recursive: true });
  const dumpPath = join(backupDir, DUMP_NAME);
  writeFileSync(dumpPath, gzipSync(Buffer.from('-- keel recovery-set fixture dump\nSELECT 1;\n')));
  const legacyManifest = join(tmp, 'backups', 'keel-db-manifest.json');
  await writeDumpManifest(dumpPath, legacyManifest);
  return { backupDir, dumpPath, legacyManifest };
}

before(async () => {
  client = await database.connect();
  await client.query(readFileSync(new URL('../store/schema.sql', import.meta.url), 'utf8'));
  snapshotId = await createSnapshot(client, { tenantRef });
  await insertResourceVersion(client, {
    snapshotId,
    resource: {
      naturalKey: 'conditionalAccessPolicy:set-fixture',
      resourceType: 'conditionalAccessPolicy',
      payload: { id: 'set-fixture', displayName: 'KEEL recovery-set fixture policy', state: 'enabled' },
      payloadHash: 'fixture-hash-set-policy',
      criticality: 'tier1',
      blastRadius: 'access-affecting',
      fidelity: 'read-only',
      provenance: { adapter: 'fixture', collectedAt: '2026-09-30T00:00:00.000Z', fidelity: 'read-only' },
    },
  });
  await completeSnapshot(client, {
    id: snapshotId, status: 'complete',
    coverageDigest: { conditionalAccessPolicy: { outcome: 'complete', itemCount: 1 }, namedLocation: { outcome: 'complete', itemCount: 0 } },
  });
  for (const kind of ['fixture.one', 'fixture.two']) {
    await appendEvidence(client, { tenantRef, kind, subject: { kind }, actor: 'fixture', eventSink: () => {} });
  }
  const tenantConfig = join(tmp, 'tenant.json');
  writeFileSync(tenantConfig, JSON.stringify({ tenantId: TENANT_ID }));
  const keyMetadata = join(tmp, 'key-metadata.json');
  writeFileSync(keyMetadata, JSON.stringify({
    instructions: 'runbook:ops/recovery-runbook.md#recovery-key',
    heldBy: 'security officer (two-person rule)',
    location: 'offline safe, site B, envelope KEEL-RK-1',
  }));
  fixture = { ...(await fixtureBackup()), checkout: fixtureCheckout(), tenantConfig, keyMetadata };
});

after(async () => {
  await client?.end();
  await database.cleanup();
  rmSync(tmp, { recursive: true, force: true });
});

let outCount = 0;
function newOut() {
  outCount += 1;
  return join(tmp, 'sets', `set-${outCount}`);
}

function setArgv(out, extra = [], { key = ['--key-metadata', fixture.keyMetadata], build = ['--build', BUILD, '--checkout', fixture.checkout] } = {}) {
  return ['node', 'keel-recovery-set.mjs', '--dump', fixture.dumpPath, '--dump-manifest', fixture.legacyManifest, '--out', out,
    '--tenant-config', fixture.tenantConfig, '--db-url', database.url, ...build, ...key, ...extra];
}

async function runSet(argv) {
  const logs = [];
  const errors = [];
  const code = await recoverySet({
    argv, env: {}, logger: { log: (m) => logs.push(m), error: (m) => errors.push(m) },
    now: () => new Date('2026-10-01T09:00:00.000Z'),
  });
  return { code, logs, errors };
}

async function buildSet(extra = []) {
  const out = newOut();
  const run = await runSet(setArgv(out, extra));
  assert.equal(run.code, 0, run.errors.join(' '));
  const summary = JSON.parse(readFileSync(join(out, RECOVERY_SET_NAMES.summary), 'utf8'));
  return { out, summary, ...run };
}

function verifyCli(out, summary, { build = summary.build.revision, exportDir = join(out, summary.names.export) } = {}) {
  return spawnSync(process.execPath, [join(ROOT, 'ops', 'keel-dump-manifest.mjs'),
    '--verify', join(out, summary.names.manifest), '--dump', join(out, summary.names.dump),
    '--tenant-ref', summary.tenantRef, '--build-revision', build, '--schema-pin', summary.build.schemaPin,
    '--config-export-dir', exportDir, '--evidence-head', summary.evidenceHead], { encoding: 'utf8' });
}

function listTree(dir) {
  return readdirSync(dir, { recursive: true }).map(String).sort();
}

const separateHost = {
  volumeOf: (p) => (p.endsWith('copy') ? '2065' : '2049'),
  ownerOf: () => 1001,
  readerAccount: () => 1002,
  readerName: () => 'keel-recovery',
  canWrite: () => false,
};

/** The capture tool's --live path over the set (primary) and a copy of it on the "other volume". */
async function captureSet(out, summary, { build = summary.build.revision, mutateCopy = null } = {}) {
  const copyRoot = join(`${out}-evidence`, 'copy');
  mkdirSync(copyRoot, { recursive: true });
  cpSync(out, copyRoot, { recursive: true });
  if (mutateCopy) mutateCopy(copyRoot);
  const [headSeq, headHash, recordCount] = summary.evidenceHead.split(':');
  const evidenceDir = join(`${out}-evidence`, 'evidence');
  let t = Date.parse('2026-10-01T10:00:00.000Z');
  const errors = [];
  const code = await capture({
    argv: ['capture', '--live', '--primary-root', out, '--copy-root', copyRoot,
      '--manifest', summary.names.manifest, '--dump', summary.names.dump, '--export', summary.names.export,
      '--recovery-principal', 'os-user:keel-recovery', '--recovery-credential-ref', 'vault:keel/recovery-login',
      '--recovery-key-ref', 'vault:keel/recovery-key', '--storage-read-ref', 'os-account:keel-recovery',
      '--tenant-authorization-ref', 'runbook:tenant-recovery-authorization', '--tenant-config', fixture.tenantConfig,
      '--checkpoint-seq', headSeq, '--checkpoint-hash', headHash, '--checkpoint-count', recordCount,
      '--build', build, '--out', evidenceDir],
    env: { KEEL_QUALIFICATION_HMAC_KEY: KEY },
    out: { log() {}, error: (m) => errors.push(m) },
    deps: { now: () => { t += 1000; return new Date(t); }, host: separateHost },
  });
  return { code, errors, file: join(evidenceDir, `${STORAGE_LIVE_GATE}.json`) };
}

const verifyOpts = {
  gate: STORAGE_LIVE_GATE, tenantRef, build: BUILD, requireLive: true, now: new Date('2026-10-01T12:00:00Z'), hmacKey: KEY,
};

test('a set built from a verified dump holds the dump, export, recovery manifest and summary, with pins from the database and checkout', async () => {
  const { out, summary } = await buildSet();
  assert.deepEqual(readdirSync(out).sort(), [RECOVERY_SET_NAMES.export, DUMP_NAME, RECOVERY_SET_NAMES.manifest, RECOVERY_SET_NAMES.summary].sort());
  assert.ok(existsSync(join(out, RECOVERY_SET_NAMES.export, 'manifest.json')));
  assert.deepEqual(readFileSync(join(out, DUMP_NAME)), readFileSync(fixture.dumpPath));

  const manifest = JSON.parse(readFileSync(join(out, RECOVERY_SET_NAMES.manifest), 'utf8'));
  assert.equal(manifest.tenantRef, tenantRef);
  assert.equal(manifest.build.revision, BUILD);
  const { currentSchemaPin } = await import('../storage/recoveryManifest.mjs');
  assert.equal(manifest.build.schemaPin, await currentSchemaPin());
  assert.equal(manifest.dump.path, DUMP_NAME);
  assert.equal(manifest.configExport.manifestPath, `${RECOVERY_SET_NAMES.export}/manifest.json`);
  assert.deepEqual(manifest.observationIds, [`${snapshotId}:conditionalAccessPolicy`, `${snapshotId}:namedLocation`]);
  const { rows } = await client.query('SELECT head_seq, head_hash, record_count FROM evidence_head WHERE tenant_ref = $1', [tenantRef]);
  assert.equal(summary.evidenceHead, `${rows[0].head_seq}:${rows[0].head_hash}:${rows[0].record_count}`);
  assert.deepEqual(manifest.evidenceCheckpoint, { headSeq: Number(rows[0].head_seq), headHash: rows[0].head_hash, recordCount: Number(rows[0].record_count) });
  assert.equal(manifest.keyRecovery.instructions, 'runbook:ops/recovery-runbook.md#recovery-key');
  assert.equal(manifest.residency.provider, 'local-disk');
  assert.equal(summary.snapshotId, snapshotId);
});

test('keel-dump-manifest.mjs --verify accepts the set with recovery complete', async () => {
  const { out, summary } = await buildSet();
  const result = verifyCli(out, summary);
  assert.equal(result.status, 0, result.stderr + result.stdout);
  assert.match(result.stdout, /verified: .*\(recovery complete\)/);
});

test('the storage capture tool accepts the set copied to another volume, and its record verifies', async () => {
  const { out, summary } = await buildSet();
  const run = await captureSet(out, summary);
  assert.equal(run.code, 0, run.errors.join(' '));
  assert.deepEqual(verifyEvidenceFile(run.file, verifyOpts).failures, []);
  const record = JSON.parse(readFileSync(run.file, 'utf8'));
  assert.equal(record.subject.recovery.manifestVerification.recoveryComplete, true);
  assert.deepEqual(record.subject.recovery.listing.before, record.subject.recovery.listing.after);
});

test('a missing or empty key-instructions field is refused and nothing is left behind', async () => {
  const flags = ['--key-held-by', 'security officer', '--key-location', 'offline safe, site B'];
  for (const key of [flags, [...flags, '--key-instructions', ''], [...flags, '--key-instructions', '   ']]) {
    const out = newOut();
    const run = await runSet(setArgv(out, [], { key }));
    assert.equal(run.code, 1);
    assert.match(run.errors.join(' '), /--key-instructions is required/);
    assert.equal(existsSync(out), false);
  }
  for (const body of [{ heldBy: 'x', location: 'y' }, { instructions: '', heldBy: 'x', location: 'y' }]) {
    const file = join(tmp, `key-${Math.random().toString(16).slice(2)}.json`);
    writeFileSync(file, JSON.stringify(body));
    const out = newOut();
    const run = await runSet(setArgv(out, [], { key: ['--key-metadata', file] }));
    assert.equal(run.code, 1);
    assert.match(run.errors.join(' '), /key metadata instructions is required/);
    assert.equal(existsSync(out), false);
  }
});

test('key metadata that looks like key material or a secret is refused', async () => {
  const secrets = [
    '-----BEGIN PGP PRIVATE KEY BLOCK----- abc',
    'password=hunter2hunter2',
    'see https://admin:s3cret@vault.example.test/keel',
    'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJrZWVsLWtleSJ9.c2lnbmF0dXJl',
    'AKIAABCDEFGHIJKLMNOP',
    'passphrase: correct horse battery staple',
    'key 9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08',
    'k=Zm9vYmFyMTIzNDU2Nzg5MEFCQ0RFRkdISUpLTE1OT1BRUlNUVVZXWFla',
  ];
  for (const secret of secrets) {
    const out = newOut();
    const run = await runSet(setArgv(out, [], {
      key: ['--key-instructions', secret, '--key-held-by', 'security officer', '--key-location', 'offline safe'],
    }));
    assert.equal(run.code, 1, `accepted ${secret}`);
    assert.equal(existsSync(out), false);
  }
  const file = join(tmp, 'key-extra.json');
  writeFileSync(file, JSON.stringify({ instructions: 'runbook', heldBy: 'x', location: 'y', privateKey: 'nope' }));
  const run = await runSet(setArgv(newOut(), [], { key: ['--key-metadata', file] }));
  assert.equal(run.code, 1);
  assert.match(run.errors.join(' '), /unknown fields: privateKey/);
});

test('a tampered export is rejected by --verify and by the capture', async () => {
  const { out, summary } = await buildSet();
  const exportDir = join(out, summary.names.export);
  const [typeDir] = readdirSync(exportDir).filter((n) => n !== 'manifest.json' && readdirSync(join(exportDir, n)).length);
  const [resource] = readdirSync(join(exportDir, typeDir));

  const run = await captureSet(out, summary, {
    mutateCopy: (copy) => writeFileSync(join(copy, summary.names.export, typeDir, resource), '{"tampered":true}\n'),
  });
  assert.equal(run.code, 1);
  assert.match(run.errors.join(' '), /configuration export/);

  writeFileSync(join(exportDir, typeDir, resource), '{"tampered":true}\n');
  const resourceTamper = verifyCli(out, summary);
  assert.equal(resourceTamper.status, 1);
  assert.match(resourceTamper.stderr, /configuration export/);

  const exportManifest = join(exportDir, 'manifest.json');
  writeFileSync(exportManifest, readFileSync(exportManifest, 'utf8').replace('"manifestVersion": 1', '"manifestVersion": 1 '));
  const manifestTamper = verifyCli(out, summary);
  assert.equal(manifestTamper.status, 1);
  assert.match(manifestTamper.stderr, /configuration export manifest checksum mismatch/);
});

test('a wrong build is rejected: by the tool against a git checkout, by --verify and by the capture', async () => {
  const out = newOut();
  const refused = await runSet(setArgv(out, [], { build: ['--build', 'not-this-checkouts-revision', '--checkout', ROOT] }));
  assert.equal(refused.code, 1);
  assert.match(refused.errors.join(' '), /is not the checkout's revision/);
  assert.equal(existsSync(out), false);

  const { out: built, summary } = await buildSet();
  const verify = verifyCli(built, summary, { build: 'some-other-build' });
  assert.equal(verify.status, 1);
  assert.match(verify.stderr, /build revision mismatch/);

  const run = await captureSet(built, summary, { build: 'some-other-build' });
  assert.equal(run.code, 1);
  assert.match(run.errors.join(' '), /build revision mismatch/);
});

test('only a verified dump is used: a checksum that disagrees, a manifest for another dump or no verification is refused', async () => {
  const other = join(tmp, 'other-manifest.json');
  writeFileSync(other, JSON.stringify({ path: '/opt/backups/elsewhere/keel-db.sql.gz', checksum: 'a'.repeat(64), timestamp: 'x' }));
  const cases = [
    [['--dump-manifest', other], /is for \/opt\/backups\/elsewhere/],
    [['--dump-sha256', 'b'.repeat(64)], /dump checksum mismatch/],
    [[], /give --dump-manifest/],
  ];
  for (const [verification, pattern] of cases) {
    const out = newOut();
    const argv = setArgv(out).filter((a, i, all) => a !== '--dump-manifest' && all[i - 1] !== '--dump-manifest');
    const run = await runSet([...argv, ...verification]);
    assert.equal(run.code, 1);
    assert.match(run.errors.join(' '), pattern);
    assert.equal(existsSync(out), false);
  }
});

test('read-only: the source backup is untouched, a non-empty output is refused, and --dry-run writes nothing', async () => {
  const before = { tree: listTree(join(tmp, 'backups')), dump: readFileSync(fixture.dumpPath), mtime: statSync(fixture.dumpPath).mtimeMs };
  const evidenceBefore = (await client.query('SELECT count(*)::int AS n FROM evidence')).rows[0].n;
  await buildSet();
  assert.deepEqual(listTree(join(tmp, 'backups')), before.tree);
  assert.deepEqual(readFileSync(fixture.dumpPath), before.dump);
  assert.equal(statSync(fixture.dumpPath).mtimeMs, before.mtime);
  assert.equal((await client.query('SELECT count(*)::int AS n FROM evidence')).rows[0].n, evidenceBefore);

  const occupied = newOut();
  mkdirSync(occupied, { recursive: true });
  writeFileSync(join(occupied, 'keep.txt'), 'operator file\n');
  const refused = await runSet(setArgv(occupied));
  assert.equal(refused.code, 1);
  assert.match(refused.errors.join(' '), /is not empty/);
  assert.deepEqual(readdirSync(occupied), ['keep.txt']);

  const intoBackups = await runSet(setArgv(join(tmp, 'backups')));
  assert.equal(intoBackups.code, 1);
  assert.match(intoBackups.errors.join(' '), /must not be, or contain, the source backup directory/);

  const dry = newOut();
  const run = await runSet(setArgv(dry, ['--dry-run']));
  assert.equal(run.code, 0, run.errors.join(' '));
  assert.equal(existsSync(dry), false);
  const text = run.logs.join('\n');
  assert.match(text, /would read:/);
  assert.match(text, new RegExp(`dump .*${DUMP_NAME}`));
  assert.match(text, /would write \(only inside/);
  assert.match(text, /recovery-manifest\.json/);
  assert.doesNotMatch(text, /:[^/@\s]+@/); // no database password echoed
  assert.deepEqual(listTree(join(tmp, 'backups')), before.tree);
});
