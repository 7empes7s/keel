/** Spec §10.3 — a predicted block on a break-glass account is a hard failure
 * with no override. There is deliberately no override parameter here. */
export async function evaluatePromotion(graphWriter, { principalMatrix, breakGlassUserIds }) {
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
      return { allowed: false, reason: `predicted block on break-glass account ${principal.userId}`, results };
    }
  }
  return { allowed: true, results };
}
