/**
 * Keel bundle v1 (Wave 2, package FMT): one portable, signed archive of one
 * snapshot that verifies offline and imports into any Keel. The format is
 * specified in docs/format/keel-bundle-v1.md; this file is its only writer,
 * verifier and importer.
 *
 *   bundle.json                                   the manifest (signed)
 *   bundle.sig                                    Ed25519 signature over bundle.json's bytes
 *   objects/<resourceType>/<sha256(naturalKey)>.json   one canonical JSON file per object
 *   content/<workload>/<sha256(contentKey)>.json  one per content item: natural key, sha256, bytes
 *   blobs/<sha256>                                the item's plaintext, only with content: 'bytes'
 *
 * Rules:
 * 1. Nothing tenant-local is in the bundle: no snapshot, version or content
 *    item ids. Objects are named by natural key, references point at natural-key
 *    symbols, and a content item is named by (workload, container, itemKey,
 *    version) plus its sha256 and byte length. So export, import into another
 *    Keel, export again gives a byte-identical archive.
 * 2. The archive is deterministic: a ustar tar with fixed header fields, the
 *    manifest and signature first and every other entry in path order. The
 *    verifier rebuilds every header and demands that exact form, so one changed
 *    byte anywhere in the file (a header, padding, the tail or any entry) fails.
 * 3. Verification needs only the archive and a public key: no database, no
 *    content store. Import verifies first and refuses an archive that fails.
 * 4. Payloads are the stored payloads, not the redacted reviewer export
 *    (configExport.mjs): a bundle is a backup and must restore every object.
 */
import { createHash, createPrivateKey, createPublicKey, randomUUID, sign, verify } from 'node:crypto';
import { open, rename, rm, stat } from 'node:fs/promises';
import { Readable } from 'node:stream';
import { CONTENT_WORKLOADS, refFor } from '../content/store.mjs';
import { assertTenantRef } from '../store/tenantRef.mjs';
import { resolveExportSnapshot } from './configExport.mjs';
import { sha256Hex, stableJson } from './manifest.mjs';

export const BUNDLE_FORMAT = 'keel-bundle';
export const BUNDLE_FORMAT_VERSION = 1;
export const CONTENT_MODES = Object.freeze(['none', 'refs', 'bytes']);
export const MANIFEST_PATH = 'bundle.json';
export const SIGNATURE_PATH = 'bundle.sig';

const BLOCK = 512;
const MAX_ENTRY_BYTES = (8 ** 11) - 1; // what an 11-digit octal ustar size field holds
const MAX_MANIFEST_BYTES = 512 * 1024 * 1024;
const MAX_SIGNATURE_BYTES = 4096;
const TYPE_NAME = /^[A-Za-z0-9._-]+$/;
const ENTRY_PATH = /^(objects\/[A-Za-z0-9._-]+\/[0-9a-f]{64}\.json|content\/[a-z-]+\/[0-9a-f]{64}\.json|blobs\/[0-9a-f]{64})$/;

// ---------------------------------------------------------------------------
// Signing keys: a 32-byte Ed25519 seed (64 hex characters or base64) from a
// git-ignored env file, KEEL_BUNDLE_SIGNING_KEY. Another Keel verifies with the
// public key only (KEEL_BUNDLE_VERIFY_KEY), so it can check bundles but never sign.

const PKCS8_ED25519 = Buffer.from('302e020100300506032b657004220420', 'hex');
const SPKI_ED25519 = Buffer.from('302a300506032b6570032100', 'hex');

function raw32(text, what) {
  const value = String(text ?? '').trim();
  const bytes = /^[0-9a-fA-F]{64}$/.test(value) ? Buffer.from(value, 'hex') : Buffer.from(value, 'base64');
  if (bytes.length !== 32) throw new Error(`${what} must be 32 bytes (64 hex characters or base64)`);
  return bytes;
}

function publicKeyInfo(publicKey) {
  const rawPublic = publicKey.export({ format: 'der', type: 'spki' }).subarray(SPKI_ED25519.length);
  return { publicKey, publicKeyHex: rawPublic.toString('hex'), keyId: sha256Hex(rawPublic).slice(0, 16) };
}

