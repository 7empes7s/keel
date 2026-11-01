import { headers } from "next/headers";
import { forbidden } from "next/navigation";

import {
  activeIntentsFor, ChangeIntentError, classifyDrift, createChangeIntent, driftTransitions, listChangeIntents, revokeChangeIntent,
} from "../../engine/policy/changeIntent.mjs";
import { displayActor } from "../../engine/insights/people.mjs";
import { OPEN_DRIFT_PREDICATE } from "../../engine/store/openDrift.mjs";
import { maskCredentials, sameForDiff } from "../../engine/safety/diffHygiene.mjs";
import { guarded, readActionParams, InvalidActionRequest, type GuardDeps } from "@/lib/action";
import { payloadName } from "@/lib/changes-view";
import { attributeOpenChanges } from "@/lib/portal-data";
import { peopleNamer, principalPerson, shownPerson } from "@/lib/people-names";
import { savedNames } from "@/lib/saved-names";
import { personLabel } from "@/lib/sentences";
import { CAPABILITIES_HEADER, PRINCIPAL_ID_HEADER } from "@/lib/principal";
import { distinctPeople } from "@/lib/people-choices";
import { WINDOW_HOURS, type ChangeIntent, type ChangeIntentsData, type IntentMadeBy, type IntentTransition } from "@/lib/change-intents-view";
import { evidenceMessage, refuseWeakReason, WeakReasonError } from "@/lib/written-reason";

// Roadmap task-93: approved emergency changes. Approving one, revoking one and reading
// the list all require a central (tenant-wide) approve grant: an approval names any
// resource in the tenant, so an entity-scoped approver is refused rather than shown a
// partial list. The engine re-checks the approver's grant on every write.

const NO_STORE = { "cache-control": "no-store" };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** The page's guard: a central approve grant and a principal, before any loader. */
export async function requireChangeIntentAccess(): Promise<void> {
  const source = await headers();
  const capabilities = (source.get(CAPABILITIES_HEADER) ?? "").split(" ");
  if (!source.get(PRINCIPAL_ID_HEADER) || !capabilities.includes("approve")) forbidden();
}

function iso(value: unknown): string | null {
  return value == null ? null : new Date(String(value instanceof Date ? value.toISOString() : value)).toISOString();
}

/**
 * Transitions as the page carries them: credential values (password hints and the
 * like) hidden, and each flagged when only an empty value or list order differs, so
 * the page can leave it out. The stored approval is unchanged.
 */
export function readableTransitions(transitions: IntentTransition[]): IntentTransition[] {
  const side = (value: IntentTransition["before"], field: string) => ({ present: value.present, value: value.present ? maskCredentials(value.value, field) : value.value });
  return transitions.map((transition) => ({
    ...transition,
    before: side(transition.before, transition.field),
    after: side(transition.after, transition.field),
    noChange: sameForDiff(transition.before.present ? transition.before.value : null, transition.after.present ? transition.after.value : null),
  }));
}

type Client = { query(text: string, values?: unknown[]): Promise<{ rows: Record<string, unknown>[] }> };

// "Hide people's names" on what approving or revoking answers with, as on the list.
async function shownIntent(client: Client, stored: ChangeIntent): Promise<ChangeIntent> {
  const namer = await peopleNamer(client);
  const intent = { ...stored, transitions: readableTransitions(stored.transitions) };
  return namer ? { ...intent, owner: shownPerson(intent.owner, namer), approver: shownPerson(intent.approver, namer), revokedBy: intent.revokedBy ? shownPerson(intent.revokedBy, namer) : null } : intent;
}

