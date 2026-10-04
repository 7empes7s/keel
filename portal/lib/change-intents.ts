import { headers } from "next/headers";
import { forbidden } from "next/navigation";

import {
  ChangeIntentError, createChangeIntent, driftTransitions, listChangeIntents, revokeChangeIntent,
} from "../../engine/policy/changeIntent.mjs";
import { OPEN_DRIFT_PREDICATE } from "../../engine/store/openDrift.mjs";
import { guarded, readActionParams, InvalidActionRequest, type GuardDeps } from "@/lib/action";
import { CAPABILITIES_HEADER, PRINCIPAL_ID_HEADER } from "@/lib/principal";
import { WINDOW_HOURS, type ChangeIntent, type ChangeIntentsData, type IntentTransition } from "@/lib/change-intents-view";

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

type Client = { query(text: string, values?: unknown[]): Promise<{ rows: Record<string, unknown>[] }> };

export async function loadChangeIntents(client: Client, tenantRef: string, now = new Date()): Promise<ChangeIntentsData> {
  const intents = (await listChangeIntents(client, { tenantRef, now })) as ChangeIntent[];
  // Open changes to existing settings, newest first: what an approver can approve.
  const { rows: drifts } = await client.query(
    `SELECT d.* FROM drift d
      WHERE d.tenant_ref = $1 AND d.change_type = 'modified' AND ${OPEN_DRIFT_PREDICATE}
      ORDER BY d.detected_at DESC, d.id DESC LIMIT 50`,
    [tenantRef],
  );
  const { rows: people } = await client.query(
    "SELECT id, email, display_name FROM principal WHERE disabled_at IS NULL ORDER BY lower(coalesce(display_name, email)), id",
  );
  return {
    intents,
    changes: drifts.map((drift) => ({
      driftId: String(drift.id), naturalKey: String(drift.natural_key), resourceType: String(drift.resource_type),
      detectedAt: iso(drift.detected_at), transitions: (driftTransitions(drift) ?? []) as IntentTransition[],
    })).filter((change) => change.transitions.length > 0),
    people: people.map((person) => ({ id: String(person.id), name: String(person.display_name ?? person.email) })),
    generatedAt: now.toISOString(),
  };
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
      return Response.json({ intent }, { status: 201, headers: NO_STORE });
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
    try {
      const { intent, settlement } = await revokeChangeIntent(client, { tenantRef, intentId: id, revokedBy: principalId, reason: body.reason });
      return Response.json({ intent, settlement: settlement ? { currentState: settlement.currentState, driftId: settlement.driftId } : null }, { headers: NO_STORE });
    } catch (error) {
      const refused = refusal(error);
      if (refused) return refused;
      throw error;
    }
  }, deps);
}
