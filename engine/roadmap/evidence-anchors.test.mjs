import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createIsolatedTestDatabase } from '../test/dbTestHelper.mjs';
import { appendEvidence, verifyChain } from '../govern/evidence.mjs';
import { publishCheckpoint, verifyAnchoredChain, checkpointBytes, rotationBytes } from '../govern/anchor.mjs';
import { createLocalStorageAdapter } from '../storage/local.mjs';
import { assertIndependentAnchorStorage } from '../storage/adapter.mjs';

async function fixture(fn) {
  const db = await createIsolatedTestDatabase(import.meta.url);
  const client = await db.connect();
  const root = await mkdtemp(join(tmpdir(), 'keel-anchor-'));
  try {
    await client.query(readFileSync(new URL('../store/schema.sql', import.meta.url), 'utf8'));
    const key = generateKeyPairSync('ed25519');
    const storage = createLocalStorageAdapter({ root });
    const context = { tenantRef: 'fixture', build: 'build-78', storage,
      storageRef: 'fixture-independent-store', keyId: 'key-v1', mode: 'fixture',
      authorize: async () => true,
      trust: { storageRef: 'fixture-independent-store', independent: true,
        qualification: 'fixture-tested', rootKeyId: 'key-v1',
        keys: { 'key-v1': { publicKey: key.publicKey, qualification: 'fixture-tested' } } },
      signer: bytes => sign(null, bytes, key.privateKey) };
    const append = () => appendEvidence(client, { tenantRef: 'fixture', kind: 'test', actor: 'fixture', subject: {}, eventSink() {} });
    await append(); await append();
    await fn({ client, context, append, key });
  } finally { await client.end(); await db.cleanup(); await rm(root, { recursive: true, force: true }); }
}

test('external checkpoint round trip, missing anchor and fixture trust ceiling', () => fixture(async ({ client, context }) => {
  assert.equal((await verifyAnchoredChain(client, context)).status, 'unanchored');
  const ref = await publishCheckpoint(client, context);
  context.checkpointRef = ref;
  assert.equal(await publishCheckpoint(client, context), ref);
  assert.equal((await verifyAnchoredChain(client, context)).status, 'verified');
  assert.equal((await verifyAnchoredChain(client, { ...context, mode: 'production' })).status, 'unanchored');
  assert.equal((await verifyAnchoredChain(client, { ...context, trust: null })).status, 'unanchored');
  await assert.rejects(verifyAnchoredChain(client, { ...context, authorize: async () => false }), /authorized/);
  await assert.rejects(publishCheckpoint(client, { ...context, authorize: async () => false }), /authorized/);
}));

test('rewriting records and internal head together is detected externally', () => fixture(async ({ client, context, append }) => {
  context.checkpointRef = await publishCheckpoint(client, context);
  const originalSeqs = (await client.query('SELECT seq FROM evidence WHERE tenant_ref = $1 ORDER BY seq', ['fixture'])).rows;
  await client.query('DELETE FROM evidence WHERE tenant_ref = $1', ['fixture']);
  await client.query('DELETE FROM evidence_head WHERE tenant_ref = $1', ['fixture']);
  const first = await append(); const last = await append();
  await client.query('UPDATE evidence SET seq = $1 WHERE seq = $2', [originalSeqs[0].seq, first.seq]);
  await client.query('UPDATE evidence SET seq = $1 WHERE seq = $2', [originalSeqs[1].seq, last.seq]);
  await client.query('UPDATE evidence_head SET head_seq = $1 WHERE tenant_ref = $2', [originalSeqs[1].seq, 'fixture']);
  assert.deepEqual(await verifyChain(client, context), { ok: true });
  assert.equal((await verifyAnchoredChain(client, context)).status, 'broken-at-sequence');
}));