/** The signing key from its seed. Never logged; only keyId and publicKeyHex are safe to print. */
export function parseBundleSigningKey(text) {
  const privateKey = createPrivateKey({
    key: Buffer.concat([PKCS8_ED25519, raw32(text, 'the bundle signing key')]), format: 'der', type: 'pkcs8',
  });
  return Object.freeze({ privateKey, ...publicKeyInfo(createPublicKey(privateKey)) });
}

/** A verify key from a raw 32-byte Ed25519 public key (hex or base64). */
export function parseBundleVerifyKey(text) {
  const publicKey = createPublicKey({
    key: Buffer.concat([SPKI_ED25519, raw32(text, 'the bundle verify key')]), format: 'der', type: 'spki',
  });
  return Object.freeze(publicKeyInfo(publicKey));
}

// ---------------------------------------------------------------------------
// The archive: a deterministic ustar tar.

function splitPath(path) {
  const bytes = Buffer.byteLength(path);
  if (bytes <= 100) return { name: path, prefix: '' };
  for (let at = path.lastIndexOf('/'); at > 0; at = path.lastIndexOf('/', at - 1)) {
    const prefix = path.slice(0, at);
    const name = path.slice(at + 1);
    if (Buffer.byteLength(prefix) <= 155 && Buffer.byteLength(name) <= 100) return { name, prefix };
  }
  throw new Error(`bundle entry path is too long for ustar: ${path}`);
}

function octal(value, width) {
  return `${value.toString(8).padStart(width - 1, '0')}\0`;
}

/** The only header this format writes or accepts for an entry. */
export function tarHeader(path, size) {
  if (!Number.isSafeInteger(size) || size < 0 || size > MAX_ENTRY_BYTES) {
    throw new Error(`bundle entry ${path} is ${size} bytes; the format holds at most ${MAX_ENTRY_BYTES}`);
  }
  const { name, prefix } = splitPath(path);
  const header = Buffer.alloc(BLOCK);
  header.write(name, 0, 'utf8');
  header.write('0000644\0', 100, 'ascii');
  header.write('0000000\0', 108, 'ascii');
  header.write('0000000\0', 116, 'ascii');
  header.write(octal(size, 12), 124, 'ascii');
  header.write('00000000000\0', 136, 'ascii');
  header.write('        ', 148, 'ascii');
  header.write('0', 156, 'ascii');
  header.write('ustar\0', 257, 'ascii');
  header.write('00', 263, 'ascii');
  header.write('0000000\0', 329, 'ascii');
  header.write('0000000\0', 337, 'ascii');
  header.write(prefix, 345, 'utf8');
  let sum = 0;
  for (const byte of header) sum += byte;
  header.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 'ascii');
  return header;
}

const padding = (size) => (BLOCK - (size % BLOCK)) % BLOCK;

function cString(buffer, start, length) {
  const field = buffer.subarray(start, start + length);
  const end = field.indexOf(0);
  return field.subarray(0, end === -1 ? length : end).toString('utf8');
}

/**
 * Reads the entry index of an archive and checks it is in the exact canonical
 * form tarHeader writes: every header rebuilt byte for byte, zero padding,
 * two zero blocks at the end and nothing after. Returns [{ path, offset, size }].
 */
async function readArchiveIndex(handle) {
  const { size: fileSize } = await handle.stat();
  const entries = [];
  const failures = [];
  const block = Buffer.alloc(BLOCK);
  let offset = 0;
  for (;;) {
    if (offset + BLOCK > fileSize) { failures.push('archive is truncated'); break; }
    await handle.read(block, 0, BLOCK, offset);
    if (block.every((byte) => byte === 0)) break;
    const prefix = cString(block, 345, 155);
    const name = cString(block, 0, 100);
    const path = prefix ? `${prefix}/${name}` : name;
    const size = Number.parseInt(cString(block, 124, 12), 8);
    let expected = null;
    try { expected = tarHeader(path, size); } catch { expected = null; }
    if (!expected || !expected.equals(block)) {
      failures.push(`entry header at byte ${offset} is not in canonical form`);
      break;
    }
    const dataOffset = offset + BLOCK;
    const pad = padding(size);
    if (dataOffset + size + pad > fileSize) { failures.push(`entry ${path} is truncated`); break; }
    if (pad) {
      const tail = Buffer.alloc(pad);
      await handle.read(tail, 0, pad, dataOffset + size);
      if (!tail.every((byte) => byte === 0)) failures.push(`entry ${path} has non-zero padding`);
    }
    entries.push({ path, offset: dataOffset, size });
    offset = dataOffset + size + pad;
  }
  if (!failures.length) {
    const end = Buffer.alloc(2 * BLOCK);
    const { bytesRead } = await handle.read(end, 0, end.length, offset);
    if (bytesRead !== end.length || !end.every((byte) => byte === 0) || offset + end.length !== fileSize) {
      failures.push('archive does not end with exactly two zero blocks');
    }
  }
  return { entries, failures };
}