export async function loadChangeIntents(client: Client, tenantRef: string, now = new Date()): Promise<ChangeIntentsData> {
  // "Hide people's names": owners, approvers and who withdrew an approval by code name.
  const namer = await peopleNamer(client);
  const intents = ((await listChangeIntents(client, { tenantRef, now })) as ChangeIntent[]).map((listed) => ({ ...listed, transitions: readableTransitions(listed.transitions) })).map((intent) => (namer ? {
    ...intent,
    owner: shownPerson(intent.owner, namer),
    approver: shownPerson(intent.approver, namer),
    revokedBy: intent.revokedBy ? shownPerson(intent.revokedBy, namer) : null,
  } : intent));
  // Open changes to existing settings, newest first: what an approver can approve. One
  // row per resource against the active baseline, the newest, as on the Changes page;
  // older drift-detect runs left a row per run for a long-lived change. A change that an
  // approval in force already covers in full is not open any more: it leaves the list
  // and the count, so approving one visibly takes it off.
  const openSql = (select: string, extra = "") => `WITH latest AS (
       SELECT DISTINCT ON (dl.natural_key) dl.id
         FROM drift dl
         JOIN baseline b ON b.id = dl.baseline_id AND b.active = true
        WHERE dl.tenant_ref = $1
        ORDER BY dl.natural_key, dl.detected_at DESC, dl.id DESC
     )
     SELECT ${select} FROM drift d
       JOIN latest ON latest.id = d.id
      WHERE d.change_type = 'modified' AND ${OPEN_DRIFT_PREDICATE}${extra}`;
  const { rows: drifts } = await client.query(`${openSql("d.*")} ORDER BY d.detected_at DESC, d.id DESC LIMIT ${CANDIDATE_LIMIT}`, [tenantRef]);
  const { rows: [counted] } = await client.query(openSql("count(*)::int AS n"), [tenantRef]);
  const liveKeys = [...new Set(intents.filter((intent) => intent.state === "active").map((intent) => intent.naturalKey))];
  const inForce = liveKeys.length ? await activeIntentsFor(client, { tenantRef, naturalKeys: liveKeys, now }) : [];
  const { rows: covered } = inForce.length
    ? await client.query(openSql("d.*", " AND d.natural_key = ANY($2::text[])"), [tenantRef, liveKeys])
    : { rows: [] as Record<string, unknown>[] };
  const approved = new Set(covered.filter((drift) => classifyDrift(drift, inForce, now).state === "approved").map((drift) => String(drift.id)));
  const open = drifts.filter((drift) => !approved.has(String(drift.id)));
  const { rows: people } = await client.query(
    "SELECT id, email, display_name FROM principal WHERE disabled_at IS NULL AND system_kind IS NULL ORDER BY lower(coalesce(display_name, email)), lower(email), id",
  );
  // Names, not ids: the name the change carries, else the newest backup's. A failed
  // lookup leaves names empty (the page says "Unnamed …"), never the page down.
  let saved: Awaited<ReturnType<typeof savedNames>> = {};
  try {
    saved = await savedNames(client, tenantRef, [...intents.map((intent) => intent.naturalKey), ...open.map((drift) => String(drift.natural_key))]);
  } catch (error) {
    console.error("[keel-portal] emergency change names unavailable", error);
  }
  // The people an approver chooses from: by code name too while names are hidden, in
  // that order, so the list matches what Activity and this page call them. Two people
  // with one name are told apart by their sign-in address (never while names are hidden).
  const choices = distinctPeople(people.map((person) => ({
    id: String(person.id),
    email: namer ? null : (person.email as string | null) ?? null,
    name: namer
      ? personLabel(principalPerson({ ...person, system_kind: null }, namer), "A person without a name")
      : personLabel({ kind: "person", id: String(person.id), name: (person.display_name as string | null) ?? null, email: (person.email as string | null) ?? null, readable: true }, "A person without a name"),
  }))).sort((left, right) => (namer ? left.name.localeCompare(right.name) : 0));
  const madeBy = await whoMadeThem(client, tenantRef, open, people, choices, namer);
  return {
    intents: intents.map((intent) => ({ ...intent, name: saved[intent.naturalKey]?.name ?? null })),
    changes: open.map((drift) => ({
      driftId: String(drift.id), naturalKey: String(drift.natural_key), resourceType: String(drift.resource_type),
      name: payloadName(drift.after_payload, String(drift.resource_type)) ?? payloadName(drift.before_payload, String(drift.resource_type)) ?? saved[String(drift.natural_key)]?.name ?? null,
      detectedAt: iso(drift.detected_at), transitions: readableTransitions((driftTransitions(drift) ?? []) as IntentTransition[]),
      madeBy: madeBy.get(String(drift.id)) ?? null,
    })).filter((change) => change.transitions.length > 0),
    openCount: Math.max(0, Number(counted?.n ?? drifts.length) - approved.size),
    people: choices,
    generatedAt: now.toISOString(),
  };
}

