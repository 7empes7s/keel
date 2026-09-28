// engine/authz/recoveryMode.mjs
//
// Recovery-mode authorization boundary (roadmap task-68, WS10). Disaster
// recovery runs offline against a disposable database — the principal and
// role_grant tables that normally answer can() may be exactly what was lost —
// so a recovery session can never derive its authority from the keel database
// it is rebuilding. Instead:
//
// 1. Recovery requires an explicit, INDEPENDENTLY AUTHENTICATED recovery
//    identity. authenticateRecoveryIdentity() refuses an anonymous identity
//    outright (mutation check: allow anonymous emergency identity) and refuses
//    to run without an injected independent authenticator — authentication is
//    a property of a separate channel (break-glass token, hardware key), never
//    of this process's own say-so.
// 2. Recovery starts read-only with outbound writes disabled.
//    openRecoveryReadOnlySession() pins the connection to
//    default_transaction_read_only at the database level and wraps query()
//    with a statement guard that refuses anything but a read (mutation check:
//    enable writes during reconstruction). The guard is evasion-tested: it
//    refuses writes hidden behind an allowed leading keyword (writable CTEs,
//    DML after a WITH clause, SELECT INTO, EXPLAIN ANALYZE), multi-statement
//    batches, and session-mode resets (SET/RESET, set_config()). The import
//    phase uses a separate, short-lived writable connection that is ended
//    before any access begins.
// 3. listMissingPrerequisites() names the credential prerequisites that are
//    still missing (recovery key material, artifact storage read access,
//    tenant recovery authorization) so an operator learns what to fetch from
//    the separately-held stores BEFORE any artifact is trusted. Credentials
//    themselves never appear here — references only (Global Constraint #6).
import { assertNoEmbeddedCredential } from '../storage/adapter.mjs';

export class RecoveryIdentityError extends Error {
  constructor(message) {
    super(message);
    this.name = 'RecoveryIdentityError';
  }
}

export class RecoveryReadOnlyError extends Error {
  constructor(message) {
    super(message);
    this.name = 'RecoveryReadOnlyError';
  }
}

// The named credential prerequisites for a reconstruction. These are the
// exact strings a missing-credential report carries, so an operator can match
// each gap to the runbook step that resolves it.
export const PREREQUISITE_RECOVERY_KEY_MATERIAL = 'recovery-key-material';
export const PREREQUISITE_ARTIFACT_STORAGE_READ = 'artifact-storage-read';
export const PREREQUISITE_TENANT_RECOVERY_AUTHORIZATION = 'tenant-recovery-authorization';

export const RECOVERY_PREREQUISITES = Object.freeze([
  PREREQUISITE_RECOVERY_KEY_MATERIAL,
  PREREQUISITE_ARTIFACT_STORAGE_READ,
  PREREQUISITE_TENANT_RECOVERY_AUTHORIZATION,
]);

function assertReference(value, name) {
  if (typeof value !== 'string' || value.length === 0) {
    throw new RecoveryIdentityError(`${name} requires a non-empty reference string`);
  }
  try {
    return assertNoEmbeddedCredential(value, name);
  } catch {
    throw new RecoveryIdentityError(
      `${name} must be a reference to separately-held material, never the credential itself`,
    );
  }
}

/**
 * Authenticates a recovery identity through an independent channel.
 *
 * - identity: { principalId, credentialRef } — who claims recovery authority
 *   and a reference to the separately-held credential that proves it. An
 *   anonymous identity (no principalId, or anonymous: true) is refused
 *   unconditionally; there is no emergency bypass (mutation check: allow
 *   anonymous emergency identity).
 * - authenticator: injected async (identity) => true|false. This is the
 *   independent channel (break-glass token service, hardware-key ceremony).
 *   Without one, authentication REFUSES — this module cannot authenticate
 *   anyone by itself.
 *
 * Returns a frozen identity token on success; throws RecoveryIdentityError
 * otherwise. Never returns a truthy "unauthenticated" identity.
 */
