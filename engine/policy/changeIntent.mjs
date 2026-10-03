// engine/policy/changeIntent.mjs
//
// Roadmap task-93: time-bounded approved emergency deviations. An operator sometimes has
// to change a setting outside the baseline in an emergency. A change intent records that
// decision, immutably: one resource, the exact field transitions approved (before ->
// after), the owner who made or will make the change, the approver (never the owner),
// a window [windowStart, windowEnd) and an optional external change id.
//
// What an intent does, and what it never does:
//
//   - The drift stays recorded, open and visible. An intent never writes a disposition,
//     never hides a change from the Changes page and never silences an alert policy.
//   - While the window is open, executeAutoRemediation (execute.mjs) refuses to roll
//     back automatically a drift whose EVERY changed field matches an approved
//     transition exactly (same field, same before value, same after value). The
//     refusal is evidence, like every other automation refusal.
//   - Any other change on the same resource is handled normally: a drift that also
//     changes an unapproved field, a field that moved to a different value than the one
//     approved, or a resource added or removed. KEEL's roll back works on whole
//     resources, so such a roll back also returns the approved field to its baseline
//     value; the evidence records that the approval did not apply and which fields
//     were unapproved.
//   - When the window ends (at windowEnd, or earlier when revoked), settleChangeIntents
//     re-reads the resource's current state from the newest collection and evaluates
//     the newest drift for it through the normal path. It never applies the inverse of
//     the approved transition: if the resource is back at its baseline, or nobody has
//     collected since, nothing is rolled back.
//   - The worker re-checks at execution (assertNoApprovedTransition, used by
//     cli/keel-remediate.mjs): a roll back queued before an intent was approved stops
//     before any write while the intent is active.
//
// decisionDigest is the canonical digest of the approval. A future ITSM mirror
// (roadmap task-97) carries it, so the change record and KEEL's intent name the same
// decision; nothing here sends anything to an external system.
import { appendEvidence } from '../govern/evidence.mjs';
import { can } from '../authz/can.mjs';
import { findPrincipalById } from '../authz/principals.mjs';
import { changedFields } from '../identity/attribution.mjs';
import { canonicalDigest } from '../restore/dryRunArtifact.mjs';
import { OPEN_DRIFT_PREDICATE } from '../store/openDrift.mjs';
import { evaluateDrift } from './evaluate.mjs';
import { AUTOMATION_KILL_SWITCH_PATH, executeAutoRemediation } from './execute.mjs';