/** The open changes the approve form lists, newest first; the count covers the rest. */
export const CANDIDATE_LIMIT = 100;

/**
 * Who made each open change, from Microsoft's audit logs (the same reading as the
 * Changes page), matched to a Keel user by sign-in address. Unknown when the audit log
 * does not say, or names several accounts. A failed read leaves every change unknown,
 * never the page down.
 */
async function whoMadeThem(
  client: Client, tenantRef: string, drifts: Record<string, unknown>[], principals: Record<string, unknown>[],
  choices: { id: string; name: string }[], namer: Awaited<ReturnType<typeof peopleNamer>>,
): Promise<Map<string, IntentMadeBy>> {
  const result = new Map<string, IntentMadeBy>();
  if (!drifts.length) return result;
  const byBaseline = new Map<string, Record<string, unknown>[]>();
  for (const drift of drifts) byBaseline.set(String(drift.baseline_id), [...(byBaseline.get(String(drift.baseline_id)) ?? []), drift]);
  try {
    const attributed = [];
    for (const [baselineId, rows] of byBaseline) {
      attributed.push(...await attributeOpenChanges(client as never, tenantRef, baselineId, rows.map((drift) => ({
        id: String(drift.id), resourceType: String(drift.resource_type), naturalKey: String(drift.natural_key),
        changeType: String(drift.change_type) as never, before: drift.before_payload as never, after: drift.after_payload as never,
      })), { central: true, entities: [] }));
    }
    // Sign-in addresses of the users the audit log names, from the newest backup of users.
    const userIds = [...new Set(attributed.flatMap((entry) => entry.actors.filter((actor) => actor.kind === "user" && actor.id).map((actor) => actor.id!.toLowerCase())))];
    const addresses = new Map<string, string[]>();
    if (userIds.length) {
      const { rows } = await client.query(
        `SELECT lower(rv.payload->>'id') AS id, lower(rv.payload->>'userPrincipalName') AS upn, lower(rv.payload->>'mail') AS mail
           FROM type_coverage_latest tcl
           JOIN resource_version rv ON rv.snapshot_id = tcl.snapshot_id AND rv.resource_type = 'user'
          WHERE tcl.tenant_ref = $1 AND tcl.resource_type = 'user' AND lower(rv.payload->>'id') = ANY($2::text[])`,
        [tenantRef, userIds],
      );
      for (const row of rows) addresses.set(String(row.id), [row.upn, row.mail].filter((value): value is string => typeof value === "string" && value.length > 0));
    }
    const principalByEmail = new Map(principals.map((principal) => [String(principal.email).toLowerCase(), String(principal.id)]));
    const label = new Map(choices.map((choice) => [choice.id, choice.name]));
    for (const entry of attributed) {
      const at = entry.evidence[0]?.occurredAt ?? null;
      if (entry.verdict === "unknown" || entry.actors.length === 0) {
        result.set(entry.changeId, { state: "unknown", principalId: null, who: null, at: null, source: entry.source ?? null });
        continue;
      }
      if (entry.actors.length > 1) {
        result.set(entry.changeId, { state: "several", principalId: null, who: null, at, source: entry.source ?? null });
        continue;
      }
      const actor = entry.actors[0];
      const emails = [...(actor.id ? addresses.get(actor.id.toLowerCase()) ?? [] : []), ...(actor.name?.includes("@") ? [actor.name.toLowerCase()] : [])];
      const principalId = actor.kind === "user" ? emails.map((email) => principalByEmail.get(email)).find(Boolean) ?? null : null;
      const shown = namer ? displayActor(actor, namer) : actor;
      result.set(entry.changeId, {
        state: principalId ? "keel-user" : actor.kind === "servicePrincipal" ? "app" : "not-keel-user",
        principalId,
        who: principalId ? label.get(principalId) ?? null : shown.name ?? null,
        at, source: entry.source ?? null,
      });
    }
  } catch (error) {
    console.error("[keel-portal] emergency change attribution unavailable", error);
  }
  return result;
}

