// engine/policy/evaluate.mjs
//
// §3.4, plan task 18: policy objects and evaluation. A policy is a rule matched
// against each newly detected drift row (resource_type, blast_radius, natural key
// glob, change_type); a match recommends alert, require_approval or auto_remediate.
// max_blast_radius is a structural guardrail, not a fourth match field: even a
// policy whose match admits a high-blast-radius drift may not auto_remediate above
// its own max_blast_radius, and evaluateDrift enforces that itself rather than
// trusting the policy's configuration. evaluateDrift always writes evidence — a
// no-match evaluation is recorded exactly like a match — so "why did nothing
// happen" is answerable from the evidence chain alone.
import { createHash } from 'node:crypto';
import { objectNameSql } from '../cir/objectName.mjs';
import { appendEvidence, appendEvidenceInTransaction } from '../govern/evidence.mjs';
import { can } from '../authz/can.mjs';
import { gateBlastRadius } from '../safety/blastRadius.mjs';
import { findPrincipalById } from '../authz/principals.mjs';
import { OPEN_DRIFT_PREDICATE, markSameContentDrift } from '../store/openDrift.mjs';
import { executeAutoRemediation } from './execute.mjs';

export const POLICY_EVALUATION_EVIDENCE_KIND = 'policy-evaluation';

const BLAST_RADIUS_RANK = { cosmetic: 0, 'access-affecting': 1, 'tenant-lockout': 2 };

function globToRegExp(glob) {
  const escaped = glob.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
  return new RegExp(`^${escaped}$`);
}

function matchesGlob(glob, value) {
  return globToRegExp(glob).test(value ?? '');
}

/** Pure match check: every non-null match column on the policy must agree with the
 * drift row. A null column matches anything. */
export function policyMatches(policy, drift) {
  if (policy.resource_type && policy.resource_type !== drift.resource_type) return false;
  if (policy.blast_radius && policy.blast_radius !== drift.blast_radius) return false;
  if (policy.change_type && policy.change_type !== drift.change_type) return false;
  if (policy.natural_key_glob && !matchesGlob(policy.natural_key_glob, drift.natural_key)) return false;
  return true;
}

/** Structural guardrail (§3.4): a policy may not auto_remediate above its own
 * max_blast_radius, whatever it matched. Never configurable away. */
export function exceedsMaxBlastRadius(drift, policy) {
  return BLAST_RADIUS_RANK[gateBlastRadius(drift.resource_type, drift.blast_radius)] > BLAST_RADIUS_RANK[policy.max_blast_radius];
}

// Roadmap task-55: the same guardrail re-applied AFTER dependency expansion. The
// enqueue-time check above sees only the original drift row; a remediation's real
// impact is the maximum blast radius over the actual operations its expanded
// dependency closure will perform, compared against the policy ceiling re-read live
// at execution — never a caller-supplied ceiling.

/** Rank of a blast-radius label, or null when the label is not a known level. */
export function blastRadiusRank(label) {
  return Object.hasOwn(BLAST_RADIUS_RANK, label) ? BLAST_RADIUS_RANK[label] : null;
}

/** Is `blastRadius` strictly above `ceiling`? Fails closed: an unrecognized label on
 * either side is treated as exceeding, never as passing. */
export function exceedsBlastRadiusCeiling(blastRadius, ceiling) {
  const impactRank = blastRadiusRank(blastRadius);
  const ceilingRank = blastRadiusRank(ceiling);
  if (impactRank === null || ceilingRank === null) return true;
  return impactRank > ceilingRank;
}

/** Maximum impact over the ACTUAL operations a plan will perform after closure:
 * every resource with a write verb (create/update/delete/restore-soft-deleted) plus
 * every resource carrying a deferred reference patch. noop resources perform no
 * write and contribute nothing. An unrecognized blast-radius label always wins the
 * maximum, so it cannot slip under a ceiling. Returns { maxBlastRadius, operations }
 * with maxBlastRadius null when the plan performs no operation at all. */
