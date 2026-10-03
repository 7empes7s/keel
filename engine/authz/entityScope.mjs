/**
 * Task 90: entity-scoped reads and approval eligibility.
 *
 * A principal's scope for a capability comes from can.mjs#capabilityScope: central
 * (every entity) or a list of entity codes. Which entity a row belongs to is derived
 * here, server-side, from task 89's ownership evidence and never from a name or a
 * client claim:
 *
 *   row (tenant, resource type, natural key, as-of time)
 *     -> the ONE lineage whose alias held that key at that time (task 50)
 *     -> that lineage's current, unexpired ownership evidence (task 89)
 *
 * A row is visible to an entity-scoped reader only when that chain resolves and the
 * evidence is `owned` by one of the reader's entities, or `shared` with one of them.
 * Unknown, unresolved, expired, missing, ambiguous (two lineages held the key) and
 * unattributable rows are visible to central readers only. Filtering happens in the
 * SQL that also produces counts, so a count never includes a row the reader cannot see.
 *
 * Approval eligibility re-reads ownership and grants at decision time. The ownership
 * captured when the request was made is only the reference point that detects a
 * change; it never authorizes on its own.
 */
import { capabilityScope } from './can.mjs';
import { findPrincipalById } from './principals.mjs';

export const SCOPE_VERSION = 1;

export class EntityScopeError extends Error {}

/** A central scope: every row is visible. */
export const CENTRAL = Object.freeze({ central: true, entities: Object.freeze([]) });

function normalizedScope(scope) {
  if (scope?.central === true) return CENTRAL;
  const entities = Array.isArray(scope?.entities) ? scope.entities.filter((code) => /^[A-Z][A-Z0-9_]{1,31}$/.test(code)) : [];
  return { central: false, entities: [...new Set(entities)].sort() };
}

/**
 * SQL predicate restricting rows to `scope`. The caller supplies SQL expressions for
 * the row's resource type, natural key and as-of time, and the index of the next free
 * placeholder. Returns { sql, values } to splice into the caller's WHERE clause.
 * A central scope is `TRUE`; an empty entity scope is `FALSE`.
 */
export function scopePredicate(scope, { tenantRef, typeExpr, keyExpr, asOfExpr, at = new Date(), nextParam }) {
  const normalized = normalizedScope(scope);
  if (normalized.central) return { sql: 'TRUE', values: [] };
  if (normalized.entities.length === 0) return { sql: 'FALSE', values: [] };
  const [t, e, now] = [nextParam, nextParam + 1, nextParam + 2];
  const window = (alias) => `${alias}.valid_from <= ${asOfExpr} AND (${alias}.valid_until IS NULL OR ${alias}.valid_until > ${asOfExpr})`;
  return {
    sql: `EXISTS (
      SELECT 1
        FROM resource_lineage_alias sa
        JOIN resource_lineage sl ON sl.id = sa.lineage_id
        JOIN resource_ownership_evidence se
          ON se.lineage_id = sl.id AND se.tenant_ref = sl.tenant_ref AND se.superseded_at IS NULL
       WHERE sl.tenant_ref = $${t} AND sl.resource_type = ${typeExpr} AND sa.natural_key = ${keyExpr}
         AND ${window('sa')}
         AND se.expires_at > $${now}
         AND ((se.state = 'owned' AND se.entity_code = ANY($${e}::text[]))
              OR (se.state = 'shared' AND se.entity_codes && $${e}::text[]))
         AND NOT EXISTS (
           SELECT 1 FROM resource_lineage_alias sa2
             JOIN resource_lineage sl2 ON sl2.id = sa2.lineage_id
            WHERE sl2.tenant_ref = sl.tenant_ref AND sl2.resource_type = sl.resource_type
              AND sa2.natural_key = sa.natural_key AND sa2.lineage_id <> sa.lineage_id
              AND ${window('sa2')}))`,
    values: [tenantRef, normalized.entities, at],
  };
}

/** The read scope of a principal id, from current grants. Unknown principals have none. */
export async function scopeForPrincipalId(client, principalId, capability, at = new Date()) {
  const principal = await findPrincipalById(client, principalId);
  if (!principal) return { central: false, entities: [] };
  return capabilityScope(client, principal, capability, at);
}

/**
 * Current ownership for resources named by (type, natural key, as-of). Each answer is
 * { resourceType, naturalKey, lineageId, evidenceId, state, entityCode, entityCodes,
 *   expiresAt } where state is an ownership state or `unattributed` (no single lineage
 * held the key at that time).
 */