function refusal(error: unknown): Response | null {
  if (!(error instanceof ChangeIntentError)) return null;
  const status = error.code === "not-found" ? 404 : error.code === "approver-not-authorized" ? 403 : 409;
  return Response.json({ error: error.code }, { status, headers: NO_STORE });
}

export function guardedChangeIntentList(deps: GuardDeps = {}) {
  return guarded({ action: "change-intents:list", capability: "approve" }, async ({ client, tenantRef }) => {
    return Response.json(await loadChangeIntents(client as Client, tenantRef), { headers: NO_STORE });
  }, deps);
}

export function guardedChangeIntentCreate(deps: GuardDeps = {}) {
  return guarded({ action: "change-intents:approve", capability: "approve", recordAttempt: true }, async ({ client, tenantRef, principalId, request }) => {
    const body = await readActionParams(request);
    if (typeof body.reason !== "string" || typeof body.ownerPrincipalId !== "string" || !UUID.test(body.ownerPrincipalId)
      || !WINDOW_HOURS.includes(Number(body.windowHours) as (typeof WINDOW_HOURS)[number])
      || (body.externalChangeId != null && typeof body.externalChangeId !== "string")) throw new InvalidActionRequest();
    refuseWeakReason(body.reason);
    const ticketProblem = body.externalChangeId ? evidenceMessage("ticket", body.externalChangeId) : null;
    if (ticketProblem) throw new WeakReasonError("externalChangeId", ticketProblem);
    const fromChange = body.driftId !== undefined;
    if (fromChange && (typeof body.driftId !== "string" || !UUID.test(body.driftId) || !Array.isArray(body.fields))) throw new InvalidActionRequest();
    if (!fromChange && (typeof body.naturalKey !== "string" || typeof body.resourceType !== "string" || !Array.isArray(body.transitions))) throw new InvalidActionRequest();
    const now = new Date();
    try {
      const intent = await createChangeIntent(client, {
        tenantRef, approverPrincipalId: principalId, ownerPrincipalId: body.ownerPrincipalId,
        ...(fromChange
          ? { driftId: body.driftId as string, fields: body.fields as string[] }
          : { naturalKey: body.naturalKey as string, resourceType: body.resourceType as string, transitions: body.transitions as Record<string, unknown>[] }),
        reason: body.reason, externalChangeId: body.externalChangeId ? String(body.externalChangeId).trim() : null,
        windowStart: now, windowEnd: new Date(now.getTime() + Number(body.windowHours) * 3_600_000), now,
      });
      return Response.json({ intent: await shownIntent(client as Client, intent as ChangeIntent) }, { status: 201, headers: NO_STORE });
    } catch (error) {
      const refused = refusal(error);
      if (refused) return refused;
      throw error;
    }
  }, deps);
}

export function guardedChangeIntentRevoke(deps: GuardDeps = {}) {
  return guarded({ action: "change-intents:revoke", capability: "approve", recordAttempt: true }, async ({ client, tenantRef, principalId, request }) => {
    const id = new URL(request.url).pathname.split("/").at(-2) ?? "";
    if (!UUID.test(id)) return Response.json({ error: "not-found" }, { status: 404, headers: NO_STORE });
    const body = await readActionParams(request);
    if (typeof body.reason !== "string") throw new InvalidActionRequest();
    refuseWeakReason(body.reason);
    try {
      const { intent, settlement } = await revokeChangeIntent(client, { tenantRef, intentId: id, revokedBy: principalId, reason: body.reason });
      return Response.json({ intent: await shownIntent(client as Client, intent as ChangeIntent), settlement: settlement ? { currentState: settlement.currentState, driftId: settlement.driftId } : null }, { headers: NO_STORE });
    } catch (error) {
      const refused = refusal(error);
      if (refused) return refused;
      throw error;
    }
  }, deps);
}
