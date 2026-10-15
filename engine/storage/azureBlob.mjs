/**
 * Azure Blob storage adapter (Wave 2 STORE).
 *
 * Implements the storage adapter contract (adapter.mjs) over one Azure Blob
 * container, behind an injected client, with the same immutability rule as
 * s3Compatible.mjs: a successful upload is NEVER immutability proof. The
 * retentionLock/immutability claims come only from retentionClaimFor(): a
 * qualified deletion-test evaluation (tools/qualification/azureBlobLock.mjs)
 * raises them, a probe that observed no version-level immutability makes
 * them 'unsupported', and anything else is 'unknown'.
 *
 * Azure terms mapped onto the qualification vocabulary (qualification.mjs is
 * provider-neutral but speaks S3 words):
 * - "Object Lock supported" = the container has version-level immutability
 *   (immutable storage with versioning) enabled;
 * - a 'Locked' blob immutability policy = COMPLIANCE: nobody, not even the
 *   account owner, can shorten or remove it;
 * - an 'Unlocked' policy = GOVERNANCE: an account admin can shorten or delete
 *   it, so it never qualifies.
 *
 * The injected client interface (all async):
 *   putBlob({ container, name, body, sha256 })       (refuses an existing blob, code 'BlobAlreadyExists')
 *   getBlob({ container, name }) -> { body }
 *   getBlobProperties({ container, name })
 *     -> { contentLength, serverEncrypted, legalHold, immutabilityPolicy: { mode, expiresOn } | null }
 *        (throws code 'BlobNotFound')
 *   listBlobs({ container, prefix }) -> { names }
 *   getContainerProperties({ container }) -> { versionLevelImmutability }
 *   deleteBlob({ container, name })                  (harness only)
 *   setBlobImmutabilityPolicy({ container, name, mode, expiresOn }) (harness only)
 *
 * createAzureBlobRestClient() is the real client: plain HTTPS against the
 * Blob REST API with a SAS token read from a git-ignored env file. The SAS
 * never appears in capabilities, results or error messages.
 */
import { sha256Hex } from '../export/manifest.mjs';
import { assertNoEmbeddedCredential, assertStorageAdapter, defineStorageCapabilities } from './adapter.mjs';
import { assertObjectName } from './local.mjs';
import { UPLOAD_NOT_IMMUTABLE_NOTE } from './s3Compatible.mjs';
import { retentionClaimFor } from './qualification.mjs';

export const AZURE_BLOB_PROVIDER = 'azure-blob';
export const AZURE_BLOB_API_VERSION = '2023-11-03';

// Only a refusal BECAUSE of the immutability policy counts as a deletion
// refusal. A 403 from a SAS without delete permission refuses too, but it
// proves nothing about retention, so it never counts.
export const AZURE_DELETE_REFUSAL_CODES = Object.freeze(['BlobImmutableDueToPolicy']);

const HEX64 = /^[0-9a-f]{64}$/;
const CONTAINER_PATTERN = /^[a-z0-9](?!.*--)[a-z0-9-]{1,61}[a-z0-9]$/;

/** Maps an Azure blob immutability policy mode onto the qualification modes. */
export function retentionModeForAzure(mode) {
  const value = typeof mode === 'string' ? mode.toLowerCase() : null;
  if (value === 'locked') return 'COMPLIANCE';
  if (value === 'unlocked') return 'GOVERNANCE';
  return null;
}

function assertContainer(container) {
  if (typeof container !== 'string' || !CONTAINER_PATTERN.test(container)) {
    throw new TypeError(`an Azure Blob adapter requires a valid container name, got ${JSON.stringify(container)}`);
  }
  return assertNoEmbeddedCredential(container, 'container');
}

/**
 * Observes what this container actually supports. Immutability comes ONLY
 * from the container's answer, never from the provider name. Encryption at
 * rest is observed on a blob (`observeName`), because the data plane reports
 * it per blob; without one it reads as not observed.
 */
