/**
 * Wave 2 FMT: Keel bundle v1. Export, import into an empty Keel (a second
 * fixture schema), export again gives a byte-identical archive; one changed
 * byte anywhere fails verification; a wrong key fails; an import restores every
 * object, reference and content item. Fixtures only: no tenant is read or written.
 */
import { strict as assert } from 'node:assert';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { after, before, test } from 'node:test';

import {
  BUNDLE_CAPABILITY, bundleKeysFromEnv, exportBundle, importBundle, parseBundleSigningKey, parseBundleVerifyKey,
  tarHeader, verifyBundle,
} from './bundle.mjs';
import { sha256Hex } from './manifest.mjs';
import { createPgContentIndex } from '../content/index.mjs';
import { createContentStore, createMemoryStorage } from '../content/store.mjs';
import { completeSnapshot, createSnapshot, insertReferences, insertResourceVersion } from '../store/db.mjs';
import { schemaSql } from '../store/loadSchema.mjs';
import { createIsolatedTestDatabase } from '../test/dbTestHelper.mjs';
import { runCli as exportCli } from '../../cli/keel-export.mjs';
import { runCli as importCli } from '../../cli/keel-import.mjs';

const TENANT = 'sha256:fmt-bundle-test';
const SEED = 'a'.repeat(64);
const OTHER_SEED = 'b'.repeat(64);
const signingKey = parseBundleSigningKey(SEED);
const source = await createIsolatedTestDatabase(`${import.meta.url}:source`);
const target = await createIsolatedTestDatabase(`${import.meta.url}:target`);
const tmp = mkdtempSync(join(tmpdir(), 'keel-bundle-'));
let a;
let b;
let storeA;
let snapshotId;
const bigBody = randomBytes(600 * 1024); // more than one content chunk

const storeOn = (client) => createContentStore({
  index: createPgContentIndex(client), storage: createMemoryStorage(), key: randomBytes(32),
  chunking: { min: 64 * 1024, maskBits: 16, max: 256 * 1024 },
});

before(async () => {
  a = await source.connect();
  b = await target.connect();
  await a.query(schemaSql());
  await b.query(schemaSql());
  storeA = storeOn(a);

  snapshotId = await createSnapshot(a, { tenantRef: TENANT });
  const resources = [
    { naturalKey: 'group:KEEL-RT-Finance', resourceType: 'group', payload: { id: 'g-1', displayName: 'KEEL-RT-Finance', mailEnabled: false } },
    { naturalKey: 'user:keel-rt-ana@example.test', resourceType: 'user', payload: { id: 'u-1', userPrincipalName: 'keel-rt-ana@example.test', onPremisesImmutableId: 'kept' } },
    {
      naturalKey: 'conditionalAccessPolicy:KEEL-RT-Block legacy', resourceType: 'conditionalAccessPolicy',
      payload: { id: 'p-1', displayName: 'KEEL-RT-Block legacy', state: 'disabled', conditions: { users: { includeGroups: ['g-1'] } } },
      references: [
        { field: 'conditions.users.includeGroups[0]', symbol: 'group:KEEL-RT-Finance', required: true },
        { field: 'conditions.users.excludeUsers[0]', symbol: null, required: false, prefix: '/administrativeUnits/' },
      ],
    },
  ];
  for (const { references = [], ...resource } of resources) {
    const versionId = await insertResourceVersion(a, {
      snapshotId,
      resource: {
        payloadHash: `fixture-${resource.naturalKey}`, criticality: 'tier1', blastRadius: 'access-affecting', fidelity: 'read-only',
        provenance: { adapter: 'fixture', collectedAt: '2026-10-15T00:00:00.000Z' }, ...resource,
      },
    });
    await insertReferences(a, { fromVersion: versionId, references });
  }
  await completeSnapshot(a, {
    id: snapshotId, status: 'complete',
    coverageDigest: { group: { outcome: 'complete', itemCount: 1 }, user: { outcome: 'complete', itemCount: 1 } },
  });

  const box = { tenantRef: TENANT, workload: 'exchange-mail', container: 'mailbox:keel-rt-ana' };
  await storeA.putItem(Readable.from([Buffer.from('{"subject":"KEEL-RT-one"}')]), { ...box, itemKey: 'msg-1', version: 'ck-1', metadata: { kind: 'message' } });
  await storeA.putItem(Readable.from([bigBody]), { ...box, workload: 'onedrive', container: 'drive:keel-rt-ana', itemKey: 'file-1', metadata: { name: 'KEEL-RT-report.bin' } });
  await storeA.putItem(Readable.from([Buffer.alloc(0)]), { ...box, itemKey: 'msg-empty', version: 'ck-0' });
  // Another tenant's content never enters this tenant's bundle.
  await storeA.putItem(Readable.from([Buffer.from('other')]), { ...box, tenantRef: 'sha256:someone-else', itemKey: 'x' });
});