async function readEntry(handle, entry) {
  const bytes = Buffer.alloc(entry.size);
  if (entry.size) await handle.read(bytes, 0, entry.size, entry.offset);
  return bytes;
}

async function* entryStream(handle, entry) {
  const step = 1024 * 1024;
  for (let at = 0; at < entry.size; at += step) {
    const length = Math.min(step, entry.size - at);
    const bytes = Buffer.alloc(length);
    await handle.read(bytes, 0, length, entry.offset + at);
    yield bytes;
  }
}

async function hashEntry(handle, entry) {
  const hash = createHash('sha256');
  for await (const bytes of entryStream(handle, entry)) hash.update(bytes);
  return hash.digest('hex');
}

// ---------------------------------------------------------------------------
// Canonical files.

const asIso = (value) => (value == null ? null : new Date(value).toISOString());

/** The natural key of a content item, the identity a bundle names it by. */
export const contentKeyOf = ({ workload, container, itemKey, version }) => JSON.stringify([workload, container, itemKey, version]);

export const objectPath = (resourceType, naturalKey) => `objects/${resourceType}/${sha256Hex(naturalKey)}.json`;
export const contentPath = (item) => `content/${item.workload}/${sha256Hex(contentKeyOf(item))}.json`;
export const blobPath = (sha256) => `blobs/${sha256}`;

function assertTypeName(type) {
  if (!TYPE_NAME.test(type) || type === '.' || type === '..') {
    throw new Error(`unsafe resource type name: ${JSON.stringify(type)}`);
  }
}

function objectDocument(row, references) {
  return {
    naturalKey: row.natural_key,
    resourceType: row.resource_type,
    payload: row.payload,
    payloadHash: row.payload_hash,
    hashVersion: row.hash_version ?? 1,
    criticality: row.criticality,
    blastRadius: row.blast_radius,
    fidelity: row.fidelity,
    provenance: row.provenance,
    references: references
      .map((ref) => ({
        field: ref.field_path, symbol: ref.to_symbol ?? null, required: ref.required, ...(ref.prefix ? { prefix: ref.prefix } : {}),
      }))
      .sort((a, b) => (a.field < b.field ? -1 : a.field > b.field ? 1 : 0)),
  };
}

/**
 * The tenant's content items as this Keel knows them at export time (not only
 * those collected before the snapshot): those this Keel holds (content_item) and those
 * it knows only by reference from an earlier import (content_ref, schema.d/33).
 * One entry per natural key; a held item wins over a bare reference.
 */
async function contentItemsFor(client, tenantRef) {
  const held = await client.query(
    `SELECT id, workload, container, item_key, version, metadata, sha256, bytes FROM content_item WHERE tenant_ref = $1`,
    [tenantRef],
  );
  const refs = await client.query(
    `SELECT workload, container, item_key, version, metadata, sha256, bytes FROM content_ref WHERE tenant_ref = $1`,
    [tenantRef],
  );
  const items = new Map();
  for (const row of [...held.rows, ...refs.rows]) {
    const item = {
      id: row.id ?? null, workload: row.workload, container: row.container, itemKey: row.item_key,
      version: row.version, metadata: row.metadata ?? {}, sha256: row.sha256, bytes: Number(row.bytes),
    };
    const key = contentKeyOf(item);
    if (!items.has(key)) items.set(key, item);
  }
  return items;
}

/**
 * Builds the bundle's entries for one completed snapshot. Small files are
 * returned as bytes; blobs as { size, sha256, open() } so a large item streams
 * from the content store straight into the archive.
 */
