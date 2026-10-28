import { ChannelConfigError } from "../../engine/notify/adapters.mjs";
import { createEscalationRule, listEscalationRules, setEscalationRuleEnabled } from "../../engine/notify/escalation.mjs";
import { CHANNEL_KIND_ERROR, CHANNEL_NOT_FOUND, CHANNEL_OFF, createChannel, createSubscription, listDeliveries, sendTestAlert } from "../../engine/notify/notifications.mjs";
import { guarded, readActionParams, InvalidActionRequest, type GuardDeps } from "@/lib/action";
import { peopleNamer, shownPerson } from "@/lib/people-names";
import type { DataSurface } from "@/lib/read";

const NO_STORE = { "cache-control": "no-store" };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SEVERITIES = ["notice", "warning", "critical"];
const DELIVERY_STATUSES = ["queued", "delivering", "retrying", "delivered", "failed", "cancelled"];
export interface Channel { id: string; kind: string; config: Record<string, unknown>; enabled: boolean; created_at?: string | null }
export interface Subscription { id: string; channel_id: string; event_glob: string; min_severity: string; created_at?: string | null }
export interface DeliveryEvent { kind: string; severity: string; alertId?: string; resourceKey?: string; control?: string; condition?: string; occurrence?: number; [key: string]: unknown }
export interface Delivery { id: string; event: DeliveryEvent; channel_id: string; channel_kind: string; status: string; attempts: number; last_error: string | null; next_attempt_at: string | null; created_at?: string | null; delivered_at?: string | null; provider_receipt?: ProviderReceipt | null }
/** Portal audit, Notifications: "when nobody responds" rules, with the owner's name and
 * the channel they escalate to joined in by the engine. */
export interface EscalationRule {
  id: string; control: string | null; min_severity: string; ack_within_ms: number; enabled: boolean; created_at?: string | null;
  owner_principal_id: string | null; owner_name?: string | null; owner_email?: string | null; owner_disabled_at?: string | null;
  escalate_channel_id: string | null; channel_kind?: string | null; channel_enabled?: boolean | null;
}

/** Task 84: what the provider said, with every secret already redacted by the engine. */
export interface ProviderReceipt { channel?: string; provider?: string; outcome?: string; httpStatus?: number | null; semantics?: string; endpointHost?: string; dedupKey?: string; providerMessageId?: string | null; providerStatus?: string | null; retryAfterMs?: number }

export function guardedNotificationList(kind: "channels" | "subscriptions" | "deliveries", surface: DataSurface, deps: GuardDeps = {}) {
  return guarded({ action: `${kind}:list`, capability: surface.capability }, async ({ client, request }) => {
    let rows;
    if (kind === "deliveries") {
      const params = new URL(request.url).searchParams;
      const channelId = params.get("channelId") ?? undefined;
      const status = params.get("status") ?? undefined;
      const limit = Number(params.get("limit") ?? 50);
      if ((channelId && !UUID.test(channelId)) || (status && !DELIVERY_STATUSES.includes(status)) || !Number.isSafeInteger(limit) || limit < 1 || limit > 500) throw new InvalidActionRequest();
      const options = { channelId, status, limit };
      rows = await listDeliveries(client, options);
    } else {
      rows = (await client.query(kind === "channels" ? "SELECT * FROM channel ORDER BY created_at DESC, id" : "SELECT * FROM subscription ORDER BY created_at DESC, id")).rows;
    }
    return Response.json({ [kind]: rows, generatedAt: new Date().toISOString() }, { headers: NO_STORE });
  }, deps);
}

function validSubscriptionBody(body: Record<string, unknown>): boolean {
  return typeof body.channelId === "string" && UUID.test(body.channelId)
    && typeof body.eventGlob === "string" && body.eventGlob.length > 0
    && SEVERITIES.includes(String(body.minSeverity));
}

