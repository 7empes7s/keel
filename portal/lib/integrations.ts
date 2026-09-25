// portal/lib/integrations.ts
//
// Roadmap task-81 (WS12): the operator-facing surface over the task-79 SIEM outbox for
// the generic webhook and CEF sinks. Registration/revoke/resume/replay require the
// `configuration` capability (checked here AND inside engine/telemetry/outbox.mjs
// itself, the same defense-in-depth pattern as portal/lib/notifications.ts); reading
// destination status, lag and quarantined events requires only `read`, so a read-only
// viewer can see what is happening without being able to change or replay anything.
import {
  registerDestination,
  revokeDestination,
  resumeDestination,
  requestReplay,
  listDestinations,
  outboxStatus,
} from "../../engine/telemetry/outbox.mjs";
import { guarded, readActionParams, InvalidActionRequest, type GuardDeps } from "@/lib/action";
import { DATA_SURFACES } from "@/lib/read";

const NO_STORE = { "cache-control": "no-store" };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// task-81 owns only the generic transports. Other destination kinds (e.g. the task-80
// Azure Monitor/Sentinel adapter) register and manage their own destinations elsewhere;
// this surface never widens to configure or list them.
const GENERIC_SIEM_KINDS = ["webhook", "cef"];

export interface Destination {
  id: string;
  tenant_ref: string;
  name: string;
  kind: string;
  config: Record<string, unknown>;
  enabled: boolean;
  revoked_at: string | null;
  created_by: string;
  created_at: string;
}

export interface DestinationStatus {
  destinationId: string;
  tenantRef: string;
  kind: string;
  paused: boolean;
  pending: number;
  delivering: number;
  acknowledged: number;
  quarantined: number;
  oldestPendingObservedAt: string | null;
  lagMs: number | null;
  checkpoint: {
    lastAcknowledgedSeq: number;
    lastAcknowledgedEventId: string | null;
    replayFromSeq: number | null;
    replayRequestedBy: string | null;
    replayRequestedAt: string | null;
  } | null;
}

export interface QuarantinedEvent {
  id: string;
  event_id: string;
  quarantined_at: string;
  quarantine_reason: string | null;
  attempts: number;
}

function notFound(): Response {
  return Response.json({ error: "not_found" }, { status: 404, headers: NO_STORE });
}

function destinationIdFromUrl(request: Request, segmentsFromEnd = 2): string {
  const segments = new URL(request.url).pathname.split("/").filter(Boolean);
  return segments.at(-segmentsFromEnd) ?? "";
}

/** GET /api/integrations: the generic webhook/CEF destinations and their live status. */
export function guardedIntegrationList(deps: GuardDeps = {}) {
  return guarded(
    { action: "integrations:list", capability: DATA_SURFACES.integrationsApi.capability },
    async ({ client, tenantRef, principalId }) => {
      const all = (await listDestinations(client, { tenantRef, principalId })) as Destination[];
      const destinations = all.filter((destination) => GENERIC_SIEM_KINDS.includes(destination.kind));
      const statuses = (await Promise.all(
        destinations.map((destination) => outboxStatus(client, {
          tenantRef, destinationId: destination.id, principalId,
        })),
      )) as DestinationStatus[];
      return Response.json(
        { destinations, statuses, generatedAt: new Date().toISOString() },
        { headers: NO_STORE },
      );
    },
    deps,
  );
}

