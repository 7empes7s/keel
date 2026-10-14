/**
 * The content store (Wave 1, package CONT): where mail, files, list items, pages and
 * other item content is kept, behind a fixed interface that every content collector
 * codes against:
 *
 *   putItem(stream, { tenantRef, workload, container, itemKey, version, metadata })
 *     -> { ref, sha256, bytes, deduped }
 *   getItem(ref) -> a Readable of the exact bytes that were put
 *   listItems({ container, since }) -> the items of a container stored after `since`
 *
 * How the bytes are kept:
 * - Chunked by content (a gear rolling hash, 256 KiB to 4 MiB, about 1.25 MiB on
 *   average), so an insert or edit inside a large item only changes the chunks around
 *   it, and storing the same bytes again stores no new chunk.
 * - Each chunk is named by a keyed hash (HMAC-SHA-256) of its plaintext, so a chunk is
 *   stored once however many items or versions hold it, and the stored names say
 *   nothing about the content to anyone without the key.
 * - Each chunk is encrypted (AES-256-GCM, a fresh IV per chunk, its name bound as
 *   associated data) before it reaches the storage adapter, so the medium only ever
 *   holds ciphertext. Both keys come from one 32-byte master key through HKDF.
 * - Reads verify every chunk's GCM tag (which also binds it to its name), then the
 *   whole item's SHA-256; a stream that does not match fails instead of returning
 *   wrong bytes.
 *
 * Memory: a put or get holds at most one chunk (4 MiB) plus the source's own buffers,
 * whatever the item's size, so a mailbox or a 1 GB file streams through a small box.
 *
 * The item index (which items exist, which chunks make them up) is pluggable:
 * ./index.mjs has the Postgres index and an in-memory one. createMemoryContentStore()
 * is the same store over memory, for collectors' fixture tests.
 */
import { createCipheriv, createDecipheriv, createHash, createHmac, hkdfSync, randomBytes } from 'node:crypto';
import { Readable } from 'node:stream';
import { createMemoryContentIndex } from './index.mjs';

export const CONTENT_REF_PREFIX = 'keel-content:';
// The content workloads an item may belong to, as the Wave 1 collectors name them:
// exchange-mail (MAIL), onedrive and sharepoint libraries (DRIVE), sharepoint-sites
// (SITES), teams (TEAMS), planner and group-conversations (PLANNER).
export const CONTENT_WORKLOADS = Object.freeze([
  'exchange-mail', 'onedrive', 'sharepoint', 'sharepoint-sites', 'teams', 'planner', 'group-conversations',
]);

export const CHUNKING = Object.freeze({ min: 256 * 1024, maskBits: 20, max: 4 * 1024 * 1024 });
const MAGIC = Buffer.from('KCH1');
const IV_BYTES = 12;
const TAG_BYTES = 16;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

// The gear table is fixed (derived from a constant), so chunk boundaries are stable
// across processes and releases; changing it would only cost dedupe, never data.
const GEAR = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i += 1) table[i] = createHash('sha256').update(`keel-content-gear-${i}`).digest().readUInt32BE(0);
  return table;
})();

/**
 * Content-defined chunking as a plain object, outside any generator: V8 optimizes the
 * hot loop here far better than inside an async generator (about 400 MB/s against 70).
 * push(buffer) returns the chunks it completed; end() returns the last one, if any.
 */
export function createChunker({ min = CHUNKING.min, maskBits = CHUNKING.maskBits, max = CHUNKING.max } = {}) {
  const mask = (2 ** maskBits) - 1;
  let pending = [];
  let pendingBytes = 0;
  let hash = 0;
  return {
    push(buffer) {
      const done = [];
      let start = 0;
      let i = 0;
      while (i < buffer.length) {
        const size = pendingBytes + (i - start);
        if (size < min) {
          i = Math.min(buffer.length, i + (min - size));
          continue;
        }
        const limit = Math.min(buffer.length, i + (max - size));
        let cut = -1;
        let h = hash;
        for (; i < limit; i += 1) {
          h = ((h << 1) + GEAR[buffer[i]]) >>> 0;
          if ((h & mask) === 0) { cut = i + 1; break; }
        }
        hash = h;
        if (cut === -1 && pendingBytes + (i - start) >= max) cut = i;
        if (cut !== -1) {
          pending.push(buffer.subarray(start, cut));
          done.push(pending.length === 1 ? Buffer.from(pending[0]) : Buffer.concat(pending));
          pending = [];
          pendingBytes = 0;
          hash = 0;
          start = cut;
          i = cut;
        }
      }
      // Copy the tail: a source may reuse its buffer for the next read.
      if (start < buffer.length) {
        pending.push(Buffer.from(buffer.subarray(start)));
        pendingBytes += buffer.length - start;
      }
      return done;
    },
    end() {
      const last = pendingBytes ? Buffer.concat(pending) : null;
      pending = [];
      pendingBytes = 0;
      hash = 0;
      return last;
    },
  };
}

