import { LIVE_POLICY_READ } from './policyScenario.mjs';

/**
 * This delegated-credential What If prototype is not wired into production:
 * the product has application credentials, while this API requires delegated
 * credentials. signInPathGate.mjs is the live §10.3 gate.
 *
 * Roadmap task-95: What If evaluates the tenant's LIVE policies, so its result is a
 * live-policy read and never proof of a proposed policy set (`provesProposedState`
 * is always false). Proposed sets are evaluated locally by policyScenario.mjs.
 */
export async function evaluatePromotion(graphWriter, { principalMatrix, breakGlassUserIds }) {
  const evidence = { evidence: LIVE_POLICY_READ, evaluates: 'current-live-policies', provesProposedState: false };
  const results = [];
  for (const principal of principalMatrix) {
    const evaluations = await graphWriter.whatIf({
      signInIdentity: { '@odata.type': '#microsoft.graph.userSignIn', userId: principal.userId },
      signInContext: { '@odata.type': '#microsoft.graph.applicationContext', includeApplications: ['All'] },
      signInConditions: {},
    });
    const blocked = evaluations.some(
      (e) => e.policyApplies && e.grantControls?.builtInControls?.includes('block'),
    );
    results.push({ principal, blocked });
    if (blocked && breakGlassUserIds.includes(principal.userId)) {
      return { allowed: false, reason: `predicted block on break-glass account ${principal.userId}`, results, ...evidence };
    }
  }
  return { allowed: true, results, ...evidence };
}

/**
 * Roadmap task-95: what a proposed-policy scenario evaluation means for a change.
 *
 *  - `refuse` when a protected principal has no open path in a fully evaluated matrix;
 *  - `review` when the result is unknown (unsupported conditions, untested scenarios,
 *    truncated budget, missing inventory);
 *  - `sampled-pass` when every protected principal kept at least one sampled path.
 *
 * This is advisory evidence for a person. It never authorizes a write, never stands in
 * for the restore sign-in path gate (signInPathGate.mjs), never sets `simulationPassed`
 * for a tenant-lockout delete and never relaxes report-only enforcement; there is no
 * field in its result any write path reads.
 */
export function proposedPolicyGate(evaluation) {
  const constant = Object.freeze({
    authorizesWrite: false,
    signInPathCheck: 'still-required',
    reportOnlyEnforcement: 'unchanged',
    universalSafety: 'not-asserted',
  });
  const principals = (evaluation?.principals ?? []).filter((entry) => entry.protected !== false);
  const lockedOut = principals.filter((entry) => entry.verdict === 'lockout');
  if (lockedOut.length) {
    return { outcome: 'refuse', reason: `no open sign-in path for ${lockedOut.map((entry) => entry.label).join(', ')}`, ...constant };
  }
  if (evaluation?.overall === 'sampled-pass' && principals.length && principals.every((entry) => entry.verdict === 'pass' && entry.basis === 'sampled')) {
    return { outcome: 'sampled-pass', reason: 'every protected principal kept at least one sampled open path', ...constant };
  }
  const unknown = principals.filter((entry) => entry.verdict !== 'pass').map((entry) => `${entry.label}: ${entry.reason}`);
  return {
    outcome: 'review',
    reason: unknown.length ? `not established: ${unknown.join('; ')}` : (evaluation?.reason ?? 'no protected principal evaluated'),
    ...constant,
  };
}
