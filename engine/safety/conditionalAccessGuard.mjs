/** Spec §10.2 — an automated restore never enforces a CA policy. This is the
 * only place a CA payload's `state` field is allowed to be set before a write. */
export function enforceReportOnly(policyPayload, { override } = {}) {
  if (override) {
    if (!override.reason || !override.signedBy) {
      throw new Error('overriding report-only enforcement requires both reason and signedBy');
    }
    return { ...policyPayload };
  }
  return { ...policyPayload, state: 'enabledForReportingButNotEnforced' };
}