test('publication requires exact readback after both a new publish and an idempotent retry', () => fixture(async ({ client, context }) => {
  for (const existing of [false, true]) {
    for (const failure of ['corrupt', 'unavailable']) {
      const calls = [];
      let stored;
      const options = { ...context, build: `readback-${existing}-${failure}`,
        storage: { ...context.storage,
          publish: async (ref, bytes) => { calls.push('publish'); stored = Buffer.from(bytes); },
          read: async () => {
            calls.push('read');
            if (calls.length === 1) {
              if (existing) return stored;
              throw Object.assign(new Error('absent fixture object'), { code: 'ENOENT' });
            }
            if (failure === 'unavailable') throw new Error('fixture readback unavailable');
            return Buffer.concat([stored, Buffer.from('corruption')]);
          },
        },
      };
      if (existing) {
        const ref = await publishCheckpoint(client, { ...context, build: options.build });
        stored = await context.storage.read(ref);
      }
      await assert.rejects(publishCheckpoint(client, options),
        failure === 'corrupt' ? /checkpoint readback failed/ : /fixture readback unavailable/);
      assert.deepEqual(calls, existing ? ['read', 'read'] : ['read', 'publish', 'read']);
    }
  }
  context.checkpointRef = await publishCheckpoint(client, context);
  assert.equal(await publishCheckpoint(client, context), context.checkpointRef);
  assert.equal((await verifyAnchoredChain(client, context)).status, 'verified');
}));

test('publication rejects embedded credentials in every checkpoint metadata field before IO', () => fixture(async ({ client, context }) => {
  for (const field of ['build', 'keyId', 'tenantRef']) {
    for (const value of ['password=synthetic-fixture-only', 'Bearer synthetic-fixture-token',
      '-----BEGIN PRIVATE KEY----- synthetic fixture']) {
      const calls = [];
      const options = { ...context, [field]: value,
        signer: bytes => { calls.push('sign'); return context.signer(bytes); },
        storage: { ...context.storage,
          read: async (...args) => { calls.push('read'); return context.storage.read(...args); },
          publish: async (...args) => { calls.push('publish'); return context.storage.publish(...args); },
        },
      };
      const observedClient = { query: (...args) => { calls.push('query'); return client.query(...args); } };
      await assert.rejects(publishCheckpoint(observedClient, options), error => {
        assert.equal(error.name, 'EmbeddedCredentialError');
        assert.match(error.message, new RegExp(`storage metadata field ${field} appears to embed credential material`));
        assert.equal(error.message.includes(value), false);
        return true;
      });
      assert.deepEqual(calls, []);
    }
  }
  assert.deepEqual(await context.storage.list(), []);
  context.checkpointRef = await publishCheckpoint(client, context);
  assert.equal((await verifyAnchoredChain(client, context)).status, 'verified');
}));

test('production publication independently requires a live-qualified publish capability', () => fixture(async ({ client, context }) => {
  // All other gates pass; synthetic claims never qualify the real local adapter.
  const production = { ...context, mode: 'production',
    storage: { ...context.storage, capabilities: { ...context.storage.capabilities,
      provider: 'fake-qualified-anchor-store', immutability: 'live-qualified',
      operations: { ...context.storage.capabilities.operations, read: 'live-qualified', publish: 'live-qualified' },
    } },
    trust: { ...context.trust, qualification: 'live-qualified',
      keys: { 'key-v1': { ...context.trust.keys['key-v1'], qualification: 'live-qualified' } },
    },
  };
  for (const publish of ['declared', 'fixture-tested', 'unsupported', 'unknown']) {
    const calls = [];
    const options = { ...production,
      signer: bytes => { calls.push('sign'); return production.signer(bytes); },
      storage: { ...production.storage,
        capabilities: { ...production.storage.capabilities,
          operations: { ...production.storage.capabilities.operations, publish },
        },
        read: async (...args) => { calls.push('read'); return production.storage.read(...args); },
        publish: async (...args) => { calls.push('publish'); return production.storage.publish(...args); },
      },
    };
    const observedClient = { query: (...args) => { calls.push('query'); return client.query(...args); } };
    assert.equal(assertIndependentAnchorStorage(options.storage, options), options.storage);
    await assert.rejects(publishCheckpoint(observedClient, options), /publication is not qualified/);
    assert.deepEqual(calls, []);
  }
  assert.deepEqual(await context.storage.list(), []);
  production.checkpointRef = await publishCheckpoint(client, production);
  assert.equal((await verifyAnchoredChain(client, production)).status, 'verified');
  assert.equal(await publishCheckpoint(client, production), production.checkpointRef);
}));

