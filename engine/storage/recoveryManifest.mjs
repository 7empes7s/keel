/**
 * Recovery manifest build + verification (roadmap task-67, WS10).
 *
 * A recovery manifest is the single document that links everything needed to
 * recover a tenant after a disaster:
 *
 * - the build revision and the schema pin (sha256 of engine/store/schema.sql)
 *   that produced the artifacts, so a restore against an incompatible
 *   build/schema is refused rather than attempted;
 * - the SQL dump checksum over the actual compressed dump bytes (the same
 *   checksum ops/keel-dump-manifest.mjs records);
 * - the included observation IDs (one per exported resource type, anchored to
 *   the source snapshot — the task-45 observation contract);
 * - a reference to the configuration export manifest (task-56) by path and
 *   sha256 — a reference, never a copy;
 * - a reference to the evidence chain checkpoint (evidence_head: seq, hash,
 *   record count) — the anchor the evidence chain is verified against;
 * - the tenant pin (tenant_ref), mandatory: a manifest without one cannot be
 *   built, and verification refuses a manifest pinned to another tenant
 *   (mutation check: omit tenant pin);
 * - residency/provider/credential-boundary metadata as reference text only —
 *   embedded credential material is rejected at construction;
 * - separately-held key recovery instructions: where the recovery key material
 *   is held and by whom. A manifest WITHOUT these instructions still verifies
 *   byte-for-byte, but recovery is reported INCOMPLETE — the artifacts alone
 *   are not enough to recover.
 *
 * Verification reads the actual artifact bytes: the dump file, the export
 * manifest file and every exported resource file (via the task-56
 * verifyManifest). A checksum mismatch anywhere is a hard failure (mutation
 * check: accept mismatched dump checksum).
 */
import { execFileSync } from 'node:child_process';
import { readFile as fsReadFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sha256Hex, verifyManifest } from '../export/manifest.mjs';
import { assertTenantRef } from '../store/tenantRef.mjs';
import { assertNoEmbeddedCredential } from './adapter.mjs';

export const RECOVERY_MANIFEST_VERSION = 1;

// Recovery-completeness gap identifiers reported by verifyRecoveryManifest.
export const INCOMPLETE_KEY_RECOVERY = 'key-recovery-instructions';
export const INCOMPLETE_EVIDENCE_CHECKPOINT = 'evidence-checkpoint-unverified';

const HEX64 = /^[0-9a-f]{64}$/;

function assertHex64(value, name) {
  if (typeof value !== 'string' || !HEX64.test(value)) {
    throw new TypeError(`${name} must be a sha256 hex digest`);
  }
  return value;
}

function assertReferenceString(value, name) {
  if (typeof value !== 'string' || value.length === 0) {
    throw new TypeError(`${name} requires a non-empty reference string`);
  }
  return assertNoEmbeddedCredential(value, name);
}

/** sha256 of the schema source of truth — the schema pin for this build. */
export async function currentSchemaPin({ readFileFn = fsReadFile } = {}) {
  return sha256Hex(await readFileFn(new URL('../store/schema.sql', import.meta.url)));
}

/**
 * The build revision of a git checkout (default: this repository), or null
 * when the path is not a repo. Mirrors tools/release/readiness.mjs.
 */
export function currentBuildRevision({ execFn, repoPath } = {}) {
  const exec = execFn ?? ((args) => execFileSync('git', args, { encoding: 'utf8' }));
  const repo = repoPath ?? fileURLToPath(new URL('../../', import.meta.url));
  try {
    return exec(['-C', repo, 'rev-parse', 'HEAD']).trim();
  } catch {
    return null;
  }
}

function freezeCheckpoint(checkpoint) {
  if (!checkpoint || typeof checkpoint !== 'object') {
    throw new TypeError('the recovery manifest requires an evidence checkpoint reference');
  }
  const headSeq = Number(checkpoint.headSeq);
  const recordCount = Number(checkpoint.recordCount);
  if (!Number.isSafeInteger(headSeq) || headSeq < 0) {
    throw new TypeError('evidence checkpoint requires a non-negative integer headSeq');
  }
  if (!Number.isSafeInteger(recordCount) || recordCount < 0) {
    throw new TypeError('evidence checkpoint requires a non-negative integer recordCount');
  }
  return Object.freeze({
    headSeq,
    headHash: assertHex64(checkpoint.headHash, 'evidence checkpoint headHash'),
    recordCount,
  });
}