async function bundleEntries(client, { tenantRef, snapshotId, content, contentStore }) {
  const snapshot = await resolveExportSnapshot(client, { tenantRef, snapshotId });
  const { rows } = await client.query('SELECT * FROM resource_version WHERE snapshot_id = $1', [snapshot.id]);
  const { rows: refRows } = await client.query(
    `SELECT rr.* FROM resource_reference rr JOIN resource_version rv ON rv.id = rr.from_version WHERE rv.snapshot_id = $1`,
    [snapshot.id],
  );
  const refsByVersion = new Map();
  for (const ref of refRows) {
    if (!refsByVersion.has(ref.from_version)) refsByVersion.set(ref.from_version, []);
    refsByVersion.get(ref.from_version).push(ref);
  }

  const entries = new Map();
  const add = (path, entry) => {
    if (entries.has(path)) throw new Error(`two bundle entries would share the path ${path}`);
    entries.set(path, entry);
  };
  for (const row of rows) {
    assertTypeName(row.resource_type);
    add(objectPath(row.resource_type, row.natural_key), { bytes: Buffer.from(stableJson(objectDocument(row, refsByVersion.get(row.id) ?? []))) });
  }

  let contentItems = 0;
  if (content !== 'none') {
    for (const item of (await contentItemsFor(client, tenantRef)).values()) {
      if (!CONTENT_WORKLOADS.includes(item.workload)) throw new Error(`content item in unknown workload ${item.workload}`);
      const withBody = content === 'bytes' && item.id !== null;
      add(contentPath(item), {
        bytes: Buffer.from(stableJson({
          workload: item.workload, container: item.container, itemKey: item.itemKey, version: item.version,
          metadata: item.metadata, sha256: item.sha256, bytes: item.bytes, body: withBody ? blobPath(item.sha256) : null,
        })),
      });
      contentItems += 1;
      if (withBody && !entries.has(blobPath(item.sha256))) {
        const ref = refFor(item.id);
        add(blobPath(item.sha256), { size: item.bytes, sha256: item.sha256, open: () => contentStore.getItem(ref) });
      }
    }
  }

  const files = {};
  for (const [path, entry] of [...entries].sort(([a], [b]) => (a < b ? -1 : 1))) {
    files[path] = entry.bytes ? { sha256: sha256Hex(entry.bytes), bytes: entry.bytes.length } : { sha256: entry.sha256, bytes: entry.size };
  }
  const manifest = {
    format: BUNDLE_FORMAT,
    formatVersion: BUNDLE_FORMAT_VERSION,
    tenantRef,
    snapshot: {
      startedAt: asIso(snapshot.started_at),
      completedAt: asIso(snapshot.completed_at),
      coverageDigest: snapshot.coverage_digest ?? null,
    },
    objects: rows.length,
    content: { mode: content, items: contentItems },
    files,
  };
  return { snapshot, manifest, entries };
}

/**
 * Exports one completed snapshot as a signed bundle at `out`. The archive is
 * written to a private temp file next to `out`, verified with the signing
 * key's public half, then renamed into place; an existing `out` is refused.
 * content: 'refs' (default) names content items; 'bytes' also carries their
 * plaintext, read with contentStore.getItem(ref); 'none' leaves content out.
 */