after(async () => {
  await a?.end();
  await b?.end();
  await source.cleanup();
  await target.cleanup();
  rmSync(tmp, { recursive: true, force: true });
});

const fileHash = (path) => sha256Hex(readFileSync(path));

async function resetTarget() {
  await b.query('TRUNCATE snapshot, resource_version, resource_reference, content_item, content_chunk, content_ref CASCADE');
}

test('export, import into an empty Keel, export again gives a byte-identical bundle (content refs)', async () => {
  await resetTarget();
  const first = join(tmp, 'refs-1.keel');
  const result = await exportBundle(a, { tenantRef: TENANT, out: first, signingKey });
  assert.equal(result.snapshotId, snapshotId);
  assert.equal(result.objects, 3);
  assert.deepEqual(result.content, { mode: 'refs', items: 3 });

  const imported = await importBundle(b, first, { verifyKey: signingKey });
  assert.notEqual(imported.snapshotId, snapshotId, 'the importing Keel gets its own snapshot id');
  assert.deepEqual(imported.content, { stored: 0, referenced: 3 });

  const second = join(tmp, 'refs-2.keel');
  await exportBundle(b, { tenantRef: TENANT, out: second, signingKey });
  assert.equal(fileHash(second), fileHash(first));
});

test('an import into an empty schema restores every object, reference and content ref', async () => {
  await resetTarget();
  const out = join(tmp, 'restore.keel');
  await exportBundle(a, { tenantRef: TENANT, out, signingKey });
  const { snapshotId: importedId } = await importBundle(b, out, { verifyKey: signingKey });

  const objects = async (client, id) => (await client.query(
    `SELECT natural_key, resource_type, payload, payload_hash, hash_version, criticality, blast_radius, fidelity, provenance
       FROM resource_version WHERE snapshot_id = $1 ORDER BY natural_key`, [id],
  )).rows;
  assert.deepEqual(await objects(b, importedId), await objects(a, snapshotId));
  const user = (await objects(b, importedId)).find((row) => row.resource_type === 'user');
  assert.equal(user.payload.onPremisesImmutableId, 'kept', 'a bundle carries the full stored payload');

  const refs = async (client, id) => (await client.query(
    `SELECT rv.natural_key, rr.field_path, rr.to_symbol, rr.required, rr.prefix FROM resource_reference rr
       JOIN resource_version rv ON rv.id = rr.from_version WHERE rv.snapshot_id = $1 ORDER BY 1, 2`, [id],
  )).rows;
  assert.equal((await refs(b, importedId)).length, 2);
  assert.deepEqual(await refs(b, importedId), await refs(a, snapshotId));

  const snap = async (client, id) => (await client.query(
    'SELECT tenant_ref, status, coverage_digest, started_at, completed_at FROM snapshot WHERE id = $1', [id],
  )).rows[0];
  const [was, now] = [await snap(a, snapshotId), await snap(b, importedId)];
  assert.equal(now.status, 'complete');
  assert.equal(now.tenant_ref, TENANT);
  assert.deepEqual(now.coverage_digest, was.coverage_digest);
  assert.equal(now.completed_at.toISOString(), was.completed_at.toISOString());

  const held = (await a.query(
    `SELECT workload, container, item_key, version, metadata, sha256, bytes FROM content_item WHERE tenant_ref = $1 ORDER BY item_key`, [TENANT],
  )).rows;
  const known = (await b.query(
    `SELECT workload, container, item_key, version, metadata, sha256, bytes FROM content_ref WHERE tenant_ref = $1 ORDER BY item_key`, [TENANT],
  )).rows;
  assert.equal(held.length, 3);
  assert.deepEqual(known, held);

  await assert.rejects(importBundle(b, out, { verifyKey: signingKey }), /already holds that snapshot/);
  // The source Keel stores microsecond times; the bundle carries milliseconds. Still the same snapshot.
  await assert.rejects(importBundle(a, out, { verifyKey: signingKey }), /already holds that snapshot/);
});

