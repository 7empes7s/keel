/**
 * Wave 2 STORE: the storage target registry and the offsite shipment to it.
 * Local directories stand in for the Mulinux volume; an Azure target uses a
 * fake fetch. No network, no real storage account.
 */
import { strict as assert } from 'node:assert';
import { execFile, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { gzipSync } from 'node:zlib';
import { after, test } from 'node:test';

import { sha256Hex } from '../export/manifest.mjs';
import { schemaSql } from '../store/loadSchema.mjs';
import { createIsolatedTestDatabase } from '../test/dbTestHelper.mjs';
import { createLocalStorageAdapter } from './local.mjs';
import {
  defineStorageTargets,
  describeShipment,
  loadStorageTargets,
  probeTargets,
  recordShipment,
  separateFilesystemCheck,
  shipArtifact,
} from './targets.mjs';
import { pruneLocalDumps, shipDumpToTargets } from '../schedules/offsite.mjs';

const tmp = mkdtempSync(join(tmpdir(), 'keel-storage-targets-'));
after(() => rmSync(tmp, { recursive: true, force: true }));

let counter = 0;
function dir(name) {
  counter += 1;
  return join(tmp, `${counter}-${name}`);
}

function localTarget(id, root = dir(id), extra = {}) {
  return { id, adapter: createLocalStorageAdapter({ root }), root, ...extra };
}

const down = { check: async () => { throw new Error('volume not mounted'); } };

// An age key pair for the offsite tests: the recipient goes in the recipients file the
// shipment reads, the identity stays in the test to decrypt what was shipped.
const ageKeys = join(tmp, 'age-identity.txt');
execFileSync('age-keygen', ['-o', ageKeys], { stdio: 'ignore' });
const ageRecipients = join(tmp, 'age-recipients.txt');
writeFileSync(ageRecipients, `# offsite recipient\n${execFileSync('age-keygen', ['-y', ageKeys], { encoding: 'utf8' })}`);
const decrypt = (path) => execFileSync('age', ['-d', '-i', ageKeys, path]);

test('two targets both hold a verified copy of one artifact, as plain files', async () => {
  const a = localTarget('mulinux');
  const b = localTarget('second');
  const bytes = Buffer.from('a backup artifact');
  const report = await shipArtifact(defineStorageTargets([a, b]), { name: 'keel-db/keel-db-2026-10-15.sql.gz', bytes });
  assert.equal(report.status, 'complete');
  assert.equal(report.sha256, sha256Hex(bytes));
  assert.deepEqual(report.copies.map((copy) => [copy.targetId, copy.verified, copy.published]),
    [['mulinux', true, 'published'], ['second', true, 'published']]);
  for (const target of [a, b]) {
    assert.deepEqual(readFileSync(join(target.root, 'keel-db', 'keel-db-2026-10-15.sql.gz')), bytes, 'readable with no Keel');
  }
  assert.match(describeShipment(report), /mulinux \(local-disk\): verified/);
});

test('one target down marks the shipment partial and names it; all down is failed', async () => {
  const good = localTarget('good');
  const bad = localTarget('bad', undefined, down);
  const bytes = Buffer.from('partial');
  const partial = await shipArtifact(defineStorageTargets([good, bad]), { name: 'artifact.bin', bytes });
  assert.equal(partial.status, 'partial');
  const failed = partial.copies.find((copy) => copy.targetId === 'bad');
  assert.equal(failed.verified, false);
  assert.equal(failed.published, 'error');
  assert.deepEqual(failed.failures, ['volume not mounted']);
  assert.match(describeShipment(partial), /bad \(local-disk\): NOT verified, error — volume not mounted/);

  const none = await shipArtifact(defineStorageTargets([localTarget('x', undefined, down)]), { name: 'artifact.bin', bytes });
  assert.equal(none.status, 'failed');

  // A retry reuses a verified existing copy, and the repaired target catches up.
  const retry = await shipArtifact(defineStorageTargets([good, localTarget('bad', bad.root)]), { name: 'artifact.bin', bytes });
  assert.equal(retry.status, 'complete');
  assert.deepEqual(retry.copies.map((copy) => copy.published), ['already-present', 'published']);
});

test('an existing copy with different bytes is never counted as verified', async () => {
  const target = localTarget('tampered');
  mkdirSync(target.root, { recursive: true });
  writeFileSync(join(target.root, 'artifact.bin'), 'other bytes');
  const report = await shipArtifact(defineStorageTargets([target]), { name: 'artifact.bin', bytes: Buffer.from('expected') });
  assert.equal(report.status, 'failed');
  assert.equal(report.copies[0].published, 'already-present');
  assert.deepEqual(report.copies[0].failures, ['checksum mismatch for artifact.bin', 'length mismatch for artifact.bin']);
});

test('the registry is built from the environment, local disk first, with no credential in any output', async () => {
  assert.equal(loadStorageTargets({}), null);
  const root = dir('env');
  const sas = 'sv=2023-11-03&sp=rwl&sig=ENVFIXTURESIG';
  const targets = loadStorageTargets({
    KEEL_STORAGE_TARGETS: 'mulinux, azure-eu',
    KEEL_STORAGE_TARGET_MULINUX_DIR: root,
    KEEL_STORAGE_TARGET_AZURE_EU_KIND: 'azure-blob',
    KEEL_STORAGE_TARGET_AZURE_EU_ACCOUNT: 'keelfixture',
    KEEL_STORAGE_TARGET_AZURE_EU_CONTAINER: 'keel-rt-fixture',
    KEEL_STORAGE_TARGET_AZURE_EU_SAS: sas,
  }, { fetchFn: async () => new Response(null, { status: 503 }) });
  assert.deepEqual(targets.map((target) => [target.id, target.adapter.capabilities.provider]),
    [['mulinux', 'local-disk'], ['azure-eu', 'azure-blob']]);
  assert.equal(targets[0].adapter.capabilities.immutability, 'unsupported');
  assert.equal(targets[1].adapter.capabilities.immutability, 'unknown');

  const report = await shipArtifact(targets, { name: 'artifact.bin', bytes: Buffer.from('x') });
  assert.equal(report.status, 'partial', 'the unreachable Azure target is reported, not dropped');
  const everything = JSON.stringify({ report, capabilities: targets.map((target) => target.adapter.capabilities) });
  assert.doesNotMatch(everything, /ENVFIXTURESIG|sig=/);

  assert.throws(() => loadStorageTargets({ KEEL_STORAGE_TARGETS: 'a', KEEL_STORAGE_TARGET_A_DIR: 'relative' }), /absolute directory/);
  assert.throws(() => loadStorageTargets({ KEEL_STORAGE_TARGETS: 'a', KEEL_STORAGE_TARGET_A_KIND: 'azure-blob', KEEL_STORAGE_TARGET_A_CONTAINER: 'keel-rt-fixture' }), /_SAS is required/);
  assert.throws(() => loadStorageTargets({ KEEL_STORAGE_TARGETS: 'a', KEEL_STORAGE_TARGET_A_KIND: 'ftp' }), /must be one of/);
  assert.throws(() => defineStorageTargets([localTarget('dup'), localTarget('dup')]), /duplicate/);
});

test('a local target on the same filesystem as the dumps is refused (volume not mounted)', async () => {
  const sameDev = async () => ({ dev: 7 });
  await assert.rejects(separateFilesystemCheck('/mnt/keel-copy/keel-store', '/opt/backups', { statFn: sameDev }), /same filesystem/);
  let call = 0;
  const differentDev = async () => ({ dev: (call += 1) });
  await separateFilesystemCheck('/mnt/keel-copy/keel-store', '/opt/backups', { statFn: differentDev })();

  const root = dir('probe');
  mkdirSync(root, { recursive: true });
  const probes = await probeTargets(defineStorageTargets([
    localTarget('ok', root),
    { ...localTarget('unmounted'), check: separateFilesystemCheck(root, root) },
  ]));
  assert.deepEqual(probes.map((probe) => [probe.targetId, probe.usable]), [['ok', true], ['unmounted', false]]);
});

function writeDump(backupRoot, date, content) {
  const dumpDir = join(backupRoot, date);
  mkdirSync(dumpDir, { recursive: true });
  const dump = join(dumpDir, 'keel-db.sql.gz');
  writeFileSync(dump, content);
  const manifestPath = join(backupRoot, 'keel-db-manifest.json');
  writeFileSync(manifestPath, JSON.stringify({
    path: dump, checksum: createHash('sha256').update(content).digest('hex'), timestamp: `${date}T05:00:00Z`,
  }));
  return manifestPath;
}

test('offsite ships the dump to every target, records it only when complete, and prunes old local copies', async () => {
  const backupRoot = dir('backups');
  const shipped = join(backupRoot, 'keel-db-shipped-manifest.json');
  const mulinux = dir('mulinux');
  const spare = dir('spare');
  const env = {
    KEEL_STORAGE_TARGETS: 'mulinux,spare',
    KEEL_STORAGE_TARGET_MULINUX_DIR: mulinux,
    KEEL_STORAGE_TARGET_MULINUX_KEEP_DAYS: '30',
    KEEL_STORAGE_TARGET_SPARE_DIR: spare,
    KEEL_OFFSITE_AGE_RECIPIENTS: ageRecipients,
  };
  mkdirSync(join(mulinux, 'keel-db'), { recursive: true });
  writeFileSync(join(mulinux, 'keel-db', 'keel-db-2026-09-01.sql.gz'), 'old');
  writeFileSync(join(mulinux, 'keel-db', 'unrelated.txt'), 'kept');
  const now = () => new Date('2026-10-15T06:00:00Z');

  const manifestPath = writeDump(backupRoot, '2026-10-15', 'dump-15');
  const dry = await shipDumpToTargets(manifestPath, shipped, { env, dryRun: true, now });
  assert.deepEqual(dry.probes.map((probe) => probe.usable), [true, true]);
  assert.equal(dry.name, 'keel-db/keel-db-2026-10-15.sql.gz.age');
  assert.deepEqual(readdirSync(join(mulinux, 'keel-db')).sort(), ['keel-db-2026-09-01.sql.gz', 'unrelated.txt'], 'a dry run writes nothing');

  const recorded = [];
  const { report, pruned } = await shipDumpToTargets(manifestPath, shipped, { env, now, recordDb: async (r) => recorded.push(r) });
  assert.equal(report.status, 'complete');
  assert.equal(recorded.length, 1);
  const shippedCopy = join(spare, 'keel-db', 'keel-db-2026-10-15.sql.gz.age');
  assert.ok(!readFileSync(shippedCopy).includes('dump-15'), 'the shipped copy is not plaintext');
  assert.equal(decrypt(shippedCopy).toString('utf8'), 'dump-15', 'the identity kept off the host decrypts it');
  assert.equal(report.sha256, sha256Hex(readFileSync(shippedCopy)), 'the report hashes the ciphertext that shipped');
  assert.deepEqual(pruned, { mulinux: ['keel-db-2026-09-01.sql.gz'], spare: [] });
  assert.deepEqual(readdirSync(join(mulinux, 'keel-db')).sort(), ['keel-db-2026-10-15.sql.gz.age', 'unrelated.txt']);
  assert.equal(JSON.parse(readFileSync(shipped, 'utf8')).timestamp, '2026-10-15T05:00:00Z');
  assert.deepEqual(JSON.parse(readFileSync(shipped, 'utf8')).shipped, { name: 'keel-db/keel-db-2026-10-15.sql.gz.age', sha256: report.sha256 },
    'the ciphertext hash is recorded with the shipped manifest');
  await assert.rejects(() => shipDumpToTargets(manifestPath, shipped, { env, now }), /not newer/);

  // The next dump with one target down: partial, not recorded, so the next run retries it.
  const next = writeDump(backupRoot, '2026-10-16', 'dump-16');
  const targets = loadStorageTargets(env).map((target) => (target.id === 'spare' ? { ...target, ...down } : target));
  const partial = await shipDumpToTargets(next, shipped, { env, targets, now });
  assert.equal(partial.report.status, 'partial');
  assert.equal(JSON.parse(readFileSync(shipped, 'utf8')).timestamp, '2026-10-15T05:00:00Z');
  const retried = await shipDumpToTargets(next, shipped, { env, now });
  assert.equal(retried.report.status, 'complete');
  assert.deepEqual(retried.report.copies.map((copy) => copy.published), ['already-present', 'published']);
  assert.equal(retried.report.sha256, partial.report.sha256, 'a retry ships the same ciphertext as the partial run');
  assert.equal(decrypt(join(spare, 'keel-db', 'keel-db-2026-10-16.sql.gz.age')).toString('utf8'), 'dump-16');

  // No recipient, or a private key where the recipients belong: nothing ships, nothing is recorded.
  const third = writeDump(backupRoot, '2026-10-17', 'dump-17');
  const before = readFileSync(shipped, 'utf8');
  await assert.rejects(() => shipDumpToTargets(third, shipped, { env: { ...env, KEEL_OFFSITE_AGE_RECIPIENTS: join(tmp, 'absent.txt') }, now }), /no encryption recipient/);
  await assert.rejects(() => shipDumpToTargets(third, shipped, { env: { ...env, KEEL_OFFSITE_AGE_RECIPIENTS: join(tmp, 'absent.txt') }, dryRun: true, now }), /no encryption recipient/);
  await assert.rejects(() => shipDumpToTargets(third, shipped, { env: { ...env, KEEL_OFFSITE_AGE_RECIPIENTS: ageKeys }, now }), /holds a private age key/);
  const empty = join(tmp, 'empty-recipients.txt');
  writeFileSync(empty, '# nobody\n');
  await assert.rejects(() => shipDumpToTargets(third, shipped, { env: { ...env, KEEL_OFFSITE_AGE_RECIPIENTS: empty }, now }), /lists none/);
  const notAge = join(tmp, 'bad-recipients.txt');
  writeFileSync(notAge, 'ssh-rsa AAAA\n');
  await assert.rejects(() => shipDumpToTargets(third, shipped, { env: { ...env, KEEL_OFFSITE_AGE_RECIPIENTS: notAge }, now }), /is not an age recipient/);
  assert.ok(!readdirSync(join(spare, 'keel-db')).some((name) => name.includes('2026-10-17')), 'nothing shipped without encryption');
  assert.equal(readFileSync(shipped, 'utf8'), before);

  await assert.rejects(() => shipDumpToTargets(next, shipped, { env: {} }), /KEEL_STORAGE_TARGETS is not set/);
  assert.deepEqual(await pruneLocalDumps(dir('empty'), 30), []);
});

test('keel-offsite.sh ships through the registry when KEEL_STORAGE_TARGETS is set', async () => {
  const exec = promisify(execFile);
  const repoRoot = fileURLToPath(new URL('../..', import.meta.url));
  const backupRoot = dir('sh-backups');
  const mulinux = dir('sh-mulinux');
  const dump = gzipSync(Array.from({ length: 5 }, (_, n) => `COPY public.fixture${n} (id) FROM stdin;\n\\.\n`).join(''));
  writeDump(backupRoot, '2026-10-15', dump);
  const env = {
    ...process.env,
    KEEL_DB_URL: '',
    KEEL_OFFSITE_BACKUP_ROOT: backupRoot,
    KEEL_STORAGE_TARGETS: 'mulinux',
    KEEL_STORAGE_TARGET_MULINUX_DIR: mulinux,
    KEEL_OFFSITE_AGE_RECIPIENTS: ageRecipients,
  };
  await assert.rejects(() => exec('bash', ['ops/keel-offsite.sh', '--dry-run'], { cwd: repoRoot, env: { ...env, KEEL_OFFSITE_AGE_RECIPIENTS: join(tmp, 'absent.txt') } }),
    (error) => /no encryption recipient/.test(error.stderr));
  const dry = await exec('bash', ['ops/keel-offsite.sh', '--dry-run'], { cwd: repoRoot, env });
  assert.match(dry.stdout, /DRY RUN: mulinux usable/);
  assert.throws(() => readdirSync(mulinux), { code: 'ENOENT' });
  const run = await exec('bash', ['ops/keel-offsite.sh'], { cwd: repoRoot, env });
  assert.match(run.stdout, /complete/);
  assert.deepEqual(decrypt(join(mulinux, 'keel-db', 'keel-db-2026-10-15.sql.gz.age')), dump);

  const next = writeDump(backupRoot, '2026-10-16', dump);
  assert.ok(next);
  await assert.rejects(() => exec('bash', ['ops/keel-offsite.sh'], {
    cwd: repoRoot, env: { ...env, KEEL_STORAGE_TARGET_MULINUX_SEPARATE_FROM: backupRoot, KEEL_STORAGE_TARGET_MULINUX_DIR: join(backupRoot, 'store') },
  }), (error) => /same filesystem/.test(error.stdout) && /did not complete/.test(error.stderr));
});

test('each copy is recorded in storage_copy', async () => {
  const database = await createIsolatedTestDatabase(import.meta.url);
  const client = await database.connect();
  try {
    await client.query(schemaSql());
    const report = await shipArtifact(defineStorageTargets([localTarget('mulinux'), localTarget('off', undefined, down)]), {
      name: 'artifact.bin', bytes: Buffer.from('recorded'),
    });
    await recordShipment(client, report);
    const { rows } = await client.query('SELECT target_id, shipment_status, verified, published, immutability, failures FROM storage_copy ORDER BY target_id');
    assert.deepEqual(rows, [
      { target_id: 'mulinux', shipment_status: 'partial', verified: true, published: 'published', immutability: 'unsupported', failures: [] },
      { target_id: 'off', shipment_status: 'partial', verified: false, published: 'error', immutability: 'unsupported', failures: ['volume not mounted'] },
    ]);
  } finally {
    await client.end();
    await database.cleanup();
  }
});
