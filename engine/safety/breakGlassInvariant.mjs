/** Spec §10.4 — a precondition to be arranged, never relaxed. Failure aborts
 * the run; there is no override parameter on this function by design. */
export function assertBreakGlassCoverage({ breakGlassUserIds, caPoliciesInRestoreSet }) {
  if (breakGlassUserIds.length < 2) {
    return { ok: false, reason: `only ${breakGlassUserIds.length} break-glass account(s) found in the target tenant, need at least 2` };
  }
  for (const policy of caPoliciesInRestoreSet) {
    const excluded = new Set(policy.conditions?.users?.excludeUsers ?? []);
    for (const bg of breakGlassUserIds) {
      if (!excluded.has(bg)) {
        return { ok: false, reason: `break-glass account ${bg} is not excluded from policy ${policy.naturalKey}` };
      }
    }
  }
  return { ok: true };
}
