/**
 * Wave 2 STORE: the Azure Blob adapter against an in-memory fake client, and
 * the REST client against a fake fetch. No network, no real storage account.
 */
import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import { sha256Hex } from '../export/manifest.mjs';
import { assertStorageAdapter } from './adapter.mjs';
import {
  AZURE_BLOB_PROVIDER,
  AZURE_DELETE_REFUSAL_CODES,
  createAzureBlobAdapter,
  createAzureBlobRestClient,
  probeAzureBlobCapabilities,
  retentionModeForAzure,
} from './azureBlob.mjs';
import { evaluateStorageQualification } from './qualification.mjs';

const CONTAINER = 'keel-rt-fixture';
const SAS = 'sv=2023-11-03&ss=b&srt=co&sp=rwdl&se=2030-01-01T00%3A00%3A00Z&sig=FIXTURESIGNATUREabc123';

function codeError(code) {
  return Object.assign(new Error(code), { code });
}

/** In-memory Azure Blob client. `policyMode` is the default policy put on every new blob. */
function fakeAzureClient({ versionLevelImmutability = false, policyMode = null } = {}) {
  const blobs = new Map();
  return {
    blobs,
    async putBlob({ name, body }) {
      if (blobs.has(name)) throw codeError('BlobAlreadyExists');
      blobs.set(name, Buffer.from(body));
    },
    async getBlob({ name }) {
      if (!blobs.has(name)) throw codeError('BlobNotFound');
      return { body: Buffer.from(blobs.get(name)) };
    },
    async getBlobProperties({ name }) {
      if (!blobs.has(name)) throw codeError('BlobNotFound');
      return {
        contentLength: blobs.get(name).length,
        serverEncrypted: true,
        legalHold: false,
        immutabilityPolicy: policyMode ? { mode: policyMode, expiresOn: '2030-01-01T00:00:00.000Z' } : null,
      };
    },
    async listBlobs({ prefix }) {
      return { names: [...blobs.keys()].filter((name) => name.startsWith(prefix)) };
    },
    async getContainerProperties() {
      return { versionLevelImmutability };
    },
    async deleteBlob({ name }) {
      if (policyMode) throw codeError('BlobImmutableDueToPolicy');
      blobs.delete(name);
    },
  };
}

test('the Azure adapter passes the storage adapter contract and round-trips bytes', async () => {
  const client = fakeAzureClient();
  const adapter = createAzureBlobAdapter({ container: CONTAINER, prefix: 'keel', client });
  assert.equal(assertStorageAdapter(adapter), adapter);
  assert.equal(adapter.capabilities.provider, AZURE_BLOB_PROVIDER);

  const bytes = Buffer.from('dump bytes');
  const published = await adapter.publish('keel-db/keel-db-2026-10-15.sql.gz', bytes);
  assert.equal(published.immutableProof, false, 'an upload is never immutability proof');
  assert.equal(published.sha256, sha256Hex(bytes));
  assert.ok(client.blobs.has('keel/keel-db/keel-db-2026-10-15.sql.gz'));
  assert.deepEqual(await adapter.read('keel-db/keel-db-2026-10-15.sql.gz'), bytes);
  assert.deepEqual(await adapter.list(), ['keel-db/keel-db-2026-10-15.sql.gz']);
  assert.deepEqual(await adapter.list('keel-db'), ['keel-db/keel-db-2026-10-15.sql.gz']);
  assert.equal((await adapter.verify('keel-db/keel-db-2026-10-15.sql.gz', { sha256: published.sha256, bytes: bytes.length })).ok, true);
  assert.deepEqual((await adapter.verify('keel-db/keel-db-2026-10-15.sql.gz', { sha256: '0'.repeat(64) })).failures,
    ['checksum mismatch for keel-db/keel-db-2026-10-15.sql.gz']);
  assert.equal((await adapter.verify('missing', { sha256: published.sha256 })).ok, false);
  await assert.rejects(() => adapter.publish('keel-db/keel-db-2026-10-15.sql.gz', bytes), /already published/);
  await assert.rejects(() => adapter.publish('../escape', bytes), /unsafe storage object name/);
});