export async function exportBundle(client, { tenantRef, snapshotId, out, signingKey, content = 'refs', contentStore = null }) {
  assertTenantRef(tenantRef);
  if (typeof out !== 'string' || !out) throw new TypeError('exportBundle needs an output path');
  if (!signingKey?.privateKey) throw new TypeError('exportBundle needs a signing key (KEEL_BUNDLE_SIGNING_KEY)');
  if (!CONTENT_MODES.includes(content)) throw new TypeError(`content must be one of ${CONTENT_MODES.join(', ')}`);
  if (content === 'bytes' && typeof contentStore?.getItem !== 'function') {
    throw new TypeError("content: 'bytes' needs the content store");
  }
  if (await stat(out).catch(() => null)) throw new Error(`refusing to overwrite ${out}`);

  const { snapshot, manifest, entries } = await bundleEntries(client, { tenantRef, snapshotId, content, contentStore });
  manifest.signer = { algorithm: 'ed25519', keyId: signingKey.keyId };
  const manifestBytes = Buffer.from(stableJson(manifest));
  const signatureBytes = Buffer.from(stableJson({
    algorithm: 'ed25519', keyId: signingKey.keyId, signature: sign(null, manifestBytes, signingKey.privateKey).toString('base64'),
  }));

  const temp = `${out}.tmp-${randomUUID()}`;
  const handle = await open(temp, 'wx', 0o600);
  try {
    const write = async (bytes) => { if (bytes.length) await handle.write(bytes); };
    const writeEntry = async (path, bytes) => {
      await write(tarHeader(path, bytes.length));
      await write(bytes);
      await write(Buffer.alloc(padding(bytes.length)));
    };
    await writeEntry(MANIFEST_PATH, manifestBytes);
    await writeEntry(SIGNATURE_PATH, signatureBytes);
    for (const path of Object.keys(manifest.files)) {
      const entry = entries.get(path);
      if (entry.bytes) { await writeEntry(path, entry.bytes); continue; }
      await write(tarHeader(path, entry.size));
      const hash = createHash('sha256');
      let written = 0;
      for await (const chunk of await entry.open()) {
        const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        hash.update(bytes);
        written += bytes.length;
        if (written > entry.size) break;
        await write(bytes);
      }
      if (written !== entry.size || hash.digest('hex') !== entry.sha256) {
        throw new Error(`content ${path} did not read back as its recorded ${entry.size} bytes and sha256`);
      }
      await write(Buffer.alloc(padding(entry.size)));
    }
    await write(Buffer.alloc(2 * BLOCK));
    await handle.close();
    const check = await verifyBundle(temp, { verifyKey: signingKey });
    if (!check.ok) throw new Error(`written bundle failed verification: ${check.failures.join('; ')}`);
    await rename(temp, out);
  } catch (error) {
    await handle.close().catch(() => {});
    await rm(temp, { force: true });
    throw error;
  }
  return { out, snapshotId: snapshot.id, keyId: signingKey.keyId, objects: manifest.objects, content: manifest.content };
}

/**
 * Verifies a bundle offline: canonical archive form, the signature over the
 * manifest with `verifyKey`, and every entry's sha256 and length against the
 * manifest, with no entry missing or extra. Never throws on a bad archive:
 * returns { ok, failures, manifest }.
 */
export async function verifyBundle(path, { verifyKey }) {
  if (!verifyKey?.publicKey) throw new TypeError('verifyBundle needs a verify key');
  let handle;
  try {
    handle = await open(path, 'r');
  } catch (error) {
    return { ok: false, failures: [`cannot open bundle: ${error.message}`], manifest: null };
  }
  try {
    return await verifyOpenBundle(handle, verifyKey);
  } finally {
    await handle.close();
  }
}

async function verifyOpenBundle(handle, verifyKey) {
  const { entries, failures } = await readArchiveIndex(handle);
  if (failures.length) return { ok: false, failures, manifest: null };
  if (entries[0]?.path !== MANIFEST_PATH || entries[1]?.path !== SIGNATURE_PATH) {
    return { ok: false, failures: ['archive must start with bundle.json then bundle.sig'], manifest: null };
  }
  if (entries[0].size > MAX_MANIFEST_BYTES || entries[1].size > MAX_SIGNATURE_BYTES) {
    return { ok: false, failures: ['manifest or signature is larger than this format allows'], manifest: null };
  }
  const manifestBytes = await readEntry(handle, entries[0]);
  const signatureBytes = await readEntry(handle, entries[1]);
  let manifest;
  let signature;
  try {
    manifest = JSON.parse(manifestBytes.toString('utf8'));
    signature = JSON.parse(signatureBytes.toString('utf8'));
  } catch {
    return { ok: false, failures: ['manifest or signature is not JSON'], manifest: null };
  }
  // Both files must be in their one canonical form, so no byte of either can
  // change without failing (base64 decoding alone would ignore some changes).
  if (stableJson(manifest) !== manifestBytes.toString('utf8') || stableJson(signature) !== signatureBytes.toString('utf8')) {
    return { ok: false, failures: ['manifest or signature is not in canonical form'], manifest: null };
  }
  let signed = false;
  try {
    const raw = Buffer.from(String(signature?.signature), 'base64');
    signed = signature?.algorithm === 'ed25519' && raw.toString('base64') === signature.signature
      && verify(null, manifestBytes, verifyKey.publicKey, raw);
  } catch { signed = false; }
  if (!signed) return { ok: false, failures: [`signature does not verify with key ${verifyKey.keyId}`], manifest: null };
  if (signature.keyId !== verifyKey.keyId || manifest?.signer?.keyId !== verifyKey.keyId) {
    failures.push('signer key id does not match the verify key');
  }
  if (manifest?.format !== BUNDLE_FORMAT || manifest?.formatVersion !== BUNDLE_FORMAT_VERSION) {
    failures.push(`not a ${BUNDLE_FORMAT} v${BUNDLE_FORMAT_VERSION}`);
  }
  const files = manifest?.files && typeof manifest.files === 'object' ? manifest.files : {};
  const declared = Object.keys(files);
  const present = entries.slice(2).map((entry) => entry.path);
  if (declared.join('\n') !== present.join('\n') || [...present].sort().join('\n') !== present.join('\n')) {
    failures.push('archive entries do not match the manifest file list in order');
  }
  for (const entry of entries.slice(2)) {
    if (!ENTRY_PATH.test(entry.path)) { failures.push(`unexpected entry ${entry.path}`); continue; }
    const meta = files[entry.path];
    if (!meta) continue;
    if (meta.bytes !== entry.size) failures.push(`length mismatch for ${entry.path}`);
    else if (await hashEntry(handle, entry) !== meta.sha256) failures.push(`checksum mismatch for ${entry.path}`);
  }
  return { ok: failures.length === 0, failures, manifest, entries };
}