export function maxOperationImpact(resources, patches = []) {
  const patchKeys = new Set((patches ?? []).map((patch) => patch.naturalKey));
  const operations = (resources ?? [])
    .filter((resource) => (resource.verb && resource.verb !== 'noop') || patchKeys.has(resource.naturalKey))
    .map((resource) => ({
      naturalKey: resource.naturalKey,
      resourceType: resource.resourceType,
      verb: resource.verb ?? 'patch',
      blastRadius: gateBlastRadius(resource.resourceType, resource.blastRadius ?? null),
    }))
    .sort((left, right) => left.naturalKey.localeCompare(right.naturalKey));

  // `null` is both "no operation seen yet" and a legitimate (unrecognized-label)
  // operation value, so a plain `maxBlastRadius === null` check cannot tell them
  // apart: once an unrecognized-label operation set maxBlastRadius to null, the
  // next operation would hit the "not yet set" branch again and silently overwrite
  // it, letting the unrecognized label slip under a ceiling instead of always
  // winning the maximum. hasImpact disambiguates the two.
  let maxBlastRadius = null;
  let hasImpact = false;
  for (const operation of operations) {
    if (!hasImpact) {
      maxBlastRadius = operation.blastRadius;
      hasImpact = true;
      continue;
    }
    const operationRank = blastRadiusRank(operation.blastRadius);
    const maxRank = blastRadiusRank(maxBlastRadius);
    if (operationRank === null || (maxRank !== null && operationRank > maxRank)) {
      maxBlastRadius = operation.blastRadius;
    }
  }
  return { maxBlastRadius, operations };
}

/** The policy's constraint version: a content fingerprint over every field that
 * governs whether and how automation may act. Recorded in the immutable dry-run
 * artifact at planning time and recomputed from the live policy row at promotion —
 * any change (ceiling, enable/pause state, rate limit, run-as identity) invalidates
 * the promotion and forces a fresh dry run. Key order is fixed so the fingerprint
 * is deterministic. */
export function policyConstraintVersion(policy) {
  return createHash('sha256').update(JSON.stringify({
    action: policy.action,
    enabled: policy.enabled,
    maxBlastRadius: policy.max_blast_radius,
    maxActionsPerWindow: policy.max_actions_per_window ?? null,
    windowSeconds: policy.window_seconds ?? null,
    runAsPrincipalId: policy.run_as_principal_id ?? null,
    runAsRepairRequired: policy.run_as_repair_required === true,
    paused: policy.paused_at != null,
  })).digest('hex');
}

function outcomeFor(policy, drift) {
  if (policy.action === 'auto_remediate' && exceedsMaxBlastRadius(drift, policy)) {
    return 'blocked-max-blast-radius';
  }
  return policy.action;
}

// An automatic policy deliberately does not inherit the creator's authority. The
// explicit run-as principal must resolve, be enabled, and hold a live remediate grant
// when an operator creates or enables the policy. The worker rechecks the same grant
// immediately before it dispatches every queued job.
export async function requireCurrentRemediationRunAs(client, runAsPrincipalId, at = new Date()) {
  const principal = await findPrincipalById(client, runAsPrincipalId);
  if (!(await can(client, principal, 'remediate', at))) {
    throw new Error('auto-remediation run-as principal must be registered, enabled, and currently authorized for remediate');
  }
  return principal;
}

/** Read current policy state, including disabled and paused policies by default. */
// Roadmap task-130: a policy row carries its run-as principal resolved to a name
// (run_as_principal: { id, email, name, readable }) and its most recent automatic
// action, so the portal never shows the run-as identity as a bare id. One query.
const POLICY_VIEW = `
  SELECT p.*,
         rp.email AS run_as_principal_email, rp.display_name AS run_as_principal_display_name,
         last_action.queued_at AS last_action_at, last_action.status AS last_action_status,
         last_action.natural_key AS last_action_natural_key, last_action.job_id AS last_action_job_id,
         (SELECT count(*)::int FROM auto_remediation_execution e
           WHERE e.policy_id = p.id AND e.queued_at > now() - interval '7 days') AS actions_last_7_days
    FROM policy p
    LEFT JOIN principal rp ON rp.id = p.run_as_principal_id
    LEFT JOIN LATERAL (
      SELECT e.queued_at, e.status, e.job_id, d.natural_key FROM auto_remediation_execution e
        LEFT JOIN drift d ON d.id = e.drift_id
       WHERE e.policy_id = p.id ORDER BY e.queued_at DESC LIMIT 1
    ) last_action ON true`;