export const CHANGE_INTENT_EVIDENCE_KIND = 'change-intent';
export const CHANGE_INTENT_MAX_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
export const CHANGE_INTENT_MAX_TRANSITIONS = 50;
const EXTERNAL_CHANGE_ID = /^[A-Za-z0-9][A-Za-z0-9._:/#-]{0,127}$/;
const FIELD = /^[A-Za-z0-9@._$-]{1,128}$/;

/** A refused intent operation. `code` is one of: invalid, not-found, drift-not-modified,
 * field-not-changed, approver-not-authorized, owner-not-found, owner-is-approver,
 * window-invalid, already-ended. */
export class ChangeIntentError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

function iso(value) {
  return value == null ? null : new Date(value).toISOString();
}

function side(container, key) {
  return Object.hasOwn(container, key) ? { present: true, value: container[key] } : { present: false, value: null };
}

/** One approved or observed field transition, in its canonical stored shape. */
function transition(field, before, after) {
  return { field, before, after };
}

function sameSide(left, right) {
  return left.present === right.present && canonicalDigest(left.value ?? null) === canonicalDigest(right.value ?? null);
}

/** The field transitions of one drift row: every top-level field whose value differs
 * between the baseline payload and the observed payload. Only a modified resource has
 * field transitions; an added or removed resource is a whole-resource change. */
export function driftTransitions(drift) {
  if (drift.change_type !== 'modified') return null;
  const before = drift.before_payload && typeof drift.before_payload === 'object' ? drift.before_payload : {};
  const after = drift.after_payload && typeof drift.after_payload === 'object' ? drift.after_payload : {};
  return changedFields(before, after).map((field) => transition(field, side(before, field), side(after, field)));
}

/** Accepts [{ field, before, after }] where a missing before/after key means the field is
 * absent on that side. Returns the canonical, field-sorted list or throws. */
export function normalizeTransitions(list) {
  if (!Array.isArray(list) || list.length === 0 || list.length > CHANGE_INTENT_MAX_TRANSITIONS) {
    throw new ChangeIntentError('invalid', `between 1 and ${CHANGE_INTENT_MAX_TRANSITIONS} field transitions are required`);
  }
  const seen = new Set();
  const normalized = list.map((entry) => {
    if (!entry || typeof entry !== 'object' || typeof entry.field !== 'string' || !FIELD.test(entry.field)) {
      throw new ChangeIntentError('invalid', 'every transition names one top-level field');
    }
    if (seen.has(entry.field)) throw new ChangeIntentError('invalid', `field ${entry.field} is listed twice`);
    seen.add(entry.field);
    const before = side(entry, 'before');
    const after = side(entry, 'after');
    if (sameSide(before, after)) throw new ChangeIntentError('invalid', `field ${entry.field} does not change`);
    return transition(entry.field, before, after);
  });
  return normalized.sort((a, b) => a.field.localeCompare(b.field));
}

/** Is the intent in force at `now`? Half-open window: active from windowStart up to,
 * not including, windowEnd; a revocation takes effect at the instant it was recorded. */
export function intentActiveAt(intent, now) {
  const at = new Date(now).getTime();
  if (!(new Date(intent.windowStart).getTime() <= at && at < new Date(intent.windowEnd).getTime())) return false;
  return intent.revokedAt == null || at < new Date(intent.revokedAt).getTime();
}

/** When the intent stopped being in force: the earlier of its revocation and windowEnd. */
export function intentEndsAt(intent) {
  const end = new Date(intent.windowEnd).getTime();
  const revoked = intent.revokedAt == null ? Infinity : new Date(intent.revokedAt).getTime();
  return new Date(Math.min(end, revoked)).toISOString();
}

/**
 * Pure: how one drift row stands against the intents given. Only intents in force at
 * `now` for the drift's own resource count. Returns
 *   { state: 'none' }                       no intent is in force for this resource
 *   { state: 'approved', ... }              every changed field matches an approved transition
 *   { state: 'unapproved', ... }            an intent is in force, but this change is not
 *                                           (wholly) the approved one
 * with approvedFields, unapprovedFields and the matching intentIds.
 */
export function classifyDrift(drift, intents, now) {
  const active = intents.filter((intent) => intent.naturalKey === drift.natural_key
    && intent.resourceType === drift.resource_type && intentActiveAt(intent, now));
  if (active.length === 0) return { state: 'none', approvedFields: [], unapprovedFields: [], intentIds: [] };
  const transitions = driftTransitions(drift);
  if (transitions === null || transitions.length === 0) {
    return {
      state: 'unapproved', reason: transitions === null ? `resource ${drift.change_type}` : 'no field changed',
      approvedFields: [], unapprovedFields: [], intentIds: [],
    };
  }
  const approvedFields = [];
  const unapprovedFields = [];
  const intentIds = new Set();
  for (const observed of transitions) {
    const covering = active.find((intent) => intent.transitions.some((approved) => approved.field === observed.field
      && sameSide(approved.before, observed.before) && sameSide(approved.after, observed.after)));
    if (covering) {
      approvedFields.push(observed.field);
      intentIds.add(covering.id);
    } else {
      unapprovedFields.push(observed.field);
    }
  }
  return {
    state: unapprovedFields.length === 0 ? 'approved' : 'unapproved',
    ...(unapprovedFields.length > 0 ? { reason: 'unapproved field change' } : {}),
    approvedFields, unapprovedFields, intentIds: [...intentIds].sort(),
  };
}

const INTENT_VIEW = `
  SELECT i.*,
         o.email AS owner_email, o.display_name AS owner_display_name,
         a.email AS approver_email, a.display_name AS approver_display_name,
         r.occurred_at AS revoked_at, r.actor AS revoked_by, r.detail AS revoke_detail,
         s.occurred_at AS settled_at, s.detail AS settle_detail
    FROM change_intent i
    LEFT JOIN principal o ON o.id = i.owner_principal_id
    LEFT JOIN principal a ON a.id = i.approver_principal_id
    LEFT JOIN change_intent_event r ON r.intent_id = i.id AND r.kind = 'revoked'
    LEFT JOIN change_intent_event s ON s.intent_id = i.id AND s.kind = 'settled'`;

function person(id, email, displayName) {
  return { id: String(id), email: email ?? null, name: displayName ?? email ?? null, readable: email != null };
}

function rowToIntent(row) {
  return {
    id: String(row.id),
    naturalKey: row.natural_key,
    resourceType: row.resource_type,
    transitions: row.transitions,
    transitionDigest: row.transition_digest,
    owner: person(row.owner_principal_id, row.owner_email, row.owner_display_name),
    approver: person(row.approver_principal_id, row.approver_email, row.approver_display_name),
    reason: row.reason,
    externalChangeId: row.external_change_id ?? null,
    sourceDriftId: row.source_drift_id ? String(row.source_drift_id) : null,
    windowStart: iso(row.window_start),
    windowEnd: iso(row.window_end),
    approvedAt: iso(row.approved_at),
    decisionDigest: row.decision_digest,
    revokedAt: iso(row.revoked_at),
    revokedBy: row.revoked_by ?? null,
    revokeReason: row.revoke_detail?.reason ?? null,
    settledAt: iso(row.settled_at),
    settlement: row.settle_detail && Object.keys(row.settle_detail).length > 0 ? row.settle_detail : null,
  };
}

async function tableExists(client) {
  const { rows: [row] } = await client.query("SELECT to_regclass('change_intent') AS name");
  return row.name != null;
}

/** Intents of one tenant whose window contains `now` and which were not revoked at or
 * before `now`, for the given resources. Legacy read: before the table exists, none. */
export async function activeIntentsFor(client, { tenantRef, naturalKeys, now = new Date() }) {
  if (!(await tableExists(client)) || naturalKeys.length === 0) return [];
  const { rows } = await client.query(
    `${INTENT_VIEW}
      WHERE i.tenant_ref = $1 AND i.natural_key = ANY($2::text[])
        AND i.window_start <= $3 AND i.window_end > $3
        AND (r.occurred_at IS NULL OR r.occurred_at > $3)
      ORDER BY i.approved_at, i.id`,
    [tenantRef, naturalKeys, now],
  );
  return rows.map(rowToIntent);
}

/** How one drift row stands against the intents in force at `now` (classifyDrift). */
export async function assessDrift(client, { tenantRef, drift, now = new Date() }) {
  const intents = await activeIntentsFor(client, { tenantRef, naturalKeys: [drift.natural_key], now });
  return classifyDrift(drift, intents, now);
}

/** Execution-time re-check for an automatic roll back: throws when any of the drift rows
 * is, at `now`, wholly an approved transition. Run before any write. */
export async function assertNoApprovedTransition(client, { driftIds, now = new Date() }) {
  if (!(await tableExists(client))) return;
  const { rows: drifts } = await client.query('SELECT * FROM drift WHERE id = ANY($1::uuid[]) ORDER BY id', [driftIds]);
  for (const drift of drifts) {
    const assessment = await assessDrift(client, { tenantRef: drift.tenant_ref, drift, now });
    if (assessment.state === 'approved') {
      throw new Error(`change-intent-approved: ${drift.natural_key} is an approved emergency change until its window ends — refusing automatic roll back`);
    }
  }
}

async function requireApprover(client, principalId, now) {
  const principal = principalId ? await findPrincipalById(client, String(principalId)) : null;
  if (!principal || !(await can(client, principal, 'approve', now))) {
    throw new ChangeIntentError('approver-not-authorized', 'only a person who can approve may approve or revoke an emergency change');
  }
  return principal;
}

/** The decision a future ITSM mirror carries: everything the approval binds. */
export function changeIntentDecision({
  tenantRef, naturalKey, resourceType, transitions, ownerPrincipalId, approverPrincipalId,
  reason, externalChangeId, windowStart, windowEnd, approvedAt,
}) {
  return {
    tenantRef, naturalKey, resourceType, transitions,
    owner: String(ownerPrincipalId), approver: String(approverPrincipalId),
    reason, externalChangeId: externalChangeId ?? null,
    windowStart: iso(windowStart), windowEnd: iso(windowEnd), approvedAt: iso(approvedAt),
  };
}

/**
 * Records an approved emergency change. Either `driftId` with `fields` (the approved
 * transitions are taken from that drift's own payloads, exactly) or `naturalKey`,
 * `resourceType` and explicit `transitions` (approved before the change is made).
 * `approverPrincipalId` must hold approve now; `ownerPrincipalId` must be another,
 * enabled person. The window cannot start in the past or last longer than
 * CHANGE_INTENT_MAX_WINDOW_MS. Returns the stored intent.
 */
export async function createChangeIntent(client, {
  tenantRef, approverPrincipalId, ownerPrincipalId, driftId, fields, naturalKey, resourceType, transitions,
  reason, externalChangeId = null, windowStart, windowEnd, now = new Date(),
}) {
  if (typeof reason !== 'string' || reason.trim().length === 0 || reason.length > 1000) {
    throw new ChangeIntentError('invalid', 'a reason is required');
  }
  if (externalChangeId != null && (typeof externalChangeId !== 'string' || !EXTERNAL_CHANGE_ID.test(externalChangeId))) {
    throw new ChangeIntentError('invalid', 'the external change id is not valid');
  }
  const approver = await requireApprover(client, approverPrincipalId, now);
  const owner = ownerPrincipalId ? await findPrincipalById(client, String(ownerPrincipalId)) : null;
  if (!owner || owner.disabled_at != null) throw new ChangeIntentError('owner-not-found', 'the owner must be an enabled person known to KEEL');
  if (String(owner.id) === String(approver.id)) {
    throw new ChangeIntentError('owner-is-approver', 'the owner of an emergency change cannot approve it');
  }

  let key = naturalKey;
  let type = resourceType;
  let approved;
  let sourceDriftId = null;
  if (driftId != null) {
    if (naturalKey != null || resourceType != null || transitions != null) {
      throw new ChangeIntentError('invalid', 'approve either from a change or from explicit transitions, not both');
    }
    const { rows: [drift] } = await client.query('SELECT * FROM drift WHERE id::text = $1 AND tenant_ref = $2', [String(driftId), tenantRef]);
    if (!drift) throw new ChangeIntentError('not-found', 'change not found');
    const observed = driftTransitions(drift);
    if (observed === null) throw new ChangeIntentError('drift-not-modified', 'only a change to existing settings can be approved field by field');
    if (!Array.isArray(fields) || fields.length === 0 || fields.some((field) => typeof field !== 'string')) {
      throw new ChangeIntentError('invalid', 'name the fields to approve');
    }
    approved = [...new Set(fields)].map((field) => {
      const match = observed.find((candidate) => candidate.field === field);
      if (!match) throw new ChangeIntentError('field-not-changed', `field ${field} is not changed by this change`);
      return match;
    }).sort((a, b) => a.field.localeCompare(b.field));
    key = drift.natural_key;
    type = drift.resource_type;
    sourceDriftId = String(drift.id);
  } else {
    if (typeof key !== 'string' || key.length === 0 || typeof type !== 'string' || type.length === 0) {
      throw new ChangeIntentError('invalid', 'name the resource and its type');
    }
    approved = normalizeTransitions((transitions ?? []).map((entry) => {
      if (!entry || typeof entry !== 'object') return entry;
      // Accept the stored shape too ({ before: { present, value } }) so a stored intent
      // can be re-approved verbatim for a new window.
      const shaped = { field: entry.field };
      for (const sideKey of ['before', 'after']) {
        const value = entry[sideKey];
        if (value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).sort().join() === 'present,value') {
          if (value.present) shaped[sideKey] = value.value;
        } else if (Object.hasOwn(entry, sideKey)) {
          shaped[sideKey] = value;
        }
      }
      return shaped;
    }));
  }

  const start = windowStart == null ? new Date(now) : new Date(windowStart);
  const end = new Date(windowEnd);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) throw new ChangeIntentError('window-invalid', 'the window needs a valid start and end');
  if (start.getTime() < new Date(now).getTime()) throw new ChangeIntentError('window-invalid', 'the window cannot start in the past');
  if (!(end.getTime() > start.getTime())) throw new ChangeIntentError('window-invalid', 'the window must end after it starts');
  if (end.getTime() - start.getTime() > CHANGE_INTENT_MAX_WINDOW_MS) {
    throw new ChangeIntentError('window-invalid', 'an emergency change can be approved for at most 7 days');
  }

  const approvedAt = new Date(now);
  const decision = changeIntentDecision({
    tenantRef, naturalKey: key, resourceType: type, transitions: approved,
    ownerPrincipalId: owner.id, approverPrincipalId: approver.id, reason: reason.trim(), externalChangeId,
    windowStart: start, windowEnd: end, approvedAt,
  });
  const decisionDigest = canonicalDigest(decision);
  const { rows: [row] } = await client.query(
    `INSERT INTO change_intent
       (tenant_ref, natural_key, resource_type, transitions, transition_digest, owner_principal_id,
        approver_principal_id, reason, external_change_id, source_drift_id, window_start, window_end,
        approved_at, decision_digest)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
     RETURNING id`,
    [
      tenantRef, key, type, JSON.stringify(approved), canonicalDigest(approved), owner.id, approver.id,
      reason.trim(), externalChangeId, sourceDriftId, start, end, approvedAt, decisionDigest,
    ],
  );
  await appendEvidence(client, {
    tenantRef,
    kind: CHANGE_INTENT_EVIDENCE_KIND,
    subject: {
      intentId: String(row.id), outcome: 'approved', naturalKey: key, resourceType: type,
      fields: approved.map((entry) => entry.field), ownerPrincipalId: String(owner.id),
      approverPrincipalId: String(approver.id), externalChangeId, sourceDriftId,
      windowStart: start.toISOString(), windowEnd: end.toISOString(), decisionDigest,
    },
    actor: String(approver.id),
  });
  return getChangeIntent(client, { tenantRef, intentId: row.id });
}

