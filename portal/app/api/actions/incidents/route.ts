import {
  IncidentAuthorizationError, IncidentNotFoundError, IncidentValidationError, assessSnapshot, authorizeRecoveryOverride,
  closeIncident, openIncident, pinSnapshot, recordCompromiseInterval, releasePin, revokeRecoveryOverride,
} from "../../../../../engine/govern/incidents.mjs";

import { guarded, readActionParams } from "@/lib/action";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const NO_STORE = { "cache-control": "no-store" } as const;

type Params = Record<string, unknown>;
type Client = Parameters<typeof openIncident>[0];

// Roadmap task-71: every investigator change to incident recovery state. The route
// checks the downstreamed `investigate` capability; each engine write re-checks the
// actor's CURRENT grant in the database and scopes every read to this tenant, so a
// grant revoked after the page loaded, or another tenant's incident, refuses.
const OPERATIONS: Record<string, (client: Client, tenantRef: string, actorId: string, params: Params) => Promise<unknown>> = {
  open: async (client, tenantRef, actorId, { title }) => ({
    incident: await openIncident(client, { tenantRef, title: title as string, actorId }),
  }),
  close: async (client, tenantRef, actorId, { incidentId }) => ({
    incident: await closeIncident(client, { tenantRef, incidentId: incidentId as string, actorId }),
  }),
  interval: async (client, tenantRef, actorId, { incidentId, startsAt, endsAt, reason }) => ({
    interval: await recordCompromiseInterval(client, {
      tenantRef, incidentId: incidentId as string, startsAt: startsAt as string, endsAt: (endsAt ?? null) as string | null, reason: reason as string, actorId,
    }),
  }),
  assess: async (client, tenantRef, actorId, { incidentId, snapshotId, verdict, exclusions, rationale }) => ({
    assessment: await assessSnapshot(client, {
      tenantRef, incidentId: incidentId as string, snapshotId: snapshotId as string, verdict: verdict as string,
      exclusions: (exclusions ?? []) as never, rationale: rationale as string, actorId,
    }),
  }),
  override: async (client, tenantRef, actorId, { incidentId, snapshotId, reason }) => ({
    override: await authorizeRecoveryOverride(client, {
      tenantRef, incidentId: incidentId as string, snapshotId: snapshotId as string, reason: reason as string, actorId,
    }),
  }),
  "revoke-override": async (client, tenantRef, actorId, { overrideId }) => ({
    override: await revokeRecoveryOverride(client, { tenantRef, overrideId: overrideId as string, actorId }),
  }),
  pin: async (client, tenantRef, actorId, { incidentId, snapshotId, reason }) => ({
    pin: await pinSnapshot(client, { tenantRef, incidentId: incidentId as string, snapshotId: snapshotId as string, reason: reason as string, actorId }),
  }),
  release: async (client, tenantRef, actorId, { pinId, reason }) => ({
    pin: await releasePin(client, { tenantRef, pinId: pinId as string, reason: reason as string, actorId }),
  }),
};

export const POST = guarded(
  { action: "incident-recovery", capability: "investigate", recordAttempt: true },
  async ({ client, principalId, tenantRef, request }) => {
    const params = (await readActionParams(request)) as Params;
    const operation = typeof params.op === "string" && Object.hasOwn(OPERATIONS, params.op) ? OPERATIONS[params.op] : null;
    if (!operation) return Response.json({ error: "invalid_request" }, { status: 400, headers: NO_STORE });
    try {
      return Response.json(await operation(client as Client, tenantRef, principalId, params), { headers: NO_STORE });
    } catch (error) {
      if (error instanceof IncidentAuthorizationError) {
        return Response.json({ error: "forbidden" }, { status: 403, headers: NO_STORE });
      }
      if (error instanceof IncidentNotFoundError) {
        return Response.json({ error: "not_found", message: error.message }, { status: 404, headers: NO_STORE });
      }
      if (error instanceof IncidentValidationError) {
        return Response.json({ error: "refused", message: error.message }, { status: 409, headers: NO_STORE });
      }
      throw error;
    }
  },
);
