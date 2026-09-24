/**
 * Roadmap task-56 boundary tests: atomic redacted configuration file exports.
 * Exercises the production engine/export/configExport.mjs,
 * engine/export/manifest.mjs, engine/contracts/fieldProjection.mjs and
 * engine/contracts/observation.mjs against the isolated test database and tmp
 * filesystem trees — including the three required mutation checks:
 *
 * - Advance latest before rename.
 * - Skip sensitive-field exclusion.
 * - Construct filename directly from natural key.
 */
import { strict as assert } from 'node:assert';
import { readdir, readFile, readlink, rename, stat, symlink, writeFile, appendFile, mkdir } from 'node:fs/promises';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, sep } from 'node:path';
import { after, before, test } from 'node:test';

import { exportProjection } from '../contracts/fieldProjection.mjs';
import { OBSERVATION_CONTRACT_VERSION } from '../contracts/observation.mjs';
import {
  exportSnapshot, readLatestExport, resolveExportSnapshot, tenantDirectoryName,
} from '../export/configExport.mjs';
import {
  MANIFEST_VERSION, RESOURCE_FILENAME_PATTERN, buildManifest, filenameForKey, stableJson, verifyManifest,
} from '../export/manifest.mjs';
import { completeSnapshot, connect, createSnapshot, insertResourceVersion } from '../store/db.mjs';
import { createIsolatedTestDatabase } from '../test/dbTestHelper.mjs';
import { fullSuccessfulCoverageDigest } from '../test/fullSuccessfulCoverage.mjs';
import { runCli } from '../../cli/keel-export.mjs';

const database = await createIsolatedTestDatabase(import.meta.url);
const tmp = mkdtempSync(join(tmpdir(), 'keel-config-export-'));
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

const UUID_PATTERN = /^[0-9a-f-]{36}$/;

async function listEntries(dir, base = dir) {
  const out = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    const rel = relative(base, path);
    if (entry.isDirectory()) out.push(...await listEntries(path, base));
    else if (entry.isSymbolicLink()) out.push(`${rel} -> ${await readlink(path)}`);
    else out.push(rel);
  }
  return out;
}

function digestWith(overrides) {
  return { ...fullSuccessfulCoverageDigest(), ...overrides };
}

/** Persists a completed snapshot fixture through the production store module. */
async function makeSnapshot({ tenantRef, digest, resources = [], startedAt, completedAt }) {
  const snapshotId = await createSnapshot(client, { tenantRef });
  for (const resource of resources) {
    await insertResourceVersion(client, {
      snapshotId,
      resource: {
        payloadHash: `fixture-hash-${resource.naturalKey}`,
        criticality: 'tier1',
        blastRadius: 'access-affecting',
        fidelity: 'read-only',
        provenance: { adapter: 'fixture', collectedAt: '2026-09-20T00:00:00.000Z', fidelity: 'read-only' },
        ...resource,
      },
    });
  }
  await completeSnapshot(client, { id: snapshotId, status: 'complete', coverageDigest: digest });
  if (startedAt) {
    await client.query('UPDATE snapshot SET started_at = $2, completed_at = $3 WHERE id = $1', [snapshotId, startedAt, completedAt]);
  }
  return snapshotId;
}

function userResource(naturalKey, extra = {}) {
  return {
    naturalKey,
    resourceType: 'user',
    payload: {
      id: `id-${naturalKey}`,
      userPrincipalName: naturalKey.slice('user:'.length),
      displayName: 'Fixture User',
      ...extra,
    },
  };
}