/** One intent of this tenant, or null. */
export async function getChangeIntent(client, { tenantRef, intentId }) {
  if (!(await tableExists(client))) return null;
  const { rows: [row] } = await client.query(`${INTENT_VIEW} WHERE i.id::text = $1 AND i.tenant_ref = $2`, [String(intentId), tenantRef]);
  return row ? rowToIntent(row) : null;
}

/** Intents of this tenant, newest first, each with its state at `now`
 * ('scheduled' | 'active' | 'revoked' | 'ended'). Legacy read: none before the table. */
export async function listChangeIntents(client, { tenantRef, now = new Date(), limit = 100 }) {
  if (!(await tableExists(client))) return [];
  const { rows } = await client.query(
    `${INTENT_VIEW} WHERE i.tenant_ref = $1 ORDER BY i.approved_at DESC, i.id DESC LIMIT $2`,
    [tenantRef, limit],
  );
  return rows.map(rowToIntent).map((intent) => ({ ...intent, state: intentState(intent, now) }));
}

export function intentState(intent, now) {
  if (intentActiveAt(intent, now)) return 'active';
  const at = new Date(now).getTime();
  if (intent.revokedAt != null && new Date(intent.revokedAt).getTime() <= at) return 'revoked';
  if (at < new Date(intent.windowStart).getTime()) return 'scheduled';
  return 'ended';
}

