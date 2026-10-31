import { grantComplianceException } from "../../engine/govern/baselineCompliance.mjs";
import { guarded, readActionParams, type GuardDeps } from "@/lib/action";
import { refuseWeakReason } from "@/lib/written-reason";

const NO_STORE = { "cache-control": "no-store" };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Compliance: grant (or renew) an exception on a failing control. It writes only Keel's
// own database: an exception row over the evaluation plus its evidence entry; the
// evaluation itself never changes. The guard checks `configuration` and records the
// attempt; the engine checks it again and refuses a missing owner, reason or a past end.
export function guardedComplianceException(deps: GuardDeps = {}) {
  return guarded({ action: "compliance:exception", capability: "configuration", recordAttempt: true }, async ({ client, principalId, tenantRef, request }) => {
    const { evaluationId, owner, reason, expiresAt } = await readActionParams(request);
    const refuse = (error: string, status = 400) => Response.json({ error }, { status, headers: NO_STORE });
    if (typeof evaluationId !== "string" || !UUID.test(evaluationId)) return refuse("invalid_request");
    if (typeof owner !== "string" || owner.trim().length === 0 || owner.length > 320) return refuse("owner_required");
    if (typeof reason !== "string" || reason.trim().length === 0) return refuse("reason_required");
    if (typeof expiresAt !== "string" || !Number.isFinite(Date.parse(expiresAt)) || Date.parse(expiresAt) <= Date.now()) return refuse("expiry_in_future");
    refuseWeakReason(reason);

    const { rows } = await client.query("SELECT verdict FROM benchmark_evaluation WHERE id = $1 AND tenant_ref = $2", [evaluationId, tenantRef]);
    if (!rows[0]) return refuse("not_found", 404);
    if (rows[0].verdict !== "fail") return refuse("not_failing", 409);

    try {
      const exception = (await grantComplianceException(client, {
        principalId, tenantRef, evaluationId, owner: owner.trim(), reason: reason.trim(), expiresAt,
      })) as Record<string, unknown>;
      return Response.json({
        exception: {
          id: String(exception.id),
          evaluationId,
          owner: exception.owner ?? null,
          reason: exception.reason ?? null,
          expiresAt: exception.expires_at instanceof Date ? exception.expires_at.toISOString() : exception.expires_at ?? null,
        },
      }, { status: 201, headers: NO_STORE });
    } catch (error) {
      if (error instanceof Error && error.message.startsWith("forbidden")) return refuse("forbidden", 403);
      if (error instanceof TypeError) return refuse("invalid_request");
      throw error;
    }
  }, deps);
}
