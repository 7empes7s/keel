/**
 * Task 89: CMDB-first resource ownership with explicit SHARED, unknown and
 * unresolved states.
 *
 * Resolution order for one (tenant, type, source id) resource:
 *
 *  1. The resource must have a live task-50 lineage. Ownership is bound to that
 *     lineage id, never to a name, so a reused name starts with no ownership.
 *  2. The configured CMDB adapter is asked by source id. Its owner values are
 *     mapped to entity codes through the trusted configuration:
 *       - exactly one entity                          -> owned
 *       - several entities, an unmapped value, or a
 *         record the CMDB marks shared                -> shared (central approval)
 *       - a record with no owners                     -> unknown
 *  3. Only when the CMDB answers "not found" does the documented entity-code
 *     fallback apply: the resource's CURRENT name carries a configured entity
 *     prefix (for example `CRE-` or `ENO-`). No prefix -> unknown.
 *  4. Any CMDB failure (error, timeout, abort, malformed answer) -> unresolved.
 *     It never falls back and never yields an entity or a global allowance.
 *
 * Every resolution appends a resource_ownership_evidence row and supersedes the
 * previous current row without rewriting it. Each row carries observed_at and
 * expires_at; an expired row authorizes nothing.
 */
import { can } from '../authz/can.mjs';
import { findPrincipalById } from '../authz/principals.mjs';
import { currentLineageFor } from '../store/resourceLineage.mjs';
import { RECORD_REF } from './adapters/cmdb.mjs';

export const OWNERSHIP_STATES = Object.freeze(['owned', 'shared', 'unknown', 'unresolved']);
const ENTITY_CODE = /^[A-Z][A-Z0-9_]{1,31}$/;
const DEFAULT_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const MAX_AGE_LIMIT_MS = 30 * 24 * 60 * 60 * 1000;
const DEFAULT_LOOKUP_TIMEOUT_MS = 5000;

/**
 * Validates the trusted ownership configuration:
 *   { entities: { CODE: { cmdbValues: [string], codePrefixes: [string] } },
 *     maxEvidenceAgeMs?, lookupTimeoutMs? }
 * A CMDB value or prefix claimed by two entities is a configuration error, not
 * something to resolve by order.
 */
export function compileOwnershipConfig(config) {
  const entities = config?.entities;
  if (!entities || typeof entities !== 'object' || Object.keys(entities).length === 0) {
    throw new Error('ownership configuration names no entities');
  }
  const valueToEntity = new Map();
  const prefixToEntity = new Map();
  for (const [code, entity] of Object.entries(entities)) {
    if (!ENTITY_CODE.test(code)) throw new Error(`invalid entity code ${code}`);
    for (const value of entity.cmdbValues ?? []) {
      const key = String(value).trim().toLowerCase();
      if (!key || valueToEntity.has(key)) throw new Error(`CMDB value mapped twice: ${value}`);
      valueToEntity.set(key, code);
    }
    for (const prefix of entity.codePrefixes ?? []) {
      if (!/^[A-Z0-9]{2,16}$/.test(prefix) || prefixToEntity.has(prefix)) throw new Error(`invalid or duplicate entity prefix ${prefix}`);
      prefixToEntity.set(prefix, code);
    }
  }
  const maxEvidenceAgeMs = config.maxEvidenceAgeMs ?? DEFAULT_MAX_AGE_MS;
  if (!Number.isSafeInteger(maxEvidenceAgeMs) || maxEvidenceAgeMs < 1 || maxEvidenceAgeMs > MAX_AGE_LIMIT_MS) {
    throw new Error('invalid ownership evidence age');
  }
  const lookupTimeoutMs = config.lookupTimeoutMs ?? DEFAULT_LOOKUP_TIMEOUT_MS;
  if (!Number.isSafeInteger(lookupTimeoutMs) || lookupTimeoutMs < 1 || lookupTimeoutMs > 60000) {
    throw new Error('invalid CMDB lookup timeout');
  }
  return { entityCodes: Object.keys(entities), valueToEntity, prefixToEntity, maxEvidenceAgeMs, lookupTimeoutMs };
}

/**
 * The documented entity-code fallback: the name part of the natural key
 * (`type:name`) must start with a configured prefix followed by `-`, `_` or a
 * space. Case-sensitive, so `cre-` or `Creative` never match.
 */
export function entityFromCode(naturalKey, compiled) {
  if (typeof naturalKey !== 'string') return null;
  const name = naturalKey.includes(':') ? naturalKey.slice(naturalKey.indexOf(':') + 1) : naturalKey;
  const match = /^([A-Z0-9]{2,16})[-_ ]/.exec(name);
  return match ? compiled.prefixToEntity.get(match[1]) ?? null : null;
}

