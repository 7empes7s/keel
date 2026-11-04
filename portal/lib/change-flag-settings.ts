import { AlertAuthorizationError } from "../../engine/notify/alerts.mjs";
import { flagSettings, setFlagEnabled } from "../../engine/notify/changeFlags.mjs";
import { guarded, InvalidActionRequest, readActionParams, type GuardDeps } from "@/lib/action";

export function guardedFlagSettingsRead(deps: GuardDeps = {}) {
  return guarded({ action: "change-flags:read", capability: "read" }, async ({ client, tenantRef }) =>
    Response.json({ settings: await flagSettings(client, { tenantRef }) }, { headers: { "cache-control": "no-store" } }), deps);
}

export function guardedFlagSettingsUpdate(deps: GuardDeps = {}) {
  return guarded({ action: "change-flags:update", capability: "policies", recordAttempt: true }, async ({ client, tenantRef, principalId, request }) => {
    const body = await readActionParams(request);
    if (typeof body.key !== "string" || typeof body.enabled !== "boolean") throw new InvalidActionRequest();
    try {
      await setFlagEnabled(client, { tenantRef, actor: principalId, key: body.key, enabled: body.enabled });
      return Response.json({ settings: await flagSettings(client, { tenantRef }) }, { headers: { "cache-control": "no-store" } });
    } catch (error) {
      if (error instanceof TypeError) throw new InvalidActionRequest();
      if (error instanceof AlertAuthorizationError) return Response.json({ error: "forbidden" }, { status: 403 });
      throw error;
    }
  }, deps);
}