/** Ends an intent before its window closes, then evaluates its resource afresh
 * (settleChangeIntents). Only a person who can approve may revoke. */
export async function revokeChangeIntent(client, {
  tenantRef, intentId, revokedBy, reason, now = new Date(), ...settleOptions
}) {
  if (typeof reason !== 'string' || reason.trim().length === 0 || reason.length > 1000) {
    throw new ChangeIntentError('invalid', 'a reason is required');
  }
  const revoker = await requireApprover(client, revokedBy, now);
  const intent = await getChangeIntent(client, { tenantRef, intentId });
  if (!intent) throw new ChangeIntentError('not-found', 'emergency change not found');
  const state = intentState(intent, now);
  if (state === 'revoked' || state === 'ended') throw new ChangeIntentError('already-ended', 'this emergency change has already ended');
  const { rows: inserted } = await client.query(
    `INSERT INTO change_intent_event (tenant_ref, intent_id, kind, occurred_at, actor, detail)
     VALUES ($1,$2,'revoked',$3,$4,$5)
     ON CONFLICT (intent_id, kind) DO NOTHING
     RETURNING id`,
    [tenantRef, intent.id, now, String(revoker.id), JSON.stringify({ reason: reason.trim() })],
  );
  if (inserted.length === 0) throw new ChangeIntentError('already-ended', 'this emergency change has already ended');
  await appendEvidence(client, {
    tenantRef,
    kind: CHANGE_INTENT_EVIDENCE_KIND,
    subject: {
      intentId: intent.id, outcome: 'revoked', naturalKey: intent.naturalKey, reason: reason.trim(),
      revokedAt: new Date(now).toISOString(), decisionDigest: intent.decisionDigest,
    },
    actor: String(revoker.id),
  });
  const settled = await settleChangeIntents(client, { tenantRef, now, intentIds: [intent.id], ...settleOptions });
  return { intent: await getChangeIntent(client, { tenantRef, intentId: intent.id }), settlement: settled[0] ?? null };
}