/**
 * Splits a byte stream into content-defined chunks. `source` is any async iterable of
 * Buffers or Uint8Arrays (a Node Readable, a fetch body, a generator). Yields Buffers.
 */
export async function* chunkStream(source, options) {
  const chunker = createChunker(options);
  for await (const raw of source) {
    const buffer = Buffer.isBuffer(raw) ? raw : typeof raw === 'string' ? Buffer.from(raw) : Buffer.from(raw.buffer, raw.byteOffset, raw.byteLength);
    yield* chunker.push(buffer);
  }
  const last = chunker.end();
  if (last) yield last;
}

/** The encryption key, chunk-naming key and key id derived from one 32-byte master key. */
export function deriveContentKeys(masterKey) {
  const master = Buffer.isBuffer(masterKey) ? masterKey : null;
  if (!master || master.length !== 32) throw new TypeError('the content store needs a 32-byte master key');
  const derive = (info) => Buffer.from(hkdfSync('sha256', master, 'keel-content-store', info, 32));
  return Object.freeze({
    encryption: derive('chunk-encryption'),
    naming: derive('chunk-naming'),
    keyId: createHash('sha256').update(derive('key-id')).digest('hex').slice(0, 16),
  });
}

/** Reads a master key file: 32 bytes as 64 hex characters or base64. Never logged. */
export function parseContentKey(text) {
  const value = String(text).trim();
  const key = /^[0-9a-fA-F]{64}$/.test(value) ? Buffer.from(value, 'hex') : Buffer.from(value, 'base64');
  if (key.length !== 32) throw new Error('the content key file must hold 32 bytes (64 hex characters or base64)');
  return key;
}

export const chunkObjectName = (id) => `content/chunks/${id.slice(0, 2)}/${id}`;

export function encryptChunk(keys, id, plaintext) {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv('aes-256-gcm', keys.encryption, iv);
  cipher.setAAD(Buffer.from(id));
  const body = cipher.update(plaintext);
  cipher.final();
  return Buffer.concat([MAGIC, iv, body, cipher.getAuthTag()]);
}

export function decryptChunk(keys, id, stored) {
  const blob = Buffer.isBuffer(stored) ? stored : Buffer.from(stored);
  if (blob.length < MAGIC.length + IV_BYTES + TAG_BYTES || !blob.subarray(0, MAGIC.length).equals(MAGIC)) {
    throw new Error(`content chunk ${id} is not a Keel chunk`);
  }
  const iv = blob.subarray(MAGIC.length, MAGIC.length + IV_BYTES);
  const decipher = createDecipheriv('aes-256-gcm', keys.encryption, iv);
  decipher.setAAD(Buffer.from(id));
  decipher.setAuthTag(blob.subarray(blob.length - TAG_BYTES));
  let plaintext;
  try {
    plaintext = Buffer.concat([decipher.update(blob.subarray(MAGIC.length + IV_BYTES, blob.length - TAG_BYTES)), decipher.final()]);
  } catch {
    throw new Error(`content chunk ${id} failed its integrity check`);
  }
  return plaintext;
}

function requireText(value, name) {
  if (typeof value !== 'string' || !value.trim()) throw new TypeError(`${name} must be a non-empty string`);
  return value;
}

function plainMetadata(metadata) {
  if (metadata === undefined || metadata === null) return {};
  if (typeof metadata !== 'object' || Array.isArray(metadata)) throw new TypeError('metadata must be a plain object');
  return JSON.parse(JSON.stringify(metadata));
}

function closeSource(source) {
  if (typeof source?.destroy === 'function') source.destroy();
  else if (typeof source?.return === 'function') source.return();
}

export const refFor = (id) => `${CONTENT_REF_PREFIX}${id}`;

export function idFromRef(ref) {
  const id = typeof ref === 'string' && ref.startsWith(CONTENT_REF_PREFIX) ? ref.slice(CONTENT_REF_PREFIX.length) : '';
  if (!UUID.test(id)) throw new TypeError(`not a content ref: ${JSON.stringify(ref)}`);
  return id;
}

const publicItem = (row) => Object.freeze({
  ref: refFor(row.id), tenantRef: row.tenantRef, workload: row.workload, container: row.container, itemKey: row.itemKey,
  version: row.version, metadata: row.metadata, sha256: row.sha256, bytes: row.bytes, createdAt: row.createdAt,
});

/**
 * The content store over an index (./index.mjs) and a storage adapter
 * (engine/storage/*: publish(name, bytes), read(name)). `key` is the 32-byte master key.
 */