/** Reads the documents of a verified bundle, refusing anything malformed. */
async function readVerifiedBundle(handle, manifest, entries) {
  const byPath = new Map(entries.map((entry) => [entry.path, entry]));
  const objects = [];
  const contents = [];
  for (const path of Object.keys(manifest.files)) {
    if (path.startsWith('blobs/')) continue;
    // Re-checked as read: the file may have changed on disk since verification.
    const bytes = await readEntry(handle, byPath.get(path));
    if (sha256Hex(bytes) !== manifest.files[path].sha256) throw new Error(`${path} changed after verification`);
    const doc = JSON.parse(bytes.toString('utf8'));
    if (path.startsWith('objects/')) {
      assertTypeName(doc.resourceType);
      if (path !== objectPath(doc.resourceType, doc.naturalKey)) throw new Error(`object ${path} does not match its natural key`);
      objects.push(doc);
    } else {
      if (!CONTENT_WORKLOADS.includes(doc.workload) || path !== contentPath(doc)) {
        throw new Error(`content ${path} does not match its natural key`);
      }
      if (doc.body !== null && (doc.body !== blobPath(doc.sha256) || !byPath.has(doc.body))) {
        throw new Error(`content ${path} names a body the bundle does not hold`);
      }
      contents.push(doc);
    }
  }
  return { objects, contents, byPath };
}

/**
 * Imports a bundle into this Keel: verifies it, then in one transaction
 * creates the snapshot with its times and coverage digest, every object with
 * its stored payload, hash and references, and every content item: one with a
 * body is put into `contentStore` (re-chunked and encrypted under this Keel's
 * key), one without is recorded as a reference (content_ref). A bundle whose
 * snapshot this Keel already holds (same tenant, start and end) is refused.
 */
