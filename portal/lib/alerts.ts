import {
  AlertAuthorizationError, AlertStateError, acknowledgeAlert, listAlerts, listAlertTransitions, resolveAlert,
} from "../../engine/notify/alerts.mjs";
import { guarded, InvalidActionRequest, readActionParams, type GuardDeps } from "@/lib/action";
import type { AlertInboxData, AlertItem } from "@/lib/alerts-view";

// Roadmap task-83: what the alerts inbox reads and the two things an operator can do
// to an alert. Viewing needs `read`; acknowledging and resolving need the drift
// response right (`dispose-accept`), checked here by the guard and again by the engine
// against the database. The inbox's words are in lib/alerts-view.ts.

const NO_STORE = { "cache-control": "no-store" };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const ALERT_RESPOND_CAPABILITY = "dispose-accept";

type Row = Record<string, unknown>;

function iso(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const date = value instanceof Date ? value : new Date(String(value));
  return Number.isNaN(date.valueOf()) ? null : date.toISOString();
}

function personName(row: Row | undefined): string | null {
  if (!row) return null;
  return (row.display_name as string | null) || (row.email as string | null) || null;
}

export function guardedAlertInbox(deps: GuardDeps = {}) {
  return guarded({ action: "alerts:list", capability: "read" }, async ({ client, principalId, tenantRef }) => {
    const rows = await listAlerts(client, { tenantRef, actor: principalId, limit: 200 }) as Row[];
    const histories = new Map<string, Row[]>();
    for (const row of rows) {
      histories.set(String(row.id), await listAlertTransitions(client, { tenantRef, actor: principalId, alertId: String(row.id) }) as Row[]);
    }
    const ids = new Set<string>();
    for (const row of rows) {
      for (const id of [row.owner_principal_id, row.acknowledged_by]) if (typeof id === "string" && UUID.test(id)) ids.add(id);
      for (const entry of histories.get(String(row.id)) ?? []) if (typeof entry.actor === "string" && UUID.test(entry.actor)) ids.add(entry.actor);
    }
    const people = new Map<string, Row>();
    if (ids.size) {
      const { rows: found } = await client.query("SELECT id::text AS id, email, display_name FROM principal WHERE id::text = ANY($1)", [[...ids]]);
      for (const person of found) people.set(String(person.id), person);
    }
    const alerts: AlertItem[] = rows.map((row) => {
      const detail = (row.detail ?? {}) as Row;
      const ownerId = typeof row.owner_principal_id === "string" ? row.owner_principal_id : null;
      return {
        id: String(row.id),
        resourceKey: String(row.resource_key),
        control: String(row.control),
        condition: String(row.condition),
        state: row.state as AlertItem["state"],
        conditionActive: Boolean(row.condition_active),
        severity: row.severity as AlertItem["severity"],
        occurrence: Number(row.occurrence),
        firstOpenedAt: iso(row.first_opened_at)!,
        occurrenceStartedAt: iso(row.occurrence_started_at)!,
        lastFiringAt: iso(row.last_firing_at)!,
        ackDeadlineAt: iso(row.ack_deadline_at),
        acknowledgedAt: iso(row.acknowledged_at),
        acknowledgedByName: row.acknowledged_by ? personName(people.get(String(row.acknowledged_by))) ?? "someone no longer listed" : null,
        owner: ownerId ? { id: ownerId, name: personName(people.get(ownerId)) ?? "someone no longer listed" } : null,
        escalated: Number(row.escalated_occurrence) >= Number(row.occurrence),
        escalationError: (row.escalation_error as string | null) ?? null,
        cause: {
          changeType: (detail.changeType as string | undefined) ?? null,
          resourceType: (detail.resourceType as string | undefined) ?? null,
          snapshotId: (detail.snapshotId as string | undefined) ?? null,
        },
        lastEventId: String(row.last_event_id),
        history: (histories.get(String(row.id)) ?? []).map((entry) => ({
          id: String(entry.id),
          occurrence: Number(entry.occurrence),
          fromState: (entry.from_state as AlertItem["state"] | null) ?? null,
          toState: entry.to_state as AlertItem["state"],
          reason: String(entry.reason),
          actor: String(entry.actor),
          actorName: personName(people.get(String(entry.actor))),
          at: iso(entry.occurred_at)!,
          eventId: (entry.event_id as string | null) ?? null,
        })),
      };
    });
    const body: AlertInboxData = { generatedAt: new Date().toISOString(), alerts };
    return Response.json(body, { headers: NO_STORE });
  }, deps);
}

export function guardedAlertAction(deps: GuardDeps = {}) {
  return guarded(
    { action: "alert-respond", capability: ALERT_RESPOND_CAPABILITY, recordAttempt: true },
    async ({ client, principalId, tenantRef, request }) => {
      const body = await readActionParams(request);
      const { alertId, action, note } = body;
      if (typeof alertId !== "string" || !UUID.test(alertId)) throw new InvalidActionRequest("alertId is required");
      if (action !== "acknowledge" && action !== "resolve") throw new InvalidActionRequest("action must be acknowledge or resolve");
      if (note !== undefined && typeof note !== "string") throw new InvalidActionRequest("note must be text");
      try {
        const alert = action === "acknowledge"
          ? await acknowledgeAlert(client, { tenantRef, alertId, actor: principalId, note: note ?? null } as unknown as Parameters<typeof acknowledgeAlert>[1])
          : await resolveAlert(client, { tenantRef, alertId, actor: principalId, reason: note?.trim() || "Resolved by hand from the alerts inbox" });
        return Response.json({ alert: { id: String((alert as Row).id), state: (alert as Row).state } }, { headers: NO_STORE });
      } catch (error) {
        if (error instanceof AlertAuthorizationError) return Response.json({ error: "forbidden" }, { status: 403, headers: NO_STORE });
        if (error instanceof AlertStateError) return Response.json({ error: "conflict" }, { status: 409, headers: NO_STORE });
        throw error;
      }
    },
    deps,
  );
}