function withRunAs(row) {
  if (!row) return row;
  const { run_as_principal_email: email, run_as_principal_display_name: displayName, ...rest } = row;
  return {
    ...rest,
    run_as_principal: row.run_as_principal_id
      ? {
        id: String(row.run_as_principal_id),
        email: email ?? null,
        name: displayName ?? email ?? null,
        readable: email != null,
      }
      : null,
  };
}

export async function listPolicies(client, { tenantRef, enabled } = {}) {
  const { rows } = await client.query(
    `${POLICY_VIEW}
      WHERE p.tenant_ref = $1 AND p.deleted_at IS NULL AND ($2::boolean IS NULL OR p.enabled = $2)
      ORDER BY p.created_at, p.id`,
    [tenantRef, enabled ?? null],
  );
  return rows.map(withRunAs);
}

/** The newest automatic actions of one policy, each with the job that ran it and the
 * change it acted on (key, type, and the saved display name when the change carries
 * one), so the portal lists them by name with a link to the job. */
export async function listPolicyActions(client, { tenantRef, policyId, limit = 20 }) {
  const { rows } = await client.query(
    `SELECT e.job_id::text AS job_id, e.status, e.queued_at, e.finished_at, e.error, e.drift_id::text AS drift_id,
            d.natural_key, d.resource_type, d.change_type, d.blast_radius,
            coalesce(${objectNameSql('d.after_payload', 'd.resource_type')},
                     ${objectNameSql('d.before_payload', 'd.resource_type')}) AS display_name
       FROM auto_remediation_execution e
       LEFT JOIN drift d ON d.id = e.drift_id
      WHERE e.tenant_ref = $1 AND e.policy_id::text = $2
      ORDER BY e.queued_at DESC, e.job_id
      LIMIT $3`,
    [tenantRef, policyId, limit],
  );
  return rows;
}

export async function getPolicy(client, { tenantRef, id }) {
  const { rows } = await client.query(`${POLICY_VIEW} WHERE p.id::text = $1 AND p.tenant_ref = $2 AND p.deleted_at IS NULL`, [id, tenantRef]);
  return rows[0] ? withRunAs(rows[0]) : null;
}

// Clearing a pause must not restore automation under a revoked identity. This does
// not enable a disabled policy; setPolicyEnabled remains the only enable path.
export async function clearPolicyPause(client, { policyId }) {
  const { rows } = await client.query('SELECT * FROM policy WHERE id = $1 AND deleted_at IS NULL', [policyId]);
  const policy = rows[0];
  if (!policy) throw new Error(`policy not found: ${policyId}`);
  if (policy.action === 'auto_remediate') {
    await requireCurrentRemediationRunAs(client, policy.run_as_principal_id);
  }
  const { rows: updated } = await client.query(
    `UPDATE policy SET paused_at = NULL, run_as_repair_required = false
      WHERE id = $1 AND deleted_at IS NULL RETURNING *`,
    [policyId],
  );
  if (!updated[0]) throw new Error(`policy not found: ${policyId}`);
  return updated[0];
}

