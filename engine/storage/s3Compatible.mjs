/**
 * Capability-negotiated S3-compatible reference storage adapter (roadmap
 * task-69, WS10).
 *
 * This adapter speaks to any S3-compatible object store through an injected
 * client, but it NEVER infers Object Lock support from S3 compatibility: an
 * S3-compatible API is a dialect, not a retention guarantee, and many
 * S3-compatible services do not implement Object Lock at all (mutation check:
 * infer Object Lock from S3 compatibility). Support is established only by
 * probing the client (`probeS3Capabilities`) and by the deletion-test harness
 * in tools/qualification/storageLock.mjs.
 *
 * Capability claims follow Global Constraint #6: the retentionLock and
 * immutability claims come from `retentionClaimFor()` — 'fixture-tested' or
 * 'live-qualified' only with a qualified evaluation, 'unsupported' when the
 * probe affirmatively found no Object Lock, otherwise 'unknown'. A successful
 * upload is never immutable proof: `publish()` returns
 * `immutableProof: false` unconditionally (mutation check: mark upload
 * success as immutable proof).
 *
 * The injected client interface (all async):
 *   putObject({ bucket, key, body, checksumSha256 })
 *   getObject({ bucket, key }) -> { body }
 *   headObject({ bucket, key }) -> { contentLength } (throws code 'NotFound')
 *   listObjects({ bucket, prefix }) -> { keys }
 *   getObjectLockConfiguration({ bucket }) -> { objectLockEnabled, rule }
 *   getObjectRetention({ bucket, key }) -> { mode, retainUntilDate }
 *   getBucketEncryption({ bucket }) -> { algorithm }
 *   deleteObject({ bucket, key })          (harness only)
 *   putObjectRetention({ bucket, key, ... }) (harness only)
 *
 * No credentials live here: the client is constructed by the caller and the
 * adapter records only a credential-boundary reference string.
 */
import { sha256Hex } from '../export/manifest.mjs';
import { assertNoEmbeddedCredential, assertStorageAdapter, defineStorageCapabilities } from './adapter.mjs';
import { assertObjectName } from './local.mjs';
import { retentionClaimFor } from './qualification.mjs';

export const S3_PROVIDER = 's3-compatible';

export const UPLOAD_NOT_IMMUTABLE_NOTE =
  'A successful upload is not proof of immutability: only a qualified deletion-test '
  + 'harness run bound to provider/bucket/mode/retention/credential boundary qualifies '
  + 'a target as retention-locked.';

const HEX64 = /^[0-9a-f]{64}$/;

function assertBucket(bucket) {
  if (typeof bucket !== 'string' || bucket.length === 0) {
    throw new TypeError('an S3-compatible adapter requires a bucket name');
  }
  return assertNoEmbeddedCredential(bucket, 'bucket');
}

/**
 * Observes what this provider/bucket actually supports. Object Lock support
 * comes ONLY from the client's answer — never from the provider name, the
 * endpoint URL or vendor marketing (Global Constraint #8). An endpoint that
 * does not answer (or answers without Object Lock) is reported
 * `supported: false` with the observed reason.
 */
export async function probeS3Capabilities(client, { bucket } = {}) {
  assertBucket(bucket);
  let objectLock;
  try {
    const config = await client.getObjectLockConfiguration({ bucket });
    if (config?.objectLockEnabled === 'Enabled') {
      const retention = config.rule?.defaultRetention ?? {};
      objectLock = Object.freeze({
        supported: true,
        mode: typeof retention.mode === 'string' ? retention.mode : null,
        days: Number.isSafeInteger(retention.days) ? retention.days : null,
        years: Number.isSafeInteger(retention.years) ? retention.years : null,
      });
    } else {
      objectLock = Object.freeze({
        supported: false,
        reason: 'bucket does not report Object Lock enabled',
      });
    }
  } catch (error) {
    objectLock = Object.freeze({
      supported: false,
      reason: `Object Lock configuration not observable (${error?.code ?? error?.message ?? 'error'})`,
    });
  }

  let encryption;
  try {
    const config = await client.getBucketEncryption({ bucket });
    encryption = Object.freeze({
      supported: typeof config?.algorithm === 'string' && config.algorithm.length > 0,
      algorithm: typeof config?.algorithm === 'string' ? config.algorithm : null,
    });
  } catch (error) {
    encryption = Object.freeze({
      supported: false,
      reason: `bucket encryption not observable (${error?.code ?? error?.message ?? 'error'})`,
    });
  }

  return Object.freeze({ provider: S3_PROVIDER, bucket, objectLock, encryption });
}

