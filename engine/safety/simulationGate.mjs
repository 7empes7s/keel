/**
 * This delegated-credential What If prototype is not wired into production:
 * the product has application credentials, while this API requires delegated
 * credentials. signInPathGate.mjs is the live §10.3 gate.
 */
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