export async function createPolicy(client, {
  tenantRef, name, enabled = true, resourceType, blastRadius, naturalKeyGlob, changeType,
  action, maxBlastRadius, maxActionsPerWindow, windowSeconds, createdBy, runAsPrincipalId,
}) {
  if (action === 'auto_remediate') {
    await requireCurrentRemediationRunAs(client, runAsPrincipalId);
  }
  const { rows } = await client.query(
    `INSERT INTO policy
       (tenant_ref, name, enabled, resource_type, blast_radius, natural_key_glob, change_type,
        action, max_blast_radius, max_actions_per_window, window_seconds, created_by,
        run_as_principal_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
     RETURNING *`,
    [
      tenantRef, name, enabled, resourceType ?? null, blastRadius ?? null, naturalKeyGlob ?? null,
      changeType ?? null, action, maxBlastRadius, maxActionsPerWindow ?? null, windowSeconds ?? null,
      createdBy, action === 'auto_remediate' ? runAsPrincipalId : null,
    ],
  );
  return rows[0];
}

// This is the only policy-enable path. A migrated policy with no valid run-as remains
// disabled until an operator repairs its identity, and a revoked, disabled, or expired
// identity cannot be used to turn automation back on.
export async function setPolicyEnabled(client, { policyId, enabled }) {
  const { rows } = await client.query('SELECT * FROM policy WHERE id = $1 AND deleted_at IS NULL', [policyId]);
  const policy = rows[0];
  if (!policy) throw new Error(`policy not found: ${policyId}`);
  if (enabled && policy.action === 'auto_remediate') {
    await requireCurrentRemediationRunAs(client, policy.run_as_principal_id);
  }
  const { rows: updated } = await client.query(
    `UPDATE policy
        SET enabled = $2,
            run_as_repair_required = CASE
              WHEN $2 AND action = 'auto_remediate' THEN false
              ELSE run_as_repair_required
            END,
            paused_at = CASE
              WHEN $2 AND action = 'auto_remediate' AND run_as_repair_required THEN NULL
              ELSE paused_at
            END
      WHERE id = $1 AND deleted_at IS NULL
      RETURNING *`,
    [policyId, enabled],
  );
  // A delete that commits after the read above leaves the rule deleted and off.
  if (!updated[0]) throw new Error(`policy not found: ${policyId}`);
  return updated[0];
}

const BLAST_RADII = Object.keys(BLAST_RADIUS_RANK);
const CHANGE_TYPES = ['added', 'modified', 'removed'];

/** The audit record of a rule edit or delete: which settings changed, old and new. */
export const POLICY_CHANGE_EVIDENCE_KIND = 'policy-change';

// The settings an edit can change, as the audit record names them, and their columns.
const EDITABLE_FIELDS = [
  ['name', 'name'], ['resourceType', 'resource_type'], ['naturalKeyGlob', 'natural_key_glob'],
  ['changeType', 'change_type'], ['blastRadius', 'blast_radius'], ['maxBlastRadius', 'max_blast_radius'],
  ['maxActionsPerWindow', 'max_actions_per_window'], ['windowSeconds', 'window_seconds'],
];

const sameValue = (a, b) => (a ?? null) === (b ?? null);

// The rule, locked until the caller's transaction ends, so the audit record and the
// change are made from the same row and commit together.
async function lockedPolicy(client, { tenantRef, policyId }) {
  const { rows } = await client.query(
    'SELECT * FROM policy WHERE id::text = $1 AND tenant_ref = $2 AND deleted_at IS NULL FOR UPDATE',
    [String(policyId), tenantRef],
  );
  if (!rows[0]) throw new Error(`policy not found: ${policyId}`);
  return rows[0];
}

// Runs `work` in one transaction and projects its audit record only once it commits.
async function withRecord(client, work) {
  let result;
  await client.query('BEGIN');
  try {
    result = await work();
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  }
  result.emit?.();
  return result.row;
}

/** Edits what a rule watches, its limits and its name. What it does (action) and the
 * account an undo rule acts as stay as they are: a different action is a different
 * rule. Editing an undo rule that is on turns it off, because its activation preview
 * was computed for the old scope and limits; it is turned on again only from a fresh
 * preview. Every field is required, so a caller sends the whole edited rule and a
 * cleared limit is an explicit null. Tenant-scoped; a deleted rule reads as not found.
 *
 * The audit record (POLICY_CHANGE_EVIDENCE_KIND) names each setting that changed with
 * its old and new value. An edit that changes nothing writes nothing and leaves the
 * rule as it is, so an undo rule saved unchanged stays on: its preview still holds. The record and the change
 * are written in one transaction from the locked row, so neither exists without the
 * other and the record always describes the change made. */
