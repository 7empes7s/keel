/**
 * Storage adapter contract (roadmap task-67, WS10).
 *
 * A storage adapter is the boundary between keel's recovery artifacts (SQL
 * dumps, configuration exports, recovery manifests) and the medium that holds
 * them. Every adapter implements exactly the five STORAGE_OPERATIONS —
 * publish, read, list, verify, retention-status — and carries an explicit
 * capabilities descriptor. Three rules are enforced here, non-negotiably:
 *
 * 1. Capability claims use the closed vocabulary of Global Constraint #5:
 *    declared, fixture-tested, live-qualified, unsupported, unknown. A
 *    capability that has not been proven is 'unsupported' or 'unknown', never
 *    silently 'declared'.
 * 2. Local filesystem permissions are NOT immutable storage. The provider
 *    ceiling table makes it a construction error for a local-disk adapter to
 *    claim retention lock or immutability — chmod/ACLs are revocable by any
 *    principal with write access (mutation check: label local permissions
 *    immutable).
 * 3. Residency/provider/credential-boundary metadata is reference text only.
 *    Anything that looks like credential material (private keys, bearer
 *    tokens, password assignments) is rejected at construction, so
 *    capabilities and manifests can never smuggle secrets.
 */

export const STORAGE_OPERATIONS = Object.freeze([
  'publish',
  'read',
  'list',
  'verify',
  'retention-status',
]);

// The operation name as exposed on the adapter object.
export const OPERATION_METHODS = Object.freeze({
  publish: 'publish',
  read: 'read',
  list: 'list',
  verify: 'verify',
  'retention-status': 'retentionStatus',
});

// Global Constraint #5: every capability claim is one of these, nothing else.
export const CAPABILITY_CLAIMS = Object.freeze([
  'declared',
  'fixture-tested',
  'live-qualified',
  'unsupported',
  'unknown',
]);

// Providers whose medium has no retention-lock or immutability primitive at
// all. For these providers the ONLY honest claims for retentionLock and
// immutability are 'unsupported' or 'unknown'; anything stronger is refused
// at construction time.
const PROVIDER_CAPABILITY_CEILINGS = Object.freeze({
  'local-disk': Object.freeze({
    retentionLock: Object.freeze(['unsupported', 'unknown']),
    immutability: Object.freeze(['unsupported', 'unknown']),
  }),
});

export class EmbeddedCredentialError extends Error {
  constructor(name) {
    super(`storage metadata field ${name} appears to embed credential material — store references only, never credentials`);
    this.name = 'EmbeddedCredentialError';
  }
}

const CREDENTIAL_PATTERNS = Object.freeze([
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /\bbearer\s+\S{8,}/i,
  /\b(password|passwd|secret|token|api[_-]?key)\s*[:=]\s*\S+/i,
]);

/**
 * Rejects a metadata value that looks like embedded credential material.
 * Storage metadata records WHERE credentials live (a reference), never the
 * credentials themselves (Global Constraint #6).
 */
export function assertNoEmbeddedCredential(value, name) {
  if (typeof value !== 'string') return value;
  for (const pattern of CREDENTIAL_PATTERNS) {
    if (pattern.test(value)) throw new EmbeddedCredentialError(name);
  }
  return value;
}

function assertClaim(value, name) {
  if (!CAPABILITY_CLAIMS.includes(value)) {
    throw new TypeError(`capability ${name} must be one of ${CAPABILITY_CLAIMS.join(', ')}, got ${JSON.stringify(value)}`);
  }
  return value;
}

/**
 * Builds the frozen capabilities descriptor for an adapter. Every operation
 * must carry an explicit claim; retentionLock and immutability are first-class
 * claims and are ceiling-checked against the provider — a provider with no
 * retention-lock primitive can never construct a descriptor claiming one.
 */
export function defineStorageCapabilities({
  provider,
  residency = {},
  retentionLock,
  immutability,
  operations = {},
}) {
  if (typeof provider !== 'string' || provider.length === 0) {
    throw new TypeError('storage capabilities require a provider name');
  }
  assertNoEmbeddedCredential(provider, 'provider');
  assertClaim(retentionLock, 'retentionLock');
  assertClaim(immutability, 'immutability');

  const ceiling = PROVIDER_CAPABILITY_CEILINGS[provider];
  for (const capability of ['retentionLock', 'immutability']) {
    const allowed = ceiling?.[capability];
    const claim = capability === 'retentionLock' ? retentionLock : immutability;
    if (allowed && !allowed.includes(claim)) {
      throw new Error(
        `provider ${provider} has no ${capability} primitive: claim ${JSON.stringify(claim)} is refused; `
        + 'filesystem permissions do not constitute immutable storage',
      );
    }
  }

  const operationClaims = {};
  for (const operation of STORAGE_OPERATIONS) {
    operationClaims[operation] = assertClaim(operations[operation], `operations.${operation}`);
  }

  const residencyOut = {};
  for (const field of ['region', 'boundary', 'credentialBoundary']) {
    const value = residency[field];
    if (value !== undefined && value !== null) {
      if (typeof value !== 'string' || value.length === 0) {
        throw new TypeError(`residency.${field} must be a non-empty reference string`);
      }
      residencyOut[field] = assertNoEmbeddedCredential(value, `residency.${field}`);
    }
  }

  return Object.freeze({
    provider,
    residency: Object.freeze(residencyOut),
    retentionLock,
    immutability,
    operations: Object.freeze(operationClaims),
  });
}

/**
 * Validates that an object is a storage adapter: a valid capabilities
 * descriptor plus a function for every one of the five contract operations.
 * Returns the adapter unchanged so callers can wrap construction.
 */
export function assertStorageAdapter(adapter) {
  if (!adapter || typeof adapter !== 'object') {
    throw new TypeError('a storage adapter must be an object');
  }
  defineStorageCapabilities(adapter.capabilities ?? {});
  for (const operation of STORAGE_OPERATIONS) {
    const method = OPERATION_METHODS[operation];
    if (typeof adapter[method] !== 'function') {
      throw new TypeError(`storage adapter for provider ${adapter.capabilities?.provider ?? '?'} lacks the ${operation} operation`);
    }
  }
  return adapter;
}