test('exports a tenant/snapshot/type tree with hashed filenames and a verifiable manifest', async () => {
  const tenantRef = 'sha256:export-basic';
  const snapshotId = await makeSnapshot({
    tenantRef,
    digest: digestWith({ user: { outcome: 'complete', itemCount: 1 } }),
    resources: [userResource('user:ana@example.test')],
  });
  const exportRoot = join(tmp, 'basic');
  const result = await exportSnapshot(client, { tenantRef, exportRoot });

  assert.equal(result.snapshotId, snapshotId);
  const tenantDir = join(exportRoot, tenantDirectoryName(tenantRef));
  assert.equal(result.exportDir, join(tenantDir, snapshotId));
  const filename = filenameForKey('user:ana@example.test');
  assert.ok(RESOURCE_FILENAME_PATTERN.test(filename));

  const entries = (await listEntries(tenantDir)).sort();
  assert.deepEqual(entries, [
    `${snapshotId}/manifest.json`,
    `${snapshotId}/user/${filename}`,
    `latest -> ${snapshotId}`,
  ].sort());

  const manifest = JSON.parse(await readFile(join(result.exportDir, 'manifest.json'), 'utf8'));
  assert.equal(manifest.manifestVersion, MANIFEST_VERSION);
  assert.equal(manifest.tenantRef, tenantRef);
  assert.equal(manifest.snapshot.id, snapshotId);
  assert.equal(manifest.types.user.enumeration, 'complete');
  assert.equal(manifest.types.user.absenceMeansDeletion, true);
  assert.equal(manifest.types.user.resources[filename].naturalKey, 'user:ana@example.test');
  assert.deepEqual(
    await verifyManifest(manifest, result.exportDir, { expectedTenantRef: tenantRef }),
    { ok: true, failures: [] },
  );

  const latest = await readLatestExport(exportRoot, { tenantRef });
  assert.equal(latest.snapshotId, snapshotId);
  assert.equal(latest.verification.ok, true);

  // A second export of the same snapshot refuses rather than clobbering.
  await assert.rejects(exportSnapshot(client, { tenantRef, exportRoot }), /already exported/);
});

test('same values with different collection times produce byte-identical resource files', async () => {
  const tenantRef = 'sha256:export-determinism';
  const payload = { id: 'g1', displayName: 'Finance', mailNickname: 'finance' };
  const resources = [{ naturalKey: 'group:finance', resourceType: 'group', payload }];
  const digest = digestWith({ group: { outcome: 'complete', itemCount: 1 } });
  const firstId = await makeSnapshot({
    tenantRef, digest, resources,
    startedAt: '2026-09-20T08:00:00.000Z', completedAt: '2026-09-20T08:05:00.000Z',
  });
  const secondId = await makeSnapshot({
    tenantRef, digest, resources,
    startedAt: '2026-09-21T09:00:00.000Z', completedAt: '2026-09-21T09:07:00.000Z',
  });
  const exportRoot = join(tmp, 'determinism');
  const first = await exportSnapshot(client, { tenantRef, snapshotId: firstId, exportRoot });
  const second = await exportSnapshot(client, { tenantRef, snapshotId: secondId, exportRoot });

  const filename = filenameForKey('group:finance');
  const firstBytes = await readFile(join(first.exportDir, 'group', filename));
  const secondBytes = await readFile(join(second.exportDir, 'group', filename));
  assert.deepEqual(firstBytes, secondBytes, 'resource bytes depend only on redacted values');
  const text = firstBytes.toString('utf8');
  for (const volatile of ['08:05', '09:07', 'collectedAt', firstId, secondId, 'startedAt', 'completedAt']) {
    assert.ok(!text.includes(volatile), `resource bytes must not carry volatile time/provenance: ${volatile}`);
  }

  // The manifest is where volatile times live: identical resource maps,
  // different snapshot windows.
  for (const type of Object.keys(first.manifest.types)) {
    assert.deepEqual(first.manifest.types[type].resources, second.manifest.types[type].resources, type);
    assert.equal(first.manifest.types[type].enumeration, second.manifest.types[type].enumeration, type);
  }
  assert.notEqual(first.manifest.snapshot.startedAt, second.manifest.snapshot.startedAt);
  assert.equal(first.manifest.snapshot.startedAt, '2026-09-20T08:00:00.000Z');
  assert.equal(second.manifest.snapshot.startedAt, '2026-09-21T09:00:00.000Z');
  assert.deepEqual(first.manifest.types.group.observation.window, {
    startedAt: '2026-09-20T08:00:00.000Z', endedAt: '2026-09-20T08:05:00.000Z',
  });
  assert.deepEqual(second.manifest.types.group.observation.window, {
    startedAt: '2026-09-21T09:00:00.000Z', endedAt: '2026-09-21T09:07:00.000Z',
  });
});

