#!/usr/bin/env node
/**
 * Retention-lock deletion-test harness (roadmap task-69, WS10).
 *
 *   node tools/qualification/storageLock.mjs qualify --bucket NAME \
 *     --tenant-ref sha256:... --out FILE --region R --boundary B \
 *     --credential-boundary REF --credential-class retention-scoped \
 *     --key-held-by WHO --key-location WHERE --key-instructions TEXT \
 *     --fixture [fixture scenario flags]
 *
 * The harness proves — behaviorally, against a canary artifact — whether a
 * storage target is retention-locked:
 *
 * 1. probe: Object Lock and bucket encryption are OBSERVED, never inferred
 *    from S3 compatibility (mutation check: infer Object Lock from S3
 *    compatibility);
 * 2. publish: a uniquely named canary object is written with its sha256 —
 *    upload success alone proves nothing (mutation check: mark upload success
 *    as immutable proof);
 * 3. readback: the canary is re-read (bounded retries for transport errors);
 *    every returned byte sequence is checksum-verified and a corrupt read is
 *    disqualifying (acceptance: retries verify object checksum);
 * 4. deletion test: deleting the canary must be REFUSED;
 * 5. bypass test: the same credential must FAIL to shorten/alter retention —
 *    a credential that can alter retention is indistinguishable from an
 *    account admin and disqualifies the target (acceptance: credential
 *    confusion);
 * 6. retention status: the observed mode must be COMPLIANCE with a retention
 *    date (mutation check: skip retention-mode check);
 * 7. cleanup: a final delete attempt is recorded honestly — under a working
 *    compliance lock the canary remains, and that is reported, not hidden.
 *
 * Builder authorization (Global Constraint #2): this CLI only ever runs the
 * in-process fixture client (`--fixture`). Live qualification against a real
 * provider is run by the orchestrating session with externally provisioned
 * credentials — without `--fixture` and without an injected client factory
 * the CLI refuses. Fixture evidence is synthetic and reaches at most
 * 'fixture-tested'; it can never support a 'live-qualified' claim.
 */