/**
 * Builds the frozen recovery manifest. Every link is mandatory at build time
 * except keyRecovery: a manifest built without key recovery instructions is
 * valid, but verification will report recovery as incomplete.
 */
export function buildRecoveryManifest({
  tenantRef,
  build,
  dump,
  observationIds,
  configExport,
  evidenceCheckpoint,
  residency,
  keyRecovery = null,
  generatedAt = new Date().toISOString(),
}) {
  // The tenant pin is non-optional (mutation check: omit tenant pin).
  assertTenantRef(tenantRef);

  if (typeof build?.revision !== 'string' || build.revision.length === 0) {
    throw new TypeError('the recovery manifest requires the build revision');
  }
  assertNoEmbeddedCredential(build.revision, 'build.revision');

  if (typeof dump?.path !== 'string' || dump.path.length === 0) {
    throw new TypeError('the recovery manifest requires the dump path');
  }
  assertHex64(dump.sha256, 'dump.sha256');
  if (dump.bytes !== undefined && (!Number.isSafeInteger(dump.bytes) || dump.bytes < 0)) {
    throw new TypeError('dump.bytes must be a non-negative integer');
  }

  if (!Array.isArray(observationIds) || observationIds.length === 0) {
    throw new TypeError('the recovery manifest requires at least one observation id');
  }
  const observations = observationIds.map((id) => {
    if (typeof id !== 'string' || id.length === 0) {
      throw new TypeError('observation ids must be non-empty strings');
    }
    return id;
  });

  if (typeof configExport?.manifestPath !== 'string' || configExport.manifestPath.length === 0) {
    throw new TypeError('the recovery manifest requires the configuration export manifest path');
  }
  assertHex64(configExport.manifestSha256, 'configExport.manifestSha256');

  if (typeof residency?.provider !== 'string' || residency.provider.length === 0) {
    throw new TypeError('the recovery manifest requires residency.provider');
  }
  const residencyOut = { provider: assertNoEmbeddedCredential(residency.provider, 'residency.provider') };
  for (const field of ['region', 'boundary', 'credentialBoundary']) {
    if (residency[field] !== undefined && residency[field] !== null) {
      residencyOut[field] = assertReferenceString(residency[field], `residency.${field}`);
    }
  }

  let keyRecoveryOut = null;
  if (keyRecovery !== null && keyRecovery !== undefined) {
    keyRecoveryOut = Object.freeze({
      heldBy: assertReferenceString(keyRecovery.heldBy, 'keyRecovery.heldBy'),
      location: assertReferenceString(keyRecovery.location, 'keyRecovery.location'),
      instructions: assertReferenceString(keyRecovery.instructions, 'keyRecovery.instructions'),
    });
  }

  return Object.freeze({
    recoveryVersion: RECOVERY_MANIFEST_VERSION,
    tenantRef,
    generatedAt,
    build: Object.freeze({
      revision: build.revision,
      schemaPin: assertHex64(build.schemaPin, 'build.schemaPin'),
    }),
    dump: Object.freeze({
      path: dump.path,
      sha256: dump.sha256,
      bytes: dump.bytes ?? null,
    }),
    observationIds: Object.freeze(observations),
    configExport: Object.freeze({
      manifestPath: configExport.manifestPath,
      manifestSha256: configExport.manifestSha256,
    }),
    evidenceCheckpoint: freezeCheckpoint(evidenceCheckpoint),
    residency: Object.freeze(residencyOut),
    keyRecovery: keyRecoveryOut,
  });
}

function checkpointMatches(manifestCheckpoint, expected) {
  return expected
    && Number(expected.headSeq) === manifestCheckpoint.headSeq
    && expected.headHash === manifestCheckpoint.headHash
    && Number(expected.recordCount) === manifestCheckpoint.recordCount;
}

