/**
 * Immutable-storage qualification binding (roadmap task-69, WS10).
 *
 * A storage target only qualifies as retention-locked when every element of
 * the boundary is proven together, never in isolation:
 *
 * - the capability probe OBSERVED Object Lock on this provider/bucket — S3
 *   compatibility alone never establishes Object Lock (mutation check: infer
 *   Object Lock from S3 compatibility);
 * - the deletion-test harness ran against a canary artifact and deletion was
 *   REFUSED — a successful upload is not proof of immutability (mutation
 *   check: mark upload success as immutable proof);
 * - the observed retention mode is COMPLIANCE — GOVERNANCE mode is overridable
 *   by any principal with bypass privilege and never qualifies (mutation
 *   check: skip retention-mode check);
 * - every readback attempt verified the canary checksum;
 * - the qualification credential is retention-scoped AND was observed unable
 *   to alter retention — an account-admin credential can never prove a lock,
 *   even if a delete happened to be refused, and the two classes cannot be
 *   confused (acceptance: credential confusion);
 * - server-side encryption, residency metadata and independently-held key
 *   recovery material references are all present — references only, embedded
 *   credential material is refused (Global Constraint #7);
 * - the whole verdict is pinned to a tenant_ref (Global Constraint #4).
 *
 * Missing external qualification remains not-qualified: builder fixtures are
 * synthetic and can only ever reach evidenceLevel 'fixture-tested', which
 * proves code behavior, not provider behavior (Global Constraint #6).
 */
import { assertNoEmbeddedCredential } from './adapter.mjs';
import { assertTenantRef } from '../store/tenantRef.mjs';

export const STORAGE_QUALIFICATION_VERSION = 1;

// The only retention mode that constitutes a compliance-grade lock: under
// COMPLIANCE mode not even an account administrator can shorten or remove the
// retention. GOVERNANCE mode is bypassable and never qualifies.
export const QUALIFYING_RETENTION_MODE = 'COMPLIANCE';
export const RETENTION_MODES = Object.freeze(['GOVERNANCE', 'COMPLIANCE']);

// Credential classes for the qualification boundary. Only 'retention-scoped'
// (a credential that holds no retention-administration privilege) can qualify
// a target; 'account-admin' and 'unknown' are disqualifying regardless of
// what the deletion test observed.
export const CREDENTIAL_CLASSES = Object.freeze(['retention-scoped', 'account-admin', 'unknown']);

export const QUALIFICATION_EVIDENCE_LEVELS = Object.freeze(['fixture-tested', 'live-qualified']);

const HEX64 = /^[0-9a-f]{64}$/;

function checkReference(value, name, failures) {
  if (typeof value !== 'string' || value.length === 0) {
    failures.push(`${name} is required — qualification binds to explicit references, not assumptions`);
    return null;
  }
  try {
    return assertNoEmbeddedCredential(value, name);
  } catch (error) {
    failures.push(error.message);
    return null;
  }
}

/**
 * Evaluates whether a storage target qualifies as retention-locked immutable
 * storage. Never throws on malformed input — every defect reads as a named
 * failure. Returns a frozen verdict:
 *
 *   { version, qualified, evidenceLevel, synthetic, failures, binding }
 *
 * `binding` (present only when qualified) pins the verdict to provider,
 * bucket, retention mode/period, credential boundary and the canary artifact
 * evidence (name + sha256) — qualification never generalizes beyond exactly
 * what was observed.
 */
