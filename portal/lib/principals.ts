import { listPrincipals } from "../../engine/authz/principals.mjs";
import { grantRole, revokeRole, disablePrincipal, SelfLockoutError, PrincipalNotFoundError, InvalidRoleGrantError } from "../../engine/authz/administration.mjs";
import { guarded, readActionParams, InvalidActionRequest, type GuardDeps } from "@/lib/action";
import type { DataSurface } from "@/lib/read";

const NO_STORE = { "cache-control": "no-store" };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export interface PrincipalView {
  id: string; email: string; disabled_at: string | null; capabilities: string[];
  role_grants: { id: string; role: string; active_from: string; active_until: string | null }[];
}

export function guardedPrincipalList(deps: GuardDeps = {}) {
  return guarded({ action: "principals:list", capability: "users" }, async ({ client }) => {
    return Response.json({ principals: await listPrincipals(client), generatedAt: new Date().toISOString() }, { headers: NO_STORE });
  }, deps);
}

export function guardedPrincipalWrite(operation: "grant" | "revoke" | "disable", surface: DataSurface, deps: GuardDeps = {}) {
  return guarded({ action: `principals:${operation}`, capability: surface.capability, recordAttempt: true }, async ({ client, principalId: actor, request }) => {
    const principalId = new URL(request.url).pathname.split("/").at(-2) ?? "";
    if (!UUID.test(principalId)) return Response.json({ error: "not_found" }, { status: 404, headers: NO_STORE });
    const body = await readActionParams(request);
    if (operation === "grant" && (typeof body.role !== "string"
      || (body.activeFrom != null && typeof body.activeFrom !== "string")
      || (body.activeUntil != null && typeof body.activeUntil !== "string"))) throw new InvalidActionRequest();
    if (operation === "revoke" && (typeof body.grantId !== "string" || !UUID.test(body.grantId))) throw new InvalidActionRequest();
    try {
      const result = operation === "grant"
        ? await grantRole(client, { principalId, role: body.role as string, grantedBy: actor, activeFrom: body.activeFrom as string | null | undefined, activeUntil: body.activeUntil as string | null | undefined })
        : operation === "revoke" ? await revokeRole(client, { principalId, grantId: body.grantId, revokedBy: actor })
        : await disablePrincipal(client, principalId);
      return Response.json({ result }, { status: operation === "grant" ? 201 : 200, headers: NO_STORE });
    } catch (error) {
      const status = error instanceof SelfLockoutError ? 403 : error instanceof PrincipalNotFoundError ? 404 : error instanceof InvalidRoleGrantError ? 400 : null;
      if (status) return Response.json({ error: status === 403 ? "forbidden" : status === 404 ? "not_found" : "invalid_request" }, { status, headers: NO_STORE });
      throw error;
    }
  }, deps);
}