test('immutability claims: unknown without evidence, unsupported when observed absent, fixture-tested only with a qualified deletion test', async () => {
  const plain = fakeAzureClient();
  const noProbe = createAzureBlobAdapter({ container: CONTAINER, client: plain });
  assert.equal(noProbe.capabilities.immutability, 'unknown');

  const absent = await probeAzureBlobCapabilities(plain, { container: CONTAINER });
  assert.equal(absent.objectLock.supported, false);
  assert.equal(createAzureBlobAdapter({ container: CONTAINER, client: plain, probe: absent }).capabilities.immutability, 'unsupported');

  const locked = fakeAzureClient({ versionLevelImmutability: true, policyMode: 'Locked' });
  const lockedAdapter = createAzureBlobAdapter({ container: CONTAINER, client: locked });
  const canary = Buffer.from('canary');
  await lockedAdapter.publish('canary.bin', canary);
  const probe = await probeAzureBlobCapabilities(locked, { container: CONTAINER, observeName: 'canary.bin' });
  assert.equal(probe.objectLock.supported, true);
  assert.equal(probe.encryption.supported, true);
  // Uploading under a locked container still claims nothing.
  assert.equal(createAzureBlobAdapter({ container: CONTAINER, client: locked, probe }).capabilities.immutability, 'unknown');

  const status = await lockedAdapter.retentionStatus('canary.bin');
  assert.equal(status.object.mode, 'COMPLIANCE');
  assert.equal(status.object.azureMode, 'Locked');

  // A delete under the immutability policy is refused, with a policy code.
  let deletion;
  try {
    await locked.deleteBlob({ container: CONTAINER, name: 'canary.bin' });
    deletion = { refused: false };
  } catch (error) {
    deletion = { refused: AZURE_DELETE_REFUSAL_CODES.includes(error.code) };
  }
  assert.equal(deletion.refused, true);
  assert.ok(locked.blobs.has('canary.bin'));

  const harness = (mode) => ({
    synthetic: true,
    provider: AZURE_BLOB_PROVIDER,
    bucket: CONTAINER,
    credentialClass: 'retention-scoped',
    canary: { name: 'canary.bin', sha256: sha256Hex(canary) },
    publish: { ok: true },
    readback: { checksumVerified: true },
    deletionTest: deletion,
    bypassTest: { credentialCouldAlterRetention: false },
    retentionStatus: { mode, retainUntilDate: '2030-01-01T00:00:00.000Z' },
  });
  const evidence = {
    tenantRef: 'sha256:store-fixture',
    probe,
    residency: { region: 'westeurope', boundary: 'EU', credentialBoundary: 'SAS reference only' },
    keyRecovery: { heldBy: 'operator', location: 'offline safe', instructions: 'see runbook' },
  };
  const qualified = evaluateStorageQualification({ ...evidence, harness: harness(retentionModeForAzure('Locked')) });
  assert.equal(qualified.qualified, true, qualified.failures.join('; '));
  assert.equal(createAzureBlobAdapter({ container: CONTAINER, client: locked, probe, qualification: qualified }).capabilities.immutability, 'fixture-tested');

  // An Unlocked policy is like GOVERNANCE: an admin can remove it, so it never qualifies.
  const unlocked = evaluateStorageQualification({ ...evidence, harness: harness(retentionModeForAzure('Unlocked')) });
  assert.equal(unlocked.qualified, false);
  assert.match(unlocked.failures.join('\n'), /retention mode is "GOVERNANCE"/);
});

function fakeFetch(routes) {
  const calls = [];
  const fetchFn = async (url, init) => {
    calls.push({ url, method: init.method, headers: init.headers });
    const parsed = new URL(url);
    const route = routes(init.method, parsed);
    return new Response(route.body ?? null, { status: route.status ?? 200, headers: route.headers ?? {} });
  };
  return { calls, fetchFn };
}