/**
 * Creates the S3-compatible adapter for `bucket` behind the injected client.
 * `qualification` is the frozen verdict of evaluateStorageQualification and
 * `probe` the frozen probeS3Capabilities result; together — and only together
 * — they can raise the retentionLock/immutability claims above 'unknown'.
 */
export function createS3CompatibleAdapter({
  bucket,
  prefix = '',
  client,
  residency = {},
  qualification = null,
  probe = null,
} = {}) {
  assertBucket(bucket);
  if (prefix) assertObjectName(prefix);
  if (!client || typeof client !== 'object') {
    throw new TypeError('an S3-compatible adapter requires an injected client');
  }
  for (const method of ['putObject', 'getObject', 'headObject', 'listObjects', 'getObjectLockConfiguration', 'getObjectRetention', 'getBucketEncryption']) {
    if (typeof client[method] !== 'function') {
      throw new TypeError(`the injected client lacks the ${method} method`);
    }
  }

  const claim = retentionClaimFor({ evaluation: qualification, probe });
  const capabilities = defineStorageCapabilities({
    provider: S3_PROVIDER,
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

  function keyFor(name) {
    assertObjectName(name);
    return prefix ? `${prefix}/${name}` : name;
  }

  function nameFor(key) {
    return prefix ? key.slice(prefix.length + 1) : key;
  }

  async function headOrNull(key) {
    try {
      return await client.headObject({ bucket, key });
    } catch (error) {
      if (error?.code === 'NotFound' || error?.code === 'NoSuchKey') return null;
      throw error;
    }
  }

  const adapter = {
    provider: S3_PROVIDER,
    capabilities,

    /**
     * Publishes bytes under `name`, at most once, with the sha256 handed to
     * the backend for integrity. The result ALWAYS carries
     * `immutableProof: false` — upload success proves nothing about retention
     * (mutation check: mark upload success as immutable proof).
     */
    async publish(name, bytes) {
      const key = keyFor(name);
      if (await headOrNull(key)) {
        throw new Error(`storage object ${name} is already published — refusing to clobber it`);
      }
      const sha256 = sha256Hex(bytes);
      await client.putObject({ bucket, key, body: bytes, checksumSha256: sha256, contentLength: bytes.length });
      return Object.freeze({ name, key, sha256, bytes: bytes.length, immutableProof: false });
    },

    /** Reads back the exact bytes stored under `name`. */
    async read(name) {
      const result = await client.getObject({ bucket, key: keyFor(name) });
      return result.body;
    },

    /** Lists published object names (sorted), optionally under a prefix. */
    async list(namePrefix = '') {
      if (namePrefix) assertObjectName(namePrefix);
      const keyPrefix = prefix ? (namePrefix ? `${prefix}/${namePrefix}` : `${prefix}/`) : namePrefix;
      const { keys } = await client.listObjects({ bucket, prefix: keyPrefix });
      return keys
        .filter((key) => !prefix || key.startsWith(`${prefix}/`))
        .map(nameFor)
        .filter((key) => !namePrefix || key === namePrefix || key.startsWith(`${namePrefix}/`) || key.startsWith(namePrefix))
        .sort();
    },

    /** Verifies a published object against a sha256 (and optional byte count). */
    async verify(name, { sha256, bytes: expectedBytes } = {}) {
      const failures = [];
      if (typeof sha256 !== 'string' || !HEX64.test(sha256)) {
        return { ok: false, failures: [`verify requires a sha256 for ${name}`] };
      }
      let bytes;
      try {
        bytes = (await client.getObject({ bucket, key: keyFor(name) })).body;
      } catch {
        return { ok: false, failures: [`missing storage object ${name}`] };
      }
      if (sha256Hex(bytes) !== sha256) failures.push(`checksum mismatch for ${name}`);
      if (expectedBytes !== undefined && bytes.length !== expectedBytes) {
        failures.push(`length mismatch for ${name}`);
      }
      return { ok: failures.length === 0, failures };
    },

    /**
     * Reports what is OBSERVED about retention on this bucket (re-probed
     * fresh), plus the descriptor claim — which never exceeds the bound
     * qualification evidence.
     */
    async retentionStatus(name = null) {
      const fresh = await probeS3Capabilities(client, { bucket });
      let object = null;
      if (name) {
        try {
          const retention = await client.getObjectRetention({ bucket, key: keyFor(name) });
          object = Object.freeze({
            mode: typeof retention?.mode === 'string' ? retention.mode : null,
            retainUntilDate: typeof retention?.retainUntilDate === 'string' ? retention.retainUntilDate : null,
          });
        } catch (error) {
          object = Object.freeze({ error: error?.code ?? error?.message ?? 'error' });
        }
      }
      return Object.freeze({
        provider: S3_PROVIDER,
        bucket,
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