test('sensitive fields never appear in any exported file (mutation pin: skip sensitive-field exclusion)', async () => {
  const tenantRef = 'sha256:export-redaction';
  await makeSnapshot({
    tenantRef,
    digest: digestWith({
      user: { outcome: 'complete', itemCount: 1 },
      group: { outcome: 'complete', itemCount: 1 },
    }),
    resources: [
      userResource('user:ana@example.test', {
        onPremisesImmutableId: 'SENSITIVE-IMMUTABLE-ID',
        employeeId: 'SENSITIVE-HR-ID',
      }),
      {
        naturalKey: 'group:finance',
        resourceType: 'group',
        payload: {
          id: 'g1', displayName: 'Finance', mailNickname: 'finance',
          securityIdentifier: 'S-1-5-SENSITIVE-SID', onPremisesSamAccountName: 'SENSITIVE-SAM',
        },
      },
    ],
  });
  const exportRoot = join(tmp, 'redaction');
  const result = await exportSnapshot(client, { tenantRef, exportRoot });

  const files = (await listEntries(result.exportDir)).filter((entry) => !entry.includes(' -> '));
  assert.ok(files.length >= 3, 'expected resource files plus the manifest');
  for (const rel of files) {
    const content = await readFile(join(result.exportDir, rel), 'utf8');
    for (const sensitive of ['SENSITIVE-IMMUTABLE-ID', 'SENSITIVE-HR-ID', 'S-1-5-SENSITIVE-SID', 'SENSITIVE-SAM']) {
      // Mutation pin: skipping exportProjection would put these values into
      // the resource files and fail this assertion.
      assert.ok(!content.includes(sensitive), `${rel} must never contain ${sensitive}`);
    }
  }
  // Redaction is a cut, not a wipe: non-sensitive context survives.
  const userFile = await readFile(join(result.exportDir, 'user', filenameForKey('user:ana@example.test')), 'utf8');
  assert.ok(userFile.includes('Fixture User'));
  assert.ok(userFile.includes('ana@example.test'));
  assert.ok(!userFile.includes('onPremisesImmutableId'), 'the sensitive key itself is absent');
  assert.deepEqual(exportProjection({ onPremisesImmutableId: 'x', displayName: 'A' }, 'user'), { displayName: 'A' });
});

test('hostile natural keys cannot escape the export tree (mutation pin: filename from natural key)', async () => {
  const tenantRef = 'sha256:export-hostile-keys';
  const hostileKeys = ['user:../../escape-marker', 'user:/absolute/evil', 'user:a/b/c', 'user:..\\..\\escape-marker'];
  const snapshotId = await makeSnapshot({
    tenantRef,
    digest: digestWith({ user: { outcome: 'complete', itemCount: hostileKeys.length } }),
    resources: hostileKeys.map((key) => userResource(key)),
  });
  const exportRoot = join(tmp, 'hostile');
  const result = await exportSnapshot(client, { tenantRef, exportRoot });

  const entries = await listEntries(exportRoot);
  const expectedFiles = new Set([
    join(tenantDirectoryName(tenantRef), snapshotId, 'manifest.json'),
    ...hostileKeys.map((key) => join(tenantDirectoryName(tenantRef), snapshotId, 'user', filenameForKey(key))),
    join(tenantDirectoryName(tenantRef), `latest -> ${snapshotId}`),
  ]);
  assert.equal(entries.length, expectedFiles.size, 'no file may appear outside the tenant/snapshot/type layout');
  for (const entry of entries) {
    // Mutation pin: constructing the filename from the natural key would turn
    // 'user:../../escape-marker' into a file outside the type directory (or a
    // nested a/b/c path), failing this membership check.
    assert.ok(expectedFiles.has(entry), `unexpected export entry: ${entry}`);
    assert.ok(!entry.includes('escape-marker') && !entry.includes('evil'), entry);
  }
  for (const key of hostileKeys) {
    assert.ok(RESOURCE_FILENAME_PATTERN.test(filenameForKey(key)), `hashed filename for ${key}`);
    assert.equal(
      result.manifest.types.user.resources[filenameForKey(key)].naturalKey,
      key,
      'the manifest maps the hashed filename back to the persisted natural key',
    );
  }
});

