import {
  ALERT_SUPPRESS_CAPABILITY, AlertAuthorizationError, AlertStateError, acknowledgeAlert, listAlerts, listAlertTransitionsFor,
  resolveAlert, suppressAlert, unsuppressAlert,
} from "../../engine/notify/alerts.mjs";
import { lookupNames } from "../../engine/insights/names.mjs";
import { guarded, InvalidActionRequest, readActionParams, type GuardDeps } from "@/lib/action";
import { alertWorkload, type AlertInboxData, type AlertItem } from "@/lib/alerts-view";
import type { ObjectFacts } from "@/lib/object-label";
import { savedNames } from "@/lib/saved-names";
import { peopleNamer, principalPerson, type Namer } from "@/lib/people-names";
import { personLabel } from "@/lib/sentences";
import { requireOptionalReason, refuseWeakReason } from "@/lib/written-reason";

// Roadmap task-83: what the alerts inbox reads and what an operator can do to an alert.
// Viewing needs `read`; acknowledging and resolving need the drift response right
// (`dispose-accept`); muting and unmuting need `policies`. Each is checked here by the
// guard and again by the engine against the database. The page's words are in
// lib/alerts-view.ts.

const NO_STORE = { "cache-control": "no-store" };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const ALERT_RESPOND_CAPABILITY = "dispose-accept";
export const ALERT_MUTE_CAPABILITY: string = ALERT_SUPPRESS_CAPABILITY;

type Row = Record<string, unknown>;

function iso(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const date = value instanceof Date ? value : new Date(String(value));
  return Number.isNaN(date.valueOf()) ? null : date.toISOString();
}

// A person by name, never an email: an account without a display name reads from the
// email's local part ("ops@contoso.com" is "Ops"). With "Hide people's names" on, a
// code name.
function personName(row: Row | undefined, namer: Namer): string | null {
  if (!row) return null;
  const label = personLabel(principalPerson(row, namer), "");
  return label || null;
}

function objectFacts(entry: (ObjectFacts & { name: string | null }) | undefined): ObjectFacts | null {
  if (!entry) return null;
  const { status, deletedSince, lastSeenAt, objectId } = entry;
  return { status, deletedSince, lastSeenAt, objectId };
}

function noteOf(entry: Row): string | null {
  const evidence = (entry.evidence ?? {}) as Row;
  const text = typeof evidence.note === "string" ? evidence.note : typeof evidence.reason === "string" ? evidence.reason : null;
  return text?.trim() || null;
}

interface QueryClient {
  query(sql: string, values?: unknown[]): Promise<{ rows: Row[] }>;
}

const WORKLOAD_NAME_SQL = `COALESCE(${["displayName", "DisplayName", "name", "Name", "title", "Title", "webUrl"].map((field) => `NULLIF(o.fields->>'${field}', '')`).join(", ")})`;

/**
 * Names, not ids: the name each alerted resource carries. A backup key reads the name
 * the newest backup holding one saved; a workload key (`<workload>:<key>`, such as a
 * SharePoint site) reads the newest workload read that named it. A failed read leaves
 * the resource unnamed, never the page down. `families` gets the template family each
 * backup key's saved copy carries, when it has one.
 */
