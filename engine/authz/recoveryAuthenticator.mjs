// engine/authz/recoveryAuthenticator.mjs
//
// The production recovery authenticator for task-68 reconstruction. It is the
// "independent channel" recoveryMode.mjs requires: it never reads the keel
// database or portal being recovered, and nothing it trusts is in the backup
// set.
//
// Design: an operator-held Ed25519 signing key proves the recovery identity.
//
// - Trust store (on the recovery host, outside the backup set, e.g.
//   /etc/keel/recovery-authenticators.json): the PUBLIC keys of the enrolled
//   recovery principals. It holds no secret. A file that carries private key
//   material, a non-Ed25519 key, or is group/world writable is refused.
// - Signed recovery assertion: the operator signs a short-lived statement
//   ({ v, purpose, principalId, keyId, tenantRef, issuedAt, expiresAt,
//   nonce }) with the private key, which stays offline with the operator
//   (tools/recovery/recovery-assertion.mjs). The identity's credentialRef is
//   the path to that assertion file — a reference, never the key.
// - Replay ledger (a directory outside the backup set, e.g.
//   /var/lib/keel/recovery-replay): each accepted nonce is claimed by an
//   exclusive file create, so one assertion authenticates exactly one
//   reconstruction, even under concurrent runs.
//
// An assertion is refused when it is unsigned or signed by another key, names
// another principal, tenant or purpose, is expired, not yet valid, longer-lived
// than the maximum lifetime, or its nonce was already used. Every refusal
// throws RecoveryIdentityError with the reason, which reconstructRecovery()
// reports at its `identity` stage.
//
// Only this authenticator is selectable by name (selectRecoveryAuthenticator).
// The fixture `async () => true` used by the tests and the release journeys
// has no name and can never be chosen in production mode.
import { createHash, createPublicKey, verify as verifySignature } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import { mkdir, readFile as fsReadFile, stat as fsStat, writeFile as fsWriteFile } from 'node:fs/promises';
import { isAbsolute, relative, resolve } from 'node:path';

import { assertNoEmbeddedCredential } from '../storage/adapter.mjs';
import { RecoveryIdentityError } from './recoveryMode.mjs';

export const SIGNED_ASSERTION_AUTHENTICATOR = 'signed-assertion';
export const PRODUCTION_RECOVERY_AUTHENTICATORS = Object.freeze([SIGNED_ASSERTION_AUTHENTICATOR]);

export const RECOVERY_ASSERTION_VERSION = 1;
export const RECOVERY_ASSERTION_PURPOSE = 'keel-recovery-reconstruct';
export const TRUST_STORE_VERSION = 1;
// An assertion is meant to be signed just before the reconstruction it
// authorizes, so its validity window is short.
export const MAX_ASSERTION_LIFETIME_MS = 15 * 60 * 1000;
export const DEFAULT_CLOCK_SKEW_MS = 60 * 1000;

const ASSERTION_FIELDS = Object.freeze([
  'v', 'purpose', 'principalId', 'keyId', 'tenantRef', 'issuedAt', 'expiresAt', 'nonce',
]);
const NONCE_PATTERN = /^[0-9a-f]{32,128}$/;
const PRODUCTION_MARK = Symbol('keel.productionRecoveryAuthenticator');

function refuse(message) {
  throw new RecoveryIdentityError(message);
}

/** The exact bytes an assertion signature covers: the fields in fixed order. */
export function canonicalAssertionBytes(assertion) {
  const ordered = {};
  for (const field of ASSERTION_FIELDS) ordered[field] = assertion[field];
  return Buffer.from(JSON.stringify(ordered), 'utf8');
}