export async function probeAzureBlobCapabilities(client, { container, observeName = null } = {}) {
  assertContainer(container);
  let objectLock;
  try {
    const properties = await client.getContainerProperties({ container });
    objectLock = properties?.versionLevelImmutability === true
      ? Object.freeze({ supported: true, mode: null, days: null, years: null })
      : Object.freeze({ supported: false, reason: 'container does not report version-level immutability enabled' });
  } catch (error) {
    objectLock = Object.freeze({
      supported: false,
      reason: `container immutability not observable (${error?.code ?? error?.message ?? 'error'})`,
    });
  }

  let encryption;
  if (observeName) {
    try {
      const properties = await client.getBlobProperties({ container, name: observeName });
      encryption = Object.freeze({
        supported: properties?.serverEncrypted === true,
        algorithm: properties?.serverEncrypted === true ? 'AES256' : null,
      });
    } catch (error) {
      encryption = Object.freeze({
        supported: false,
        reason: `blob encryption not observable (${error?.code ?? error?.message ?? 'error'})`,
      });
    }
  } else {
    encryption = Object.freeze({ supported: false, reason: 'no blob observed yet: encryption is reported per blob' });
  }

  return Object.freeze({ provider: AZURE_BLOB_PROVIDER, bucket: container, objectLock, encryption });
}

/**
 * Creates the Azure Blob adapter for `container` behind the injected client.
 * `qualification` (evaluateStorageQualification verdict) and `probe`
 * (probeAzureBlobCapabilities result) together, and only together, can raise
 * the retentionLock/immutability claims above 'unknown'.
 */
export function createAzureBlobAdapter({
  container,
  prefix = '',
  client,
  residency = {},
  qualification = null,
  probe = null,
} = {}) {
  assertContainer(container);
  if (prefix) assertObjectName(prefix);
  if (!client || typeof client !== 'object') {
    throw new TypeError('an Azure Blob adapter requires an injected client');
  }
  for (const method of ['putBlob', 'getBlob', 'getBlobProperties', 'listBlobs', 'getContainerProperties']) {
    if (typeof client[method] !== 'function') {
      throw new TypeError(`the injected client lacks the ${method} method`);
    }
  }

  const claim = retentionClaimFor({ evaluation: qualification, probe });
  const capabilities = defineStorageCapabilities({
    provider: AZURE_BLOB_PROVIDER,
    residency: {
      ...(residency.region ? { region: residency.region } : {}),
      ...(residency.boundary ? { boundary: residency.boundary } : {}),
      ...(residency.credentialBoundary ? { credentialBoundary: residency.credentialBoundary } : {}),
    },
    retentionLock: claim,
    immutability: claim,
    operations: {
      publish: 'fixture-tested',
      read: 'fixture-tested',
      list: 'fixture-tested',
      verify: 'fixture-tested',
      'retention-status': 'fixture-tested',
    },
  });

  function blobFor(name) {
    assertObjectName(name);
    return prefix ? `${prefix}/${name}` : name;
  }

  async function propertiesOrNull(name) {
    try {
      return await client.getBlobProperties({ container, name });
    } catch (error) {
      if (error?.code === 'BlobNotFound' || error?.status === 404) return null;
      throw error;
    }
  }

  const adapter = {
    provider: AZURE_BLOB_PROVIDER,
    capabilities,

    /**
     * Publishes bytes under `name`, at most once. The result ALWAYS carries
     * `immutableProof: false`: upload success proves nothing about retention.
     */
    async publish(name, bytes) {
      const blob = blobFor(name);
      if (await propertiesOrNull(blob)) {
        throw new Error(`storage object ${name} is already published — refusing to clobber it`);
      }
      const sha256 = sha256Hex(bytes);
      await client.putBlob({ container, name: blob, body: bytes, sha256 });
      return Object.freeze({ name, key: blob, sha256, bytes: bytes.length, immutableProof: false });
    },

    async read(name) {
      return (await client.getBlob({ container, name: blobFor(name) })).body;
    },

    async list(namePrefix = '') {
      if (namePrefix) assertObjectName(namePrefix);
      const blobPrefix = prefix ? (namePrefix ? `${prefix}/${namePrefix}` : `${prefix}/`) : namePrefix;
      const { names } = await client.listBlobs({ container, prefix: blobPrefix });
      return names
        .filter((blob) => !prefix || blob.startsWith(`${prefix}/`))
        .map((blob) => (prefix ? blob.slice(prefix.length + 1) : blob))
        .filter((name) => !namePrefix || name.startsWith(namePrefix))
        .sort();
    },

    async verify(name, { sha256, bytes: expectedBytes } = {}) {
      if (typeof sha256 !== 'string' || !HEX64.test(sha256)) {
        return { ok: false, failures: [`verify requires a sha256 for ${name}`] };
      }
      let bytes;
      try {
        bytes = (await client.getBlob({ container, name: blobFor(name) })).body;
      } catch {
        return { ok: false, failures: [`missing storage object ${name}`] };
      }
      const failures = [];
      if (sha256Hex(bytes) !== sha256) failures.push(`checksum mismatch for ${name}`);
      if (expectedBytes !== undefined && bytes.length !== expectedBytes) failures.push(`length mismatch for ${name}`);
      return { ok: failures.length === 0, failures };
    },

    /**
     * What is OBSERVED about retention (re-probed fresh), plus the descriptor
     * claim, which never exceeds the bound qualification evidence.
     */
    async retentionStatus(name = null) {
      const fresh = await probeAzureBlobCapabilities(client, { container, observeName: name ? blobFor(name) : null });
      let object = null;
      if (name) {
        try {
          const properties = await client.getBlobProperties({ container, name: blobFor(name) });
          const policy = properties?.immutabilityPolicy ?? null;
          object = Object.freeze({
            mode: retentionModeForAzure(policy?.mode),
            azureMode: typeof policy?.mode === 'string' ? policy.mode : null,
            retainUntilDate: typeof policy?.expiresOn === 'string' ? policy.expiresOn : null,
            legalHold: properties?.legalHold === true,
          });
        } catch (error) {
          object = Object.freeze({ error: error?.code ?? error?.message ?? 'error' });
        }
      }
      return Object.freeze({
        provider: AZURE_BLOB_PROVIDER,
        bucket: container,
        retentionLock: claim,
        immutability: claim,
        objectLock: fresh.objectLock,
        encryption: fresh.encryption,
        object,
        note: claim === 'unknown' || claim === 'unsupported' ? UPLOAD_NOT_IMMUTABLE_NOTE : undefined,
      });
    },
  };

  return assertStorageAdapter(adapter);
}

