// engine/policy/execute.mjs
//
// §3.4, plan task 19: automatic remediation execution. engine/policy/evaluate.mjs (task
// 18) only recommends an outcome; this module is what acts on an 'auto_remediate'
// outcome, and it acts through the exact path a human-approved remediation uses —
// enqueue() into the job table (§3.1), executed by keel-worker's 'remediate' handler,
// which dispatches to cli/keel-remediate.mjs -> runRestore, inheriting every one of
// restore's safety gates, the §10.3 sign-in path gate included. There is no separate,
// automation-only apply path anywhere in this chain for a bypass to hide in.
//
// This module never trusts a value computed earlier by a caller: it re-reads the
// policy's live row immediately before acting, because an evaluation computed moments
// ago can already be stale — an operator may have disabled the policy since, or a
// concurrent evaluation may already have tripped its rate limit.
//
// Three structural guardrails, none configurable away (§3.4):
//   - max_blast_radius, re-verified here rather than trusted from the caller's outcome
//     string — the same rule evaluate.mjs already enforces, enforced again by the
//     component that is actually about to act.
//   - a rate limit that PAUSES the policy — setting policy.paused_at — when
//     max_actions_per_window is exceeded within window_seconds, rather than silently
//     skipping the action that tipped it over. Once paused, a policy takes no further
//     automatic action until an operator clears it.
//   - the global kill switch at killSwitchPath (default
//     /var/lib/keel/AUTOMATION_DISABLED): its mere existence stops every policy,
//     unconditionally, with no deploy and no per-policy override.
//
// Every outcome — executed or refused — is written to the evidence chain, so "why did
// nothing happen" stays answerable exactly as evaluate.mjs already made true for the
// recommendation itself.
import { existsSync } from 'node:fs';
import { enqueue } from '../jobs/queue.mjs';
import { appendEvidence } from '../govern/evidence.mjs';
import { exceedsMaxBlastRadius } from './evaluate.mjs';

export const AUTOMATION_KILL_SWITCH_PATH = '/var/lib/keel/AUTOMATION_DISABLED';
export const AUTOMATION_EXECUTION_EVIDENCE_KIND = 'automation-execution';

async function countExecutedActions(client, { tenantRef, policyId, windowSeconds }) {
  const { rows } = await client.query(
    `SELECT count(*)::int AS count FROM evidence
     WHERE tenant_ref = $1 AND kind = $2 AND subject->>'policyId' = $3
       AND subject->>'outcome' = 'executed'
       AND occurred_at > now() - ($4 * interval '1 second')`,
    [tenantRef, AUTOMATION_EXECUTION_EVIDENCE_KIND, policyId, windowSeconds],
  );
  return rows[0].count;
}

/** Acts on one 'auto_remediate' match from evaluateDrift. Re-reads the policy fresh and
 * re-derives every guardrail itself; nothing about whether to act is trusted from the
 * caller. Returns { executed, outcome, jobId? }. A refusal is a recorded outcome, not a
 * thrown error — only a missing drift/policy row (a caller error) throws. */
export async function executeAutoRemediation(client, {
  tenantRef, drift, policyId, actor = 'policy-automation',
  killSwitchPath = AUTOMATION_KILL_SWITCH_PATH,
}) {
  const refuse = async (outcome, extra = {}) => {
    await appendEvidence(client, {
      tenantRef,
      kind: AUTOMATION_EXECUTION_EVIDENCE_KIND,
      subject: {
        policyId, driftId: drift.id, naturalKey: drift.natural_key, outcome, ...extra,
      },
      actor,
    });
    return { executed: false, outcome };
  };

  // The kill switch stops every policy — checked before this policy's own state, so a
  // global halt never depends on any one policy's configuration being consulted first.
  if (existsSync(killSwitchPath)) return refuse('automation-disabled');

  const { rows } = await client.query('SELECT * FROM policy WHERE id = $1', [policyId]);
  const policy = rows[0];
  if (!policy) throw new Error(`policy not found: ${policyId}`);
  if (!policy.enabled) return refuse('policy-disabled');
  if (policy.paused_at) return refuse('policy-paused');

  // Structural guardrail (§3.4), re-verified here rather than trusted from the caller.
  if (exceedsMaxBlastRadius(drift, policy)) return refuse('blocked-max-blast-radius');

  if (policy.max_actions_per_window != null && policy.window_seconds != null) {
    const count = await countExecutedActions(client, {
      tenantRef, policyId: policy.id, windowSeconds: policy.window_seconds,
    });
    if (count >= policy.max_actions_per_window) {
      // Exceeding the limit PAUSES the policy — a durable state change the next
      // evaluation will see — rather than merely skipping this one action while
      // leaving the policy enabled to trip the same limit silently again next time.
      await client.query('UPDATE policy SET paused_at = now() WHERE id = $1', [policy.id]);
      return refuse('rate-limit-paused');
    }
  }

  // requestedBy is the policy's own creator: the same principal whose 'policies'
  // capability created this automation is who task 25's re-authorization at execution
  // time will check. If that principal's access is later revoked, this policy's
  // automatic actions stop being able to run — exactly the revocation guarantee task 25
  // exists to provide, extended to automation instead of bypassing it.
  const job = await enqueue(client, {
    kind: 'remediate',
    params: { driftIds: [drift.id], mode: 'enforce' },
    requestedBy: policy.created_by,
    idempotencyKey: `policy:${policy.id}:drift:${drift.id}`,
  });

  await appendEvidence(client, {
    tenantRef,
    kind: AUTOMATION_EXECUTION_EVIDENCE_KIND,
    subject: {
      policyId: policy.id, driftId: drift.id, naturalKey: drift.natural_key,
      outcome: 'executed', jobId: job.id,
    },
    actor,
  });

  return { executed: true, outcome: 'executed', jobId: job.id };
}