test('production verification independently requires a live-qualified signing key', () => fixture(async ({ client, context }) => {
  context.checkpointRef = await publishCheckpoint(client, context);
  // Simulate qualified external storage without upgrading the local-disk adapter
  // or claiming any real provider qualification. Only the key gate varies.
  const production = { ...context, mode: 'production',
    storage: { ...context.storage, capabilities: { ...context.storage.capabilities,
      provider: 'fake-qualified-anchor-store', immutability: 'live-qualified',
      operations: { ...context.storage.capabilities.operations, read: 'live-qualified', publish: 'live-qualified' },
    } },
    trust: { ...context.trust, qualification: 'live-qualified' },
  };
  assert.deepEqual(await verifyAnchoredChain(client, production), {
    ok: false, status: 'unanchored', reason: 'external-trust-unavailable',
  });
  await assert.rejects(publishCheckpoint(client, production), /signing key unavailable or untrusted/);
  const qualified = { ...production, trust: { ...production.trust,
    keys: { 'key-v1': { ...context.trust.keys['key-v1'], qualification: 'live-qualified' } },
  } };
  const result = await verifyAnchoredChain(client, qualified);
  assert.equal(result.status, 'verified');
  assert.equal(result.qualification, 'live-qualified');
  assert.equal(await publishCheckpoint(client, qualified), context.checkpointRef);
}));

test('a valid signed checkpoint cannot be replayed under a different pinned storage reference', () => fixture(async ({ client, context }) => {
  context.checkpointRef = await publishCheckpoint(client, context);
  assert.equal((await verifyAnchoredChain(client, context)).status, 'verified');
  // Replay the unchanged signed bytes through a different trusted storage
  // identity. The storage/trust gate passes; the signed checkpoint must not.
  const destination = { ...context, storageRef: 'other-independent-store',
    trust: { ...context.trust, storageRef: 'other-independent-store' },
  };
  assert.deepEqual(await verifyAnchoredChain(client, destination), {
    ok: false, status: 'unanchored', reason: 'external-trust-unavailable',
  });
  destination.checkpointRef = await publishCheckpoint(client, destination);
  assert.notEqual(destination.checkpointRef, context.checkpointRef);
  assert.equal((await verifyAnchoredChain(client, destination)).status, 'verified');
}));

test('publication reauthorizes after signing and refuses storage access after revocation', () => fixture(async ({ client, context }) => {
  let allowed = true;
  const decisions = [];
  const storageCalls = [];
  const options = { ...context,
    authorize: async request => {
      decisions.push({ ...request, allowed });
      return allowed;
    },
    signer: async bytes => {
      const signature = await context.signer(bytes);
      allowed = false;
      return signature;
    },
    storage: { ...context.storage,
      read: async (...args) => { storageCalls.push('read'); return context.storage.read(...args); },
      publish: async (...args) => { storageCalls.push('publish'); return context.storage.publish(...args); },
    },
  };
  await assert.rejects(publishCheckpoint(client, options), /not authorized/);
  assert.deepEqual(decisions, [
    { tenantRef: context.tenantRef, action: 'publish', allowed: true },
    { tenantRef: context.tenantRef, action: 'publish', allowed: false },
  ]);
  assert.deepEqual(storageCalls, []);
  assert.deepEqual(await context.storage.list(), []);
  // A later authorized retry still publishes and verifies normally.
  context.checkpointRef = await publishCheckpoint(client, context);
  assert.equal((await verifyAnchoredChain(client, context)).status, 'verified');
}));

