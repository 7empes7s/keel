// engine/itsm/bridge.mjs
//
// Roadmap task-96 (WS8): the canonical approval mirror and the adapter contract.
//
// KEEL holds the one canonical decision. For an action that needs approval it is the
// approval_request row (govern/approvals.mjs), decided once, under a row lock, and
// minting at most one job (idempotency key `approval:<request id>`). For an emergency
// change it is the change intent (policy/changeIntent.mjs) and its decision_digest. An
// ITSM change record is a MIRROR of that decision:
//
//   - itsm_record binds one external record (adapter, external ref) to the CURRENT plan:
//     an approval request, its plan digest (approvals.mjs#approvalPlanDigest) and a
//     version. Re-planning (mirrorApprovalRequest with a new request for the same record)
//     moves the record to the next version and supersedes the old request, so it can
//     never be approved afterwards. Every version stays in itsm_record_version.
//   - The decision for a version is recorded once in itsm_decision (append-only, one per
//     version): outcome, approver principal, source (portal, itsm or keel), the external
//     event id it came from, the plan digest and version, and decision_digest. Its row
//     id is the decision's immutable event id. It is mirrored out through the outbox.
//
// Inbound callbacks (receiveCallback) never carry authority on their own. A callback
// that says "approved" decides only when ALL of these hold at decision time:
//   1. its event id was not handled before (itsm_inbox, UNIQUE per adapter): a
//      duplicate returns the first outcome and acts no further;
//   2. it names the record's CURRENT version and plan digest: a delayed callback for an
//      earlier version or another plan is refused (stale-version, stale-plan), and the
//      digest is checked again under the request's row lock (expectedPlanDigest);
//   3. its external user is mapped explicitly to an enabled KEEL principal
//      (itsm_identity_map); an unmapped user is refused;
//   4. that principal is, NOW, an eligible approver of that request: approveRequest runs
//      with enforceScope, so current grants and task-90 entity scope decide, and
//      self-approval is refused as always.
// When the request was already decided (by the portal, or by an earlier callback), a
// callback with the same outcome is `already-decided` and acts no further; one with the
// other outcome is a `conflict`: the first committed decision stands (the request row
// lock orders them), the conflict is recorded in the inbox and as evidence, and a
// conflict event is mirrored out so the external record shows the canonical decision.
//
// A lost callback is recovered by reconcileRecord, which polls the adapter for the
// record's current state and feeds it through the same path under a deterministic event
// id. Lost outbound deliveries are retried by the outbox (outbox.mjs).
//
// Nothing here contacts an external system: adapters are injected. Callback
// authentication (signatures, replay windows) belongs to the adapter that receives the
// HTTP request (roadmap task-97); this module receives already-authenticated events.
import { can } from '../authz/can.mjs';
import { findPrincipalById } from '../authz/principals.mjs';
import { appendEvidence } from '../govern/evidence.mjs';
import {
  ApprovalClosedError, ApprovalExpiredError, ApprovalInvalidatedError, ApprovalPlanChangedError, ApprovalScopeError,
  PromotionRefusedError, SelfApprovalError, approvalPlanDigest, approveRequest, rejectRequest, supersedeRequest,
} from '../govern/approvals.mjs';
import { getChangeIntent } from '../policy/changeIntent.mjs';
import { canonicalDigest } from '../restore/dryRunArtifact.mjs';
import { enqueueItsmEvent, drainItsmOutbox } from './outbox.mjs';

export const ITSM_MIRROR_EVIDENCE_KIND = 'itsm-mirror';
export const ITSM_CALLBACK_EVIDENCE_KIND = 'itsm-callback';
export const ITSM_CONFLICT_EVIDENCE_KIND = 'itsm-decision-conflict';

/**
 * What every ITSM adapter provides. The bridge calls nothing else.
 *   name                     stable adapter id, e.g. 'servicenow'
 *   deliver(event)           sends one outbox event { eventId, kind, externalRef,
 *                            payload }; resolves on acceptance, throws on failure
 *                            (error.permanent = true for a rejection retrying cannot fix).
 *                            Must deduplicate on eventId: delivery is at-least-once.
 *   fetchRecord(externalRef) the record's current state for reconciliation:
 *                            { status, externalUser, version, planDigest } or null.
 * Inbound events handed to receiveCallback are already authenticated by the adapter and
 * normalized to { eventId, externalRef, status, externalUser, version, planDigest,
 * reason? } with status 'approved', 'rejected' or any other (informational) value.
 */