export async function ownershipOfResources(client, { tenantRef, resources }) {
  const answers = [];
  for (const { resourceType, naturalKey, asOf } of resources) {
    const when = asOf ? new Date(asOf) : new Date();
    const { rows: lineages } = await client.query(
      `SELECT DISTINCT sa.lineage_id
         FROM resource_lineage_alias sa
         JOIN resource_lineage sl ON sl.id = sa.lineage_id
        WHERE sl.tenant_ref = $1 AND sl.resource_type = $2 AND sa.natural_key = $3
          AND sa.valid_from <= $4 AND (sa.valid_until IS NULL OR sa.valid_until > $4)`,
      [tenantRef, resourceType, naturalKey, when],
    );
    const base = { resourceType, naturalKey, lineageId: null, evidenceId: null, entityCode: null, entityCodes: [], expiresAt: null };
    if (lineages.length !== 1) {
      answers.push({ ...base, state: 'unattributed' });
      continue;
    }
    answers.push({ ...base, lineageId: lineages[0].lineage_id, ...await currentOwnership(client, tenantRef, lineages[0].lineage_id) });
  }
  return answers;
}

async function currentOwnership(client, tenantRef, lineageId) {
  const { rows: [row] } = await client.query(
    `SELECT id, state, entity_code, entity_codes, expires_at
       FROM resource_ownership_evidence
      WHERE tenant_ref = $1 AND lineage_id = $2 AND superseded_at IS NULL`,
    [tenantRef, lineageId],
  );
  if (!row) return { evidenceId: null, state: 'never-resolved', entityCode: null, entityCodes: [], expiresAt: null };
  return {
    evidenceId: row.id, state: row.state, entityCode: row.entity_code,
    entityCodes: [...(row.entity_codes ?? [])].sort(), expiresAt: new Date(row.expires_at).toISOString(),
  };
}

/** Whether a resolved ownership answer is visible to `scope` at `at`. */
export function ownershipVisibleTo(scope, ownership, at = new Date()) {
  const normalized = normalizedScope(scope);
  if (normalized.central) return true;
  if (!ownership?.expiresAt || !(new Date(ownership.expiresAt) > at)) return false;
  if (ownership.state === 'owned') return normalized.entities.includes(ownership.entityCode);
  if (ownership.state === 'shared') return ownership.entityCodes.some((code) => normalized.entities.includes(code));
  return false;
}

/**
 * The entity scope an approval request is bound to, captured when it is requested.
 * `centralOnly` is true when any resource is not owned by exactly one entity; such a
 * request can only be decided by a central approver.
 */
export async function captureApprovalScope(client, { tenantRef, resources, at = new Date() }) {
  const owned = await ownershipOfResources(client, { tenantRef, resources });
  const fresh = (entry) => entry.expiresAt && new Date(entry.expiresAt) > at;
  const centralOnly = owned.length === 0 || owned.some((entry) => entry.state !== 'owned' || !fresh(entry));
  return {
    version: SCOPE_VERSION,
    capturedAt: at.toISOString(),
    centralOnly,
    entities: [...new Set(owned.filter((entry) => entry.state === 'owned').map((entry) => entry.entityCode))].sort(),
    resources: owned.map(({ resourceType, naturalKey, lineageId, evidenceId, state, entityCode, entityCodes }) => (
      { resourceType, naturalKey, lineageId, evidenceId, state, entityCode, entityCodes })),
  };
}

const sameOwner = (captured, current) => captured.state === current.state
  && (captured.entityCode ?? null) === (current.entityCode ?? null)
  && JSON.stringify([...(captured.entityCodes ?? [])].sort()) === JSON.stringify(current.entityCodes);

function covers(scope, entities) {
  return scope.central || (entities.length > 0 && entities.every((code) => scope.entities.includes(code)));
}

/**
 * May `approverId` decide a request bound to `entityScope` at `at`?
 *
 * Returns { eligible: true, via: 'central' | 'entity' } or
 *   { eligible: false, reason, invalidate?: true, handoff?: 'central' }.
 * `invalidate` means the request itself is no longer valid (its resources changed
 * owner, or the requester no longer holds `requesterCapability` over them) and must
 * be closed. A request without a captured scope (made before task 90) is decided only
 * by a central approver.
 */