export function guardedNotificationCreate(kind: "channels" | "subscriptions", surface: DataSurface, deps: GuardDeps = {}) {
  return guarded({ action: `${kind}:create`, capability: surface.capability, recordAttempt: true }, async ({ client, request }) => {
    const body = await readActionParams(request);
    if (kind === "channels") {
      if ((body.config !== undefined && (body.config === null || typeof body.config !== "object" || Array.isArray(body.config)))
        || (body.enabled !== undefined && typeof body.enabled !== "boolean")) throw new InvalidActionRequest();
    } else if (!validSubscriptionBody(body)) throw new InvalidActionRequest();
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

function idFrom(request: Request, depth: number): string {
  return new URL(request.url).pathname.split("/").at(depth) ?? "";
}

function notFound(): Response {
  return Response.json({ error: "not_found" }, { status: 404, headers: NO_STORE });
}

/** POST /api/channels/[id]/disable, POST /api/channels/[id]/enable and DELETE
 * /api/subscriptions/[id]. A channel is never deleted: the deliveries sent through it
 * stay as the record of what was sent. */
export function guardedNotificationUpdate(kind: "channels" | "channels-enable" | "subscriptions", deps: GuardDeps = {}) {
  const action = kind === "channels" ? "channels:disable" : kind === "channels-enable" ? "channels:enable" : "subscriptions:delete";
  return guarded({ action, capability: "configuration", recordAttempt: true }, async ({ client, request }) => {
    const id = idFrom(request, kind === "subscriptions" ? -1 : -2);
    if (!UUID.test(id)) return notFound();
    const { rows } = await client.query(kind === "channels"
      ? "UPDATE channel SET enabled = false WHERE id = $1 RETURNING id"
      : kind === "channels-enable"
        ? "UPDATE channel SET enabled = true WHERE id = $1 RETURNING id"
        : "DELETE FROM subscription WHERE id = $1 RETURNING id", [id]);
    return rows[0] ? Response.json({ id: rows[0].id }, { headers: NO_STORE }) : notFound();
  }, deps);
}

/** POST /api/channels/[id]/test: queues one test alert to that channel. The send itself
 * happens in the notify job, so this route touches no provider. */
export function guardedChannelTest(deps: GuardDeps = {}) {
  return guarded({ action: "channels:test", capability: "configuration", recordAttempt: true }, async ({ client, request, principalId }) => {
    const id = idFrom(request, -2);
    if (!UUID.test(id)) return notFound();
    try {
      const { delivery } = await sendTestAlert(client, { channelId: id, requestedBy: principalId });
      return Response.json({ delivery }, { status: 202, headers: NO_STORE });
    } catch (error) {
      if (error instanceof Error && error.message === CHANNEL_NOT_FOUND) return notFound();
      if (error instanceof Error && error.message === CHANNEL_OFF) return Response.json({ error: "channel_off" }, { status: 409, headers: NO_STORE });
      throw error;
    }
  }, deps);
}

/** PATCH /api/subscriptions/[id]: change where a rule sends, which alerts and from which
 * severity. The whole rule is sent, so a half-changed rule is never stored. */
export function guardedSubscriptionPatch(deps: GuardDeps = {}) {
  return guarded({ action: "subscriptions:update", capability: "configuration", recordAttempt: true }, async ({ client, request }) => {
    const id = idFrom(request, -1);
    if (!UUID.test(id)) return notFound();
    const body = await readActionParams(request);
    if (!validSubscriptionBody(body)) throw new InvalidActionRequest();
    try {
      const { rows } = await client.query(
        "UPDATE subscription SET channel_id = $2, event_glob = $3, min_severity = $4 WHERE id = $1 RETURNING *",
        [id, body.channelId, body.eventGlob, body.minSeverity],
      );
      return rows[0] ? Response.json({ subscription: rows[0] }, { headers: NO_STORE }) : notFound();
    } catch (error) {
      if ((error as { code?: string }).code === "23503") return Response.json({ error: "invalid_request" }, { status: 400, headers: NO_STORE });
      throw error;
    }
  }, deps);
}

/** GET /api/escalation-rules: the tenant's "when nobody responds" rules. */
export function guardedEscalationList(surface: DataSurface, deps: GuardDeps = {}) {
  return guarded({ action: "escalation-rules:list", capability: surface.capability }, async ({ client, tenantRef }) => {
    // "Hide people's names": each owner by code name, without their email.
    const namer = await peopleNamer(client);
    const rules = ((await listEscalationRules(client, { tenantRef })) as Record<string, unknown>[]).map((rule) => {
      if (!namer || !rule.owner_principal_id || (rule.owner_email == null && rule.owner_name == null)) return rule;
      const shown = shownPerson({ id: String(rule.owner_principal_id), email: (rule.owner_email as string | null) ?? null, name: (rule.owner_name as string | null) ?? null, readable: true }, namer);
      return { ...rule, owner_name: shown.name, owner_email: null };
    });
    return Response.json({ escalationRules: rules, generatedAt: new Date().toISOString() }, { headers: NO_STORE });
  }, deps);
}

export const ACK_WITHIN_MIN_MS = 60_000;
export const ACK_WITHIN_MAX_MS = 7 * 24 * 3_600_000;

/** POST /api/escalation-rules: { minSeverity, ackWithinMs, channelId, ownerPrincipalId? }. */
export function guardedEscalationCreate(surface: DataSurface, deps: GuardDeps = {}) {
  return guarded({ action: "escalation-rules:create", capability: surface.capability, recordAttempt: true }, async ({ client, request, principalId, tenantRef }) => {
    const body = await readActionParams(request);
    const ackWithinMs = Number(body.ackWithinMs);
    if (!SEVERITIES.includes(String(body.minSeverity))
      || !Number.isSafeInteger(ackWithinMs) || ackWithinMs < ACK_WITHIN_MIN_MS || ackWithinMs > ACK_WITHIN_MAX_MS
      || typeof body.channelId !== "string" || !UUID.test(body.channelId)
      || (body.ownerPrincipalId !== undefined && body.ownerPrincipalId !== null && (typeof body.ownerPrincipalId !== "string" || !UUID.test(body.ownerPrincipalId)))
      || (body.control !== undefined && body.control !== null && (typeof body.control !== "string" || !body.control.length))) throw new InvalidActionRequest();
    try {
      const options = {
        tenantRef, control: (body.control as string | null | undefined) ?? null, minSeverity: String(body.minSeverity), ackWithinMs,
        ownerPrincipalId: (body.ownerPrincipalId as string | null | undefined) ?? null, escalateChannelId: body.channelId as string, createdBy: principalId,
      };
      const rule = await createEscalationRule(client, options as unknown as Parameters<typeof createEscalationRule>[1]);
      return Response.json({ escalationRule: rule }, { status: 201, headers: NO_STORE });
    } catch (error) {
      if ((error as { code?: string }).code === "23503") return Response.json({ error: "invalid_request" }, { status: 400, headers: NO_STORE });
      throw error;
    }
  }, deps);
}

/** POST /api/escalation-rules/[id]/disable and /enable. */
export function guardedEscalationToggle(enabled: boolean, deps: GuardDeps = {}) {
  return guarded({ action: enabled ? "escalation-rules:enable" : "escalation-rules:disable", capability: "configuration", recordAttempt: true }, async ({ client, request, principalId, tenantRef }) => {
    const id = idFrom(request, -2);
    if (!UUID.test(id)) return notFound();
    const rule = await setEscalationRuleEnabled(client, { tenantRef, id, enabled, actor: principalId });
    return rule ? Response.json({ escalationRule: rule }, { headers: NO_STORE }) : notFound();
  }, deps);
}