export function createContentStore({ index, storage, key, chunking = CHUNKING }) {
  if (!index || !storage || typeof storage.publish !== 'function' || typeof storage.read !== 'function') {
    throw new TypeError('the content store needs an index and a storage adapter');
  }
  const keys = deriveContentKeys(key);

  async function storeChunk(id, plaintext) {
    if (await index.hasChunk(id)) return 0;
    const blob = encryptChunk(keys, id, plaintext);
    const name = chunkObjectName(id);
    try {
      await storage.publish(name, blob);
    } catch (error) {
      // Publish-once adapters refuse a second write. A chunk published by a run that
      // died before indexing it is the same plaintext under the same key: keep it.
      if (!/already published/.test(String(error?.message))) throw error;
    }
    await index.addChunk({ id, keyId: keys.keyId, objectName: name, plainBytes: plaintext.length, storedBytes: blob.length });
    return blob.length;
  }

  return Object.freeze({
    keyId: keys.keyId,

    async putItem(source, { tenantRef, workload, container, itemKey, version, metadata } = {}) {
      requireText(tenantRef, 'tenantRef');
      if (!CONTENT_WORKLOADS.includes(workload)) throw new TypeError(`workload must be one of ${CONTENT_WORKLOADS.join(', ')}`);
      requireText(container, 'container');
      requireText(itemKey, 'itemKey');
      if (version !== undefined && version !== null) requireText(version, 'version');
      const meta = plainMetadata(metadata);
      if (!source || typeof source[Symbol.asyncIterator] !== 'function') throw new TypeError('putItem needs a readable stream');
      const identity = { tenantRef, workload, container, itemKey };
      // A version already held is not read again: delta collectors re-offer items freely.
      if (version) {
        const held = await index.findItem({ ...identity, version });
        if (held) {
          closeSource(source);
          return { ref: refFor(held.id), sha256: held.sha256, bytes: held.bytes, deduped: true };
        }
      }
      const whole = createHash('sha256');
      const chunks = [];
      let bytes = 0;
      let newBytes = 0;
      for await (const chunk of chunkStream(source, chunking)) {
        whole.update(chunk);
        bytes += chunk.length;
        const id = createHmac('sha256', keys.naming).update(chunk).digest('hex');
        newBytes += await storeChunk(id, chunk);
        chunks.push([id, chunk.length]);
      }
      const sha256 = whole.digest('hex');
      const row = await index.insertItem({
        ...identity, version: version || `sha256:${sha256}`, metadata: meta, sha256, bytes, chunks, keyId: keys.keyId, newBytes,
      });
      if (row.sha256 !== sha256) {
        throw new Error(`${itemKey} version ${row.version} is already stored with different content`);
      }
      return { ref: refFor(row.id), sha256, bytes, deduped: newBytes === 0 };
    },

    async getItem(ref) {
      const row = await index.getItem(idFromRef(ref));
      if (!row) throw new Error(`no content item ${ref}`);
      if (row.keyId !== keys.keyId) throw new Error(`content item ${ref} is encrypted under another key (${row.keyId})`);
      async function* plaintext() {
        const whole = createHash('sha256');
        let bytes = 0;
        for (const [id, size] of row.chunks) {
          const chunk = decryptChunk(keys, id, await storage.read(chunkObjectName(id)));
          if (chunk.length !== size) throw new Error(`content chunk ${id} has the wrong length`);
          whole.update(chunk);
          bytes += chunk.length;
          yield chunk;
        }
        if (bytes !== row.bytes || whole.digest('hex') !== row.sha256) throw new Error(`content item ${ref} does not match its checksum`);
      }
      return Readable.from(plaintext(), { objectMode: false, highWaterMark: 1 });
    },

    async listItems({ container, since, tenantRef, workload, limit = 1000 } = {}) {
      requireText(container, 'container');
      const after = since === undefined || since === null ? null : new Date(since);
      if (after && !Number.isFinite(after.valueOf())) throw new TypeError('since must be a date');
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 10000) throw new TypeError('limit must be 1..10000');
      return (await index.listItems({ container, since: after, tenantRef, workload, limit })).map(publicItem);
    },
  });
}

/** An in-memory storage adapter for fixtures: publish-once, like the real ones. */
export function createMemoryStorage() {
  const objects = new Map();
  return {
    objects,
    async publish(name, bytes) {
      if (objects.has(name)) throw new Error(`storage object ${name} is already published — refusing to clobber it`);
      objects.set(name, Buffer.from(bytes));
      return { name, bytes: bytes.length };
    },
    async read(name) {
      if (!objects.has(name)) throw new Error(`missing storage object ${name}`);
      return Buffer.from(objects.get(name));
    },
    async list(prefix = '') { return [...objects.keys()].filter((name) => name.startsWith(prefix)).sort(); },
  };
}

/**
 * The same store over memory, for content collectors' fixture tests: the real
 * chunking, encryption and checks, with nothing written to disk or a database.
 */
export function createMemoryContentStore({ key = randomBytes(32), chunking, now } = {}) {
  const storage = createMemoryStorage();
  const index = createMemoryContentIndex({ now });
  const store = createContentStore({ index, storage, key, chunking });
  return Object.freeze({ ...store, storage, index });
}
