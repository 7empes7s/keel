/**
 * Roadmap task-65: credential and service recovery completion.
 *
 * Restoring configuration is not the same as restoring a working service.
 * KEEL can never read some parts of an object back, so it can never write them
 * either:
 *   - client secrets and certificates (passwordCredentials, keyCredentials);
 *   - admin consent;
 *   - the new object id a recreate assigns, which every system outside the
 *     tenant must be told about.
 *
 * After an enforced restore, this module emits OWNED completion items for
 * exactly that remaining work, and tracks each through to verified evidence.
 *
 * A resource moves through three states:
 *   configuration-restored     — KEEL wrote and verified the configuration;
 *                                credential/consent/integration items are open
 *   service-validation-pending — only the service-validation check remains
 *   verified-complete          — every item closed with evidence (or none needed)
 *
 * Guarantees:
 *  - A recreate is never complete immediately: it always emits at least an
 *    integration item (new id) and a service-validation item.
 *  - Only metadata and evidence REFERENCES are stored. Evidence has a closed
 *    schema; any other field (e.g. a pasted secret) is refused, and so is
 *    secret-shaped text in an allowed field. Nothing is redacted and then kept.
 *  - Closing or reopening an item re-checks the actor's CURRENT `restore`
 *    capability (a revoked or disabled principal cannot). It requires linked
 *    evidence, and is recorded in the tamper-evident evidence chain.
 *  - Emission and closing are idempotent: a re-run never duplicates an item,
 *    and closing a verified item again changes nothing.
 */
import { redactSecrets } from '../../tools/tenant-probe/graph.mjs';
import { can } from '../authz/can.mjs';
import { findPrincipalById } from '../authz/principals.mjs';
import { appendEvidence } from '../govern/evidence.mjs';

export const COMPLETION_KINDS = Object.freeze(['credential', 'certificate', 'consent', 'integration', 'service-validation']);
export const COMPLETION_EVIDENCE_TYPES = Object.freeze(['ticket', 'link', 'log-reference', 'attestation']);
export const COMPLETION_EVIDENCE_KIND = 'recovery-completion';
const EVIDENCE_FIELDS = new Set(['type', 'reference', 'note', 'observedAt']);
const CONFIGURATION_KINDS = new Set(['credential', 'certificate', 'consent', 'integration']);

const item = (kind, requirement, description) => Object.freeze({ kind, requirement, description });

/**
 * What a recovered object of each type still needs, beyond its configuration.
 * Keyed by resource type; the `recreate` list applies only when a new object
 * was created, the `restore` list after a soft-delete restore (which keeps the
 * id and, for applications, the stored credentials).
 */
export const COMPLETION_RULES = Object.freeze({
  application: {
    recreate: [
      item('credential', 'passwordCredentials', 'Issue new client secrets and update every consumer that authenticates as this app'),
      item('certificate', 'keyCredentials', 'Upload certificates again and update every consumer that authenticates with them'),
      item('consent', 'adminConsent', 'Grant admin consent again for the application permissions'),
    ],
    restore: [],
    validation: item('service-validation', 'signIn', 'Confirm a real sign-in or token request succeeds for the application'),
  },
  servicePrincipal: {
    recreate: [item('consent', 'adminConsent', 'Grant admin consent and app role assignments again')],
    restore: [],
    validation: item('service-validation', 'signIn', 'Confirm the service principal signs in and its integrations work'),
  },
  identityProvider: {
    recreate: [item('credential', 'clientSecret', 'Enter the identity provider client secret again')],
    restore: [],
    validation: item('service-validation', 'federatedSignIn', 'Confirm a federated sign-in through this provider succeeds'),
  },
  user: {
    recreate: [item('credential', 'password', 'Issue a new password and have the user re-register MFA methods')],
    restore: [],
    validation: item('service-validation', 'signIn', 'Confirm the user can sign in'),
  },
});

const DEFAULT_RULE = Object.freeze({
  recreate: [],
  restore: [],
  validation: item('service-validation', 'serviceCheck', 'Confirm the services that depend on this object work'),
});

/** The completion items an applied recovery leaves open. Update/none/delete leave none. */
export function completionItemsFor({ resourceType, mechanism }) {
  const rule = COMPLETION_RULES[resourceType] ?? DEFAULT_RULE;
  if (mechanism === 'recreate') {
    return [
      ...rule.recreate,
      item('integration', 'newObjectId', 'A new object id was assigned: update every external system that referenced the old id'),
      rule.validation,
    ];
  }
  if (mechanism === 'soft-delete-restore') {
    return [...rule.restore, ...(COMPLETION_RULES[resourceType] ? [rule.validation] : [])];
  }
  return [];
}

/** Resource-level state from its items. */
export function resourceCompletionState(items) {
  const open = items.filter((entry) => entry.state !== 'verified');
  if (open.length === 0) return 'verified-complete';
  if (open.some((entry) => CONFIGURATION_KINDS.has(entry.kind))) return 'configuration-restored';
  return 'service-validation-pending';
}