export async function updatePolicy(client, {
  tenantRef, policyId, name, resourceType, blastRadius, naturalKeyGlob, changeType,
  maxBlastRadius, maxActionsPerWindow, windowSeconds, actor,
}) {
  if (typeof actor !== 'string' || !actor) throw new Error('a rule edit needs an actor');
  if (typeof name !== 'string' || !name.trim()) throw new Error('policy name is required');
  if (blastRadius != null && !BLAST_RADII.includes(blastRadius)) throw new Error(`invalid blast radius: ${blastRadius}`);
  if (!BLAST_RADII.includes(maxBlastRadius)) throw new Error(`invalid max blast radius: ${maxBlastRadius}`);
  if (changeType != null && !CHANGE_TYPES.includes(changeType)) throw new Error(`invalid change type: ${changeType}`);
  if ((maxActionsPerWindow == null) !== (windowSeconds == null)) throw new Error('a rate limit needs both a count and a window');
  const next = {
    // An empty value means "any", the same as none, so it never reads as a change.
    name: name.trim(), resourceType: resourceType || null, naturalKeyGlob: naturalKeyGlob || null,
    changeType: changeType || null, blastRadius: blastRadius || null, maxBlastRadius,
    maxActionsPerWindow: maxActionsPerWindow ?? null, windowSeconds: windowSeconds ?? null,
  };
  return withRecord(client, async () => {
    const before = await lockedPolicy(client, { tenantRef, policyId });
    // The limit's count and window are one setting: when either changes, both are recorded.
    const limitChanged = !sameValue(before.max_actions_per_window, next.maxActionsPerWindow) || !sameValue(before.window_seconds, next.windowSeconds);
    const fields = EDITABLE_FIELDS
      .filter(([field, column]) => !sameValue(before[column], next[field]) || (limitChanged && (field === 'maxActionsPerWindow' || field === 'windowSeconds')))
      .map(([field, column]) => ({ field, before: before[column] ?? null, after: next[field] }));
    if (!fields.length) return { row: before };
    const turnedOff = before.action === 'auto_remediate' && before.enabled === true;
    const { emit } = await appendEvidenceInTransaction(client, {
      tenantRef,
      kind: POLICY_CHANGE_EVIDENCE_KIND,
      subject: {
        change: 'edited', policyId: String(before.id), name: next.name, action: before.action,
        fields: turnedOff ? [...fields, { field: 'enabled', before: true, after: false }] : fields,
      },
      actor,
    });
    const { rows } = await client.query(
      `UPDATE policy
          SET name = $2, resource_type = $3, blast_radius = $4, natural_key_glob = $5, change_type = $6,
              max_blast_radius = $7, max_actions_per_window = $8, window_seconds = $9,
              enabled = CASE WHEN action = 'auto_remediate' THEN false ELSE enabled END
        WHERE id = $1
        RETURNING *`,
      [
        before.id, next.name, next.resourceType, next.blastRadius, next.naturalKeyGlob,
        next.changeType, next.maxBlastRadius, next.maxActionsPerWindow, next.windowSeconds,
      ],
    );
    return { row: rows[0], emit };
  });
}

/** Deletes a rule: it is turned off and marked deleted, never removed, so the
 * evaluations, automatic actions and previews that reference it stay readable as
 * history. A deleted rule is skipped by every reader of current rules and by
 * evaluation; deleting twice reads as not found. The audit record lists the rule's
 * settings as they were, in the same transaction as the delete. */