import { randomUUID } from 'node:crypto';
import { mkdir, rename as fsRename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { pathToFileURL } from 'node:url';
import { sha256Hex } from '../../engine/export/manifest.mjs';
import { createS3CompatibleAdapter, probeS3Capabilities, S3_PROVIDER } from '../../engine/storage/s3Compatible.mjs';
import {
  CREDENTIAL_CLASSES,
  evaluateStorageQualification,
  STORAGE_QUALIFICATION_VERSION,
} from '../../engine/storage/qualification.mjs';
import { assertNoEmbeddedCredential } from '../../engine/storage/adapter.mjs';
import { assertTenantRef } from '../../engine/store/tenantRef.mjs';

export const HARNESS_VERSION = 1;

// Error codes that count as a refusal for the deletion/bypass tests.
export const RETENTION_REFUSAL_CODES = Object.freeze([
  'AccessDenied',
  'ObjectLocked',
  'RetentionPolicyNotMet',
  'InvalidRequest',
  'MethodNotAllowed',
]);

/**
 * In-memory fake S3-compatible client — the fixture this harness is
 * authorized to run. `fixture: true` marks every observation synthetic.
 *
 * Options model provider/credential behavior:
 * - objectLock: whether the bucket reports Object Lock enabled;
 * - mode: 'COMPLIANCE' | 'GOVERNANCE' default retention mode;
 * - retentionDays: default retention period;
 * - encryption: bucket encryption algorithm, or null when none is configured;
 * - credentialCanAlterRetention: whether the credential behind the client can
 *   shorten/alter retention (an account-admin-class credential);
 * - corruptReadOnAttempt / readErrorAttempts: per-object read attempt number
 *   that returns corrupted bytes / the count of initial reads that fail with
 *   a transport error before succeeding.
 */
export function createFakeS3Client({
  objectLock = false,
  mode = 'COMPLIANCE',
  retentionDays = 30,
  encryption = 'AES256',
  credentialCanAlterRetention = false,
  corruptReadOnAttempt = null,
  readErrorAttempts = 0,
} = {}) {
  const objects = new Map();
  const reads = new Map();
  const retainUntilDate = new Date(Date.now() + retentionDays * 24 * 60 * 60 * 1000).toISOString();

  function failure(message, code) {
    const error = new Error(message);
    error.code = code;
    return error;
  }

  return {
    fixture: true,

    async putObject({ key, body, checksumSha256 }) {
      if (checksumSha256 && sha256Hex(body) !== checksumSha256) {
        throw failure('the supplied checksum does not match the received bytes', 'BadDigest');
      }
      objects.set(key, Buffer.from(body));
      return { etag: sha256Hex(body) };
    },

    async getObject({ key }) {
      if (!objects.has(key)) throw failure('the specified key does not exist', 'NotFound');
      const attempt = (reads.get(key) ?? 0) + 1;
      reads.set(key, attempt);
      if (attempt <= readErrorAttempts) throw failure('reduce your request rate', 'SlowDown');
      let body = Buffer.from(objects.get(key));
      if (attempt === corruptReadOnAttempt) body = Buffer.concat([body, Buffer.from('corruption')]);
      return { body };
    },

    async headObject({ key }) {
      if (!objects.has(key)) throw failure('the specified key does not exist', 'NotFound');
      return { contentLength: objects.get(key).length };
    },

    async listObjects({ prefix: keyPrefix = '' }) {
      return { keys: [...objects.keys()].filter((key) => key.startsWith(keyPrefix)).sort() };
    },

    async getObjectLockConfiguration() {
      if (!objectLock) {
        throw failure('Object Lock configuration does not exist for this bucket', 'ObjectLockConfigurationNotFoundError');
      }
      return { objectLockEnabled: 'Enabled', rule: { defaultRetention: { mode, days: retentionDays } } };
    },

    async getObjectRetention({ key }) {
      if (!objectLock) {
        throw failure('Object Lock configuration does not exist for this bucket', 'ObjectLockConfigurationNotFoundError');
      }
      if (!objects.has(key)) throw failure('the specified key does not exist', 'NotFound');
      return { mode, retainUntilDate };
    },

    async getBucketEncryption() {
      if (!encryption) {
        throw failure('the bucket has no server-side encryption configuration', 'ServerSideEncryptionConfigurationNotFoundError');
      }
      return { algorithm: encryption };
    },

    async putObjectRetention() {
      // A credential that can alter retention is exactly the account-admin
      // confusion this harness exists to detect — even when the backend
      // claims COMPLIANCE mode, the observed behavior decides.
      if (!objectLock || !credentialCanAlterRetention) {
        throw failure('Access Denied — retention cannot be altered', 'AccessDenied');
      }
      return {};
    },

    async deleteObject({ key }) {
      if (objectLock && !(mode === 'GOVERNANCE' && credentialCanAlterRetention)) {
        throw failure('Access Denied — the object is under a retention lock', 'AccessDenied');
      }
      objects.delete(key);
      return {};
    },
  };
}

/**
 * Runs the deletion-test qualification against `client` and evaluates the
 * verdict. Returns a frozen { probe, harness, evaluation }. The harness
 * record is the canary-artifact evidence the evaluation binds to
 * provider/bucket/mode/retention/credential boundary.
 */
export async function runStorageLockQualification({
  client,
  bucket,
  prefix = 'qualification',
  tenantRef,
  credentialClass = 'unknown',
  residency = {},
  keyRecovery = null,
  expectedBinding = null,
  canaryBytes = Buffer.from(`keel retention-lock canary ${randomUUID()}`),
  maxReadAttempts = 3,
  sleep = async () => {},
  now = () => new Date(),
} = {}) {
  assertTenantRef(tenantRef);
  if (!CREDENTIAL_CLASSES.includes(credentialClass)) {
    throw new TypeError(`credentialClass must be one of ${CREDENTIAL_CLASSES.join(', ')}`);
  }

  const probe = await probeS3Capabilities(client, { bucket });

  let publish = { ok: false, skipped: 'Object Lock not observed — nothing was published' };
  let readback = { ok: false, checksumVerified: false, attempts: [] };
  let deletionTest = { refused: false, skipped: 'Object Lock not observed — no canary to delete' };
  let bypassTest = { credentialCouldAlterRetention: true, skipped: 'Object Lock not observed — bypass not testable' };
  let retentionStatus = null;
  let cleanup = null;
  let canaryKey = null;

  if (probe.objectLock.supported === true) {
    const adapter = createS3CompatibleAdapter({ bucket, prefix, client, residency, probe });
    const canaryName = `canary-${randomUUID()}.bin`;
    const canarySha256 = sha256Hex(canaryBytes);

    const published = await adapter.publish(canaryName, canaryBytes);
    canaryKey = published.key;
    publish = {
      ok: true,
      sha256: published.sha256,
      bytes: published.bytes,
      immutableProof: published.immutableProof,
    };

    // Readback with bounded retries. Every attempt that returns bytes is
    // checksum-verified; a transport error may be retried, but a checksum
    // mismatch is corruption — disqualifying, and no retry repairs trust.
    const attempts = [];
    let verified = false;
    let corrupt = false;
    for (let attempt = 1; attempt <= maxReadAttempts && !verified && !corrupt; attempt += 1) {
      try {
        const bytes = await adapter.read(canaryName);
        if (sha256Hex(bytes) === canarySha256) {
          attempts.push(Object.freeze({ attempt, outcome: 'checksum-verified' }));
          verified = true;
        } else {
          attempts.push(Object.freeze({ attempt, outcome: 'checksum-mismatch' }));
          corrupt = true;
        }
      } catch (error) {
        attempts.push(Object.freeze({ attempt, outcome: `error: ${error?.code ?? error?.message ?? 'error'}` }));
        await sleep();
      }
    }
    readback = { ok: verified && !corrupt, checksumVerified: verified && !corrupt, attempts };

    // Observed retention on the canary object.
    try {
      const retention = await client.getObjectRetention({ bucket, key: canaryKey });
      retentionStatus = {
        mode: typeof retention?.mode === 'string' ? retention.mode : null,
        retainUntilDate: typeof retention?.retainUntilDate === 'string' ? retention.retainUntilDate : null,
      };
    } catch (error) {
      retentionStatus = { mode: null, retainUntilDate: null, error: error?.code ?? 'error' };
    }

    // Deletion test: removing the canary must be refused.
    try {
      await client.deleteObject({ bucket, key: canaryKey });
      deletionTest = { refused: false, outcome: 'the canary was deleted — no retention lock is in effect' };
    } catch (error) {
      deletionTest = {
        refused: RETENTION_REFUSAL_CODES.includes(error?.code),
        code: error?.code ?? null,
      };
    }

    // Bypass test: the same credential must fail to shorten/alter retention.
    try {
      await client.putObjectRetention({
        bucket,
        key: canaryKey,
        mode: 'GOVERNANCE',
        retainUntilDate: new Date(0).toISOString(),
        bypassGovernance: true,
      });
      bypassTest = { credentialCouldAlterRetention: true };
    } catch (error) {
      bypassTest = { credentialCouldAlterRetention: false, code: error?.code ?? null };
    }

    // Cleanup, recorded honestly: under a working compliance lock the canary
    // remains until its retention expires, and that is reported, not hidden.
    try {
      await client.deleteObject({ bucket, key: canaryKey });
      cleanup = { removed: true };
    } catch (error) {
      cleanup = { removed: false, code: error?.code ?? null, note: 'canary remains until its retention period expires' };
    }
  }

  const harness = Object.freeze({
    version: HARNESS_VERSION,
    // Only an externally marked non-fixture client yields non-synthetic
    // evidence; builder fixtures are always synthetic.
    synthetic: client.fixture !== false,
    provider: S3_PROVIDER,
    bucket,
    credentialClass,
    canary: Object.freeze({
      name: canaryKey,
      sha256: sha256Hex(canaryBytes),
      bytes: canaryBytes.length,
    }),
    publish,
    readback,
    deletionTest,
    bypassTest,
    retentionStatus,
    cleanup,
    observedAt: now().toISOString(),
  });

  const evaluation = evaluateStorageQualification({
    tenantRef,
    probe,
    harness,
    residency,
    keyRecovery,
    expectedBinding,
  });

  return Object.freeze({ probe, harness, evaluation });
}

const USAGE = `usage: storageLock.mjs qualify --bucket NAME --tenant-ref sha256:... --out FILE
  --region R --boundary B --credential-boundary REF --credential-class CLASS
  --key-held-by WHO --key-location WHERE --key-instructions TEXT
  [--fixture] [--fixture-no-object-lock] [--fixture-mode GOVERNANCE]
  [--fixture-no-encryption] [--fixture-credential-can-alter-retention]
  [--fixture-corrupt-read N] [--fixture-read-errors N] [--retention-days N]

Without --fixture this CLI refuses to run: live qualification against a real
provider is executed by the orchestrating session with externally provisioned
credentials, never by the builder.`;

function flagValue(argv, name) {
  const index = argv.indexOf(`--${name}`);
  return index > -1 ? argv[index + 1] : null;
}

function hasFlag(argv, name) {
  return argv.includes(`--${name}`);
}

/** Injectable CLI entrypoint (mirrors ops/keel-dump-manifest.mjs). */
export async function runCli({ argv = process.argv, logger = console, dependencies = {} } = {}) {
  const { clientFactory = null, writeFileFn = writeFile, renameFn = fsRename, mkdirFn = mkdir } = dependencies;

  if (hasFlag(argv, 'help')) {
    logger.log(USAGE);
    return 0;
  }
  if (argv[2] !== 'qualify') {
    logger.error(USAGE);
    return 2;
  }

  const required = [
    'bucket', 'tenant-ref', 'out', 'region', 'boundary', 'credential-boundary',
    'credential-class', 'key-held-by', 'key-location', 'key-instructions',
  ];
  const missing = required.filter((name) => !flagValue(argv, name));
  if (missing.length > 0) {
    for (const name of missing) logger.error(`missing --${name}`);
    return 1;
  }

  let tenantRef;
  try {
    tenantRef = assertTenantRef(flagValue(argv, 'tenant-ref'));
  } catch (error) {
    logger.error(error.message);
    return 1;
  }

  const residency = {
    region: flagValue(argv, 'region'),
    boundary: flagValue(argv, 'boundary'),
    credentialBoundary: flagValue(argv, 'credential-boundary'),
  };
  const keyRecovery = {
    heldBy: flagValue(argv, 'key-held-by'),
    location: flagValue(argv, 'key-location'),
    instructions: flagValue(argv, 'key-instructions'),
  };
  // References only: refuse credential-shaped values before anything runs or
  // is written (Global Constraint #7).
  try {
    for (const [field, value] of [...Object.entries(residency), ...Object.entries(keyRecovery)]) {
      assertNoEmbeddedCredential(value, field);
    }
  } catch (error) {
    logger.error(error.message);
    return 1;
  }

  const credentialClass = flagValue(argv, 'credential-class');
  if (!CREDENTIAL_CLASSES.includes(credentialClass)) {
    logger.error(`--credential-class must be one of ${CREDENTIAL_CLASSES.join(', ')}`);
    return 1;
  }

  let client;
  if (clientFactory) {
    client = await clientFactory({ argv });
  } else if (hasFlag(argv, 'fixture')) {
    client = createFakeS3Client({
      objectLock: !hasFlag(argv, 'fixture-no-object-lock'),
      mode: flagValue(argv, 'fixture-mode') ?? 'COMPLIANCE',
      retentionDays: Number(flagValue(argv, 'retention-days') ?? 30),
      encryption: hasFlag(argv, 'fixture-no-encryption') ? null : 'AES256',
      credentialCanAlterRetention: hasFlag(argv, 'fixture-credential-can-alter-retention'),
      corruptReadOnAttempt: flagValue(argv, 'fixture-corrupt-read') ? Number(flagValue(argv, 'fixture-corrupt-read')) : null,
      readErrorAttempts: Number(flagValue(argv, 'fixture-read-errors') ?? 0),
    });
  } else {
    logger.error('no storage client configured — live qualification against a real provider is run by the orchestrating session with externally provisioned credentials, never by the builder CLI');
    return 1;
  }

  const bucket = flagValue(argv, 'bucket');
  let result;
  try {
    result = await runStorageLockQualification({
      client,
      bucket,
      tenantRef,
      credentialClass,
      residency,
      keyRecovery,
    });
  } catch (error) {
    logger.error(`qualification harness failed: ${error.message}`);
    return 1;
  }

  // The evidence record carries verdicts and references only — never
  // credential material.
  const record = {
    version: STORAGE_QUALIFICATION_VERSION,
    generatedAt: new Date().toISOString(),
    tenantRef,
    residency,
    keyRecovery,
    probe: result.probe,
    harness: result.harness,
    evaluation: result.evaluation,
  };
  const out = flagValue(argv, 'out');
  const temporary = `${out}.${randomUUID()}.tmp`;
  await mkdirFn(dirname(out), { recursive: true });
  await writeFileFn(temporary, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
  await renameFn(temporary, out);

  if (result.evaluation.qualified) {
    logger.log(`storage lock qualification: qualified (${result.evaluation.evidenceLevel}${result.evaluation.synthetic ? ', synthetic fixture' : ''})`);
  } else {
    logger.log('storage lock qualification: NOT qualified');
    for (const failure of result.evaluation.failures) logger.error(`  - ${failure}`);
  }
  return result.evaluation.qualified ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runCli().then((exit) => process.exit(exit), (error) => {
    console.error(error);
    process.exit(1);
  });
}