test('with content bytes, the importing Keel stores every item under its own key and re-exports identically', async () => {
  await resetTarget();
  const first = join(tmp, 'bytes-1.keel');
  const result = await exportBundle(a, { tenantRef: TENANT, out: first, signingKey, content: 'bytes', contentStore: storeA });
  assert.deepEqual(result.content, { mode: 'bytes', items: 3 });

  await assert.rejects(importBundle(b, first, { verifyKey: signingKey }), /needs the content store/);
  const storeB = storeOn(b);
  const imported = await importBundle(b, first, { verifyKey: signingKey, contentStore: storeB });
  assert.deepEqual(imported.content, { stored: 3, referenced: 0 });

  const [file] = await storeB.listItems({ container: 'drive:keel-rt-ana', tenantRef: TENANT });
  const chunks = [];
  for await (const chunk of await storeB.getItem(file.ref)) chunks.push(chunk);
  assert.ok(Buffer.concat(chunks).equals(bigBody));
  assert.notEqual(storeB.keyId, storeA.keyId);

  const second = join(tmp, 'bytes-2.keel');
  await exportBundle(b, { tenantRef: TENANT, out: second, signingKey, content: 'bytes', contentStore: storeB });
  assert.equal(fileHash(second), fileHash(first));
});

test('exporting the same snapshot twice gives the same bytes, and an existing file is never overwritten', async () => {
  const one = join(tmp, 'same-1.keel');
  const two = join(tmp, 'same-2.keel');
  await exportBundle(a, { tenantRef: TENANT, out: one, signingKey });
  await exportBundle(a, { tenantRef: TENANT, out: two, signingKey });
  assert.equal(fileHash(one), fileHash(two));
  await assert.rejects(exportBundle(a, { tenantRef: TENANT, out: one, signingKey }), /refusing to overwrite/);
});

async function changedBytesThatVerify(path, positions) {
  const original = readFileSync(path);
  const probe = `${path}.probe`;
  const passed = [];
  for (const i of positions(original.length)) {
    const copy = Buffer.from(original);
    copy[i] ^= 0x01;
    writeFileSync(probe, copy);
    if ((await verifyBundle(probe, { verifyKey: signingKey })).ok) passed.push(i);
  }
  return passed;
}

test('one changed byte anywhere in the archive fails verification', async () => {
  // Every single byte of a refs bundle: headers, manifest, signature, entries, padding, tail.
  const refs = join(tmp, 'tamper-refs.keel');
  await exportBundle(a, { tenantRef: TENANT, out: refs, signingKey });
  assert.equal((await verifyBundle(refs, { verifyKey: signingKey })).ok, true);
  const every = (length) => Array.from({ length }, (_, i) => i);
  assert.deepEqual(await changedBytesThatVerify(refs, every), [], 'no single-byte change may verify');

  // A bundle with content bytes: a spread through the blobs, which are hashed, not signed directly.
  const out = join(tmp, 'tamper.keel');
  await exportBundle(a, { tenantRef: TENANT, out, signingKey, content: 'bytes', contentStore: storeA });
  const spread = (length) => Array.from({ length: Math.ceil(length / 4099) }, (_, i) => i * 4099);
  assert.deepEqual(await changedBytesThatVerify(out, spread), [], 'no single-byte change in a blob may verify');
  const original = readFileSync(out);
  const probe = join(tmp, 'probe.keel');

  writeFileSync(probe, Buffer.concat([original, Buffer.alloc(512)]));
  assert.equal((await verifyBundle(probe, { verifyKey: signingKey })).ok, false, 'appended bytes fail');
  writeFileSync(probe, original.subarray(0, original.length - 512));
  assert.equal((await verifyBundle(probe, { verifyKey: signingKey })).ok, false, 'a truncated archive fails');

  copyWith(probe, original, (copy) => { copy[copy.length - 2048] ^= 1; });
  await resetTarget();
  await assert.rejects(importBundle(b, probe, { verifyKey: signingKey, contentStore: storeOn(b) }), /failed verification/);
  assert.equal((await b.query('SELECT count(*)::int AS n FROM snapshot')).rows[0].n, 0, 'nothing is imported from a bad bundle');
});

function copyWith(path, original, change) {
  const copy = Buffer.from(original);
  change(copy);
  writeFileSync(path, copy);
}