test('truncation remains a failure with a rewritten internal head', () => fixture(async ({ client, context }) => {
  context.checkpointRef = await publishCheckpoint(client, context);
  await client.query('DELETE FROM evidence WHERE tenant_ref = $1', ['fixture']);
  await client.query('DELETE FROM evidence_head WHERE tenant_ref = $1', ['fixture']);
  assert.deepEqual(await verifyChain(client, context), { ok: true });
  assert.equal((await verifyAnchoredChain(client, context)).status, 'truncated');
}));

test('tenant, key, build, signature and storage trust are pinned outside the DB', () => fixture(async ({ client, context }) => {
  context.checkpointRef = await publishCheckpoint(client, context);
  for (const patch of [ { tenantRef: 'foreign' }, { build: 'foreign-build' },
    { trust: { ...context.trust, keys: {} } },
    { trust: { ...context.trust, independent: false } } ]) {
    assert.equal((await verifyAnchoredChain(client, { ...context, ...patch })).ok, false);
  }
  const doc = JSON.parse(await context.storage.read(context.checkpointRef));
  doc.checkpoint.headHash = '0'.repeat(64);
  await context.storage.publish('tampered.json', Buffer.from(JSON.stringify(doc)));
  assert.equal((await verifyAnchoredChain(client, { ...context, checkpointRef: 'tampered.json' })).ok, false);
}));

test('rotation requires old-key authenticated continuity and the new key signature', () => fixture(async ({ client, context, key }) => {
  const next = generateKeyPairSync('ed25519');
  context.trust.keys['key-v2'] = { publicKey: next.publicKey, qualification: 'fixture-tested' };
  const rotation = { tenantRef: context.tenantRef, storageRef: context.storageRef, fromKeyId: 'key-v1', toKeyId: 'key-v2',
    publicKey: next.publicKey.export({ type: 'spki', format: 'pem' }) };
  context.rotations = [{ rotation, signature: sign(null, rotationBytes(rotation), key.privateKey).toString('base64') }];
  context.keyId = 'key-v2'; context.signer = bytes => sign(null, bytes, next.privateKey);
  context.checkpointRef = await publishCheckpoint(client, context);
  assert.equal((await verifyAnchoredChain(client, context)).ok, true);
  const doc = JSON.parse(await context.storage.read(context.checkpointRef));
  doc.rotations[0].signature = Buffer.alloc(64).toString('base64');
  await context.storage.publish('bad-continuity.json', Buffer.from(JSON.stringify(doc)));
  assert.equal((await verifyAnchoredChain(client, { ...context, checkpointRef: 'bad-continuity.json' })).ok, false);
  doc.rotations = [];
  await context.storage.publish('no-continuity.json', Buffer.from(JSON.stringify(doc)));
  assert.equal((await verifyAnchoredChain(client, { ...context, checkpointRef: 'no-continuity.json' })).ok, false);
}));

test('checkpoint binds count and detects single-row edits; uncovered tail is explicit', () => fixture(async ({ client, context, append }) => {
  context.checkpointRef = await publishCheckpoint(client, context);
  await append();
  const result = await verifyAnchoredChain(client, context);
  assert.equal(result.status, 'verified'); assert.equal(result.unanchoredRecords, 1);
  await client.query("UPDATE evidence SET actor = 'tampered' WHERE tenant_ref = $1", ['fixture']);
  assert.equal((await verifyAnchoredChain(client, context)).status, 'broken-at-sequence');
}));