/**
 * Verifies a recovery manifest against the actual artifact bytes and the
 * caller's pins. Never throws on malformed input — a partial or tampered
 * manifest reads as { ok: false, failures }, not a crash.
 *
 * Options:
 * - expectedTenantRef: refuse a manifest pinned to another tenant.
 * - dumpPath: where the dump bytes are read from (defaults to the path the
 *   manifest recorded). The sha256 over those bytes must match the manifest
 *   exactly — a mismatch is a hard failure.
 * - expectedBuild: { revision, schemaPin } of the environment doing the
 *   verification. A build or schema mismatch is refused. Without it the
 *   build/schema link cannot be verified and is a failure, never a pass.
 * - configExportDir: directory of the configuration export. The export
 *   manifest file is read, checksummed against the manifest's reference and
 *   fully verified via the task-56 verifyManifest (every resource file's
 *   bytes). Every observation id the recovery manifest lists must be backed
 *   by an observation in that export (`<snapshotId>:<resourceType>`).
 * - expectedCheckpoint: the current evidence chain head. A mismatch is a hard
 *   failure; leaving it out makes recovery incomplete (the anchor is
 *   unverified), not failed.
 * - dependencies.readFile: injectable for tests.
 *
 * Returns { ok, failures, recoveryComplete, incomplete }. `ok` covers
 * structural, byte and pin verification; `recoveryComplete` additionally
 * requires no completeness gaps (key recovery instructions present, evidence
 * checkpoint verified).
 */