test('the REST client signs every call with the SAS and never leaks it in errors', async () => {
  const { calls, fetchFn } = fakeFetch((method, url) => {
    if (method === 'PUT') return { status: 201 };
    if (method === 'HEAD' && url.pathname.endsWith('missing')) return { status: 404 };
    if (method === 'HEAD') {
      return {
        headers: {
          'content-length': '4',
          'x-ms-server-encrypted': 'true',
          'x-ms-immutability-policy-mode': 'locked',
          'x-ms-immutability-policy-until-date': 'Wed, 01 Jan 2030 00:00:00 GMT',
        },
      };
    }
    if (method === 'GET' && url.searchParams.get('comp') === 'list') {
      const page = url.searchParams.get('marker')
        ? '<EnumerationResults><Blobs><Blob><Name>b&amp;c</Name></Blob></Blobs><NextMarker/></EnumerationResults>'
        : '<EnumerationResults><Blobs><Blob><Name>a</Name></Blob></Blobs><NextMarker>m2</NextMarker></EnumerationResults>';
      return { body: page };
    }
    if (method === 'GET' && url.searchParams.get('restype') === 'container') {
      return { headers: { 'x-ms-immutable-storage-with-versioning-enabled': 'true' } };
    }
    if (method === 'DELETE') return { status: 409, headers: { 'x-ms-error-code': 'BlobImmutableDueToPolicy' } };
    return { body: 'data' };
  });
  const client = createAzureBlobRestClient({ endpoint: 'https://keelfixture.blob.core.windows.net', sas: `?${SAS}`, fetchFn });
  assert.equal(client.fixture, false);

  await client.putBlob({ container: CONTAINER, name: 'keel-db/a b.gz', body: Buffer.from('data'), sha256: sha256Hex(Buffer.from('data')) });
  const put = calls.at(-1);
  assert.equal(put.headers['if-none-match'], '*', 'uploads never overwrite');
  assert.equal(put.headers['x-ms-blob-type'], 'BlockBlob');
  assert.match(put.url, /^https:\/\/keelfixture\.blob\.core\.windows\.net\/keel-rt-fixture\/keel-db\/a%20b\.gz\?sv=/);
  assert.equal(new URL(put.url).searchParams.get('sig'), 'FIXTURESIGNATUREabc123');

  assert.deepEqual(await client.getBlobProperties({ container: CONTAINER, name: 'x' }), {
    contentLength: 4,
    serverEncrypted: true,
    legalHold: false,
    immutabilityPolicy: { mode: 'locked', expiresOn: '2030-01-01T00:00:00.000Z' },
  });
  assert.deepEqual((await client.listBlobs({ container: CONTAINER, prefix: '' })).names, ['a', 'b&c']);
  assert.equal(new URL(calls.at(-1).url).searchParams.get('marker'), 'm2');
  assert.deepEqual(await client.getContainerProperties({ container: CONTAINER }), { versionLevelImmutability: true });
  assert.deepEqual((await client.getBlob({ container: CONTAINER, name: 'x' })).body, Buffer.from('data'));

  await assert.rejects(() => client.getBlobProperties({ container: CONTAINER, name: 'missing' }), (error) => {
    assert.equal(error.code, 'BlobNotFound');
    assert.doesNotMatch(error.message, /sig|FIXTURESIGNATURE/);
    return true;
  });
  await assert.rejects(() => client.deleteBlob({ container: CONTAINER, name: 'x' }), (error) => {
    assert.ok(AZURE_DELETE_REFUSAL_CODES.includes(error.code), 'a policy refusal counts as a deletion refusal');
    assert.doesNotMatch(error.message, /FIXTURESIGNATURE/);
    return true;
  });
  for (const call of calls) assert.equal(call.headers['x-ms-version'], '2023-11-03');
});

test('a delete refused for missing SAS permission is not an immutability refusal', async () => {
  const { fetchFn } = fakeFetch(() => ({ status: 403, headers: { 'x-ms-error-code': 'AuthorizationPermissionMismatch' } }));
  const client = createAzureBlobRestClient({ endpoint: 'https://keelfixture.blob.core.windows.net', sas: SAS, fetchFn });
  await assert.rejects(() => client.deleteBlob({ container: CONTAINER, name: 'x' }), (error) => {
    assert.equal(error.code, 'AuthorizationPermissionMismatch');
    assert.equal(AZURE_DELETE_REFUSAL_CODES.includes(error.code), false);
    return true;
  });
});

test('the REST client refuses unsafe configuration', () => {
  const fetchFn = async () => new Response(null);
  assert.throws(() => createAzureBlobRestClient({ endpoint: 'http://keelfixture.blob.core.windows.net', sas: SAS, fetchFn }), /https/);
  assert.throws(() => createAzureBlobRestClient({ endpoint: `https://keelfixture.blob.core.windows.net/?${SAS}`, sas: SAS, fetchFn }), /pass the SAS separately/);
  assert.throws(() => createAzureBlobRestClient({ endpoint: 'https://keelfixture.blob.core.windows.net', sas: 'not-a-sas', fetchFn }), /sv= and sig=/);
  assert.throws(() => createAzureBlobAdapter({ container: 'Bad_Name', client: fakeAzureClient() }), /valid container name/);
});