export async function alertResourceNames(client: QueryClient, tenantRef: string, keys: string[], families: Map<string, string> = new Map()): Promise<Map<string, string>> {
  const names = new Map<string, string>();
  const unique = [...new Set(keys)];
  const workloadKeys = unique.filter((key) => alertWorkload(key) !== null);
  const backupKeys = unique.filter((key) => alertWorkload(key) === null);
  try {
    const saved = await savedNames(client, tenantRef, backupKeys);
    for (const [key, entry] of Object.entries(saved)) {
      if (entry.name?.trim()) names.set(key, entry.name.trim());
      if (entry.templateFamily) families.set(key, entry.templateFamily);
    }
  } catch (error) {
    console.error("[keel-portal] alert resource names unavailable", error);
  }
  if (workloadKeys.length) {
    const workloads = workloadKeys.map((key) => alertWorkload(key)!);
    const resources = workloadKeys.map((key, index) => key.slice(workloads[index].length + 1));
    try {
      const { rows } = await client.query(
        `SELECT DISTINCT ON (c.workload, o.resource_key) c.workload, o.resource_key, ${WORKLOAD_NAME_SQL} AS name
           FROM workload_observation o
           JOIN workload_collection c ON c.id = o.collection_id
           JOIN unnest($2::text[], $3::text[]) AS wanted(workload, resource_key)
             ON wanted.workload = c.workload AND wanted.resource_key = o.resource_key
          WHERE c.tenant_ref = $1
          ORDER BY c.workload, o.resource_key, (${WORKLOAD_NAME_SQL} IS NULL), c.created_at DESC, c.id DESC`,
        [tenantRef, workloads, resources],
      );
      for (const row of rows) {
        const name = typeof row.name === "string" ? row.name.replace(/^https?:\/\//, "").trim() : "";
        if (name) names.set(`${row.workload}:${row.resource_key}`, name);
      }
    } catch (error) {
      console.error("[keel-portal] alert workload names unavailable", error);
    }
  }
  return names;
}

/**
 * Whether each backup key is still in the newest backup, or since when it is gone, and
 * the name it last had (engine/insights/names.mjs). Service settings keys are left out:
 * they are not in backups. A failed read leaves every alert without these facts, never
 * the page down.
 */
export async function alertObjects(client: QueryClient, tenantRef: string, keys: string[]): Promise<Map<string, ObjectFacts & { name: string | null }>> {
  const facts = new Map<string, ObjectFacts & { name: string | null }>();
  const backupKeys = [...new Set(keys)].filter((key) => alertWorkload(key) === null);
  if (!backupKeys.length) return facts;
  try {
    const names = await lookupNames(client, { tenantRef, ids: backupKeys });
    for (const [key, object] of names) {
      facts.set(key, { status: object.status, deletedSince: object.deletedSince, lastSeenAt: object.lastSeenAt, objectId: object.objectId, name: object.name });
    }
  } catch (error) {
    console.error("[keel-portal] alert object names unavailable", error);
  }
  return facts;
}

export function guardedAlertInbox(deps: GuardDeps = {}) {
  return guarded({ action: "alerts:list", capability: "read" }, async ({ client, principalId, tenantRef }) => {
    const rows = await listAlerts(client, { tenantRef, actor: principalId, limit: 200 }) as Row[];
    // Every alert's history in one read, not one per alert: the page polls.
    const histories = new Map<string, Row[]>();
    const transitions = await listAlertTransitionsFor(client, { tenantRef, actor: principalId, alertIds: rows.map((row) => String(row.id)) }) as Row[];
    for (const entry of transitions) {
      const key = String(entry.alert_id);
      histories.set(key, [...(histories.get(key) ?? []), entry]);
    }
    const ids = new Set<string>();
    for (const row of rows) {
      for (const id of [row.owner_principal_id, row.acknowledged_by]) if (typeof id === "string" && UUID.test(id)) ids.add(id);
      for (const entry of histories.get(String(row.id)) ?? []) if (typeof entry.actor === "string" && UUID.test(entry.actor)) ids.add(entry.actor);
    }
    const people = new Map<string, Row>();
    if (ids.size) {
      const { rows: found } = await client.query("SELECT id::text AS id, email, display_name, system_kind FROM principal WHERE id::text = ANY($1)", [[...ids]]);
      for (const person of found) people.set(String(person.id), person);
    }
    const namer = people.size ? await peopleNamer(client as QueryClient) : null;
    const keys = rows.map((row) => String(row.resource_key));
    const families = new Map<string, string>();
    const resourceNames = await alertResourceNames(client as QueryClient, tenantRef, keys, families);
    const objects = await alertObjects(client as QueryClient, tenantRef, keys);
    const alerts: AlertItem[] = rows.map((row) => {
      const detail = (row.detail ?? {}) as Row;
      // Alerts acknowledged before the acknowledger became the owner (2026-10-31) have no
      // owner stored: the person who acknowledged the current occurrence owns it.
      const ackOwner = row.state === "acknowledged" && typeof row.acknowledged_by === "string" && UUID.test(row.acknowledged_by) ? row.acknowledged_by : null;
      const ownerId = typeof row.owner_principal_id === "string" ? row.owner_principal_id : ackOwner;
      return {
        id: String(row.id),
        resourceKey: String(row.resource_key),
        name: resourceNames.get(String(row.resource_key)) ?? objects.get(String(row.resource_key))?.name ?? null,
        object: objectFacts(objects.get(String(row.resource_key))),
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
        acknowledgedByName: row.acknowledged_by ? personName(people.get(String(row.acknowledged_by)), namer) ?? "someone no longer listed" : null,
        owner: ownerId ? { id: ownerId, name: personName(people.get(ownerId), namer) ?? "someone no longer listed", ...(people.has(ownerId) && principalPerson(people.get(ownerId)!, namer).pseudonym ? { pseudonym: true } : {}) } : null,
        escalated: Number(row.escalated_occurrence) >= Number(row.occurrence),
        escalationError: (row.escalation_error as string | null) ?? null,
        cause: {
          changeType: (detail.changeType as string | undefined) ?? null,
          resourceType: (detail.resourceType as string | undefined) ?? null,
          snapshotId: (detail.snapshotId as string | undefined) ?? null,
        },
        ...(families.has(String(row.resource_key)) ? { templateFamily: families.get(String(row.resource_key))! } : {}),
        lastEventId: String(row.last_event_id),
        history: (histories.get(String(row.id)) ?? []).map((entry) => ({
          id: String(entry.id),
          occurrence: Number(entry.occurrence),
          fromState: (entry.from_state as AlertItem["state"] | null) ?? null,
          toState: entry.to_state as AlertItem["state"],
          reason: String(entry.reason),
          actor: String(entry.actor),
          actorName: personName(people.get(String(entry.actor)), namer),
          at: iso(entry.occurred_at)!,
          eventId: (entry.event_id as string | null) ?? null,
          note: noteOf(entry),
        })),
      };
    });
    const body: AlertInboxData = { generatedAt: new Date().toISOString(), alerts };
    return Response.json(body, { headers: NO_STORE });
  }, deps);
}

// The alert's owner as the inbox shows one, or null. A failed name read gives no name
// rather than failing an acknowledge that is already recorded.
async function ownerOf(client: QueryClient, id: unknown): Promise<AlertItem["owner"]> {
  if (typeof id !== "string" || !UUID.test(id)) return null;
  try {
    const { rows: [row] } = await client.query("SELECT id::text AS id, email, display_name, system_kind FROM principal WHERE id::text = $1", [id]);
    if (!row) return { id, name: "someone no longer listed" };
    const namer = await peopleNamer(client);
    return { id, name: personName(row, namer) ?? "someone no longer listed", ...(principalPerson(row, namer).pseudonym ? { pseudonym: true } : {}) };
  } catch (error) {
    console.error("[keel-portal] alert owner name unavailable", error);
    return null;
  }
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
      requireOptionalReason(note, "note");
      try {
        const alert = action === "acknowledge"
          ? await acknowledgeAlert(client, { tenantRef, alertId, actor: principalId, note: note ?? null } as unknown as Parameters<typeof acknowledgeAlert>[1])
          : await resolveAlert(client, { tenantRef, alertId, actor: principalId, reason: note?.trim() || "Resolved by hand from the alerts inbox" });
        // The acknowledger owns it now: the page shows them as owner before its next read.
        const owner = action === "acknowledge" ? await ownerOf(client as QueryClient, (alert as Row).owner_principal_id) : undefined;
        return Response.json({ alert: { id: String((alert as Row).id), state: (alert as Row).state, ...(owner !== undefined ? { owner } : {}) } }, { headers: NO_STORE });
      } catch (error) {
        if (error instanceof AlertAuthorizationError) return Response.json({ error: "forbidden" }, { status: 403, headers: NO_STORE });
        if (error instanceof AlertStateError) return Response.json({ error: "conflict" }, { status: 409, headers: NO_STORE });
        throw error;
      }
    },
    deps,
  );
}

/** Mute or unmute: the alert stays recorded, only notification stops. Needs `policies`. */
export function guardedAlertMute(deps: GuardDeps = {}) {
  return guarded(
    { action: "alert-mute", capability: ALERT_MUTE_CAPABILITY, recordAttempt: true },
    async ({ client, principalId, tenantRef, request }) => {
      const body = await readActionParams(request);
      const { alertId, action, note } = body;
      if (typeof alertId !== "string" || !UUID.test(alertId)) throw new InvalidActionRequest("alertId is required");
      if (action !== "mute" && action !== "unmute") throw new InvalidActionRequest("action must be mute or unmute");
      if (note !== undefined && typeof note !== "string") throw new InvalidActionRequest("note must be text");
      if (action === "mute" && !note?.trim()) throw new InvalidActionRequest("a reason is required to mute an alert");
      if (action === "mute") refuseWeakReason(note, "note");
      try {
        const alert = action === "mute"
          ? await suppressAlert(client, { tenantRef, alertId, actor: principalId, reason: note!.trim() })
          : await unsuppressAlert(client, { tenantRef, alertId, actor: principalId });
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
