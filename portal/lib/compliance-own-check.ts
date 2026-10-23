import { createOwnCheck, controlFromRow, removeOwnCheck, shapeOwnCheck } from "../../engine/benchmarks/ownChecks.mjs";
import { runComplianceChecks } from "../../engine/benchmarks/runChecks.mjs";
import { guarded, readActionParams, type GuardDeps } from "@/lib/action";

const NO_STORE = { "cache-control": "no-store" };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Compliance: a check the tenant writes itself (engine/benchmarks/ownChecks.mjs). Saving
// writes only Keel's own database: the check, its evidence entry, and its first result,
// run at once against the newest backup so the page shows it straight away. The guard
// checks `configuration` and records the attempt; the engine checks it again.
export function guardedOwnCheckCreate(deps: GuardDeps = {}) {
  return guarded({ action: "compliance:own-check", capability: "configuration", recordAttempt: true }, async ({ client, principalId, tenantRef, request }) => {
    const params = await readActionParams(request);
    const input = {
      standard: params.standard, name: params.name, resourceType: params.resourceType, field: params.field,
      operator: params.operator, expected: params.expected, appliesTo: params.appliesTo, severity: params.severity,
    };
    if (!Object.hasOwn(params, "expected")) delete (input as Record<string, unknown>).expected;
    try {
      const row = (await createOwnCheck(client, { principalId, tenantRef, input })) as Record<string, unknown>;
      // The check is saved: a failure of its first run must not read as "not saved" (a
      // retry would write it twice). It runs again after the next backup.
      let evaluation: { id: string; verdict: string } | undefined;
      try {
        const checks = (await runComplianceChecks(client, { tenantRef, actor: principalId, controls: [controlFromRow(row)] })) as {
          evaluations: { id: string; verdict: string }[];
        };
        evaluation = checks.evaluations[0];
      } catch {
        evaluation = undefined;
      }
      return Response.json({
        check: shapeOwnCheck(row),
        evaluationId: evaluation ? String(evaluation.id) : null,
        verdict: evaluation?.verdict ?? null,
      }, { status: 201, headers: NO_STORE });
    } catch (error) {
      if (error instanceof Error && error.message.startsWith("forbidden")) return Response.json({ error: "forbidden" }, { status: 403, headers: NO_STORE });
      if (error instanceof TypeError) return Response.json({ error: "invalid_request", detail: error.message }, { status: 400, headers: NO_STORE });
      throw error;
    }
  }, deps);
}

// Removes one of the tenant's own checks. Its past results and evidence stay; it no
// longer runs or shows.
export function guardedOwnCheckRemove(deps: GuardDeps = {}) {
  return guarded({ action: "compliance:own-check-remove", capability: "configuration", recordAttempt: true }, async ({ client, principalId, tenantRef, request }) => {
    const { checkId } = await readActionParams(request);
    if (typeof checkId !== "string" || !UUID.test(checkId)) return Response.json({ error: "invalid_request" }, { status: 400, headers: NO_STORE });
    try {
      const row = await removeOwnCheck(client, { principalId, tenantRef, checkId });
      if (!row) return Response.json({ error: "not_found" }, { status: 404, headers: NO_STORE });
      return Response.json({ removed: checkId }, { status: 200, headers: NO_STORE });
    } catch (error) {
      if (error instanceof Error && error.message.startsWith("forbidden")) return Response.json({ error: "forbidden" }, { status: 403, headers: NO_STORE });
      throw error;
    }
  }, deps);
}