export async function verifyRecoveryManifest(manifest, {
  expectedTenantRef,
  dumpPath,
  expectedBuild,
  configExportDir,
  expectedCheckpoint,
  dependencies = {},
} = {}) {
  const { readFile = fsReadFile } = dependencies;
  const failures = [];
  const incomplete = [];

  if (!manifest || typeof manifest !== 'object') {
    return { ok: false, failures: ['recovery manifest is not an object'], recoveryComplete: false, incomplete: [] };
  }
  if (manifest.recoveryVersion !== RECOVERY_MANIFEST_VERSION) {
    failures.push(`unsupported recoveryVersion: ${JSON.stringify(manifest.recoveryVersion)}`);
  }

  // Tenant pin: mandatory, and it must be THIS tenant (mutation check: omit
  // tenant pin — a manifest without one is a hard failure, and a foreign
  // tenant is refused).
  if (typeof manifest.tenantRef !== 'string' || manifest.tenantRef.length === 0) {
    failures.push('recovery manifest lacks a tenant pin');
  } else if (expectedTenantRef !== undefined && manifest.tenantRef !== expectedTenantRef) {
    failures.push(`tenant pin mismatch: manifest is for ${manifest.tenantRef}, not ${expectedTenantRef}`);
  }

  // Build/schema pin: a restore against an incompatible build or schema is
  // refused. Without the verifier's own pins this link is unverifiable — a
  // failure, never a silent pass.
  if (typeof manifest.build?.revision !== 'string' || !HEX64.test(manifest.build?.schemaPin ?? '')) {
    failures.push('recovery manifest lacks a build/schema pin');
  } else if (!expectedBuild) {
    failures.push('build/schema pin unverified: the verifier supplied no expected build');
  } else {
    if (manifest.build.revision !== expectedBuild.revision) {
      failures.push(`build revision mismatch: manifest was built by ${manifest.build.revision}, verifier is ${expectedBuild.revision}`);
    }
    if (manifest.build.schemaPin !== expectedBuild.schemaPin) {
      failures.push('schema pin mismatch: the manifest was produced against a different schema');
    }
  }

  // Dump bytes: the checksum is over the actual artifact, never trusted.
  if (typeof manifest.dump?.path !== 'string' || !HEX64.test(manifest.dump?.sha256 ?? '')) {
    failures.push('recovery manifest lacks a dump checksum');
  } else {
    let dumpBytes;
    try {
      dumpBytes = await readFile(dumpPath ?? manifest.dump.path);
    } catch {
      failures.push(`dump artifact unreadable at ${dumpPath ?? manifest.dump.path}`);
    }
    if (dumpBytes) {
      // Mutation check: accept mismatched dump checksum.
      if (sha256Hex(dumpBytes) !== manifest.dump.sha256) {
        failures.push('dump checksum mismatch: the artifact bytes do not match the manifest');
      }
      if (manifest.dump.bytes !== null && manifest.dump.bytes !== undefined && dumpBytes.length !== manifest.dump.bytes) {
        failures.push('dump length mismatch: the artifact size does not match the manifest');
      }
    }
  }

  // Observation IDs: every listed id must be backed by an observation in the
  // configuration export the manifest references.
  const listedObservations = Array.isArray(manifest.observationIds) ? manifest.observationIds : [];
  if (listedObservations.length === 0) {
    failures.push('recovery manifest lists no observation ids');
  }

  // Configuration export link: checksum the referenced export manifest, then
  // run the task-56 verification over the whole export tree.
  if (typeof manifest.configExport?.manifestPath !== 'string' || !HEX64.test(manifest.configExport?.manifestSha256 ?? '')) {
    failures.push('recovery manifest lacks a configuration export manifest reference');
  } else if (!configExportDir) {
    failures.push('configuration export unverified: the verifier supplied no export directory');
  } else {
    let exportManifestBytes;
    try {
      exportManifestBytes = await readFile(join(configExportDir, 'manifest.json'));
    } catch {
      failures.push(`configuration export manifest unreadable in ${configExportDir}`);
    }
    if (exportManifestBytes) {
      if (sha256Hex(exportManifestBytes) !== manifest.configExport.manifestSha256) {
        failures.push('configuration export manifest checksum mismatch');
      }
      let exportManifest = null;
      try {
        exportManifest = JSON.parse(exportManifestBytes.toString('utf8'));
      } catch {
        failures.push('configuration export manifest is not valid JSON');
      }
      if (exportManifest) {
        const exportCheck = await verifyManifest(exportManifest, configExportDir, {
          expectedTenantRef: manifest.tenantRef,
        });
        for (const failure of exportCheck.failures) {
          failures.push(`configuration export: ${failure}`);
        }
        if (exportCheck.ok && typeof exportManifest.snapshot?.id === 'string') {
          const backed = new Set(
            Object.keys(exportManifest.types ?? {}).map((type) => `${exportManifest.snapshot.id}:${type}`),
          );
          for (const id of listedObservations) {
            if (!backed.has(id)) {
              failures.push(`observation id not backed by the configuration export: ${JSON.stringify(id)}`);
            }
          }
        }
      }
    }
  }

  // Evidence checkpoint: the manifest must reference one; when the verifier
  // knows the current head, a mismatch is a hard failure. Without a current
  // head the anchor is unverified and recovery is incomplete, not failed.
  const checkpoint = manifest.evidenceCheckpoint;
  if (
    !checkpoint
    || !Number.isSafeInteger(Number(checkpoint.headSeq))
    || !HEX64.test(checkpoint.headHash ?? '')
    || !Number.isSafeInteger(Number(checkpoint.recordCount))
  ) {
    failures.push('recovery manifest lacks an evidence checkpoint reference');
  } else if (expectedCheckpoint !== undefined) {
    if (!checkpointMatches(checkpoint, expectedCheckpoint)) {
      failures.push('evidence checkpoint mismatch: the chain head has moved or the manifest was tampered with');
    }
  } else {
    incomplete.push(INCOMPLETE_EVIDENCE_CHECKPOINT);
  }

  // Residency metadata: references only — credential material in a manifest is
  // a hard failure even if every checksum matches.
  if (typeof manifest.residency?.provider !== 'string' || manifest.residency.provider.length === 0) {
    failures.push('recovery manifest lacks residency.provider metadata');
  } else {
    for (const [field, value] of Object.entries(manifest.residency)) {
      try {
        assertNoEmbeddedCredential(value, `residency.${field}`);
      } catch (error) {
        failures.push(error.message);
      }
    }
  }

  // Key recovery instructions: their absence is not a byte-level failure — the
  // artifacts still verify — but recovery without them is INCOMPLETE.
  const keyRecovery = manifest.keyRecovery;
  if (
    !keyRecovery
    || typeof keyRecovery.instructions !== 'string' || keyRecovery.instructions.length === 0
    || typeof keyRecovery.heldBy !== 'string' || keyRecovery.heldBy.length === 0
    || typeof keyRecovery.location !== 'string' || keyRecovery.location.length === 0
  ) {
    incomplete.push(INCOMPLETE_KEY_RECOVERY);
  }

  const ok = failures.length === 0;
  return { ok, failures, recoveryComplete: ok && incomplete.length === 0, incomplete };
}