export class CompletionAuthorizationError extends Error {
  constructor(message) {
    super(message);
    this.name = 'CompletionAuthorizationError';
  }
}

export class CompletionEvidenceError extends Error {
  constructor(message) {
    super(message);
    this.name = 'CompletionEvidenceError';
  }
}

export class CompletionItemNotFoundError extends Error {
  constructor(id) {
    super(`completion item not found: ${id}`);
    this.name = 'CompletionItemNotFoundError';
  }
}

const SECRET_SHAPES = [
  /-----BEGIN [A-Z ]*(PRIVATE KEY|CERTIFICATE)-----/,
  /[A-Za-z0-9_~.-]{3}\dQ~[A-Za-z0-9_~.-]{20,}/, // Entra client-secret shape
];

function secretShaped(text) {
  return redactSecrets(text) !== text || SECRET_SHAPES.some((pattern) => pattern.test(text));
}

/**
 * Evidence is a REFERENCE to proof held elsewhere (a ticket, a link, a log
 * query id, an attestation), never the credential itself. Unknown fields and
 * secret-shaped text are refused outright — never stored, never redacted-and-kept.
 */
export function validateCompletionEvidence(evidence) {
  if (!evidence || typeof evidence !== 'object' || Array.isArray(evidence)) {
    throw new CompletionEvidenceError('completion requires linked evidence');
  }
  const extra = Object.keys(evidence).filter((key) => !EVIDENCE_FIELDS.has(key));
  if (extra.length > 0) {
    throw new CompletionEvidenceError(`evidence may only carry ${[...EVIDENCE_FIELDS].join(', ')} — refused field(s): ${extra.join(', ')}`);
  }
  if (!COMPLETION_EVIDENCE_TYPES.includes(evidence.type)) {
    throw new CompletionEvidenceError(`evidence type must be one of ${COMPLETION_EVIDENCE_TYPES.join(', ')}`);
  }
  if (typeof evidence.reference !== 'string' || evidence.reference.trim().length === 0 || evidence.reference.length > 500) {
    throw new CompletionEvidenceError('evidence needs a reference (1–500 characters) to where the proof is held');
  }
  if (evidence.note !== undefined && (typeof evidence.note !== 'string' || evidence.note.length > 1000)) {
    throw new CompletionEvidenceError('evidence note must be text of at most 1000 characters');
  }
  for (const text of [evidence.reference, evidence.note ?? '']) {
    if (secretShaped(text)) {
      throw new CompletionEvidenceError('evidence looks like it contains a secret or key — store a reference to the proof, never the credential');
    }
  }
  const observedAt = evidence.observedAt === undefined ? null : new Date(evidence.observedAt);
  if (observedAt && Number.isNaN(observedAt.valueOf())) throw new CompletionEvidenceError('evidence.observedAt is not a timestamp');
  return {
    type: evidence.type,
    reference: evidence.reference.trim(),
    ...(evidence.note ? { note: evidence.note } : {}),
    ...(observedAt ? { observedAt: observedAt.toISOString() } : {}),
  };
}

function normalize(row) {
  return {
    id: row.id,
    tenantRef: row.tenant_ref,
    restoreRef: row.restore_ref,
    naturalKey: row.natural_key,
    resourceType: row.resource_type,
    mechanism: row.mechanism,
    kind: row.kind,
    requirement: row.requirement,
    description: row.description,
    owner: row.owner,
    state: row.state,
    evidence: row.evidence ?? [],
    closedBy: row.closed_by ?? null,
    closedAt: row.closed_at ? new Date(row.closed_at).toISOString() : null,
    reopenCount: row.reopen_count ?? 0,
    createdAt: row.created_at ? new Date(row.created_at).toISOString() : null,
  };
}

/**
 * Emits the items an enforced restore left open. `applied` are
 * { naturalKey, resourceType, mechanism } for resources that were actually
 * written. Idempotent per (tenant, restoreRef, naturalKey, kind, requirement).
 */
export async function emitCompletionItems(client, { tenantRef, restoreRef, owner, applied }) {
  if (typeof restoreRef !== 'string' || restoreRef.length === 0) throw new Error('emitCompletionItems requires restoreRef');
  const emitted = [];
  for (const resource of applied) {
    for (const entry of completionItemsFor(resource)) {
      const { rows } = await client.query(
        `INSERT INTO recovery_completion_item
           (tenant_ref, restore_ref, natural_key, resource_type, mechanism, kind, requirement, description, owner)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
         ON CONFLICT (tenant_ref, restore_ref, natural_key, kind, requirement) DO NOTHING
         RETURNING *`,
        [tenantRef, restoreRef, resource.naturalKey, resource.resourceType, resource.mechanism,
          entry.kind, entry.requirement, entry.description, owner ?? null],
      );
      if (rows[0]) emitted.push(normalize(rows[0]));
    }
  }
  return emitted;
}