export class AzureBlobError extends Error {
  constructor(message, { status, code }) {
    super(message);
    this.name = 'AzureBlobError';
    this.status = status;
    this.code = code;
  }
}

/** Normalizes a SAS token to its query string; refuses anything that is not one. */
function normalizeSas(sas) {
  if (typeof sas !== 'string') throw new TypeError('a SAS token is required');
  const token = sas.trim().replace(/^\?/, '');
  const params = new URLSearchParams(token);
  if (!params.get('sig') || !params.get('sv')) {
    throw new TypeError('the SAS token must be a query string with sv= and sig=');
  }
  return token;
}

function encodeBlobPath(name) {
  return name.split('/').map(encodeURIComponent).join('/');
}

function decodeXml(text) {
  return text
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

/**
 * The real Azure Blob client: HTTPS to the Blob REST API, authorized by a SAS
 * token. `endpoint` is the account's blob endpoint
 * (https://<account>.blob.core.windows.net). The SAS is held only in this
 * closure; errors name the operation and blob path, never the token.
 *
 * Single-request uploads (Put Blob) only, which the service accepts up to
 * 5000 MiB; larger artifacts are refused before any request is sent.
 */
export function createAzureBlobRestClient({ endpoint, sas, fetchFn = globalThis.fetch, apiVersion = AZURE_BLOB_API_VERSION } = {}) {
  let base;
  try {
    base = new URL(endpoint);
  } catch {
    throw new TypeError('an Azure Blob endpoint URL is required');
  }
  if (base.protocol !== 'https:') throw new TypeError('the Azure Blob endpoint must use https');
  if (base.search || base.username || base.password) {
    throw new TypeError('the Azure Blob endpoint must not carry a query or credentials: pass the SAS separately');
  }
  const token = normalizeSas(sas);
  const root = base.origin;

  async function call(operation, method, path, { query = {}, headers = {}, body } = {}) {
    const url = new URL(`${root}/${path}`);
    for (const [key, value] of Object.entries(query)) {
      if (value !== undefined && value !== null && value !== '') url.searchParams.set(key, value);
    }
    const signed = `${url.toString()}${url.search ? '&' : '?'}${token}`;
    let response;
    try {
      response = await fetchFn(signed, {
        method,
        headers: { 'x-ms-version': apiVersion, 'x-ms-date': new Date().toUTCString(), ...headers },
        body,
      });
    } catch (error) {
      throw new AzureBlobError(`${operation} ${path}: network error (${error?.code ?? error?.cause?.code ?? 'unreachable'})`, {
        status: 0, code: error?.code ?? 'NetworkError',
      });
    }
    if (!response.ok) {
      const code = response.headers.get('x-ms-error-code') ?? (response.status === 404 ? 'BlobNotFound' : `HTTP${response.status}`);
      throw new AzureBlobError(`${operation} ${path}: ${response.status} ${code}`, { status: response.status, code });
    }
    return response;
  }

  return {
    fixture: false,

    async putBlob({ container, name, body, sha256 }) {
      const bytes = Buffer.from(body);
      if (bytes.length > 5000 * 1024 * 1024) {
        throw new AzureBlobError(`putBlob ${container}/${name}: ${bytes.length} bytes exceeds the single-upload limit`, { status: 0, code: 'TooLarge' });
      }
      await call('putBlob', 'PUT', `${container}/${encodeBlobPath(name)}`, {
        headers: {
          'x-ms-blob-type': 'BlockBlob',
          'content-type': 'application/octet-stream',
          'content-length': String(bytes.length),
          'if-none-match': '*',
          ...(sha256 ? { 'x-ms-meta-sha256': sha256 } : {}),
        },
        body: bytes,
      });
      return { sha256: sha256Hex(bytes) };
    },

    async getBlob({ container, name }) {
      const response = await call('getBlob', 'GET', `${container}/${encodeBlobPath(name)}`);
      return { body: Buffer.from(await response.arrayBuffer()) };
    },

    async getBlobProperties({ container, name }) {
      const response = await call('getBlobProperties', 'HEAD', `${container}/${encodeBlobPath(name)}`);
      const h = response.headers;
      const mode = h.get('x-ms-immutability-policy-mode');
      const until = h.get('x-ms-immutability-policy-until-date');
      return {
        contentLength: Number(h.get('content-length') ?? NaN),
        serverEncrypted: h.get('x-ms-server-encrypted') === 'true',
        legalHold: h.get('x-ms-legal-hold') === 'true',
        immutabilityPolicy: mode ? { mode, expiresOn: until ? new Date(until).toISOString() : null } : null,
      };
    },

    async listBlobs({ container, prefix = '' }) {
      const names = [];
      let marker = '';
      do {
        const response = await call('listBlobs', 'GET', container, {
          query: { restype: 'container', comp: 'list', prefix, marker },
        });
        const xml = await response.text();
        for (const match of xml.matchAll(/<Blob>[\s\S]*?<Name>([\s\S]*?)<\/Name>/g)) names.push(decodeXml(match[1]));
        marker = decodeXml(/<NextMarker>([\s\S]*?)<\/NextMarker>/.exec(xml)?.[1] ?? '');
      } while (marker);
      return { names };
    },

    async getContainerProperties({ container }) {
      const response = await call('getContainerProperties', 'GET', container, { query: { restype: 'container' } });
      return { versionLevelImmutability: response.headers.get('x-ms-immutable-storage-with-versioning-enabled') === 'true' };
    },

    async deleteBlob({ container, name }) {
      await call('deleteBlob', 'DELETE', `${container}/${encodeBlobPath(name)}`);
      return {};
    },

    async setBlobImmutabilityPolicy({ container, name, mode, expiresOn }) {
      await call('setBlobImmutabilityPolicy', 'PUT', `${container}/${encodeBlobPath(name)}`, {
        query: { comp: 'immutabilityPolicies' },
        headers: {
          'x-ms-immutability-policy-until-date': new Date(expiresOn).toUTCString(),
          'x-ms-immutability-policy-mode': mode,
        },
      });
      return {};
    },
  };
}