test('a wrong key fails verification, and a verify key alone verifies', async () => {
  const out = join(tmp, 'keys.keel');
  await exportBundle(a, { tenantRef: TENANT, out, signingKey });
  const wrong = parseBundleSigningKey(OTHER_SEED);
  const failed = await verifyBundle(out, { verifyKey: wrong });
  assert.equal(failed.ok, false);
  assert.match(failed.failures.join(), /signature does not verify/);

  const publicOnly = parseBundleVerifyKey(signingKey.publicKeyHex);
  assert.equal(publicOnly.keyId, signingKey.keyId);
  assert.equal((await verifyBundle(out, { verifyKey: publicOnly })).ok, true);

  // Re-signing a doctored manifest with another key does not pass the right key.
  const resigned = join(tmp, 'resigned.keel');
  await exportBundle(a, { tenantRef: TENANT, out: resigned, signingKey: wrong });
  assert.equal((await verifyBundle(resigned, { verifyKey: signingKey })).ok, false);

  assert.throws(() => parseBundleSigningKey('short'), /32 bytes/);
  assert.deepEqual(bundleKeysFromEnv({}), { signingKey: null, verifyKey: null });
  assert.equal(bundleKeysFromEnv({ KEEL_BUNDLE_VERIFY_KEY: signingKey.publicKeyHex }).signingKey, null);
});

test('ustar headers are canonical and long paths use the prefix field', () => {
  const header = tarHeader(`objects/${'t'.repeat(60)}/${'0'.repeat(64)}.json`, 10);
  assert.equal(header.length, 512);
  assert.equal(header.subarray(257, 262).toString(), 'ustar');
  assert.equal(header.subarray(345, 345 + 68).toString(), `objects/${'t'.repeat(60)}`);
  assert.throws(() => tarHeader('x', -1), /at most/);
});

test('the CLIs refuse without the export capability, then export, verify offline and import', async () => {
  const lines = [];
  const logger = { log: (line) => lines.push(line), error: (line) => lines.push(String(line)) };
  const env = { KEEL_BUNDLE_SIGNING_KEY: SEED };
  const out = join(tmp, 'cli.keel');
  const asAdmin = (granted) => ({
    connect: async () => ({ query: a.query.bind(a), end: async () => {} }),
    resolvePrincipal: async (_client, email) => ({ id: 'p-1', email }),
    can: async (_client, _principal, capability) => granted && capability === BUNDLE_CAPABILITY,
  });
  const argv = ['node', 'keel-export.mjs', '--bundle', out, '--tenant-ref', TENANT, '--db-url', 'postgres://fixture', '--as', 'keel-rt-admin@example.test'];

  assert.equal(await exportCli({ argv, env, logger, dependencies: asAdmin(false) }), 1);
  assert.match(lines.join('\n'), /does not hold the export capability/);
  assert.equal(existsSync(out), false);
  assert.equal(await exportCli({ argv: argv.slice(0, -2), env, logger, dependencies: asAdmin(true) }), 1, '--as is required');

  assert.equal(await exportCli({ argv, env, logger, dependencies: asAdmin(true) }), 0);
  assert.equal(await importCli({ argv: ['node', 'keel-import.mjs', '--bundle', out, '--verify-only'], env: { KEEL_BUNDLE_VERIFY_KEY: signingKey.publicKeyHex }, logger }), 0);
  assert.equal(await importCli({ argv: ['node', 'keel-import.mjs', '--bundle', out, '--verify-only'], env: { KEEL_BUNDLE_SIGNING_KEY: OTHER_SEED }, logger }), 1);
  assert.equal(await importCli({ argv: ['node', 'keel-import.mjs', '--public-key'], env, logger }), 0);
  assert.ok(lines.includes(`KEEL_BUNDLE_VERIFY_KEY=${signingKey.publicKeyHex}`));

  await resetTarget();
  const importArgv = ['node', 'keel-import.mjs', '--bundle', out, '--db-url', 'postgres://fixture', '--as', 'keel-rt-admin@example.test'];
  const intoB = (granted) => ({ ...asAdmin(granted), connect: async () => ({ query: b.query.bind(b), end: async () => {} }) });
  assert.equal(await importCli({ argv: importArgv, env, logger, dependencies: intoB(false) }), 1);
  assert.equal((await b.query('SELECT count(*)::int AS n FROM snapshot')).rows[0].n, 0);
  assert.equal(await importCli({ argv: importArgv, env, logger, dependencies: intoB(true) }), 0);
  assert.equal((await b.query('SELECT count(*)::int AS n FROM resource_version')).rows[0].n, 3);
});