export async function deletePolicy(client, { tenantRef, policyId, deletedBy }) {
  if (typeof deletedBy !== 'string' || !deletedBy) throw new Error('a rule delete needs an actor');
  return withRecord(client, async () => {
    const before = await lockedPolicy(client, { tenantRef, policyId });
    const fields = [
      { field: 'action', before: before.action, after: null },
      { field: 'enabled', before: before.enabled === true, after: false },
      ...EDITABLE_FIELDS.map(([field, column]) => ({ field, before: before[column] ?? null, after: null })),
    ];
    const { emit } = await appendEvidenceInTransaction(client, {
      tenantRef,
      kind: POLICY_CHANGE_EVIDENCE_KIND,
      subject: { change: 'deleted', policyId: String(before.id), name: before.name, action: before.action, fields },
      actor: deletedBy,
    });
    const { rows } = await client.query(
      'UPDATE policy SET enabled = false, deleted_at = now(), deleted_by = $2 WHERE id = $1 RETURNING *',
      [before.id, deletedBy],
    );
    return { row: rows[0], emit };
  });
}

/** Evaluates one newly detected drift row against every enabled policy for its
 * tenant, and writes exactly one evidence record for the evaluation — whether or
 * not any policy matched. Returns the matches so a caller (e.g. task 19's
 * auto-remediation execution) can act on an 'auto_remediate' outcome without
 * re-deriving it. */
export async function evaluateDrift(client, { tenantRef, drift, actor = 'policy-evaluator' }) {
  const { rows: policies } = await client.query(
    `SELECT * FROM policy WHERE tenant_ref = $1 AND enabled = true AND deleted_at IS NULL ORDER BY created_at, id`,
    [tenantRef],
  );

  const matches = policies
    .filter((policy) => policyMatches(policy, drift))
    .map((policy) => ({
      policyId: policy.id,
      policyName: policy.name,
      action: policy.action,
      outcome: outcomeFor(policy, drift),
    }));

  await appendEvidence(client, {
    tenantRef,
    kind: POLICY_EVALUATION_EVIDENCE_KIND,
    subject: {
      driftId: drift.id,
      naturalKey: drift.natural_key,
      resourceType: drift.resource_type,
      changeType: drift.change_type,
      blastRadius: drift.blast_radius,
      matched: matches.length > 0,
      matches,
    },
    actor,
  });

  return { driftId: drift.id, matches };
}

// A policy can be created or enabled after its matching drift was recorded. Re-run the
// normal one-drift evaluation for every open change so those rows receive the same
// evidence and auto-remediation path as newly recorded drift. Older drift-detect runs
// recorded a new row per run for a change they still saw; only the newest row for a
// resource (per baseline) says where the change stands, so only that row is evaluated,
// and only while it is open. Superseded rows are left as they are.
export async function evaluateOpenDrifts(client, {
  tenantRef,
  actor = 'policy-evaluator',
  automationActor = 'policy-automation',
}) {
  // A row recorded only because a stored hash predates a field rule is never acted on.
  await markSameContentDrift(client, { tenantRef });
  const { rows: drifts } = await client.query(
    `WITH latest AS (
       SELECT DISTINCT ON (baseline_id, natural_key) id
         FROM drift
        WHERE tenant_ref = $1
        ORDER BY baseline_id, natural_key, detected_at DESC, id DESC
     )
     SELECT d.*
       FROM drift d
       JOIN latest ON latest.id = d.id
      WHERE ${OPEN_DRIFT_PREDICATE}
      ORDER BY d.detected_at, d.id`,
    [tenantRef],
  );

  const evaluations = [];
  for (const drift of drifts) {
    const evaluation = await evaluateDrift(client, { tenantRef, drift, actor });
    const remediations = [];
    for (const match of evaluation.matches) {
      if (match.outcome === 'auto_remediate') {
        remediations.push({
          policyId: match.policyId,
          ...(await executeAutoRemediation(client, {
            tenantRef, drift, policyId: match.policyId, actor: automationActor,
          })),
        });
      }
    }
    evaluations.push({ ...evaluation, remediations });
  }
  return evaluations;
}