export async function authenticateRecoveryIdentity({ identity, authenticator, at = new Date() }) {
  if (typeof authenticator !== 'function') {
    throw new RecoveryIdentityError(
      'recovery identity authentication requires an independent authenticator — none configured',
    );
  }
  if (!identity || typeof identity !== 'object' || identity.anonymous === true) {
    throw new RecoveryIdentityError('anonymous recovery identity is refused — no emergency bypass exists');
  }
  const principalId = assertReference(identity.principalId, 'identity.principalId');
  const credentialRef = assertReference(identity.credentialRef, 'identity.credentialRef');
  const decision = await authenticator({ principalId, credentialRef });
  if (decision !== true) {
    throw new RecoveryIdentityError(
      `the independent authenticator refused recovery identity ${principalId}`,
    );
  }
  return Object.freeze({
    principalId,
    credentialRef,
    authenticatedAt: at.toISOString(),
    independent: true,
  });
}

// Credential references the reconstruction must be handed, keyed to the named
// prerequisite each one satisfies.
const CREDENTIAL_FIELDS = Object.freeze({
  [PREREQUISITE_RECOVERY_KEY_MATERIAL]: 'recoveryKeyMaterial',
  [PREREQUISITE_ARTIFACT_STORAGE_READ]: 'artifactStorageRead',
  [PREREQUISITE_TENANT_RECOVERY_AUTHORIZATION]: 'tenantRecoveryAuthorization',
});

function credentialSatisfied(value) {
  if (typeof value !== 'string' || value.length === 0) return false;
  try {
    assertNoEmbeddedCredential(value, 'credential');
  } catch {
    // A value that IS credential material is not a reference to it — the
    // prerequisite stays missing and the material is never carried further.
    return false;
  }
  return true;
}

/**
 * Lists the named credential prerequisites that are still missing. Pure and
 * synchronous: it inspects the supplied credential references and returns the
 * names of every gap, in stable RECOVERY_PREREQUISITES order. An empty result
 * means reconstruction may proceed to manifest verification.
 */
export function listMissingPrerequisites({ credentials = {} } = {}) {
  const missing = [];
  for (const prerequisite of RECOVERY_PREREQUISITES) {
    if (!credentialSatisfied(credentials?.[CREDENTIAL_FIELDS[prerequisite]])) {
      missing.push(prerequisite);
    }
  }
  return missing;
}