async function lookupWithTimeout(adapter, request, timeoutMs) {
  const controller = new AbortController();
  let timer;
  try {
    return await Promise.race([
      adapter.lookup({ ...request, signal: controller.signal }),
      new Promise((_, reject) => {
        timer = setTimeout(() => { controller.abort(); reject(new Error('CMDB lookup timed out')); }, timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/** Pure classification of one CMDB answer (or failure) into an ownership decision. */
export function classifyOwnership({ answer, failed, naturalKey, compiled }) {
  if (failed || !answer || !['found', 'not-found'].includes(answer.status)) {
    return { state: 'unresolved', entityCode: null, entityCodes: [], source: 'none', reason: 'cmdb-lookup-failed' };
  }
  if (answer.status === 'not-found') {
    const fallback = entityFromCode(naturalKey, compiled);
    return fallback
      ? { state: 'owned', entityCode: fallback, entityCodes: [fallback], source: 'entity-code-fallback', reason: 'entity-code-prefix' }
      : { state: 'unknown', entityCode: null, entityCodes: [], source: 'none', reason: 'no-cmdb-record-no-entity-code' };
  }
  if (typeof answer.recordRef !== 'string' || !RECORD_REF.test(answer.recordRef) || !Array.isArray(answer.owners)) {
    return { state: 'unresolved', entityCode: null, entityCodes: [], source: 'none', reason: 'cmdb-answer-malformed' };
  }
  const mapped = new Set();
  let unmapped = 0;
  for (const owner of answer.owners) {
    const code = compiled.valueToEntity.get(String(owner).trim().toLowerCase());
    if (code) mapped.add(code); else unmapped += 1;
  }
  const entityCodes = [...mapped].sort();
  if (answer.shared === true) {
    return { state: 'shared', entityCode: null, entityCodes, source: 'cmdb', reason: 'cmdb-marked-shared', recordRef: answer.recordRef };
  }
  if (entityCodes.length === 0) {
    return { state: 'unknown', entityCode: null, entityCodes, source: 'cmdb', reason: unmapped ? 'cmdb-owner-unmapped' : 'cmdb-record-without-owner', recordRef: answer.recordRef };
  }
  if (entityCodes.length > 1 || unmapped > 0) {
    return { state: 'shared', entityCode: null, entityCodes, source: 'cmdb', reason: 'cmdb-owner-ambiguous', recordRef: answer.recordRef };
  }
  return { state: 'owned', entityCode: entityCodes[0], entityCodes, source: 'cmdb', reason: 'cmdb-single-owner', recordRef: answer.recordRef };
}

function freshnessUntil(observedAt, answer, compiled) {
  let until = observedAt.getTime() + compiled.maxEvidenceAgeMs;
  const recordUntil = Date.parse(answer?.validUntil ?? '');
  if (Number.isFinite(recordUntil)) until = Math.min(until, recordUntil);
  return new Date(until);
}

async function authorize(client, options, capability) {
  if (!options.managedTenantRef || options.tenantRef !== options.managedTenantRef) throw new Error('tenant mismatch');
  const principal = await findPrincipalById(client, options.requestedBy);
  if (!principal || !await can(client, principal, capability)) throw new Error('not authorized for ownership');
  return principal;
}

/**
 * Resolves and records ownership for one resource. Requires the trusted
 * caller's current `collect` capability; the adapter must be bound to the same
 * managed tenant. Returns the appended evidence row.
 */
export async function resolveOwnership(client, {
  tenantRef, managedTenantRef, requestedBy, resourceType, sourceId, adapter, config, now = new Date(),
}) {
  await authorize(client, { tenantRef, managedTenantRef, requestedBy }, 'collect');
  if (!adapter || adapter.tenantRef !== tenantRef) throw new Error('CMDB adapter is not bound to this tenant');
  const compiled = compileOwnershipConfig(config);

  const lineage = await currentLineageFor(client, { tenantRef, resourceType, sourceId });
  if (!lineage) throw new Error('resource has no lineage in this tenant');

  let answer = null;
  let failed = false;
  if (!lineage.tombstoned_at) {
    try {
      answer = await lookupWithTimeout(adapter, { resourceType, sourceId }, compiled.lookupTimeoutMs);
    } catch {
      failed = true;
    }
  }
  const decision = lineage.tombstoned_at
    ? { state: 'unknown', entityCode: null, entityCodes: [], source: 'none', reason: 'resource-tombstoned' }
    : classifyOwnership({ answer, failed, naturalKey: lineage.natural_key, compiled });
  const expiresAt = decision.state === 'unresolved' ? now : freshnessUntil(now, answer, compiled);

  await client.query('BEGIN');
  try {
    // Serialize concurrent resolutions of the same lineage on its row lock.
    await client.query('SELECT id FROM resource_lineage WHERE id = $1 FOR UPDATE', [lineage.lineage_id]);
    await client.query(
      `UPDATE resource_ownership_evidence SET superseded_at = $2
        WHERE lineage_id = $1 AND superseded_at IS NULL`,
      [lineage.lineage_id, now],
    );
    const { rows: [row] } = await client.query(
      `INSERT INTO resource_ownership_evidence
         (tenant_ref, lineage_id, state, entity_code, entity_codes, source, reason,
          cmdb_record_ref, natural_key, observed_at, expires_at, recorded_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
       RETURNING *`,
      [tenantRef, lineage.lineage_id, decision.state, decision.entityCode, decision.entityCodes,
        decision.source, decision.reason, decision.recordRef ?? null, lineage.natural_key ?? null,
        now, expiresAt, requestedBy],
    );
    await client.query('COMMIT');
    return row;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  }
}

async function ownershipTableExists(client) {
  const { rows: [row] } = await client.query("SELECT to_regclass('resource_ownership_evidence') AS name");
  return row.name != null;
}

async function currentEvidence(client, tenantRef, lineageId) {
  const { rows: [row] } = await client.query(
    `SELECT * FROM resource_ownership_evidence
      WHERE tenant_ref = $1 AND lineage_id = $2 AND superseded_at IS NULL`,
    [tenantRef, lineageId],
  );
  return row ?? null;
}

/**
 * Authorized server reader: the current ownership of a resource plus its full
 * history (newest first). Legacy installations without the table report
 * `not-configured`, never a fabricated owner.
 */
export async function readOwnership(client, { tenantRef, managedTenantRef, requestedBy, resourceType, sourceId, now = new Date() }) {
  await authorize(client, { tenantRef, managedTenantRef, requestedBy }, 'read');
  if (!await ownershipTableExists(client)) return { status: 'not-configured', current: null, history: [] };
  const lineage = await currentLineageFor(client, { tenantRef, resourceType, sourceId });
  if (!lineage) return { status: 'no-lineage', current: null, history: [] };
  const { rows } = await client.query(
    `SELECT * FROM resource_ownership_evidence
      WHERE tenant_ref = $1 AND lineage_id = $2
      ORDER BY observed_at DESC, id`,
    [tenantRef, lineage.lineage_id],
  );
  const current = rows.find((row) => row.superseded_at == null) ?? null;
  return {
    status: current ? 'resolved' : 'never-resolved',
    lineageId: lineage.lineage_id,
    current: current && { ...current, fresh: current.expires_at > now },
    history: rows,
  };
}

/** One evidence row by id, tenant-scoped — what an approval cited, unchanged. */
export async function ownershipEvidenceById(client, { tenantRef, managedTenantRef, requestedBy, evidenceId }) {
  await authorize(client, { tenantRef, managedTenantRef, requestedBy }, 'read');
  const { rows: [row] } = await client.query(
    'SELECT * FROM resource_ownership_evidence WHERE tenant_ref = $1 AND id::text = $2',
    [tenantRef, String(evidenceId)],
  );
  return row ?? null;
}

/**
 * Write eligibility from ownership. Allowed only when the acting principal holds
 * `capability` now AND the resource's current evidence is `owned` by
 * `entityCode`, unexpired at `at`, and (when `evidenceId` is given) is still the
 * evidence the decision was made under. SHARED hands off to central approval;
 * unknown, unresolved, expired, missing and changed evidence refuse. Nothing
 * here grants a global or cross-entity allowance.
 */
export async function ownershipAllowsWrite(client, {
  tenantRef, managedTenantRef, requestedBy, capability, resourceType, sourceId, entityCode, evidenceId = null, at = new Date(),
}) {
  const refuse = (reason, extra = {}) => ({ allowed: false, reason, ...extra });
  if (!managedTenantRef || tenantRef !== managedTenantRef) return refuse('tenant-mismatch');
  const principal = await findPrincipalById(client, requestedBy);
  if (!principal || !await can(client, principal, capability, at)) return refuse('capability-missing');
  if (!ENTITY_CODE.test(entityCode ?? '')) return refuse('entity-scope-missing');
  if (!await ownershipTableExists(client)) return refuse('ownership-not-configured');
  const lineage = await currentLineageFor(client, { tenantRef, resourceType, sourceId });
  if (!lineage || lineage.tombstoned_at) return refuse('no-live-lineage');
  const evidence = await currentEvidence(client, tenantRef, lineage.lineage_id);
  if (!evidence) return refuse('ownership-never-resolved');
  if (evidenceId != null && evidence.id !== evidenceId) return refuse('ownership-changed', { evidenceId: evidence.id });
  if (!(evidence.expires_at > at)) return refuse('ownership-expired', { evidenceId: evidence.id });
  if (evidence.state === 'shared') return refuse('central-approval-required', { evidenceId: evidence.id, handoff: 'central' });
  if (evidence.state !== 'owned') return refuse(`ownership-${evidence.state}`, { evidenceId: evidence.id });
  if (evidence.entity_code !== entityCode) return refuse('entity-mismatch', { evidenceId: evidence.id });
  return { allowed: true, reason: 'owned', evidenceId: evidence.id, entityCode: evidence.entity_code, expiresAt: evidence.expires_at };
}