test('interrupted export leaves the previous latest untouched (mutation pin: advance latest before rename)', async () => {
  const tenantRef = 'sha256:export-interrupted';
  const digest = digestWith({ group: { outcome: 'complete', itemCount: 1 } });
  const resources = [{ naturalKey: 'group:finance', resourceType: 'group', payload: { id: 'g1', displayName: 'Finance' } }];
  const firstId = await makeSnapshot({ tenantRef, digest, resources });
  const secondId = await makeSnapshot({ tenantRef, digest, resources });
  const exportRoot = join(tmp, 'interrupted');

  await exportSnapshot(client, { tenantRef, snapshotId: firstId, exportRoot });
  const tenantDir = join(exportRoot, tenantDirectoryName(tenantRef));

  // Inject a failure at exactly the staged->final rename of the second export.
  const finalDirSecond = join(tenantDir, secondId);
  await assert.rejects(
    exportSnapshot(client, {
      tenantRef,
      snapshotId: secondId,
      exportRoot,
      dependencies: {
        rename: async (source, destination) => {
          if (destination === finalDirSecond) throw new Error('injected rename failure');
          return rename(source, destination);
        },
      },
    }),
    /injected rename failure/,
  );

  // Mutation pin: if latest were advanced before the staged tree is renamed
  // into place, it would now point at a snapshot directory that does not
  // exist — the readlink below would name secondId instead of firstId.
  assert.equal(await readlink(join(tenantDir, 'latest')), firstId);
  const latest = await readLatestExport(exportRoot, { tenantRef });
  assert.equal(latest.snapshotId, firstId);
  assert.equal(latest.verification.ok, true, 'the previous export still verifies');
  await stat(join(tenantDir, firstId, 'manifest.json'));
  assert.equal((await readdir(tenantDir)).filter((entry) => entry.startsWith('.staging-')).length, 0,
    'the failed export removes its private staging directory');
});

test('partial and failed types are explicit unknown/missing, never empty; complete-empty is genuinely empty', async () => {
  const tenantRef = 'sha256:export-completeness';
  await makeSnapshot({
    tenantRef,
    digest: digestWith({
      user: { outcome: 'partial', itemCount: 1, error: 'fixture: read stopped early' },
      group: { outcome: 'failed', itemCount: null, error: 'fixture: HTTP 403' },
      namedLocation: { outcome: 'complete-empty', itemCount: 0 },
      contact: { outcome: 'not-requested', itemCount: null },
    }),
    resources: [userResource('user:ana@example.test')],
  });
  const exportRoot = join(tmp, 'completeness');
  const result = await exportSnapshot(client, { tenantRef, exportRoot });

  const { types } = result.manifest;
  assert.equal(types.user.enumeration, 'partial');
  assert.equal(types.user.absenceMeansDeletion, false);
  assert.equal(Object.keys(types.user.resources).length, 1,
    'a partial type keeps its observed resources — it is not exported as empty');
  await stat(join(result.exportDir, 'user', filenameForKey('user:ana@example.test')));
  assert.equal(types.user.observation.completeness, 'partial');

  assert.equal(types.group.enumeration, 'unknown');
  assert.equal(types.group.outcome, 'failed');
  assert.equal(types.group.resources, null, 'a failed type is explicit unknown/missing, never an empty listing');
  assert.equal(types.group.absenceMeansDeletion, false);

  assert.equal(types.namedLocation.enumeration, 'complete');
  assert.deepEqual(types.namedLocation.resources, {}, 'a completed empty read is genuinely empty');
  assert.equal(types.namedLocation.absenceMeansDeletion, true);

  assert.equal(types.contact.enumeration, 'unknown');
  assert.equal(types.contact.outcome, 'not-requested');
  assert.equal(types.contact.resources, null);

  // Observation provenance rides the manifest: legacy digest entries read as
  // contractVersion 0 with an unknown evidence level — never promoted.
  assert.equal(types.user.observation.contractVersion, 0);
  assert.equal(types.user.observation.evidenceLevel, 'unknown');
  assert.equal(OBSERVATION_CONTRACT_VERSION, 1);
});

