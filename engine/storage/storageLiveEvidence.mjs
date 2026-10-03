/**
 * Roadmap task-114: the evidence contract for independent storage recovery
 * qualification (gate `storage-live-acceptance`).
 *
 * Operator decision (2026-09-30, "local copy, honest ceiling"): backups go to
 * a local copy on a separate volume. The local-disk adapter keeps
 * retentionLock and immutability unsupported, so this gate qualifies only what
 * a local copy can prove:
 *
 *  - independent recovery read: an independently authenticated recovery
 *    identity (task-68), separate from the account that writes backups and
 *    unable to write to the copy, read every recovery artifact back from the
 *    copy and its bytes matched;
 *  - manifest verification: the task-67/68 recovery manifest, read from the
 *    copy, verified against the copied artifact bytes with recovery complete
 *    (no missing credential prerequisite, key instructions present, evidence
 *    checkpoint verified).
 *
 * Storage immutability, retention lock and the lock deletion canary are
 * reported UNQUALIFIED in every record — never claimed, never omitted. A
 * record that claims any of them, or names any provider other than the local
 * disk, is refused: a lock-capable provider is outside the decided scope and
 * stays refused here until a later task qualifies one through task-69.
 *
 * The capture tool never deletes anything: it reads, stats and lists. The
 * copy's object listing before and after the run is recorded and must be
 * identical (ordinary backups are never deleted).
 *
 * This module never touches storage. The capture tool
 * (tools/qualification/storageLiveAcceptance.mjs) produces records; this
 * checks them.
 */
import { RECOVERY_PREREQUISITES } from '../authz/recoveryMode.mjs';
import { LOCAL_PROVIDER, localStorageCapabilities } from './local.mjs';
import { STORAGE_QUALIFICATION_VERSION } from './qualification.mjs';
import { RECOVERY_MANIFEST_VERSION } from './recoveryManifest.mjs';

export const STORAGE_LIVE_GATE = 'storage-live-acceptance';
export const STORAGE_LIVE_OPERATION = 'storage.local-copy-recovery';
export const STORAGE_LIVE_CREDENTIAL_MODE = 'recovery-reader';
/** A backup copy older than this at capture time does not prove current recovery. */
export const STORAGE_LIVE_BACKUP_MAX_AGE_DAYS = 7;

/** Exactly what a local copy can prove; nothing else may be claimed. */
export const STORAGE_LIVE_QUALIFIED_CLAIMS = Object.freeze(['independent-recovery-read', 'manifest-verification']);
/** Reported UNQUALIFIED in every record, with the reason. */
export const STORAGE_LIVE_UNQUALIFIED_CLAIMS = Object.freeze(['retentionLock', 'immutability', 'lockCanary']);
export const UNQUALIFIED = 'UNQUALIFIED';

const DAY_MS = 24 * 60 * 60 * 1000;
const HEX64 = /^[0-9a-f]{64}$/;
const SECRET_KEY = /secret|password|private.?key|token|assertion|credential.?value/i;
const SECRET_VALUE = /-----BEGIN [A-Z ]*PRIVATE KEY-----|^eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\./;

/** The task-68 / task-69 prerequisites as the production code defines them today. */
export function storageLivePrerequisite() {
  const local = localStorageCapabilities();
  return {
    'task-68': { recoveryManifestVersion: RECOVERY_MANIFEST_VERSION, recoveryPrerequisites: [...RECOVERY_PREREQUISITES] },
    'task-69': {
      storageQualificationVersion: STORAGE_QUALIFICATION_VERSION,
      provider: LOCAL_PROVIDER,
      retentionLock: local.retentionLock,
      immutability: local.immutability,
    },
  };
}

/** The UNQUALIFIED block every record carries; reasons are fixed here, not by the runner. */
export function storageLiveUnqualified() {
  return {
    retentionLock: { status: UNQUALIFIED, reason: 'local-disk adapter: retentionLock unsupported (operator decision 2026-09-30)' },
    immutability: { status: UNQUALIFIED, reason: 'local-disk adapter: immutability unsupported; filesystem permissions are revocable' },
    lockCanary: { status: UNQUALIFIED, reason: 'not run: a local copy has no lock, so a deletion canary could only delete' },
  };
}

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function scanForCredentialMaterial(value, path, failures) {
  if (Array.isArray(value)) {
    value.forEach((item, i) => scanForCredentialMaterial(item, `${path}[${i}]`, failures));
  } else if (value && typeof value === 'object') {
    for (const [key, item] of Object.entries(value)) {
      if (SECRET_KEY.test(key)) failures.push(`credential material refused at ${path}.${key}`);
      scanForCredentialMaterial(item, `${path}.${key}`, failures);
    }
  } else if (typeof value === 'string' && SECRET_VALUE.test(value)) {
    failures.push(`credential material refused at ${path}`);
  }
}