export async function importBundle(client, path, { verifyKey, contentStore = null }) {
  if (!verifyKey?.publicKey) throw new TypeError('importBundle needs a verify key');
  // One handle for verification and import, so the bytes imported are the bytes verified.
  const handle = await open(path, 'r');
  try {
    const verification = await verifyOpenBundle(handle, verifyKey);
    if (!verification.ok) throw new Error(`bundle failed verification: ${verification.failures.join('; ')}`);
    const { manifest } = verification;
    assertTenantRef(manifest.tenantRef);
    const { objects, contents, byPath } = await readVerifiedBundle(handle, manifest, verification.entries);
    if (contents.some((doc) => doc.body !== null) && typeof contentStore?.putItem !== 'function') {
      throw new Error('this bundle carries content bytes; importing it needs the content store');
    }
    const { tenantRef, snapshot } = manifest;
    await client.query('BEGIN');
    try {
      const { rows: existing } = await client.query(
        `SELECT id FROM snapshot WHERE tenant_ref = $1
           AND date_trunc('milliseconds', started_at) = $2 AND date_trunc('milliseconds', completed_at) = $3`,
        [tenantRef, snapshot.startedAt, snapshot.completedAt],
      );
      if (existing.length) throw new Error(`this Keel already holds that snapshot (${existing[0].id})`);
      const { rows: [created] } = await client.query(
        `INSERT INTO snapshot (tenant_ref, started_at, completed_at, status, coverage_digest)
         VALUES ($1, $2, $3, 'complete', $4) RETURNING id`,
        [tenantRef, snapshot.startedAt, snapshot.completedAt, snapshot.coverageDigest === null ? null : JSON.stringify(snapshot.coverageDigest)],
      );
      for (const doc of objects) {
        const { rows: [version] } = await client.query(
          `INSERT INTO resource_version
             (snapshot_id, natural_key, resource_type, payload, payload_hash, hash_version, criticality, blast_radius, fidelity, provenance)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING id`,
          [created.id, doc.naturalKey, doc.resourceType, JSON.stringify(doc.payload), doc.payloadHash, doc.hashVersion,
            doc.criticality, doc.blastRadius, doc.fidelity, JSON.stringify(doc.provenance)],
        );
        for (const ref of doc.references) {
          await client.query(
            `INSERT INTO resource_reference (from_version, field_path, to_symbol, required, prefix) VALUES ($1, $2, $3, $4, $5)`,
            [version.id, ref.field, ref.symbol, ref.required, ref.prefix ?? null],
          );
        }
      }
      let stored = 0;
      let referenced = 0;
      for (const doc of contents) {
        if (doc.body !== null) {
          const put = await contentStore.putItem(Readable.from(entryStream(handle, byPath.get(doc.body))), {
            tenantRef, workload: doc.workload, container: doc.container, itemKey: doc.itemKey, version: doc.version, metadata: doc.metadata,
          });
          if (put.sha256 !== doc.sha256 || put.bytes !== doc.bytes) throw new Error(`content ${doc.itemKey} did not store as its recorded sha256`);
          stored += 1;
          continue;
        }
        const { rows: [ref] } = await client.query(
          `INSERT INTO content_ref (tenant_ref, workload, container, item_key, version, metadata, sha256, bytes)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
           ON CONFLICT (tenant_ref, workload, container, item_key, version) DO UPDATE SET tenant_ref = content_ref.tenant_ref
           RETURNING sha256`,
          [tenantRef, doc.workload, doc.container, doc.itemKey, doc.version, JSON.stringify(doc.metadata), doc.sha256, doc.bytes],
        );
        if (ref.sha256 !== doc.sha256) throw new Error(`content ${doc.itemKey} version ${doc.version} is already known with different content`);
        referenced += 1;
      }
      await client.query('COMMIT');
      return { snapshotId: created.id, tenantRef, objects: objects.length, content: { stored, referenced } };
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    }
  } finally {
    await handle.close();
  }
}

// ---------------------------------------------------------------------------
// What the CLIs share: keys from the environment, the capability gate, and the
// content store named by the content-reader file.

export const BUNDLE_CAPABILITY = 'export';

/**
 * Keys from a git-ignored env file (on the box, /etc/keel/bundle.env, mode 600,
 * loaded as an EnvironmentFile): KEEL_BUNDLE_SIGNING_KEY signs and also
 * verifies; KEEL_BUNDLE_VERIFY_KEY alone lets a Keel verify and import bundles
 * it could never have signed.
 */
export function bundleKeysFromEnv(env = process.env) {
  const signingKey = env.KEEL_BUNDLE_SIGNING_KEY ? parseBundleSigningKey(env.KEEL_BUNDLE_SIGNING_KEY) : null;
  const verifyKey = env.KEEL_BUNDLE_VERIFY_KEY ? parseBundleVerifyKey(env.KEEL_BUNDLE_VERIFY_KEY) : signingKey;
  return { signingKey, verifyKey };
}

/** Refuses unless the principal named by `email` holds the bundle capability now. */
export async function requireBundleCapability(client, email, { resolve, can }) {
  if (typeof email !== 'string' || !email) throw new Error(`--as EMAIL is required: bundles need the ${BUNDLE_CAPABILITY} capability`);
  const principal = await resolve(client, email);
  if (!principal || !(await can(client, principal, BUNDLE_CAPABILITY, new Date()))) {
    throw new Error(`${email} does not hold the ${BUNDLE_CAPABILITY} capability`);
  }
  return principal;
}
