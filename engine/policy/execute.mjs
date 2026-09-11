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
import { can } from '../authz/can.mjs';
import { findPrincipalById } from '../authz/principals.mjs';

export const AUTOMATION_KILL_SWITCH_PATH = '/var/lib/keel/AUTOMATION_DISABLED';
export const AUTOMATION_EXECUTION_EVIDENCE_KIND = 'automation-execution';

async function countQueuedOrExecutedActions(client, { tenantRef, policyId, windowSeconds }) {
  const { rows } = await client.query(
    `SELECT count(*)::int AS count
       FROM auto_remediation_execution
      WHERE tenant_ref = $1
        AND policy_id = $2
        AND status IN ('queued','executed')
        AND queued_at > now() - ($3 * interval '1 second')`,
    [tenantRef, policyId, windowSeconds],
  );
  return rows[0].count;
}

async function executionForPolicyDrift(client, { policyId, driftId }) {
  const { rows } = await client.query(
    `SELECT * FROM auto_remediation_execution
      WHERE policy_id = $1 AND drift_id = $2`,
    [policyId, driftId],
  );
  return rows[0] ?? null;
}

// The worker calls this only after it has made a remediate job terminal. Human-requested
// remediation has no auto_remediation_execution row and therefore remains unaffected.
// The queued -> terminal transition is conditional, making a repeated worker outcome
// idempotent and ensuring there can never be two terminal evidence entries for one job.
export async function recordAutoRemediationTerminalOutcome(client, {
  job, status, error = null, actor = 'keel-worker',
}) {
  if (job.kind !== 'remediate') return null;
  const { rows: executions } = await client.query(
    `SELECT * FROM auto_remediation_execution WHERE job_id::text = $1`,
    [job.id],
  );
  const execution = executions[0];
  if (!execution || execution.status !== 'queued') return execution ?? null;

  const outcome = status === 'succeeded' ? 'executed' : 'failed';
  const { rows } = await client.query(
    `UPDATE auto_remediation_execution
        SET status = $2, finished_at = now(), error = $3
      WHERE job_id::text = $1 AND status = 'queued'
      RETURNING *`,
    [job.id, outcome, error],
  );
  const terminal = rows[0];
  if (!terminal) return executionForPolicyDrift(client, {
    policyId: execution.policy_id, driftId: execution.drift_id,
  });

  await appendEvidence(client, {
    tenantRef: terminal.tenant_ref,
    kind: AUTOMATION_EXECUTION_EVIDENCE_KIND,
    subject: {
      policyId: terminal.policy_id,
      driftId: terminal.drift_id,
      jobId: terminal.job_id,
      outcome,
      jobStatus: status,
      ...(error ? { error } : {}),
    },
    actor,
  });
  return terminal;
}

/** Acts on one 'auto_remediate' match from evaluateDrift. Re-reads the policy fresh and
 * re-derives every guardrail itself; nothing about whether to act is trusted from the
 * caller. Returns { executed, outcome, jobId? }. Enqueuing reports `queued`; only the
 * worker's terminal outcome records `executed`. A refusal is recorded rather than
 * thrown — only a missing drift/policy row (a caller error) throws. */
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
  if (policy.run_as_repair_required || !policy.run_as_principal_id) {
    return refuse('run-as-repair-required');
  }

  // A later revocation, expiry, or disablement never lets automation mint a job under
  // a stale identity. The worker independently makes this same decision immediately
  // before dispatch, so a job already queued before the change also stops before its
  // handler.
  const runAsPrincipal = await findPrincipalById(client, policy.run_as_principal_id);
  if (!(await can(client, runAsPrincipal, 'remediate', new Date()))) {
    await client.query(
      `UPDATE policy
          SET enabled = false,
              paused_at = COALESCE(paused_at, now()),
              run_as_repair_required = true
        WHERE id = $1`,
      [policy.id],
    );
    return refuse('run-as-not-authorized');
  }

  // Structural guardrail (§3.4), re-verified here rather than trusted from the caller.
  if (exceedsMaxBlastRadius(drift, policy)) return refuse('blocked-max-blast-radius');

  // Re-evaluating the same policy/drift must return its original job without consuming
  // another rate-limit slot or creating a second queued evidence record.
  const existing = await executionForPolicyDrift(client, { policyId: policy.id, driftId: drift.id });
  if (existing) {
    return {
      executed: existing.status === 'executed', outcome: existing.status, jobId: existing.job_id,
    };
  }

  if (policy.max_actions_per_window != null && policy.window_seconds != null) {
    const count = await countQueuedOrExecutedActions(client, {
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

  // created_by remains audit provenance. The job carries the explicit run-as principal,
  // whose live remediate grant the worker re-authorizes immediately before dispatch.
  const job = await enqueue(client, {
    kind: 'remediate',
    params: { driftIds: [drift.id], mode: 'enforce' },
    requestedBy: policy.run_as_principal_id,
    idempotencyKey: `policy:${policy.id}:drift:${drift.id}`,
  });

  const { rows: executions } = await client.query(
    `INSERT INTO auto_remediation_execution
       (job_id, tenant_ref, policy_id, drift_id, status)
     VALUES ($1,$2,$3,$4,'queued')
     ON CONFLICT (policy_id, drift_id) DO NOTHING
     RETURNING *`,
    [job.id, tenantRef, policy.id, drift.id],
  );
  const execution = executions[0];
  if (!execution) {
    const concurrent = await executionForPolicyDrift(client, { policyId: policy.id, driftId: drift.id });
    return {
      executed: concurrent?.status === 'executed', outcome: concurrent?.status ?? 'queued', jobId: job.id,
    };
  }

  await appendEvidence(client, {
    tenantRef,
    kind: AUTOMATION_EXECUTION_EVIDENCE_KIND,
    subject: {
      policyId: policy.id, driftId: drift.id, naturalKey: drift.natural_key,
      outcome: 'queued', jobId: job.id,
    },
    actor,
  });

  return { executed: false, outcome: 'queued', jobId: job.id };
}