export async function listCompletionItems(client, { tenantRef, restoreRef }) {
  const { rows } = await client.query(
    `SELECT * FROM recovery_completion_item WHERE tenant_ref = $1 AND restore_ref = $2 ORDER BY natural_key, kind, requirement`,
    [tenantRef, restoreRef],
  );
  return rows.map(normalize);
}

/** Per-resource summary for a restore: state plus its items. */
export function summarizeCompletion(items) {
  const byResource = new Map();
  for (const entry of items) {
    if (!byResource.has(entry.naturalKey)) byResource.set(entry.naturalKey, []);
    byResource.get(entry.naturalKey).push(entry);
  }
  return [...byResource].map(([naturalKey, entries]) => ({
    naturalKey, resourceType: entries[0].resourceType, mechanism: entries[0].mechanism,
    state: resourceCompletionState(entries), items: entries,
  }));
}

async function authorize(client, actorId, at) {
  const principal = await findPrincipalById(client, actorId);
  if (!principal || !(await can(client, principal, 'restore', at))) {
    throw new CompletionAuthorizationError('only a principal currently holding the restore capability can change a completion item');
  }
  return principal;
}

async function loadItem(client, { tenantRef, itemId }) {
  const { rows } = await client.query(
    `SELECT * FROM recovery_completion_item WHERE id::text = $1 AND tenant_ref = $2 FOR UPDATE`,
    [itemId, tenantRef],
  );
  if (!rows[0]) throw new CompletionItemNotFoundError(itemId);
  return rows[0];
}

/** Closes an item with linked evidence. Re-closing a verified item is a no-op. */
export async function completeItem(client, { tenantRef, itemId, actorId, evidence, at = new Date() }) {
  const linked = validateCompletionEvidence(evidence);
  await client.query('BEGIN');
  try {
    await authorize(client, actorId, at);
    const row = await loadItem(client, { tenantRef, itemId });
    if (row.state === 'verified') {
      await client.query('COMMIT');
      return { item: normalize(row), changed: false };
    }
    const entry = { ...linked, recordedBy: actorId, recordedAt: at.toISOString() };
    const { rows } = await client.query(
      `UPDATE recovery_completion_item
          SET state = 'verified', evidence = evidence || $2::jsonb, closed_by = $3, closed_at = $4, updated_at = $4
        WHERE id = $1
        RETURNING *`,
      [row.id, JSON.stringify([entry]), actorId, at],
    );
    await client.query(
      `INSERT INTO recovery_completion_event (item_id, tenant_ref, from_state, to_state, actor, evidence, at)
       VALUES ($1,$2,$3,'verified',$4,$5,$6)`,
      [row.id, tenantRef, row.state, actorId, entry, at],
    );
    await appendEvidence(client, {
      tenantRef,
      kind: COMPLETION_EVIDENCE_KIND,
      subject: {
        itemId: row.id, restoreRef: row.restore_ref, naturalKey: row.natural_key, kind: row.kind,
        requirement: row.requirement, transition: 'verified', evidenceType: linked.type, evidenceReference: linked.reference,
      },
      actor: actorId,
    });
    await client.query('COMMIT');
    return { item: normalize(rows[0]), changed: true };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  }
}

/** Reopens a verified item (the evidence trail is kept). */
export async function reopenItem(client, { tenantRef, itemId, actorId, reason, at = new Date() }) {
  if (typeof reason !== 'string' || reason.trim().length === 0 || secretShaped(reason)) {
    throw new CompletionEvidenceError('reopening requires a reason (and never a secret)');
  }
  await client.query('BEGIN');
  try {
    await authorize(client, actorId, at);
    const row = await loadItem(client, { tenantRef, itemId });
    if (row.state !== 'verified') {
      await client.query('COMMIT');
      return { item: normalize(row), changed: false };
    }
    const { rows } = await client.query(
      `UPDATE recovery_completion_item
          SET state = 'pending', closed_by = NULL, closed_at = NULL, reopen_count = reopen_count + 1, updated_at = $2
        WHERE id = $1
        RETURNING *`,
      [row.id, at],
    );
    await client.query(
      `INSERT INTO recovery_completion_event (item_id, tenant_ref, from_state, to_state, actor, evidence, at)
       VALUES ($1,$2,'verified','pending',$3,$4,$5)`,
      [row.id, tenantRef, actorId, { reason: reason.trim() }, at],
    );
    await appendEvidence(client, {
      tenantRef,
      kind: COMPLETION_EVIDENCE_KIND,
      subject: { itemId: row.id, restoreRef: row.restore_ref, naturalKey: row.natural_key, kind: row.kind, requirement: row.requirement, transition: 'reopened', reason: reason.trim() },
      actor: actorId,
    });
    await client.query('COMMIT');
    return { item: normalize(rows[0]), changed: true };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  }
}