/** POST /api/integrations: register a new webhook or CEF destination (configuration). */
export function guardedIntegrationRegister(deps: GuardDeps = {}) {
  return guarded(
    { action: "integrations:register", capability: "configuration", recordAttempt: true },
    async ({ client, tenantRef, principalId, request }) => {
      const body = await readActionParams(request);
      if (
        typeof body.name !== "string" || body.name.length === 0
        || !GENERIC_SIEM_KINDS.includes(String(body.kind))
        || (body.config !== undefined
          && (body.config === null || typeof body.config !== "object" || Array.isArray(body.config)))
      ) {
        throw new InvalidActionRequest();
      }
      try {
        const destination = await registerDestination(client, {
          tenantRef, name: body.name, kind: body.kind as string,
          config: (body.config as Record<string, unknown>) ?? {}, requestedBy: principalId,
        });
        return Response.json({ destination }, { status: 201, headers: NO_STORE });
      } catch (error) {
        if (error instanceof Error && /credential reference/.test(error.message)) {
          return Response.json({ error: error.message }, { status: 400, headers: NO_STORE });
        }
        throw error;
      }
    },
    deps,
  );
}

/** POST /api/integrations/[id]/revoke or /resume: pause/resume delivery (configuration). */
export function guardedIntegrationLifecycle(kind: "revoke" | "resume", deps: GuardDeps = {}) {
  return guarded(
    { action: `integrations:${kind}`, capability: "configuration", recordAttempt: true },
    async ({ client, tenantRef, principalId, request }) => {
      const id = destinationIdFromUrl(request);
      if (!UUID.test(id)) return notFound();
      try {
        const destination = kind === "revoke"
          ? await revokeDestination(client, { tenantRef, destinationId: id, requestedBy: principalId })
          : await resumeDestination(client, { tenantRef, destinationId: id, requestedBy: principalId });
        return Response.json({ destination }, { headers: NO_STORE });
      } catch (error) {
        if (error instanceof Error && error.message.startsWith("destination not found")) return notFound();
        throw error;
      }
    },
    deps,
  );
}

/** POST /api/integrations/[id]/replay: rewind acknowledged events for redelivery (configuration). */
export function guardedIntegrationReplay(deps: GuardDeps = {}) {
  return guarded(
    { action: "integrations:replay", capability: "configuration", recordAttempt: true },
    async ({ client, tenantRef, principalId, request }) => {
      const id = destinationIdFromUrl(request);
      if (!UUID.test(id)) return notFound();
      const body = await readActionParams(request);
      const fromSeq = Number(body.fromSeq ?? 0);
      if (!Number.isSafeInteger(fromSeq) || fromSeq < 0) throw new InvalidActionRequest();
      try {
        const checkpoint = await requestReplay(client, {
          tenantRef, destinationId: id, fromSeq, requestedBy: principalId,
        });
        if (!checkpoint) return notFound();
        return Response.json({ checkpoint }, { headers: NO_STORE });
      } catch (error) {
        if (error instanceof Error && error.message.startsWith("destination not found")) return notFound();
        throw error;
      }
    },
    deps,
  );
}

/** GET /api/integrations/[id]/quarantined: quarantined events awaiting operator review (read). */
export function guardedIntegrationQuarantined(deps: GuardDeps = {}) {
  return guarded(
    { action: "integrations:quarantined", capability: DATA_SURFACES.integrationsQuarantinedApi.capability },
    async ({ client, tenantRef, request }) => {
      const id = destinationIdFromUrl(request, 2);
      if (!UUID.test(id)) return notFound();
      const params = new URL(request.url).searchParams;
      const requestedLimit = Number(params.get("limit") ?? 50);
      const limit = Number.isSafeInteger(requestedLimit) && requestedLimit > 0 && requestedLimit <= 200
        ? requestedLimit : 50;
      const { rows } = await client.query(
        `SELECT id, event_id, quarantined_at, quarantine_reason, attempts
           FROM siem_outbox_event
          WHERE destination_id = $1 AND tenant_ref = $2 AND status = 'quarantined'
          ORDER BY quarantined_at DESC
          LIMIT $3`,
        [id, tenantRef, limit],
      );
      return Response.json(
        { quarantined: rows as unknown as QuarantinedEvent[], generatedAt: new Date().toISOString() },
        { headers: NO_STORE },
      );
    },
    deps,
  );
}