test('absence means deletion only within a successful complete enumeration', async () => {
  const tenantRef = 'sha256:export-deletion';
  const group = (name) => ({ naturalKey: `group:${name}`, resourceType: 'group', payload: { id: name, displayName: name } });
  await makeSnapshot({
    tenantRef,
    digest: digestWith({ group: { outcome: 'complete', itemCount: 2 } }),
    resources: [group('finance'), group('legal')],
    startedAt: '2026-09-20T08:00:00.000Z', completedAt: '2026-09-20T08:05:00.000Z',
  });
  const secondId = await makeSnapshot({
    tenantRef,
    digest: digestWith({ group: { outcome: 'complete', itemCount: 1 } }),
    resources: [group('finance')],
    startedAt: '2026-09-21T08:00:00.000Z', completedAt: '2026-09-21T08:05:00.000Z',
  });
  const exportRoot = join(tmp, 'deletion');
  // No snapshotId: the latest completed snapshot is exported.
  const result = await exportSnapshot(client, { tenantRef, exportRoot });
  assert.equal(result.snapshotId, secondId);

  const entry = result.manifest.types.group;
  assert.equal(entry.enumeration, 'complete');
  assert.equal(entry.absenceMeansDeletion, true,
    'within a complete enumeration, a missing resource file is a deletion');
  assert.deepEqual(
    Object.values(entry.resources).map((meta) => meta.naturalKey),
    ['group:finance'],
    'group:legal is absent from a complete enumeration — deleted, representably',
  );

  // A complete type whose digest itemCount disagrees with the persisted rows
  // aborts the whole export instead of publishing a quietly incomplete tree.
  const mismatchTenant = 'sha256:export-mismatch';
  await makeSnapshot({
    tenantRef: mismatchTenant,
    digest: digestWith({ group: { outcome: 'complete', itemCount: 2 } }),
    resources: [group('finance')],
  });
  await assert.rejects(
    exportSnapshot(client, { tenantRef: mismatchTenant, exportRoot: join(tmp, 'mismatch') }),
    /coverage\/export count mismatch/,
  );
  const mismatchDir = join(tmp, 'mismatch', tenantDirectoryName(mismatchTenant));
  assert.equal((await readdir(mismatchDir)).filter((entry) => !entry.startsWith('.staging-')).length, 0,
    'a refused export publishes nothing');
});

