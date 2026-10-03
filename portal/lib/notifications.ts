import { ChannelConfigError } from "../../engine/notify/adapters.mjs";
import { CHANNEL_KIND_ERROR, createChannel, createSubscription, listDeliveries } from "../../engine/notify/notifications.mjs";
import { guarded, readActionParams, InvalidActionRequest, type GuardDeps } from "@/lib/action";
import type { DataSurface } from "@/lib/read";

const NO_STORE = { "cache-control": "no-store" };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export interface Channel { id: string; kind: string; config: Record<string, unknown>; enabled: boolean }
export interface Subscription { id: string; channel_id: string; event_glob: string; min_severity: string }
export interface Delivery { id: string; event: { kind: string; severity: string }; channel_id: string; channel_kind: string; status: string; attempts: number; last_error: string | null; next_attempt_at: string | null; provider_receipt?: ProviderReceipt | null }

/** Task 84: what the provider said, with every secret already redacted by the engine. */
export interface ProviderReceipt { channel?: string; provider?: string; outcome?: string; httpStatus?: number | null; semantics?: string; endpointHost?: string; dedupKey?: string; providerMessageId?: string | null; providerStatus?: string | null; retryAfterMs?: number }

export function guardedNotificationList(kind: "channels" | "subscriptions" | "deliveries", surface: DataSurface, deps: GuardDeps = {}) {
  return guarded({ action: `${kind}:list`, capability: surface.capability }, async ({ client, request }) => {
    let rows;
    if (kind === "deliveries") {
      const params = new URL(request.url).searchParams;
      const channelId = params.get("channelId") ?? undefined;
      const limit = Number(params.get("limit") ?? 50);
      if ((channelId && !UUID.test(channelId)) || !Number.isSafeInteger(limit) || limit < 1 || limit > 500) throw new InvalidActionRequest();
      const options = { channelId, limit };
      rows = await listDeliveries(client, options);
    } else {
      rows = (await client.query(kind === "channels" ? "SELECT * FROM channel ORDER BY created_at DESC, id" : "SELECT * FROM subscription ORDER BY created_at DESC, id")).rows;
    }
    return Response.json({ [kind]: rows, generatedAt: new Date().toISOString() }, { headers: NO_STORE });
  }, deps);
}

export function guardedNotificationCreate(kind: "channels" | "subscriptions", surface: DataSurface, deps: GuardDeps = {}) {
  return guarded({ action: `${kind}:create`, capability: surface.capability, recordAttempt: true }, async ({ client, request }) => {
    const body = await readActionParams(request);
    if (kind === "channels") {
      if ((body.config !== undefined && (body.config === null || typeof body.config !== "object" || Array.isArray(body.config)))
        || (body.enabled !== undefined && typeof body.enabled !== "boolean")) throw new InvalidActionRequest();
    } else if (typeof body.channelId !== "string" || !UUID.test(body.channelId)
      || typeof body.eventGlob !== "string" || !body.eventGlob.length
      || !["notice", "warning", "critical"].includes(String(body.minSeverity))) throw new InvalidActionRequest();
    try {
      const row = kind === "channels"
        ? await createChannel(client, { kind: body.kind, config: body.config, enabled: typeof body.enabled === "boolean" ? body.enabled : true })
        : await createSubscription(client, { channelId: body.channelId, eventGlob: body.eventGlob, minSeverity: body.minSeverity });
      return Response.json({ [kind === "channels" ? "channel" : "subscription"]: row }, { status: 201, headers: NO_STORE });
    } catch (error) {
      if (error instanceof ChannelConfigError || (error instanceof Error && error.message === CHANNEL_KIND_ERROR)) {
        return Response.json({ error: error.message }, { status: 400, headers: NO_STORE });
      }
      if ((error as { code?: string }).code === "23503") return Response.json({ error: "invalid_request" }, { status: 400, headers: NO_STORE });
      throw error;
    }
  }, deps);
}

export function guardedNotificationUpdate(kind: "channels" | "subscriptions", deps: GuardDeps = {}) {
  return guarded({ action: kind === "channels" ? "channels:disable" : "subscriptions:delete", capability: "configuration", recordAttempt: true }, async ({ client, request }) => {
    const id = new URL(request.url).pathname.split("/").at(kind === "channels" ? -2 : -1) ?? "";
    if (!UUID.test(id)) return Response.json({ error: "not_found" }, { status: 404, headers: NO_STORE });
    const { rows } = await client.query(kind === "channels"
      ? "UPDATE channel SET enabled = false WHERE id = $1 RETURNING id"
      : "DELETE FROM subscription WHERE id = $1 RETURNING id", [id]);
    return Response.json(rows[0] ? { id: rows[0].id } : { error: "not_found" }, { status: rows[0] ? 200 : 404, headers: NO_STORE });
  }, deps);
}