/**
 * The resource's current state, read afresh: the newest complete collection that holds
 * any resource of this type, compared with the active baseline.
 *   matches-baseline    the resource is as the baseline has it; nothing to roll back
 *   drifted             the newest collection differs; `drift` is the open drift row
 *                       recorded for that collection
 *   awaiting-detection  the newest collection differs but no drift row was recorded for
 *                       it yet; the next drift detection evaluates it normally
 *   unknown             no baseline or no collection of this type
 */
export async function currentResourceState(client, { tenantRef, naturalKey, resourceType }) {
  const { rows: [baseline] } = await client.query(
    'SELECT id FROM baseline WHERE tenant_ref = $1 AND active = true LIMIT 1',
    [tenantRef],
  );
  if (!baseline) return { state: 'unknown', reason: 'no active baseline' };
  const { rows: [snapshot] } = await client.query(
    `SELECT s.id, s.completed_at FROM snapshot s
      WHERE s.tenant_ref = $1 AND s.status = 'complete'
        AND EXISTS (SELECT 1 FROM resource_version rv WHERE rv.snapshot_id = s.id AND rv.resource_type = $2)
      ORDER BY s.completed_at DESC NULLS LAST, s.started_at DESC, s.id DESC
      LIMIT 1`,
    [tenantRef, resourceType],
  );
  if (!snapshot) return { state: 'unknown', reason: 'no collection of this type' };
  const { rows: [current] } = await client.query(
    'SELECT payload_hash FROM resource_version WHERE snapshot_id = $1 AND natural_key = $2',
    [snapshot.id, naturalKey],
  );
  const { rows: [base] } = await client.query(
    `SELECT rv.payload_hash FROM baseline_resource br
       JOIN resource_version rv ON rv.id = br.resource_version_id
      WHERE br.baseline_id = $1 AND br.natural_key = $2`,
    [baseline.id, naturalKey],
  );
  const observedAt = iso(snapshot.completed_at);
  if ((current?.payload_hash ?? null) === (base?.payload_hash ?? null)) {
    return { state: 'matches-baseline', snapshotId: String(snapshot.id), observedAt };
  }
  const { rows: [drift] } = await client.query(
    `SELECT d.* FROM drift d
      WHERE d.tenant_ref = $1 AND d.baseline_id = $2 AND d.observed_snapshot = $3 AND d.natural_key = $4
        AND ${OPEN_DRIFT_PREDICATE}`,
    [tenantRef, baseline.id, snapshot.id, naturalKey],
  );
  if (!drift) return { state: 'awaiting-detection', snapshotId: String(snapshot.id), observedAt };
  return { state: 'drifted', snapshotId: String(snapshot.id), observedAt, drift };
}