export const ITSM_ADAPTER_CONTRACT = Object.freeze({
  methods: Object.freeze(['deliver', 'fetchRecord']),
  deliverySemantics: 'at-least-once',
  dedupKeyFields: Object.freeze(['adapter', 'eventId']),
  decisionStatuses: Object.freeze(['approved', 'rejected']),
});

const ADAPTER_NAME = /^[a-z][a-z0-9-]{1,39}$/;
const EXTERNAL_REF = /^[A-Za-z0-9][A-Za-z0-9._:/#-]{0,127}$/;
const EVENT_ID = /^[A-Za-z0-9][A-Za-z0-9._:/#@+=-]{0,199}$/;

/** A refused mirror operation. `code`: invalid, not-authorized, not-found, not-pending,
 * principal-not-found. */
export class ItsmMirrorError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

export function assertAdapter(adapter) {
  if (!adapter || typeof adapter.name !== 'string' || !ADAPTER_NAME.test(adapter.name)) {
    throw new ItsmMirrorError('invalid', 'an adapter needs a valid name');
  }
  for (const method of ITSM_ADAPTER_CONTRACT.methods) {
    if (typeof adapter[method] !== 'function') throw new ItsmMirrorError('invalid', `adapter ${adapter.name} does not implement ${method}`);
  }
  return adapter;
}

function adapterName(adapter) {
  const name = typeof adapter === 'string' ? adapter : adapter?.name;
  if (typeof name !== 'string' || !ADAPTER_NAME.test(name)) throw new ItsmMirrorError('invalid', 'an adapter needs a valid name');
  return name;
}

async function requireCapability(client, principalId, capability) {
  const principal = principalId ? await findPrincipalById(client, String(principalId)) : null;
  if (!principal || !(await can(client, principal, capability, new Date()))) {
    throw new ItsmMirrorError('not-authorized', `requires the ${capability} capability`);
  }
  return principal;
}

function iso(value) {
  return value == null ? null : new Date(value).toISOString();
}

async function findRecord(client, { tenantRef, adapter, externalRef }) {
  const { rows: [record] } = await client.query(
    'SELECT * FROM itsm_record WHERE tenant_ref = $1 AND adapter = $2 AND external_ref = $3',
    [tenantRef, adapter, externalRef],
  );
  return record ?? null;
}

async function getRequest(client, id) {
  const { rows: [request] } = await client.query('SELECT * FROM approval_request WHERE id = $1', [id]);
  return request ?? null;
}

/** Maps an external user of one adapter to a KEEL principal (configuration capability).
 * The mapping says who the person is; their current KEEL grants decide what they may do. */
export async function mapExternalIdentity(client, { tenantRef, adapter, externalUser, principalId, requestedBy }) {
  const name = adapterName(adapter);
  if (typeof externalUser !== 'string' || externalUser.length === 0 || externalUser.length > 256) {
    throw new ItsmMirrorError('invalid', 'an external user is required');
  }
  await requireCapability(client, requestedBy, 'configuration');
  const principal = principalId ? await findPrincipalById(client, String(principalId)) : null;
  if (!principal) throw new ItsmMirrorError('principal-not-found', 'the principal is not known to KEEL');
  await client.query(
    `INSERT INTO itsm_identity_map (tenant_ref, adapter, external_user, principal_id, created_by)
     VALUES ($1,$2,$3,$4,$5)
     ON CONFLICT (tenant_ref, adapter, external_user)
     DO UPDATE SET principal_id = EXCLUDED.principal_id, created_by = EXCLUDED.created_by, created_at = now()`,
    [tenantRef, name, externalUser, principal.id, String(requestedBy)],
  );
  await appendEvidence(client, {
    tenantRef,
    kind: ITSM_MIRROR_EVIDENCE_KIND,
    subject: { outcome: 'identity-mapped', adapter: name, externalUser, principalId: String(principal.id) },
    actor: String(requestedBy),
  });
}

async function principalForExternalUser(client, { tenantRef, adapter, externalUser }) {
  if (typeof externalUser !== 'string' || externalUser.length === 0) return null;
  const { rows: [row] } = await client.query(
    `SELECT p.* FROM itsm_identity_map m JOIN principal p ON p.id = m.principal_id
      WHERE m.tenant_ref = $1 AND m.adapter = $2 AND m.external_user = $3 AND p.disabled_at IS NULL`,
    [tenantRef, adapter, externalUser],
  );
  return row ?? null;
}

function recordEventId(record, version) {
  return `keel:${record.id}:v${version}:record`;
}

/**
 * Mirrors a pending approval request to an external record (configuration capability).
 * The first call binds the record at version 1. A later call naming the same record with
 * ANOTHER pending request is a re-plan: the record moves to the next version, the old
 * request is superseded (closed, so it can never be approved) and the new binding is
 * mirrored out. Calling again with the bound request is a no-op. A record whose current
 * version was already decided cannot be re-planned.
 */
export async function mirrorApprovalRequest(client, { tenantRef, adapter, externalRef, requestId, requestedBy }) {
  const name = adapterName(adapter);
  if (typeof externalRef !== 'string' || !EXTERNAL_REF.test(externalRef)) throw new ItsmMirrorError('invalid', 'the external reference is not valid');
  await requireCapability(client, requestedBy, 'configuration');
  const request = await getRequest(client, requestId);
  if (!request) throw new ItsmMirrorError('not-found', 'approval request not found');
  if (request.status !== 'pending' || new Date(request.expires_at) <= new Date()) {
    throw new ItsmMirrorError('not-pending', 'only a pending approval request can be mirrored');
  }
  const planDigest = approvalPlanDigest(request);

  let record;
  let superseded = null;
  await client.query('BEGIN');
  let committed = false;
  try {
    const { rows: [existing] } = await client.query(
      'SELECT * FROM itsm_record WHERE tenant_ref = $1 AND adapter = $2 AND external_ref = $3 FOR UPDATE',
      [tenantRef, name, externalRef],
    );
    if (existing && existing.subject_kind !== 'approval_request') {
      throw new ItsmMirrorError('invalid', 'this record mirrors an emergency change, not an approval request');
    }
    if (existing && String(existing.approval_request_id) === String(request.id)) {
      await client.query('COMMIT');
      committed = true;
      return existing;
    }
    if (existing) {
      const { rows: [decided] } = await client.query(
        'SELECT 1 FROM itsm_decision WHERE record_id = $1 AND version = $2',
        [existing.id, existing.version],
      );
      const previous = await getRequest(client, existing.approval_request_id);
      if (decided || ['approved', 'rejected'].includes(previous?.status)) {
        throw new ItsmMirrorError('invalid', 'this record was already decided; mirror the new plan to a new record');
      }
      const { rows: [moved] } = await client.query(
        `UPDATE itsm_record SET approval_request_id = $2, plan_digest = $3, version = version + 1, updated_at = now()
          WHERE id = $1 RETURNING *`,
        [existing.id, request.id, planDigest],
      );
      record = moved;
      superseded = existing.approval_request_id;
    } else {
      const { rows: [created] } = await client.query(
        `INSERT INTO itsm_record (tenant_ref, adapter, external_ref, subject_kind, approval_request_id, plan_digest, version, created_by)
         VALUES ($1,$2,$3,'approval_request',$4,$5,1,$6) RETURNING *`,
        [tenantRef, name, externalRef, request.id, planDigest, String(requestedBy)],
      );
      record = created;
    }
    await client.query(
      `INSERT INTO itsm_record_version (record_id, tenant_ref, version, approval_request_id, plan_digest, bound_by)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [record.id, tenantRef, record.version, request.id, planDigest, String(requestedBy)],
    );
    await enqueueItsmEvent(client, {
      tenantRef, adapter: name, recordId: record.id, eventId: recordEventId(record, record.version), kind: 'record',
      payload: {
        externalRef, version: record.version, planDigest, requestId: String(request.id), action: request.action,
        expiresAt: iso(request.expires_at), supersedes: superseded ? String(superseded) : null,
      },
    });
    await client.query('COMMIT');
    committed = true;
  } finally {
    if (!committed) await client.query('ROLLBACK');
  }
  // Closed after the record moved: from this point no callback names the old request,
  // and the old request itself can no longer be decided from anywhere.
  if (superseded) await supersedeRequest(client, { tenantRef, id: superseded, supersededBy: request.id, actor: String(requestedBy) });
  await appendEvidence(client, {
    tenantRef,
    kind: ITSM_MIRROR_EVIDENCE_KIND,
    subject: {
      outcome: superseded ? 'replanned' : 'mirrored', recordId: String(record.id), adapter: name, externalRef,
      version: record.version, planDigest, requestId: String(request.id), supersededRequestId: superseded ? String(superseded) : null,
    },
    actor: String(requestedBy),
  });
  return record;
}

/**
 * Mirrors an approved emergency change (task-93) to an external record (configuration
 * capability). The intent was decided in KEEL; the mirrored decision carries its
 * decisionDigest unchanged, so both records name the same decision. Inbound callbacks
 * never decide an intent.
 */
export async function mirrorChangeIntent(client, { tenantRef, adapter, externalRef, intentId, requestedBy }) {
  const name = adapterName(adapter);
  if (typeof externalRef !== 'string' || !EXTERNAL_REF.test(externalRef)) throw new ItsmMirrorError('invalid', 'the external reference is not valid');
  await requireCapability(client, requestedBy, 'configuration');
  const intent = await getChangeIntent(client, { tenantRef, intentId });
  if (!intent) throw new ItsmMirrorError('not-found', 'emergency change not found');
  const existing = await findRecord(client, { tenantRef, adapter: name, externalRef });
  if (existing) {
    if (String(existing.change_intent_id) === intent.id) return existing;
    throw new ItsmMirrorError('invalid', 'this external record already mirrors another decision');
  }
  const { rows: [record] } = await client.query(
    `INSERT INTO itsm_record (tenant_ref, adapter, external_ref, subject_kind, change_intent_id, plan_digest, version, created_by)
     VALUES ($1,$2,$3,'change_intent',$4,$5,1,$6) RETURNING *`,
    [tenantRef, name, externalRef, intent.id, intent.transitionDigest, String(requestedBy)],
  );
  await client.query(
    `INSERT INTO itsm_record_version (record_id, tenant_ref, version, change_intent_id, plan_digest, bound_by)
     VALUES ($1,$2,1,$3,$4,$5)`,
    [record.id, tenantRef, intent.id, intent.transitionDigest, String(requestedBy)],
  );
  const decision = {
    kind: 'keel-change-intent-decision', tenantRef, adapter: name, externalRef, version: 1,
    intentId: intent.id, naturalKey: intent.naturalKey, resourceType: intent.resourceType,
    transitionDigest: intent.transitionDigest, outcome: 'approved', approver: intent.approver.id, owner: intent.owner.id,
    windowStart: intent.windowStart, windowEnd: intent.windowEnd, approvedAt: intent.approvedAt,
    decisionDigest: intent.decisionDigest,
  };
  const { rows: [stored] } = await client.query(
    `INSERT INTO itsm_decision (tenant_ref, record_id, version, change_intent_id, outcome, source, decided_by, decision, decision_digest)
     VALUES ($1,$2,1,$3,'approved','keel',$4,$5,$6) RETURNING *`,
    [tenantRef, record.id, intent.id, intent.approver.id, JSON.stringify(decision), intent.decisionDigest],
  );
  await enqueueItsmEvent(client, {
    tenantRef, adapter: name, recordId: record.id, eventId: `keel:decision:${stored.id}`, kind: 'decision',
    payload: { eventId: String(stored.id), decision, decisionDigest: intent.decisionDigest },
  });
  await appendEvidence(client, {
    tenantRef,
    kind: ITSM_MIRROR_EVIDENCE_KIND,
    subject: { outcome: 'intent-mirrored', recordId: String(record.id), adapter: name, externalRef, intentId: intent.id, decisionDigest: intent.decisionDigest },
    actor: String(requestedBy),
  });
  return record;
}

/** The canonical decision of one record version, as mirrored out. */
export function approvalDecision({ tenantRef, record, request, source, externalEventId }) {
  return {
    kind: 'keel-approval-decision', tenantRef, adapter: record.adapter, externalRef: record.external_ref,
    version: record.version, requestId: String(request.id), action: request.action, planDigest: approvalPlanDigest(request),
    outcome: request.status, approver: String(request.decided_by), source, externalEventId: externalEventId ?? null,
    decidedAt: iso(request.decided_at),
  };
}

/** Records the canonical decision for the record's current version once (UNIQUE per
 * version) and mirrors it out. Returns the stored decision row. */
async function recordDecision(client, { tenantRef, record, request, source, externalEventId = null }) {
  const decision = approvalDecision({ tenantRef, record, request, source, externalEventId });
  const decisionDigest = canonicalDigest(decision);
  const { rows: [stored] } = await client.query(
    `INSERT INTO itsm_decision
       (tenant_ref, record_id, version, approval_request_id, outcome, source, decided_by, external_event_id, decision, decision_digest)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
     ON CONFLICT (record_id, version) DO NOTHING
     RETURNING *`,
    [tenantRef, record.id, record.version, request.id, request.status, source, String(request.decided_by), externalEventId,
      JSON.stringify(decision), decisionDigest],
  );
  if (!stored) {
    const { rows: [existing] } = await client.query('SELECT * FROM itsm_decision WHERE record_id = $1 AND version = $2', [record.id, record.version]);
    return existing;
  }
  await enqueueItsmEvent(client, {
    tenantRef, adapter: record.adapter, recordId: record.id, eventId: `keel:decision:${stored.id}`, kind: 'decision',
    payload: { eventId: String(stored.id), decision, decisionDigest },
  });
  await appendEvidence(client, {
    tenantRef,
    kind: ITSM_MIRROR_EVIDENCE_KIND,
    subject: {
      outcome: 'decision-recorded', recordId: String(record.id), decisionId: String(stored.id), version: record.version,
      requestId: String(request.id), decision: request.status, source, externalEventId, decisionDigest,
    },
    actor: String(request.decided_by),
  });
  return stored;
}

/**
 * Records the canonical decision of every mirrored request decided outside a callback
 * (the portal) or whose callback was interrupted before it recorded one. The source is
 * `itsm` when a callback of the deciding principal was being applied to that request,
 * otherwise `portal`. Returns the decisions recorded now.
 */
export async function syncMirrorDecisions(client, { tenantRef, adapter = null, excludeInboxId = null }) {
  const { rows } = await client.query(
    `SELECT r.*, (SELECT i.external_event_id FROM itsm_inbox i
                   WHERE i.tenant_ref = r.tenant_ref AND i.record_id = r.id AND i.approval_request_id = q.id
                     AND i.principal_id::text = q.decided_by AND i.outcome IN ('applying','applied')
                     AND ($3::uuid IS NULL OR i.id <> $3::uuid)
                   ORDER BY i.received_at, i.id LIMIT 1) AS callback_event_id
       FROM itsm_record r
       JOIN approval_request q ON q.id = r.approval_request_id
      WHERE r.tenant_ref = $1 AND ($2::text IS NULL OR r.adapter = $2)
        AND q.status IN ('approved','rejected')
        AND NOT EXISTS (SELECT 1 FROM itsm_decision d WHERE d.record_id = r.id AND d.version = r.version)
      ORDER BY r.created_at, r.id`,
    [tenantRef, adapter ? adapterName(adapter) : null, excludeInboxId],
  );
  const recorded = [];
  for (const record of rows) {
    const request = await getRequest(client, record.approval_request_id);
    recorded.push(await recordDecision(client, {
      tenantRef, record, request,
      source: record.callback_event_id ? 'itsm' : 'portal', externalEventId: record.callback_event_id ?? null,
    }));
  }
  return recorded;
}

function normalizeEvent(event) {
  if (!event || typeof event !== 'object') throw new ItsmMirrorError('invalid', 'a callback event is required');
  const { eventId, externalRef, status, externalUser = null, version, planDigest, reason = null } = event;
  if (typeof eventId !== 'string' || !EVENT_ID.test(eventId)) throw new ItsmMirrorError('invalid', 'the callback needs a valid event id');
  if (typeof externalRef !== 'string' || !EXTERNAL_REF.test(externalRef)) throw new ItsmMirrorError('invalid', 'the callback needs a valid external reference');
  if (typeof status !== 'string' || status.length === 0 || status.length > 64) throw new ItsmMirrorError('invalid', 'the callback needs a status');
  return {
    eventId, externalRef, status,
    externalUser: typeof externalUser === 'string' ? externalUser.slice(0, 256) : null,
    version: Number.isInteger(version) ? version : null,
    planDigest: typeof planDigest === 'string' ? planDigest : null,
    reason: typeof reason === 'string' ? reason.slice(0, 1000) : null,
  };
}

/**
 * Handles one authenticated inbound callback (see the header for the rules). Returns
 * { outcome, duplicate, detail, inboxId } where outcome is one of:
 *   applied               this callback decided the request (approved or rejected)
 *   already-decided       the request already carries this outcome; nothing more done
 *   conflict              the request carries the other outcome; the first decision
 *                         stands and the conflict is recorded and mirrored out
 *   stale-version         the callback names an earlier (or unknown) record version
 *   stale-plan            the callback names another plan digest than the current one
 *   unmapped-identity     the external user is not mapped to an enabled principal
 *   refused-not-eligible  the mapped principal may not decide this request now
 *   refused-self-approval the mapped principal requested it
 *   refused-invalidated   the request's ownership or requester grant changed (task-90)
 *   refused-expired       the request expired or was superseded
 *   refused-promotion     a restore's dry run cannot be promoted
 *   ignored-status        a status that is not a decision
 *   not-decidable         the record mirrors an emergency change decided in KEEL
 *   unknown-record        no record with this reference
 * A redelivered event id returns the first outcome with duplicate: true.
 */
export async function receiveCallback(client, { tenantRef, adapter, event }) {
  const name = adapterName(adapter);
  const callback = normalizeEvent(event);
  let { rows: [inbox] } = await client.query(
    `INSERT INTO itsm_inbox (tenant_ref, adapter, external_event_id, external_ref, event)
     VALUES ($1,$2,$3,$4,$5)
     ON CONFLICT (tenant_ref, adapter, external_event_id) DO NOTHING
     RETURNING *`,
    [tenantRef, name, callback.eventId, callback.externalRef, JSON.stringify(callback)],
  );
  if (!inbox) {
    const { rows: [existing] } = await client.query(
      'SELECT * FROM itsm_inbox WHERE tenant_ref = $1 AND adapter = $2 AND external_event_id = $3',
      [tenantRef, name, callback.eventId],
    );
    // A handled event is never acted on again. One left 'applying' (the handler stopped
    // part-way) is resumed: every step below is idempotent.
    if (existing.outcome !== 'applying') {
      return { outcome: existing.outcome, duplicate: true, detail: existing.detail, inboxId: String(existing.id) };
    }
    inbox = existing;
  }

  const record = await findRecord(client, { tenantRef, adapter: name, externalRef: callback.externalRef });
  const finish = async (outcome, detail = {}) => {
    await client.query(
      `UPDATE itsm_inbox SET outcome = $2, detail = $3, handled_at = now(), record_id = COALESCE(record_id, $4)
        WHERE id = $1`,
      [inbox.id, outcome, JSON.stringify(detail), record?.id ?? null],
    );
    await appendEvidence(client, {
      tenantRef,
      kind: ITSM_CALLBACK_EVIDENCE_KIND,
      subject: {
        outcome, adapter: name, externalEventId: callback.eventId, externalRef: callback.externalRef,
        status: callback.status, externalUser: callback.externalUser, version: callback.version,
        planDigest: callback.planDigest, recordId: record ? String(record.id) : null, ...detail,
      },
      actor: `itsm:${name}`,
    });
    return { outcome, duplicate: false, detail, inboxId: String(inbox.id) };
  };

  if (!record) return finish('unknown-record');
  if (record.subject_kind !== 'approval_request') return finish('not-decidable');
  if (!ITSM_ADAPTER_CONTRACT.decisionStatuses.includes(callback.status)) return finish('ignored-status');
  // The plan the external approver saw must be the record's current plan, by version
  // and by digest. A delayed callback for a re-planned record names an older version.
  if (callback.version !== record.version) {
    return finish('stale-version', { currentVersion: record.version });
  }
  if (callback.planDigest !== record.plan_digest) return finish('stale-plan', { currentVersion: record.version });

  const principal = await principalForExternalUser(client, { tenantRef, adapter: name, externalUser: callback.externalUser });
  if (!principal) return finish('unmapped-identity');
  await client.query(
    'UPDATE itsm_inbox SET record_id = $2, approval_request_id = $3, principal_id = $4 WHERE id = $1',
    [inbox.id, record.id, record.approval_request_id, principal.id],
  );

  const decide = {
    tenantRef, id: record.approval_request_id, decidedBy: String(principal.id),
    // Current grants and entity scope decide, never the external status.
    enforceScope: true, expectedPlanDigest: callback.planDigest,
  };
  let jobId = null;
  try {
    if (callback.status === 'approved') {
      ({ job: { id: jobId } } = await approveRequest(client, decide));
    } else {
      await rejectRequest(client, { ...decide, reason: callback.reason ?? `rejected in ${name} ${callback.externalRef}` });
    }
  } catch (error) {
    if (error instanceof ApprovalClosedError) {
      const current = await getRequest(client, record.approval_request_id);
      // The decision that won is recorded first (a portal decision, or this callback's
      // own earlier attempt when the handler stopped after deciding). A callback of the
      // other outcome never counts as the source of the winning decision.
      const canonical = (await syncMirrorDecisions(client, {
        tenantRef, adapter: name, excludeInboxId: current.status === callback.status ? null : inbox.id,
      }))
        .find((row) => String(row.record_id) === String(record.id))
        ?? (await client.query('SELECT * FROM itsm_decision WHERE record_id = $1 AND version = $2', [record.id, record.version])).rows[0];
      const detail = {
        canonicalOutcome: current.status, canonicalDecidedBy: current.decided_by,
        decisionId: canonical ? String(canonical.id) : null, principalId: String(principal.id),
      };
      if (current.status === callback.status) return finish('already-decided', detail);
      await enqueueItsmEvent(client, {
        tenantRef, adapter: name, recordId: record.id, eventId: `keel:conflict:${inbox.id}`, kind: 'conflict',
        payload: {
          externalEventId: callback.eventId, externalStatus: callback.status, externalUser: callback.externalUser,
          canonicalOutcome: current.status, decisionId: detail.decisionId, decisionDigest: canonical?.decision_digest ?? null,
        },
      });
      await appendEvidence(client, {
        tenantRef,
        kind: ITSM_CONFLICT_EVIDENCE_KIND,
        subject: {
          recordId: String(record.id), requestId: String(current.id), canonicalOutcome: current.status,
          canonicalDecidedBy: current.decided_by, externalStatus: callback.status, externalEventId: callback.eventId,
          externalPrincipalId: String(principal.id),
        },
        actor: `itsm:${name}`,
      });
      return finish('conflict', detail);
    }
    if (error instanceof ApprovalPlanChangedError) return finish('stale-plan', { currentVersion: record.version });
    if (error instanceof SelfApprovalError) return finish('refused-self-approval', { principalId: String(principal.id) });
    if (error instanceof ApprovalScopeError) return finish('refused-not-eligible', { principalId: String(principal.id), reason: error.reason });
    if (error instanceof ApprovalInvalidatedError) return finish('refused-invalidated', { reason: error.reason });
    if (error instanceof ApprovalExpiredError) return finish('refused-expired');
    if (error instanceof PromotionRefusedError) return finish('refused-promotion', { reason: error.message });
    throw error; // left 'applying': a redelivery resumes it
  }
  const request = await getRequest(client, record.approval_request_id);
  const decision = await recordDecision(client, { tenantRef, record, request, source: 'itsm', externalEventId: callback.eventId });
  return finish('applied', {
    decisionId: String(decision.id), decision: request.status, principalId: String(principal.id), ...(jobId ? { jobId: String(jobId) } : {}),
  });
}

/**
 * Recovers a lost callback: reads the record's current state from the adapter and
 * handles it as a callback under a deterministic event id, so polling twice acts once
 * and a late original callback finds the request already decided.
 */
export async function reconcileRecord(client, { tenantRef, adapter, externalRef }) {
  assertAdapter(adapter);
  const state = await adapter.fetchRecord(externalRef);
  if (!state) return { outcome: 'not-found', duplicate: false, detail: {} };
  const eventId = `reconcile:${externalRef}:v${state.version}:${state.status}:${state.externalUser ?? '-'}`.slice(0, 200);
  return receiveCallback(client, { tenantRef, adapter: adapter.name, event: { ...state, externalRef, eventId } });
}

/** One mirror cycle for an adapter: record decisions made in the portal, then deliver
 * due outbox events. */
export async function runMirrorCycle(client, { tenantRef, adapter, now = null }) {
  assertAdapter(adapter);
  const recorded = await syncMirrorDecisions(client, { tenantRef, adapter: adapter.name });
  // The clock is read after recording, so the decisions just recorded are due.
  const delivery = await drainItsmOutbox(client, { tenantRef, adapter, now: now ?? new Date() });
  return { recorded: recorded.length, ...delivery };
}

/**
 * The mirror of this tenant as a reader sees it (read capability): each record with its
 * versions, its canonical decisions, every callback that did not simply apply (conflicts
 * and refusals stay visible) and its outbox state.
 */
export async function listMirror(client, { tenantRef, principalId, limit = 100 }) {
  await requireCapability(client, principalId, 'read');
  const { rows: records } = await client.query(
    'SELECT * FROM itsm_record WHERE tenant_ref = $1 ORDER BY created_at DESC, id DESC LIMIT $2',
    [tenantRef, Math.min(Math.max(Math.trunc(limit), 1), 100)],
  );
  if (records.length === 0) return [];
  const ids = records.map((record) => record.id);
  const byRecord = async (sql) => {
    const { rows } = await client.query(sql, [tenantRef, ids]);
    const grouped = new Map();
    for (const row of rows) grouped.set(String(row.record_id), [...(grouped.get(String(row.record_id)) ?? []), row]);
    return grouped;
  };
  const versions = await byRecord('SELECT * FROM itsm_record_version WHERE tenant_ref = $1 AND record_id = ANY($2::uuid[]) ORDER BY version');
  const decisions = await byRecord('SELECT * FROM itsm_decision WHERE tenant_ref = $1 AND record_id = ANY($2::uuid[]) ORDER BY version');
  const callbacks = await byRecord(
    `SELECT id, record_id, external_event_id, event, outcome, detail, received_at, handled_at
       FROM itsm_inbox WHERE tenant_ref = $1 AND record_id = ANY($2::uuid[]) ORDER BY received_at, id`,
  );
  const outbox = await byRecord(
    `SELECT record_id, status, count(*)::int AS count FROM itsm_outbox_event
      WHERE tenant_ref = $1 AND record_id = ANY($2::uuid[]) GROUP BY record_id, status`,
  );
  return records.map((record) => {
    const key = String(record.id);
    const recordCallbacks = callbacks.get(key) ?? [];
    return {
      id: key, adapter: record.adapter, externalRef: record.external_ref, subjectKind: record.subject_kind,
      approvalRequestId: record.approval_request_id ? String(record.approval_request_id) : null,
      changeIntentId: record.change_intent_id ? String(record.change_intent_id) : null,
      version: record.version, planDigest: record.plan_digest,
      versions: (versions.get(key) ?? []).map((row) => ({
        version: row.version, planDigest: row.plan_digest, boundAt: iso(row.bound_at),
        approvalRequestId: row.approval_request_id ? String(row.approval_request_id) : null,
      })),
      decisions: (decisions.get(key) ?? []).map((row) => ({
        id: String(row.id), version: row.version, outcome: row.outcome, source: row.source, decidedBy: row.decided_by,
        externalEventId: row.external_event_id, decisionDigest: row.decision_digest, recordedAt: iso(row.recorded_at),
      })),
      conflicts: recordCallbacks.filter((row) => row.outcome === 'conflict').map((row) => ({
        externalEventId: row.external_event_id, externalStatus: row.event.status, externalUser: row.event.externalUser,
        ...row.detail, receivedAt: iso(row.received_at),
      })),
      refusedCallbacks: recordCallbacks.filter((row) => !['applied', 'already-decided', 'conflict', 'applying'].includes(row.outcome))
        .map((row) => ({ externalEventId: row.external_event_id, outcome: row.outcome, status: row.event.status, receivedAt: iso(row.received_at) })),
      outbox: Object.fromEntries((outbox.get(key) ?? []).map((row) => [row.status, row.count])),
    };
  });
}