export async function approvalEligibility(client, {
  tenantRef, entityScope, approverId, approverScope = null, requesterId, requesterCapability, at = new Date(),
}) {
  // A caller that has just resolved the approver's grants (the portal proxy does so on
  // every request) may pass them; otherwise they are read here.
  const approver = approverScope ? normalizedScope(approverScope) : await scopeForPrincipalId(client, approverId, 'approve', at);
  if (!entityScope) {
    return approver.central ? { eligible: true, via: 'central' } : { eligible: false, reason: 'central-approval-required', handoff: 'central' };
  }
  if (entityScope.version !== SCOPE_VERSION || !Array.isArray(entityScope.resources)) {
    return { eligible: false, reason: 'scope-unreadable', invalidate: true };
  }

  // Ownership is re-read now. A change of owner invalidates the request; evidence that
  // has merely expired refuses until it is re-resolved.
  const current = [];
  for (const captured of entityScope.resources) {
    const now = captured.lineageId
      ? { ...captured, ...await currentOwnership(client, tenantRef, captured.lineageId) }
      : { ...captured, state: 'unattributed', entityCode: null, entityCodes: [] };
    if (!sameOwner(captured, now)) return { eligible: false, reason: 'ownership-changed', invalidate: true };
    if (now.state !== 'unattributed' && !(now.expiresAt && new Date(now.expiresAt) > at)) {
      return { eligible: false, reason: 'ownership-expired', handoff: 'central' };
    }
    current.push(now);
  }
  const centralOnly = entityScope.centralOnly === true || current.some((entry) => entry.state !== 'owned');
  const entities = [...new Set(current.filter((entry) => entry.state === 'owned').map((entry) => entry.entityCode))].sort();

  // An entity-decidable request rests on the requester's entity grant, so losing it
  // invalidates the request. (Every job is re-authorized against its requester again
  // when the worker runs it.)
  if (requesterCapability && !centralOnly) {
    const requester = await scopeForPrincipalId(client, requesterId, requesterCapability, at);
    if (!covers(requester, entities)) {
      return { eligible: false, reason: 'requester-grant-changed', invalidate: true };
    }
  }
  if (approver.central) return { eligible: true, via: 'central' };
  if (centralOnly) return { eligible: false, reason: 'central-approval-required', handoff: 'central' };
  if (covers(approver, entities)) return { eligible: true, via: 'entity' };
  return { eligible: false, reason: 'outside-approval-scope', handoff: 'central' };
}

/**
 * The approval inbox filter for a scoped approver, as SQL over approval_request.entity_scope.
 * Central approvers see every request; an entity approver sees only requests whose
 * captured scope is entity-decidable and entirely inside their entities. Requests
 * without a captured scope are central-only.
 */
export function approvalInboxPredicate(scope, { column = 'entity_scope', nextParam }) {
  const normalized = normalizedScope(scope);
  if (normalized.central) return { sql: 'TRUE', values: [] };
  if (normalized.entities.length === 0) return { sql: 'FALSE', values: [] };
  return {
    sql: `(${column} IS NOT NULL
           AND (${column}->>'centralOnly') = 'false'
           AND jsonb_array_length(${column}->'entities') > 0
           AND ARRAY(SELECT jsonb_array_elements_text(${column}->'entities')) <@ $${nextParam}::text[])`,
    values: [normalized.entities],
  };
}

/**
 * The server keeps the full safety graph; a scoped viewer receives it with every key
 * outside their scope replaced. Decisions (completeness, refusals, fingerprint) are
 * computed over the full graph and passed through unchanged, so a hidden dependency
 * still blocks or hands off. Redacted keys collapse to one marker per list, so the
 * number of foreign resources is not disclosed.
 */
export const REDACTED = Object.freeze({ redacted: true, label: 'A dependency outside your scope' });

export function redactImpactForScope(analysis, { isVisible }) {
  let redacted = false;
  const keysOf = (list) => {
    const visible = [];
    let hidden = false;
    for (const key of list ?? []) {
      if (isVisible(key)) visible.push(key); else hidden = true;
    }
    if (hidden) redacted = true;
    return hidden ? [...visible, REDACTED] : visible;
  };
  const hiddenDependencies = (analysis.hidden ?? []).map((node) => (isVisible(node.key) ? node : null));
  if (hiddenDependencies.some((node) => node === null)) redacted = true;
  const result = {
    ...analysis,
    keys: keysOf(analysis.keys),
    impacted: keysOf(analysis.impacted),
    closure: keysOf(analysis.closure),
    visibleClosure: keysOf(analysis.visibleClosure),
    waves: (analysis.waves ?? []).map((wave) => (Array.isArray(wave) ? keysOf(wave) : wave)),
    edgeEffects: (analysis.edgeEffects ?? []).filter((edge) => {
      const ok = isVisible(edge.from) && isVisible(edge.to);
      if (!ok) redacted = true;
      return ok;
    }),
    cycles: (analysis.cycles ?? []).map((cycle) => keysOf(cycle)),
    hidden: [...hiddenDependencies.filter(Boolean), ...(hiddenDependencies.includes(null) ? [REDACTED] : [])],
    truncated: keysOf(analysis.truncated),
    patches: (analysis.patches ?? []).filter((patch) => {
      const ok = isVisible(patch.naturalKey) && isVisible(patch.symbol);
      if (!ok) redacted = true;
      return ok;
    }),
  };
  if (redacted) {
    result.scopeHandoff = {
      required: true,
      handoff: 'central',
      reason: 'dependency-outside-scope',
      explanation: 'This change touches at least one resource outside your entities. A central approver must review it.',
    };
  }
  return result;
}