// The statement guard behind the read-only session. A statement passes only
// if it is a SINGLE, genuinely read-only statement; anything that can write —
// directly, or smuggled behind an allowed leading keyword — is refused before
// it reaches the database, where default_transaction_read_only refuses it
// again. Checking only the leading keyword is not enough:
//
// - a WITH clause can carry data-modifying CTEs
//   (WITH d AS (DELETE FROM t RETURNING *) SELECT ...) or precede a DML
//   statement (WITH x AS (...) UPDATE ...), both keeping the leading WITH;
// - EXPLAIN ANALYZE EXECUTES the explained statement;
// - SELECT ... INTO creates a table;
// - a semicolon turns one call into a multi-statement batch, so
//   "SELECT 1; SET default_transaction_read_only = off" would reset the
//   transaction mode for later transactions on this connection;
// - set_config() resets the same GUCs from inside a plain SELECT;
// - nextval()/setval() mutate sequence state.
//
// All checks run on text with string literals, dollar-quoted strings, quoted
// identifiers and comments blanked out, so a payload like
// SELECT '-- DELETE FROM evidence;' cannot smuggle keywords past the guard
// and legitimate data containing those words cannot false-positive.
const READ_ONLY_LEADING_KEYWORD = /^\s*(SELECT|WITH|VALUES|TABLE|SHOW|EXPLAIN)\b/i;
const WRITE_KEYWORD = /\b(INSERT|UPDATE|DELETE|MERGE|INTO|ANALYZE)\b/i;
const SIDE_EFFECT_FUNCTION = /\b(set_config|nextval|setval|pg_terminate_backend|pg_cancel_backend|pg_reload_conf)\s*\(/i;

// Blanks out string literals ('' escapes), quoted identifiers ("" escapes),
// dollar-quoted strings ($tag$ ... $tag$), line comments and (nested) block
// comments, preserving everything else so keyword checks see only real SQL.
function blankLiteralsAndComments(sql) {
  let out = '';
  let i = 0;
  while (i < sql.length) {
    const ch = sql[i];
    if (ch === "'" || ch === '"') {
      out += ' ';
      i += 1;
      while (i < sql.length) {
        if (sql[i] === ch) {
          if (sql[i + 1] === ch) { i += 2; continue; }
          i += 1;
          break;
        }
        i += 1;
      }
      continue;
    }
    if (ch === '$') {
      const tag = /^\$[A-Za-z_0-9]*\$/.exec(sql.slice(i))?.[0];
      if (tag) {
        const close = sql.indexOf(tag, i + tag.length);
        out += ' ';
        i = close === -1 ? sql.length : close + tag.length;
        continue;
      }
      out += ch;
      i += 1;
      continue;
    }
    if (ch === '-' && sql[i + 1] === '-') {
      while (i < sql.length && sql[i] !== '\n') i += 1;
      out += ' ';
      continue;
    }
    if (ch === '/' && sql[i + 1] === '*') {
      let depth = 1;
      i += 2;
      while (i < sql.length && depth > 0) {
        if (sql[i] === '/' && sql[i + 1] === '*') { depth += 1; i += 2; }
        else if (sql[i] === '*' && sql[i + 1] === '/') { depth -= 1; i += 2; }
        else { i += 1; }
      }
      out += ' ';
      continue;
    }
    out += ch;
    i += 1;
  }
  return out;
}

export function assertReadOnlyStatement(sql) {
  if (typeof sql !== 'string') {
    throw new RecoveryReadOnlyError(
      'recovery mode is read-only: only SELECT/WITH/VALUES/TABLE/SHOW/EXPLAIN statements are permitted',
    );
  }
  const inspection = blankLiteralsAndComments(sql);
  if (inspection.includes(';')) {
    throw new RecoveryReadOnlyError(
      'recovery mode is read-only: one statement per query — multi-statement batches can reset the transaction mode',
    );
  }
  if (!READ_ONLY_LEADING_KEYWORD.test(inspection)) {
    throw new RecoveryReadOnlyError(
      'recovery mode is read-only: only SELECT/WITH/VALUES/TABLE/SHOW/EXPLAIN statements are permitted',
    );
  }
  if (WRITE_KEYWORD.test(inspection)) {
    throw new RecoveryReadOnlyError(
      'recovery mode is read-only: INSERT/UPDATE/DELETE/MERGE are refused wherever they appear '
      + '(including writable CTEs and DML after a WITH clause), as are SELECT INTO and EXPLAIN ANALYZE',
    );
  }
  if (SIDE_EFFECT_FUNCTION.test(inspection)) {
    throw new RecoveryReadOnlyError(
      'recovery mode is read-only: set_config/nextval/setval and backend-control functions are refused',
    );
  }
  return sql;
}

/**
 * Pins a connection read-only and returns the guarded access handle every
 * reconstruction read must go through. Two independent layers, both checked
 * by tests:
 *
 * - database level: default_transaction_read_only = on, so ANY write on this
 *   connection fails with SQLSTATE 25006 even if the statement guard is
 *   bypassed (mutation check: enable writes during reconstruction);
 * - statement level: query() refuses anything but a single read-only
 *   statement before it is sent — including writes smuggled behind an
 *   allowed leading keyword (writable CTE, DML after WITH, SELECT INTO,
 *   EXPLAIN ANALYZE), multi-statement batches, and set_config() mode
 *   resets — so a caller gets a RecoveryReadOnlyError naming the rule
 *   rather than a bare database error.
 */
export async function openRecoveryReadOnlySession(client) {
  await client.query('SET default_transaction_read_only = on');
  await client.query('SET SESSION CHARACTERISTICS AS TRANSACTION READ ONLY');
  return Object.freeze({
    client,
    readOnly: true,
    async query(sql, params) {
      return client.query(assertReadOnlyStatement(sql), params);
    },
  });
}