/**
 * Settles every intent of this tenant that has ended by `now` (window over or revoked)
 * and was not settled yet: records the settlement once, re-reads the resource's current
 * state (currentResourceState) and, when it still differs from the baseline, evaluates
 * that newest drift row through the normal policy path (evaluateDrift, then
 * executeAutoRemediation for each automatic match). Returns one entry per settled intent.
 */
export async function settleChangeIntents(client, {
  tenantRef, now = new Date(), intentIds = null, actor = 'change-intent-settlement',
  killSwitchPath = AUTOMATION_KILL_SWITCH_PATH,
}) {
  if (!(await tableExists(client))) return [];
  const { rows } = await client.query(
    `${INTENT_VIEW}
      WHERE i.tenant_ref = $1 AND s.id IS NULL
        AND (i.window_end <= $2 OR r.occurred_at <= $2)
        AND ($3::text[] IS NULL OR i.id::text = ANY($3::text[]))
      ORDER BY i.window_end, i.id`,
    [tenantRef, now, intentIds ? intentIds.map(String) : null],
  );
  const results = [];
  for (const intent of rows.map(rowToIntent)) {
    const current = await currentResourceState(client, { tenantRef, naturalKey: intent.naturalKey, resourceType: intent.resourceType });
    const detail = {
      endedAt: intentEndsAt(intent), currentState: current.state, snapshotId: current.snapshotId ?? null,
      observedAt: current.observedAt ?? null, driftId: current.drift ? String(current.drift.id) : null,
    };
    // Single settlement: the UNIQUE (intent_id, kind) lets exactly one settle through.
    const { rows: claimed } = await client.query(
      `INSERT INTO change_intent_event (tenant_ref, intent_id, kind, occurred_at, actor, detail)
       VALUES ($1,$2,'settled',$3,$4,$5)
       ON CONFLICT (intent_id, kind) DO NOTHING
       RETURNING id`,
      [tenantRef, intent.id, now, actor, JSON.stringify(detail)],
    );
    if (claimed.length === 0) continue;

    const remediations = [];
    let evaluation = null;
    if (current.state === 'drifted') {
      evaluation = await evaluateDrift(client, { tenantRef, drift: current.drift, actor });
      for (const match of evaluation.matches) {
        if (match.outcome !== 'auto_remediate') continue;
        remediations.push({
          policyId: match.policyId,
          ...(await executeAutoRemediation(client, {
            tenantRef, drift: current.drift, policyId: match.policyId, actor, killSwitchPath, now,
          })),
        });
      }
    }
    await appendEvidence(client, {
      tenantRef,
      kind: CHANGE_INTENT_EVIDENCE_KIND,
      subject: {
        intentId: intent.id, outcome: 'settled', naturalKey: intent.naturalKey, decisionDigest: intent.decisionDigest,
        ...detail, matched: evaluation ? evaluation.matches.length : 0,
        remediations: remediations.map(({ policyId, outcome, jobId }) => ({ policyId, outcome, ...(jobId ? { jobId: String(jobId) } : {}) })),
      },
      actor,
    });
    results.push({ intentId: intent.id, ...detail, evaluation, remediations });
  }
  return results;
}