test('adapter trust registry must pin the caller storage reference before any IO', () => fixture(async ({ client, context }) => {
  context.checkpointRef = await publishCheckpoint(client, context);
  const calls = [];
  const options = { ...context, trust: { ...context.trust, storageRef: 'different-trust-store' },
    storage: { ...context.storage,
      read: async (...args) => { calls.push('read'); return context.storage.read(...args); },
      publish: async (...args) => { calls.push('publish'); return context.storage.publish(...args); },
    },
  };
  // The signed checkpoint still matches the caller; only the trust pin differs.
  assert.throws(() => assertIndependentAnchorStorage(options.storage, options), /independent external storage trust unavailable/);
  assert.deepEqual(await verifyAnchoredChain(client, options), {
    ok: false, status: 'unanchored', reason: 'external-trust-unavailable',
  });
  await assert.rejects(publishCheckpoint(client, options), /independent external storage trust unavailable/);
  assert.deepEqual(calls, []);
  assert.equal(assertIndependentAnchorStorage(context.storage, context), context.storage);
  assert.equal((await verifyAnchoredChain(client, context)).status, 'verified');
}));

test('omitted authorization and non-true decisions deny both entry points before IO', () => fixture(async ({ client, context }) => {
  context.checkpointRef = await publishCheckpoint(client, context);
  for (const authorization of [{}, { authorize: async () => undefined }, { authorize: async () => null },
    { authorize: async () => 'true' }]) {
    const { authorize, ...withoutAuthorization } = context;
    const calls = [];
    const options = { ...withoutAuthorization, ...authorization,
      storage: { ...context.storage,
        read: async (...args) => { calls.push('read'); return context.storage.read(...args); },
        publish: async (...args) => { calls.push('publish'); return context.storage.publish(...args); },
      },
    };
    const observedClient = { query: (...args) => { calls.push('query'); return client.query(...args); } };
    await assert.rejects(verifyAnchoredChain(observedClient, options), /not authorized/);
    await assert.rejects(publishCheckpoint(observedClient, options), /not authorized/);
    assert.deepEqual(calls, []);
  }
  assert.equal((await verifyAnchoredChain(client, context)).status, 'verified');
}));

test('authenticated rotation cannot reuse the root or an abandoned intermediate key ID', () => fixture(async ({ client, context, key }) => {
  const keys = { 'key-v1': key, 'key-v2': generateKeyPairSync('ed25519'), 'key-v3': generateKeyPairSync('ed25519') };
  for (const [id, pair] of Object.entries(keys)) {
    context.trust.keys[id] = { publicKey: pair.publicKey, qualification: 'fixture-tested' };
  }
  const rotate = (fromKeyId, toKeyId) => {
    const rotation = { tenantRef: context.tenantRef, storageRef: context.storageRef, fromKeyId, toKeyId,
      publicKey: keys[toKeyId].publicKey.export({ type: 'spki', format: 'pem' }) };
    return { rotation, signature: sign(null, rotationBytes(rotation), keys[fromKeyId].privateKey).toString('base64') };
  };
  context.rotations = [rotate('key-v1', 'key-v2'), rotate('key-v2', 'key-v3')];
  context.keyId = 'key-v3';
  context.signer = bytes => sign(null, bytes, keys['key-v3'].privateKey);
  context.checkpointRef = await publishCheckpoint(client, context);
  assert.equal((await verifyAnchoredChain(client, context)).status, 'verified');
  const original = JSON.parse(await context.storage.read(context.checkpointRef));
  for (const reused of ['key-v1', 'key-v2']) {
    const rotations = [...context.rotations, rotate('key-v3', reused)];
    const checkpoint = { ...original.checkpoint, keyId: reused };
    const signer = bytes => sign(null, bytes, keys[reused].privateKey);
    const doc = { ...original, checkpoint, rotations, signature: signer(checkpointBytes(checkpoint)).toString('base64') };
    const checkpointRef = `reused-${reused}.json`;
    // All signatures and pins are valid: continuity alone must reject key reuse.
    await context.storage.publish(checkpointRef, Buffer.from(JSON.stringify(doc)));
    assert.deepEqual(await verifyAnchoredChain(client, { ...context, checkpointRef }), {
      ok: false, status: 'unanchored', reason: 'external-trust-unavailable',
    });
    const before = await context.storage.list();
    await assert.rejects(publishCheckpoint(client, { ...context, rotations, keyId: reused, signer }), /rotation continuity mismatch/);
    assert.deepEqual(await context.storage.list(), before);
  }
}));
