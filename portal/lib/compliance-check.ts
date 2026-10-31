import { runComplianceChecks } from "../../engine/benchmarks/runChecks.mjs";
import { guarded, type GuardDeps } from "@/lib/action";

const NO_STORE = { "cache-control": "no-store" };

// Compliance: "Check now". Runs every control against the newest backups and records
// each result. It reads Keel's own database and writes only check results and their
// evidence entries, never the tenant. Keel also runs it after each backup. The guard
// checks `collect`, the permission that runs backups, and records the attempt.
export function guardedComplianceCheck(deps: GuardDeps = {}) {
  return guarded({ action: "compliance:check", capability: "collect", recordAttempt: true }, async ({ client, principalId, tenantRef }) => {
    const checks = (await runComplianceChecks(client, { tenantRef, actor: principalId })) as {
      checked: number; pass: number; fail: number; unknown: number; byHand: number; notApplicable: number; notConfigured: number;
    };
    return Response.json({
      checked: checks.checked, pass: checks.pass, fail: checks.fail, unknown: checks.unknown, byHand: checks.byHand ?? 0, notApplicable: checks.notApplicable, notConfigured: checks.notConfigured,
    }, { status: 201, headers: NO_STORE });
  }, deps);
}