function time(value) {
  const parsed = Date.parse(value ?? '');
  return Number.isNaN(parsed) ? null : parsed;
}

function parseCapture(artifactBytes, artifactReason) {
  if (!artifactBytes) {
    return { capture: null, failure: `raw capture artifact is missing — external evidence is required (${artifactReason ?? 'not supplied'})` };
  }
  try {
    return { capture: JSON.parse(artifactBytes.toString('utf8')), failure: null };
  } catch {
    return { capture: null, failure: 'raw capture artifact is not valid JSON' };
  }
}

function validatePrerequisite(recorded, failures) {
  const expected = storageLivePrerequisite();
  for (const task of Object.keys(expected)) {
    if (!recorded?.[task]) failures.push(`missing prerequisite: ${task}`);
    else if (canonical(recorded[task]) !== canonical(expected[task])) failures.push(`prerequisite ${task} differs from the production code`);
  }
}

function validateStorage(storage, failures) {
  if (!storage || typeof storage !== 'object') {
    failures.push('storage target is not recorded');
    return;
  }
  if (storage.provider !== LOCAL_PROVIDER) {
    failures.push(`provider '${storage.provider ?? 'missing'}' is refused: this gate qualifies only the local-disk copy (operator decision)`);
  }
  if (storage.retentionLock !== 'unsupported' || storage.immutability !== 'unsupported') {
    failures.push('the local copy must record retentionLock and immutability as unsupported');
  }
  const volumes = storage.volumes;
  if (!volumes || volumes.primary?.device === undefined || volumes.copy?.device === undefined) {
    failures.push('volume identity of the primary backup and the copy is not recorded');
  } else if (String(volumes.primary.device) === String(volumes.copy.device)) {
    failures.push('the copy is on the same volume as the primary backup — not an independent copy');
  }
  if (typeof storage.copyRootRef !== 'string' || !storage.copyRootRef) failures.push('copy root reference missing');
}

function validateIdentity(identity, failures) {
  if (!identity || typeof identity !== 'object') {
    failures.push('recovery identity is not recorded');
    return;
  }
  if (identity.anonymous === true || typeof identity.principalId !== 'string' || !identity.principalId) {
    failures.push('anonymous recovery identity is refused');
  }
  if (identity.independent !== true || typeof identity.authenticatedBy !== 'string' || !identity.authenticatedBy) {
    failures.push('recovery identity was not authenticated through an independent channel');
  }
  const reader = identity.readerAccount;
  const writers = Array.isArray(identity.writerAccounts) ? identity.writerAccounts : [];
  if (reader === undefined || reader === null || writers.length === 0) {
    failures.push('reader and writer accounts are not recorded — identity separation unprovable');
  } else if (writers.some((w) => String(w) === String(reader))) {
    failures.push('identity separation failed: the recovery reader is also a backup writer');
  }
  if (identity.readerCanWrite !== false) failures.push('identity separation failed: the recovery reader can write to the copy');
  if (!Array.isArray(identity.missingPrerequisites) || identity.missingPrerequisites.length !== 0) {
    failures.push(`task-68 credential prerequisites missing: ${(identity.missingPrerequisites ?? ['unknown']).join(', ')}`);
  }
}

function validateRecovery(recovery, { observedAt }, failures) {
  if (!recovery || typeof recovery !== 'object') {
    failures.push('recovery read is not recorded');
    return;
  }
  const reads = Array.isArray(recovery.reads) ? recovery.reads : [];
  for (const role of ['manifest', 'dump', 'export-manifest']) {
    if (!reads.some((r) => r?.role === role)) failures.push(`recovery read of the ${role} from the copy is missing`);
  }
  for (const read of reads) {
    if (!HEX64.test(read?.sha256 ?? '') || read.sha256 !== read.expectedSha256) {
      failures.push(`recovery read of ${read?.name ?? 'unknown'} does not match its recorded digest`);
    }
  }
  const verification = recovery.manifestVerification;
  if (!verification || verification.ok !== true || (verification.failures ?? []).length) {
    failures.push(`recovery manifest did not verify from the copy${verification?.failures?.length ? `: ${verification.failures.join('; ')}` : ''}`);
  }
  if (verification?.recoveryComplete !== true) {
    failures.push(`recovery is incomplete: ${(verification?.incomplete ?? ['unknown']).join(', ')}`);
  }
  const generatedAt = time(recovery.manifestGeneratedAt);
  if (generatedAt === null) failures.push('backup manifest generation time missing');
  else if (observedAt !== null) {
    if (generatedAt > observedAt) failures.push('backup manifest is newer than the observation');
    if (observedAt - generatedAt > STORAGE_LIVE_BACKUP_MAX_AGE_DAYS * DAY_MS) {
      failures.push(`backup copy is stale (older than ${STORAGE_LIVE_BACKUP_MAX_AGE_DAYS} days at capture)`);
    }
  }
  const listing = recovery.listing;
  if (!listing?.before || !listing?.after || !(listing.before.count > 0)) {
    failures.push('the copy listing before and after the run is not recorded');
  } else if (listing.before.count !== listing.after.count || listing.before.sha256 !== listing.after.sha256) {
    failures.push('the copy listing changed during the run — ordinary backups must never be deleted');
  }
}