export function evaluateStorageQualification({
  tenantRef,
  probe = null,
  harness = null,
  residency = {},
  keyRecovery = null,
  expectedBinding = null,
} = {}) {
  const failures = [];

  // Tenant pin (Global Constraint #4): qualification is tenant-specific.
  try {
    assertTenantRef(tenantRef);
  } catch (error) {
    failures.push(error.message);
  }

  // Residency and credential-boundary references.
  const residencyOut = {};
  for (const field of ['region', 'boundary', 'credentialBoundary']) {
    residencyOut[field] = checkReference(residency?.[field], `residency.${field}`, failures);
  }

  // Independent recovery material: references to separately-held key recovery
  // instructions. The artifacts alone are never the whole recovery story.
  const keyRecoveryOut = {};
  for (const field of ['heldBy', 'location', 'instructions']) {
    keyRecoveryOut[field] = checkReference(keyRecovery?.[field], `keyRecovery.${field}`, failures);
  }

  // Capability probe: Object Lock must have been OBSERVED. S3 compatibility
  // is an API dialect, not a retention guarantee (mutation check).
  if (!probe || typeof probe !== 'object') {
    failures.push('capability probe is missing — S3 compatibility alone does not establish Object Lock');
  } else if (probe.objectLock?.supported !== true) {
    const reason = probe.objectLock?.reason ?? 'no observation';
    failures.push(`Object Lock was not observed on this provider/bucket (${reason}) — S3 compatibility alone does not establish Object Lock`);
  }

  // Encryption at rest must be observed on the bucket.
  if (probe?.encryption?.supported !== true || typeof probe.encryption?.algorithm !== 'string') {
    failures.push('server-side encryption was not observed on this bucket');
  }

  // Deletion-test harness evidence. Without it there is no behavioral proof:
  // a successful upload says nothing about immutability (mutation check).
  if (!harness || typeof harness !== 'object') {
    failures.push('deletion-test harness evidence is missing — a successful upload is not proof of immutability');
  } else {
    if (harness.publish?.ok !== true) {
      failures.push('canary publish did not succeed — no artifact was ever at risk');
    }
    if (!HEX64.test(harness.canary?.sha256 ?? '')) {
      failures.push('canary evidence lacks a sha256 checksum');
    }
    // Every readback attempt must have verified the checksum; one corrupt
    // read means the read path cannot be trusted (acceptance: retries verify
    // object checksum).
    if (harness.readback?.checksumVerified !== true) {
      failures.push('canary readback bytes were not checksum-verified on every attempt');
    }
    if (harness.deletionTest?.refused !== true) {
      failures.push('canary deletion was not refused — no retention lock is in effect');
    }
    // Retention mode: only COMPLIANCE qualifies (mutation check: skip
    // retention-mode check — a GOVERNANCE lock can be bypassed).
    const mode = harness.retentionStatus?.mode ?? null;
    if (mode !== QUALIFYING_RETENTION_MODE) {
      failures.push(`retention mode is ${JSON.stringify(mode)}, not ${QUALIFYING_RETENTION_MODE} — only ${QUALIFYING_RETENTION_MODE} mode prevents administrative removal`);
    }
    if (
      typeof harness.retentionStatus?.retainUntilDate !== 'string'
      || harness.retentionStatus.retainUntilDate.length === 0
    ) {
      failures.push('no retention period was observed for the canary object');
    }
    // The credential boundary: the class must be retention-scoped AND the
    // harness must have observed the credential failing to alter retention.
    // A declared class that the behavior contradicts, or an account-admin
    // credential, never qualifies (acceptance: credential confusion).
    if (harness.credentialClass !== 'retention-scoped') {
      failures.push(`credential class ${JSON.stringify(harness.credentialClass ?? null)} is not 'retention-scoped' — an account-admin or unknown credential can never prove a retention lock`);
    }
    if (harness.bypassTest?.credentialCouldAlterRetention !== false) {
      failures.push('the qualification credential was able to alter retention — a compliance lock is not proven');
    }
  }

  // Optional caller binding: when the caller pins provider/bucket/mode/
  // credentialBoundary, the harness evidence must match exactly.
  if (expectedBinding && harness && typeof harness === 'object') {
    const actual = {
      provider: harness.provider ?? probe?.provider ?? null,
      bucket: harness.bucket ?? null,
      mode: harness.retentionStatus?.mode ?? null,
      credentialBoundary: residencyOut.credentialBoundary,
    };
    for (const field of ['provider', 'bucket', 'mode', 'credentialBoundary']) {
      if (expectedBinding[field] !== undefined && expectedBinding[field] !== actual[field]) {
        failures.push(`binding mismatch: expected ${field} ${JSON.stringify(expectedBinding[field])}, harness ran against ${JSON.stringify(actual[field])}`);
      }
    }
  }

  const qualified = failures.length === 0;
  // Builder fixtures are always synthetic and can only reach fixture-tested;
  // live-qualified requires a non-synthetic external runner.
  const synthetic = harness?.synthetic !== false;
  const evidenceLevel = qualified ? (synthetic ? 'fixture-tested' : 'live-qualified') : null;

  const binding = qualified
    ? Object.freeze({
      provider: harness.provider ?? probe.provider,
      bucket: harness.bucket ?? null,
      mode: harness.retentionStatus.mode,
      retainUntilDate: harness.retentionStatus.retainUntilDate,
      defaultRetentionDays: probe.objectLock?.days ?? null,
      credentialBoundary: residencyOut.credentialBoundary,
      canary: Object.freeze({
        name: harness.canary.name,
        sha256: harness.canary.sha256,
      }),
    })
    : null;

  return Object.freeze({
    version: STORAGE_QUALIFICATION_VERSION,
    qualified,
    evidenceLevel,
    synthetic,
    failures: Object.freeze(failures),
    binding,
  });
}

/**
 * Maps probe/qualification evidence to the strongest honest capability claim
 * for retentionLock/immutability. Without a qualified evaluation the claim is
 * never stronger than 'unknown' ('unsupported' when the probe affirmatively
 * observed no Object Lock) — missing external qualification prevents
 * immutable claims.
 */
export function retentionClaimFor({ evaluation = null, probe = null } = {}) {
  if (evaluation?.qualified === true && QUALIFICATION_EVIDENCE_LEVELS.includes(evaluation.evidenceLevel)) {
    return evaluation.evidenceLevel;
  }
  if (probe?.objectLock && probe.objectLock.supported === false) return 'unsupported';
  return 'unknown';
}