function isInside(child, parent) {
  const rel = relative(resolve(parent), resolve(child));
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

/**
 * Refuses a trust path that lies inside the backup set. The trust root must
 * survive the loss (or tampering) of the artifacts it is used to recover.
 */
export function assertOutsideBackupSet(path, name, backupSetPaths = []) {
  for (const root of backupSetPaths) {
    if (typeof root !== 'string' || root.length === 0) continue;
    if (isInside(path, root)) {
      refuse(`${name} (${resolve(path)}) lies inside the backup set (${resolve(root)}) — `
        + 'the recovery trust root must be held outside the artifacts it authenticates');
    }
  }
}

function parseEd25519PublicKey(pem, where) {
  if (typeof pem !== 'string' || !pem.includes('-----BEGIN PUBLIC KEY-----')) {
    refuse(`${where}: publicKey must be an SPKI PEM public key`);
  }
  let key;
  try {
    key = createPublicKey(pem);
  } catch {
    refuse(`${where}: publicKey is not a readable public key`);
  }
  if (key.asymmetricKeyType !== 'ed25519') {
    refuse(`${where}: only Ed25519 recovery keys are accepted (got ${key.asymmetricKeyType})`);
  }
  return key;
}

/**
 * Loads and validates the trust store of enrolled recovery principals.
 * Returns a Map of principalId -> { keyId, publicKey, fingerprint }.
 */
export async function loadRecoveryTrustStore(path, { readFile = fsReadFile, stat = fsStat } = {}) {
  if (typeof path !== 'string' || path.length === 0) {
    refuse('the signed-assertion authenticator requires a recovery trust store path');
  }
  let info;
  try {
    info = await stat(path);
  } catch {
    refuse(`recovery trust store unreadable at ${path}`);
  }
  if (!info.isFile()) refuse(`recovery trust store ${path} is not a regular file`);
  if ((info.mode & (fsConstants.S_IWGRP | fsConstants.S_IWOTH)) !== 0) {
    refuse(`recovery trust store ${path} is group- or world-writable — restrict it to its owner`);
  }
  const text = (await readFile(path, 'utf8')).toString();
  try {
    assertNoEmbeddedCredential(text, 'trust store');
  } catch {
    refuse(`recovery trust store ${path} carries credential material — it must hold public keys only`);
  }
  let document;
  try {
    document = JSON.parse(text);
  } catch {
    refuse(`recovery trust store ${path} is not valid JSON`);
  }
  if (document?.version !== TRUST_STORE_VERSION || !Array.isArray(document.principals)) {
    refuse(`recovery trust store ${path} must be { "version": ${TRUST_STORE_VERSION}, "principals": [...] }`);
  }
  const principals = new Map();
  document.principals.forEach((entry, index) => {
    const where = `trust store principals[${index}]`;
    if (typeof entry?.principalId !== 'string' || entry.principalId.length === 0) refuse(`${where}: principalId is required`);
    if (typeof entry.keyId !== 'string' || entry.keyId.length === 0) refuse(`${where}: keyId is required`);
    if (principals.has(entry.principalId)) refuse(`${where}: principal ${entry.principalId} is enrolled twice`);
    const publicKey = parseEd25519PublicKey(entry.publicKey, where);
    const fingerprint = `sha256:${createHash('sha256').update(publicKey.export({ type: 'spki', format: 'der' })).digest('hex')}`;
    principals.set(entry.principalId, Object.freeze({ keyId: entry.keyId, publicKey, fingerprint }));
  });
  if (principals.size === 0) refuse(`recovery trust store ${path} enrolls no recovery principal`);
  return principals;
}

function parseTime(value, field) {
  const ms = typeof value === 'string' ? Date.parse(value) : NaN;
  if (!Number.isFinite(ms)) refuse(`recovery assertion ${field} is not an ISO time`);
  return ms;
}

/** Verifies a parsed { assertion, signature } envelope; returns the assertion. */
export function verifyRecoveryAssertion(envelope, {
  principals, principalId, tenantRef, now, maxLifetimeMs = MAX_ASSERTION_LIFETIME_MS,
  clockSkewMs = DEFAULT_CLOCK_SKEW_MS,
}) {
  const assertion = envelope?.assertion;
  if (!assertion || typeof assertion !== 'object' || typeof envelope.signature !== 'string') {
    refuse('recovery assertion must be { "assertion": {...}, "signature": "<base64>" }');
  }
  const extra = Object.keys(assertion).filter((field) => !ASSERTION_FIELDS.includes(field));
  if (extra.length > 0) refuse(`recovery assertion carries unsigned fields: ${extra.join(', ')}`);
  if (assertion.v !== RECOVERY_ASSERTION_VERSION) refuse(`recovery assertion version must be ${RECOVERY_ASSERTION_VERSION}`);
  if (assertion.purpose !== RECOVERY_ASSERTION_PURPOSE) {
    refuse(`recovery assertion purpose must be ${RECOVERY_ASSERTION_PURPOSE}`);
  }
  if (assertion.principalId !== principalId) {
    refuse(`recovery assertion was issued to ${assertion.principalId}, not the claimed identity ${principalId}`);
  }
  const enrolled = principals.get(principalId);
  if (!enrolled) refuse(`recovery principal ${principalId} is not enrolled in the trust store`);
  if (assertion.keyId !== enrolled.keyId) {
    refuse(`recovery assertion key ${assertion.keyId} is not the enrolled key for ${principalId}`);
  }
  if (assertion.tenantRef !== tenantRef) refuse('recovery assertion is bound to a different tenant');
  if (typeof assertion.nonce !== 'string' || !NONCE_PATTERN.test(assertion.nonce)) {
    refuse('recovery assertion nonce must be 32-128 lowercase hex characters');
  }
  const signature = Buffer.from(envelope.signature, 'base64');
  if (signature.length !== 64
    || !verifySignature(null, canonicalAssertionBytes(assertion), enrolled.publicKey, signature)) {
    refuse(`recovery assertion signature does not verify against the enrolled key for ${principalId}`);
  }
  const issuedAt = parseTime(assertion.issuedAt, 'issuedAt');
  const expiresAt = parseTime(assertion.expiresAt, 'expiresAt');
  const at = now.getTime();
  if (expiresAt <= issuedAt) refuse('recovery assertion expires before it is issued');
  if (expiresAt - issuedAt > maxLifetimeMs) {
    refuse(`recovery assertion lifetime exceeds the ${maxLifetimeMs / 60000}-minute maximum`);
  }
  if (issuedAt > at + clockSkewMs) refuse('recovery assertion is not yet valid (issued in the future)');
  if (at >= expiresAt) refuse(`recovery assertion expired at ${assertion.expiresAt}`);
  return { assertion, fingerprint: enrolled.fingerprint };
}

/**
 * Claims a nonce in the replay ledger with an exclusive create: the first
 * caller wins, every later presentation of the same assertion is refused.
 */
async function claimNonce(ledgerDir, { nonce, principalId, at }, { mkdirFn = mkdir, writeFile = fsWriteFile } = {}) {
  await mkdirFn(ledgerDir, { recursive: true, mode: 0o700 });
  try {
    await writeFile(resolve(ledgerDir, `${nonce}.used`), `${JSON.stringify({ principalId, usedAt: at.toISOString() })}\n`, {
      flag: 'wx', mode: 0o600,
    });
  } catch (error) {
    if (error?.code === 'EEXIST') refuse('recovery assertion was already used (replay refused)');
    refuse(`recovery replay ledger ${ledgerDir} is not writable: ${error.message}`);
  }
}

/**
 * Builds the production signed-assertion authenticator. The returned
 * function has the recoveryMode.mjs authenticator shape
 * ({ principalId, credentialRef }) => true, and throws RecoveryIdentityError
 * on every refusal. `credentialRef` is the path to the signed assertion.
 */
export async function createSignedAssertionAuthenticator({
  trustStorePath,
  replayLedgerDir,
  tenantRef,
  backupSetPaths = [],
  maxLifetimeMs = MAX_ASSERTION_LIFETIME_MS,
  now = () => new Date(),
  dependencies = {},
}) {
  if (typeof tenantRef !== 'string' || tenantRef.length === 0) {
    refuse('the signed-assertion authenticator must be bound to a tenantRef');
  }
  if (typeof replayLedgerDir !== 'string' || replayLedgerDir.length === 0) {
    refuse('the signed-assertion authenticator requires a replay ledger directory');
  }
  if (!Number.isFinite(maxLifetimeMs) || maxLifetimeMs <= 0 || maxLifetimeMs > MAX_ASSERTION_LIFETIME_MS) {
    refuse(`maximum assertion lifetime must be positive and at most ${MAX_ASSERTION_LIFETIME_MS / 60000} minutes`);
  }
  assertOutsideBackupSet(trustStorePath ?? '', 'recovery trust store', backupSetPaths);
  assertOutsideBackupSet(replayLedgerDir, 'recovery replay ledger', backupSetPaths);
  const { readFile = fsReadFile } = dependencies;
  const principals = await loadRecoveryTrustStore(trustStorePath, dependencies);

  const authenticator = async ({ principalId, credentialRef }) => {
    let envelope;
    try {
      envelope = JSON.parse((await readFile(credentialRef, 'utf8')).toString());
    } catch {
      refuse(`recovery assertion unreadable at ${credentialRef}`);
    }
    const at = now();
    const { assertion } = verifyRecoveryAssertion(envelope, { principals, principalId, tenantRef, now: at, maxLifetimeMs });
    await claimNonce(replayLedgerDir, { nonce: assertion.nonce, principalId, at }, dependencies);
    return true;
  };
  Object.defineProperty(authenticator, PRODUCTION_MARK, { value: SIGNED_ASSERTION_AUTHENTICATOR });
  return Object.freeze(authenticator);
}

/** The production authenticator kind of a function, or null for anything else (fixtures included). */
export function productionAuthenticatorKind(authenticator) {
  return typeof authenticator === 'function' ? authenticator[PRODUCTION_MARK] ?? null : null;
}

/**
 * Selects a production recovery authenticator by name. Only the names in
 * PRODUCTION_RECOVERY_AUTHENTICATORS exist; a fixture or always-true
 * authenticator is never selectable here.
 */
export async function selectRecoveryAuthenticator({ kind, ...options }) {
  if (!PRODUCTION_RECOVERY_AUTHENTICATORS.includes(kind)) {
    refuse(`recovery authenticator ${JSON.stringify(kind)} is not selectable — production recovery accepts only: `
      + PRODUCTION_RECOVERY_AUTHENTICATORS.join(', '));
  }
  return createSignedAssertionAuthenticator(options);
}