test('manifest verification detects tampering, path escape and tenant-pin mismatch', async () => {
  const tenantRef = 'sha256:export-verify';
  await makeSnapshot({
    tenantRef,
    digest: digestWith({ user: { outcome: 'complete', itemCount: 1 } }),
    resources: [userResource('user:ana@example.test')],
  });
  const exportRoot = join(tmp, 'verify');
  const result = await exportSnapshot(client, { tenantRef, exportRoot });
  const manifestPath = join(result.exportDir, 'manifest.json');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));

  assert.deepEqual(await verifyManifest(manifest, result.exportDir, { expectedTenantRef: tenantRef }), { ok: true, failures: [] });

  const userPath = join(result.exportDir, 'user', filenameForKey('user:ana@example.test'));
  const original = await readFile(userPath);
  await appendFile(userPath, 'tampered');
  let verification = await verifyManifest(manifest, result.exportDir, { expectedTenantRef: tenantRef });
  assert.equal(verification.ok, false);
  assert.ok(verification.failures.some((f) => f.includes('checksum mismatch')));
  assert.ok(verification.failures.some((f) => f.includes('length mismatch')));
  await writeFile(userPath, original);

  const tamperedManifest = structuredClone(manifest);
  tamperedManifest.types.user.resources[filenameForKey('user:ana@example.test')].sha256 = '0'.repeat(64);
  assert.equal((await verifyManifest(tamperedManifest, result.exportDir)).ok, false, 'a forged checksum entry fails');

  assert.equal(
    (await verifyManifest(manifest, result.exportDir, { expectedTenantRef: 'sha256:someone-else' })).ok,
    false,
    'the tenant pin refuses a manifest written for another tenant',
  );
  assert.equal((await verifyManifest(manifest, join(exportRoot, 'nowhere'))).ok, false, 'missing files fail');

  // A manifest declaring a traversal filename fails closed even though no
  // export could ever have produced it.
  const hostile = buildManifest({
    tenantRef,
    snapshot: { id: manifest.snapshot.id },
    types: { user: { enumeration: 'complete', resources: { '../../../etc/passwd.json': { naturalKey: 'x', resourceType: 'user', sha256: '0'.repeat(64), bytes: 1 } } } },
  });
  const hostileCheck = await verifyManifest(hostile, result.exportDir);
  assert.equal(hostileCheck.ok, false);
  assert.ok(hostileCheck.failures.some((f) => f.includes('unsafe resource filename')));

  assert.equal((await verifyManifest(null, result.exportDir)).ok, false);
  assert.equal((await verifyManifest({ ...manifest, manifestVersion: 999 }, result.exportDir)).ok, false);

  // An on-disk manifest edit is caught by the readLatestExport path too.
  await writeFile(manifestPath, stableJson(tamperedManifest));
  assert.equal((await readLatestExport(exportRoot, { tenantRef })).verification.ok, false);
  await writeFile(manifestPath, stableJson(manifest));
});

test('symlinked path components are rejected; nothing is written through them', async () => {
  const tenantRef = 'sha256:export-symlink';
  await makeSnapshot({
    tenantRef,
    digest: digestWith({ user: { outcome: 'complete', itemCount: 1 } }),
    resources: [userResource('user:ana@example.test')],
  });

  // A symlinked tenant directory inside a real export root.
  const root = join(tmp, 'symlink-root');
  const outside = join(tmp, 'symlink-outside');
  await mkdir(root, { recursive: true });
  await mkdir(outside, { recursive: true });
  await symlink(outside, join(root, tenantDirectoryName(tenantRef)));
  await assert.rejects(
    exportSnapshot(client, { tenantRef, exportRoot: root }),
    /symlink/,
  );
  assert.deepEqual(await readdir(outside), [], 'nothing was written through the symlink');

  // A symlinked export root itself.
  const realRoot = join(tmp, 'symlink-real-root');
  const linkRoot = join(tmp, 'symlink-link-root');
  await mkdir(realRoot, { recursive: true });
  await symlink(realRoot, linkRoot);
  await assert.rejects(
    exportSnapshot(client, { tenantRef, exportRoot: linkRoot }),
    /symlink/,
  );
  assert.deepEqual(await readdir(realRoot), [], 'nothing was written through the symlinked root');
});

