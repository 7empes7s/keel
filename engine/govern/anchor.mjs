import { createPublicKey, verify } from 'node:crypto';
import { verifyChain } from './evidence.mjs';
import { assertIndependentAnchorStorage, assertNoEmbeddedCredential } from '../storage/adapter.mjs';

// Domain-separated fixed tuples avoid JSON property-order ambiguity.
export function checkpointBytes(c) {
  return Buffer.from(JSON.stringify(['keel-evidence-checkpoint-v1', c.tenantRef, c.sequence,
    c.headHash, c.recordCount, c.build, c.storageRef, c.keyId]));
}
export function rotationBytes(r) {
  return Buffer.from(JSON.stringify(['keel-evidence-key-rotation-v1', r.tenantRef,
    r.storageRef, r.fromKeyId, r.toKeyId, r.publicKey]));
}
async function authorized(options, action) {
  if (!options.tenantRef || await options.authorize?.({ tenantRef: options.tenantRef, action }) !== true) {
    throw new Error('evidence anchor operation is not authorized');
  }
}
function publicKey(options, keyId) {
  const key = options.trust?.keys?.[keyId];
  if (!key || (options.mode !== 'fixture' && key.qualification !== 'live-qualified')
    || !['fixture-tested', 'live-qualified'].includes(key.qualification)) throw new Error('signing key unavailable or untrusted');
  const publicKey = typeof key.publicKey === 'string' ? createPublicKey(key.publicKey) : key.publicKey;
  if (publicKey?.type !== 'public' || publicKey.asymmetricKeyType !== 'ed25519') throw new Error('Ed25519 public key required');
  return publicKey;
}
function authenticate(doc, options) {
  const c = doc.checkpoint;
  if (doc.version !== 1 || !c || c.tenantRef !== options.tenantRef || c.build !== options.build
    || c.storageRef !== options.storageRef || !/^[1-9][0-9]*$/.test(c.sequence)
    || !/^[1-9][0-9]*$/.test(c.recordCount) || !/^[a-f0-9]{64}$/.test(c.headHash)) throw new Error('checkpoint scope or format mismatch');
  let keyId = options.trust.rootKeyId;
  publicKey(options, keyId);
  const seen = new Set([keyId]);
  for (const { rotation: r, signature } of doc.rotations ?? []) {
    if (r.tenantRef !== options.tenantRef || r.storageRef !== options.storageRef
      || r.fromKeyId !== keyId || seen.has(r.toKeyId)) throw new Error('rotation continuity mismatch');
    const next = publicKey(options, r.toKeyId);
    if (next.export({ type: 'spki', format: 'pem' }) !== r.publicKey
      || !verify(null, rotationBytes(r), publicKey(options, keyId), Buffer.from(signature, 'base64'))) throw new Error('rotation signature mismatch');
    keyId = r.toKeyId; seen.add(keyId);
  }
  if (keyId !== c.keyId || !verify(null, checkpointBytes(c), publicKey(options, c.keyId), Buffer.from(doc.signature, 'base64'))) {
    throw new Error('checkpoint signature or key continuity mismatch');
  }
  return c;
}

// A coherent DB snapshot is required: appends can continue on other connections.
async function inspect(client, tenantRef) {
  await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
  try {
    const integrity = await verifyChain(client, { tenantRef });
    const { rows } = await client.query('SELECT seq, record_hash FROM evidence WHERE tenant_ref = $1 ORDER BY seq', [tenantRef]);
    await client.query('COMMIT');
    return { integrity, rows };
  } catch (error) { await client.query('ROLLBACK'); throw error; }
}

/** Private signing material stays in the injected signer, never in stored metadata. */
export async function publishCheckpoint(client, options) {
  await authorized(options, 'publish');
  assertIndependentAnchorStorage(options.storage, options);
  for (const field of ['build', 'keyId', 'tenantRef']) {
    if (typeof options[field] !== 'string' || !options[field]) throw new Error(`${field} required`);
    assertNoEmbeddedCredential(options[field], field);
  }
  if (options.mode !== 'fixture' && options.storage.capabilities.operations.publish !== 'live-qualified') throw new Error('publication is not qualified');
  const { integrity, rows } = await inspect(client, options.tenantRef);
  if (!integrity.ok || !rows.length) throw new Error('cannot anchor empty or broken evidence');
  const head = rows.at(-1);
  const checkpoint = { tenantRef: options.tenantRef, sequence: String(head.seq), headHash: head.record_hash,
    recordCount: String(rows.length), build: options.build, storageRef: options.storageRef, keyId: options.keyId };
  const rotations = (options.rotations ?? []).map(({ rotation: r, signature }) => ({
    rotation: { tenantRef: r.tenantRef, storageRef: r.storageRef, fromKeyId: r.fromKeyId,
      toKeyId: r.toKeyId, publicKey: r.publicKey }, signature,
  }));
  const doc = { version: 1, checkpoint, rotations,
    signature: Buffer.from(await options.signer(checkpointBytes(checkpoint))).toString('base64') };
  authenticate(doc, options);
  // Content-addressing supports retry without overwriting an independently held object.
  const { createHash } = await import('node:crypto');
  const bytes = Buffer.from(JSON.stringify(doc));
  const ref = `evidence-checkpoints/${createHash('sha256').update(bytes).digest('hex')}.json`;
  await authorized(options, 'publish');
  let existing;
  try { existing = await options.storage.read(ref); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (existing) {
    if (!Buffer.from(existing).equals(bytes)) throw new Error('checkpoint object conflict');
  } else await options.storage.publish(ref, bytes);
  if (!Buffer.from(await options.storage.read(ref)).equals(bytes)) throw new Error('checkpoint readback failed');
  return ref;
}

/** checkpointRef MUST be pinned outside the DB; no internal-head fallback. */
export async function verifyAnchoredChain(client, options) {
  await authorized(options, 'verify');
  const unanchored = { ok: false, status: 'unanchored', reason: 'external-trust-unavailable' };
  let checkpoint;
  try {
    assertIndependentAnchorStorage(options.storage, options);
    if (!options.checkpointRef) return { ...unanchored, reason: 'missing-external-anchor' };
    checkpoint = authenticate(JSON.parse(await options.storage.read(options.checkpointRef)), options);
  } catch { return unanchored; }
  const { integrity, rows } = await inspect(client, options.tenantRef);
  const actualSeq = rows.at(-1)?.seq ?? '0';
  if (BigInt(actualSeq) < BigInt(checkpoint.sequence) || BigInt(rows.length) < BigInt(checkpoint.recordCount)) {
    return { ok: false, status: 'truncated', expectedSeq: checkpoint.sequence, actualSeq };
  }
  const index = rows.findIndex(row => String(row.seq) === checkpoint.sequence);
  if (index < 0 || rows[index].record_hash !== checkpoint.headHash || BigInt(index + 1) !== BigInt(checkpoint.recordCount)) {
    return { ok: false, status: 'broken-at-sequence', brokenAtSeq: checkpoint.sequence };
  }
  if (!integrity.ok) return { ...integrity, status: integrity.reason === 'truncated' ? 'truncated' : 'broken-at-sequence' };
  return { ok: true, status: 'verified', qualification: options.mode === 'fixture' ? 'fixture-tested' : 'live-qualified',
    anchoredThroughSeq: checkpoint.sequence, build: checkpoint.build, keyId: checkpoint.keyId,
    unanchoredRecords: rows.length - index - 1 };
}
