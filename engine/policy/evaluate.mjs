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
import { appendEvidence } from '../govern/evidence.mjs';
import { can } from '../authz/can.mjs';
import { findPrincipalById } from '../authz/principals.mjs';

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
  return BLAST_RADIUS_RANK[drift.blast_radius] > BLAST_RADIUS_RANK[policy.max_blast_radius];
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
  const { rows } = await client.query('SELECT * FROM policy WHERE id = $1', [policyId]);
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
      WHERE id = $1
      RETURNING *`,
    [policyId, enabled],
  );
  return updated[0];
}

/** Evaluates one newly detected drift row against every enabled policy for its
 * tenant, and writes exactly one evidence record for the evaluation — whether or
 * not any policy matched. Returns the matches so a caller (e.g. task 19's
 * auto-remediation execution) can act on an 'auto_remediate' outcome without
 * re-deriving it. */
export async function evaluateDrift(client, { tenantRef, drift, actor = 'policy-evaluator' }) {
  const { rows: policies } = await client.query(
    `SELECT * FROM policy WHERE tenant_ref = $1 AND enabled = true ORDER BY created_at, id`,
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
