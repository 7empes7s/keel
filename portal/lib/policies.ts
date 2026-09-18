import { existsSync } from "node:fs";
import { createPolicy, listPolicies, setPolicyEnabled, clearPolicyPause } from "../../engine/policy/evaluate.mjs";
import { AUTOMATION_KILL_SWITCH_PATH } from "../../engine/policy/execute.mjs";
import { guarded, readActionParams, InvalidActionRequest, type GuardDeps } from "@/lib/action";

import type { DataSurface } from "@/lib/read";

const NO_STORE = { "cache-control": "no-store" };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const BLAST = ["cosmetic", "access-affecting", "tenant-lockout"];

export interface Policy {
  id: string;
  name: string;
  enabled: boolean;
  paused_at: string | null;
  run_as_repair_required: boolean;
  run_as_principal_id: string | null;
  resource_type: string | null;
  blast_radius: string | null;
  natural_key_glob: string | null;
  change_type: string | null;
  action: string;
  max_blast_radius: string;
  max_actions_per_window: number | null;
  window_seconds: number | null;
  created_by: string;
  created_at: string;
}

export function automationDisabled(path = AUTOMATION_KILL_SWITCH_PATH): boolean {
  return existsSync(path);
}

export function guardedPolicyList(deps: GuardDeps = {}) {
  return guarded({ action: "policies:list", capability: "policies" }, async ({ client, tenantRef, request }) => {
    const filter = new URL(request.url).searchParams.get("enabled");
    if (filter !== null && filter !== "true" && filter !== "false") throw new InvalidActionRequest();
    const policies = await listPolicies(client, { tenantRef, enabled: filter === null ? undefined : filter === "true" });
    return Response.json({ policies, automationDisabled: automationDisabled(), generatedAt: new Date().toISOString() }, { headers: NO_STORE });
  }, deps);
}

export function guardedPolicyShow(deps: GuardDeps = {}) {
  return guarded({ action: "policies:show", capability: "policies" }, async ({ client, tenantRef, request }) => {
    const id = new URL(request.url).pathname.split("/").at(-1) ?? "";
    if (!UUID.test(id)) return Response.json({ error: "not_found" }, { status: 404, headers: NO_STORE });
    const { rows } = await client.query("SELECT * FROM policy WHERE id = $1 AND tenant_ref = $2", [id, tenantRef]);
    return Response.json(rows[0] ? { policy: rows[0] } : { error: "not_found" }, { status: rows[0] ? 200 : 404, headers: NO_STORE });
  }, deps);
}

export function guardedPolicyCreate(surface: DataSurface, deps: GuardDeps = {}) {
  return guarded({ action: "policies:create", capability: surface.capability, recordAttempt: true }, async ({ client, tenantRef, principalId, request }) => {
    const body = await readActionParams(request);
    if (typeof body.name !== "string" || !body.name.trim()
      || !["alert", "require_approval", "auto_remediate"].includes(String(body.action))
      || !BLAST.includes(String(body.maxBlastRadius))
      || (body.enabled !== undefined && typeof body.enabled !== "boolean")) throw new InvalidActionRequest();
    for (const key of ["resourceType", "naturalKeyGlob", "changeType", "blastRadius", "runAsPrincipalId"]) {
      if (body[key] != null && typeof body[key] !== "string") throw new InvalidActionRequest();
    }
    if (body.blastRadius != null && !BLAST.includes(String(body.blastRadius))) throw new InvalidActionRequest();
    for (const key of ["maxActionsPerWindow", "windowSeconds"]) {
      if (body[key] != null && (!Number.isSafeInteger(body[key]) || Number(body[key]) <= 0)) throw new InvalidActionRequest();
    }
    if ((body.maxActionsPerWindow == null) !== (body.windowSeconds == null)) throw new InvalidActionRequest();
    try {
      const policy = await createPolicy(client, {
        tenantRef, createdBy: principalId, name: body.name, enabled: body.enabled ?? true,
        resourceType: body.resourceType, blastRadius: body.blastRadius, naturalKeyGlob: body.naturalKeyGlob,
        changeType: body.changeType, action: body.action, maxBlastRadius: body.maxBlastRadius,
        maxActionsPerWindow: body.maxActionsPerWindow, windowSeconds: body.windowSeconds,
        runAsPrincipalId: body.runAsPrincipalId,
      });
      return Response.json({ policy }, { status: 201, headers: NO_STORE });
    } catch {
      return Response.json({ error: "invalid_request" }, { status: 400, headers: NO_STORE });
    }
  }, deps);
}

export function guardedPolicyUpdate(operation: "enabled" | "clear-pause", surface: DataSurface, deps: GuardDeps = {}) {
  return guarded({ action: `policies:${operation}`, capability: surface.capability, recordAttempt: true }, async ({ client, tenantRef, request }) => {
    const id = new URL(request.url).pathname.split("/").at(-2) ?? "";
    if (!UUID.test(id)) return Response.json({ error: "not_found" }, { status: 404, headers: NO_STORE });
    const { rows } = await client.query("SELECT id FROM policy WHERE id = $1 AND tenant_ref = $2", [id, tenantRef]);
    if (!rows[0]) return Response.json({ error: "not_found" }, { status: 404, headers: NO_STORE });
    const body = await readActionParams(request);
    if (operation === "enabled" && typeof body.enabled !== "boolean") throw new InvalidActionRequest();
    try {
      const policy = operation === "enabled"
        ? await setPolicyEnabled(client, { policyId: id, enabled: body.enabled })
        : await clearPolicyPause(client, { policyId: id });
      return Response.json({ policy }, { headers: NO_STORE });
    } catch {
      return Response.json({ error: "conflict" }, { status: 409, headers: NO_STORE });
    }
  }, deps);
}