function validateClaims(subject, failures) {
  const claimed = Array.isArray(subject.qualified) ? [...subject.qualified].sort() : [];
  if (canonical(claimed) !== canonical([...STORAGE_LIVE_QUALIFIED_CLAIMS].sort())) {
    failures.push(`qualified claims must be exactly ${STORAGE_LIVE_QUALIFIED_CLAIMS.join(', ')}`);
  }
  const unqualified = subject.unqualified;
  for (const claim of STORAGE_LIVE_UNQUALIFIED_CLAIMS) {
    if (unqualified?.[claim]?.status !== UNQUALIFIED) {
      failures.push(`${claim} must be reported ${UNQUALIFIED} for a local copy (never claimed, never omitted)`);
    }
  }
}

/**
 * Validates a storage-live-acceptance record. `runner` is the base verifier's
 * runner-proof result; `artifactBytes` are the proof artifact's bytes after
 * their digest verified (null otherwise, with `artifactReason` saying why).
 * Returns failure strings.
 */
export function validateStorageLiveAcceptance(evidence, { tenantRef = null, build = null, runner = null, artifactBytes = null, artifactReason = null } = {}) {
  const failures = [];
  if (!tenantRef || !build) failures.push('storage-live-acceptance requires the expected tenant and build identity');
  if (tenantRef && evidence.tenantRef !== tenantRef) failures.push('storage-live-acceptance tenant mismatch');
  if (build && evidence.build !== build) failures.push('storage-live-acceptance build mismatch');
  if (evidence.operation !== STORAGE_LIVE_OPERATION) {
    failures.push(`operation mismatch: expected '${STORAGE_LIVE_OPERATION}', got '${evidence.operation ?? 'missing'}'`);
  }
  if (evidence.credentialMode !== STORAGE_LIVE_CREDENTIAL_MODE) failures.push(`storage recovery requires credential mode '${STORAGE_LIVE_CREDENTIAL_MODE}'`);

  // Both proofs: the signature binds the record, the artifact binds the raw capture.
  if (!runner?.ok) failures.push(`storage recovery runner proof required (${runner?.reason ?? 'not checked'})`);
  if (evidence.evidenceLevel === 'live-qualified' && (evidence.synthetic !== false || runner?.synthetic !== false)) {
    failures.push('storage fixture evidence cannot claim live qualification');
  }
  scanForCredentialMaterial(evidence, 'evidence', failures);

  const subject = evidence.subject;
  if (!subject || typeof subject !== 'object') return [...failures, 'subject is missing'];

  validatePrerequisite(subject.prerequisite, failures);
  validateStorage(subject.storage, failures);
  validateIdentity(subject.identity, failures);
  validateRecovery(subject.recovery, { observedAt: time(evidence.observedAt) }, failures);
  validateClaims(subject, failures);

  const { capture, failure } = parseCapture(artifactBytes, artifactReason);
  if (failure) failures.push(failure);
  else {
    if (subject.captureSha256 !== evidence.proof?.artifact?.sha256) failures.push('signed capture digest does not name the proof artifact');
    if (capture.tenantRef !== evidence.tenantRef) failures.push('raw capture tenant differs from the record');
    if (capture.build !== evidence.build) failures.push('raw capture build differs from the record');
    if (capture.operation !== evidence.operation) failures.push('raw capture operation differs from the record');
    for (const part of ['storage', 'identity', 'recovery']) {
      if (canonical(capture[part]) !== canonical(subject[part])) failures.push(`raw capture ${part} differs from the record`);
    }
  }
  return failures;
}