test('snapshot resolution is tenant-scoped and refuses incomplete runs', async () => {
  const tenantRef = 'sha256:export-scoping';
  const snapshotId = await makeSnapshot({
    tenantRef,
    digest: digestWith({}),
    resources: [],
  });
  await assert.rejects(
    resolveExportSnapshot(client, { tenantRef: 'sha256:export-other', snapshotId }),
    /no completed snapshot/,
    'a foreign tenant cannot name this snapshot (Global Constraint #4)',
  );
  assert.equal((await resolveExportSnapshot(client, { tenantRef, snapshotId })).id, snapshotId);

  const runningId = await createSnapshot(client, { tenantRef });
  await assert.rejects(
    resolveExportSnapshot(client, { tenantRef, snapshotId: runningId }),
    /no completed snapshot/,
    'a still-running snapshot is never exported',
  );
  assert.throws(() => tenantDirectoryName('not-a-tenant-ref'), TypeError);
  assert.throws(() => filenameForKey(''), TypeError);
});

test('CLI exports the latest complete snapshot, keeps tenant scope, and closes its client', async () => {
  const tenantRef = 'sha256:export-cli';
  await makeSnapshot({
    tenantRef,
    digest: digestWith({ user: { outcome: 'complete', itemCount: 1 } }),
    resources: [userResource('user:ana@example.test')],
    startedAt: '2026-09-20T08:00:00.000Z', completedAt: '2026-09-20T08:05:00.000Z',
  });
  const foreignSnapshotId = await makeSnapshot({
    tenantRef: 'sha256:export-cli-foreign',
    digest: digestWith({}),
    resources: [],
  });
  const exportRoot = join(tmp, 'cli');

  const makeDeps = (state) => ({
    connect: async (url) => {
      assert.equal(url, database.url, 'the CLI test must use the isolated KEEL_DB_TEST_URL schema');
      const testClient = await connect(url);
      return {
        query: (...args) => testClient.query(...args),
        end: async () => {
          state.clientClosed = true;
          await testClient.end();
        },
      };
    },
  });
  const quietLogger = (state) => ({
    log() {},
    error(error) { state.errors.push(error); },
  });

  const ok = { errors: [], clientClosed: false };
  const exitCode = await runCli({
    argv: ['node', 'keel-export.mjs', '--db-url', database.url, '--tenant-ref', tenantRef, '--export-root', exportRoot],
    dependencies: makeDeps(ok),
    logger: quietLogger(ok),
  });
  assert.equal(exitCode, 0, JSON.stringify(ok.errors));
  assert.equal(ok.clientClosed, true);
  const latest = await readLatestExport(exportRoot, { tenantRef });
  assert.equal(latest.verification.ok, true);
  assert.equal(latest.manifest.tenantRef, tenantRef);

  const foreign = { errors: [], clientClosed: false };
  const foreignExit = await runCli({
    argv: ['node', 'keel-export.mjs', '--db-url', database.url, '--tenant-ref', tenantRef, '--snapshot-id', foreignSnapshotId, '--export-root', join(tmp, 'cli-foreign')],
    dependencies: makeDeps(foreign),
    logger: quietLogger(foreign),
  });
  assert.equal(foreignExit, 1, 'naming another tenant\'s snapshot fails');
  assert.equal(foreign.clientClosed, true);
  assert.ok(foreign.errors.length === 1);

  const noRoot = { errors: [], clientClosed: false };
  const noRootExit = await runCli({
    argv: ['node', 'keel-export.mjs', '--db-url', database.url, '--tenant-ref', tenantRef],
    dependencies: makeDeps(noRoot),
    logger: quietLogger(noRoot),
  });
  assert.equal(noRootExit, 1, 'an export root is required');

  const helpState = { errors: [], messages: [] };
  const helpExit = await runCli({
    argv: ['node', 'keel-export.mjs', '--help'],
    logger: { log(message) { helpState.messages.push(message); }, error(error) { helpState.errors.push(error); } },
  });
  assert.equal(helpExit, 0);
  assert.ok(helpState.messages[0].includes('--export-root'));
});
