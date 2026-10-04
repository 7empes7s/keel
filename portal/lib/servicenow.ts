// portal/lib/servicenow.ts
//
// Roadmap task-97 (WS8): the portal surface over the ServiceNow approval mirror adapter
// (engine/itsm/adapters/servicenow.mjs). Reading its status needs `read`; storing its
// mapping needs `configuration` (checked here AND inside the engine). The status never
// carries a secret, only the names of stored secrets.
import { saveServiceNowConfig, serviceNowStatus } from "../../engine/itsm/adapters/servicenow.mjs";
import { guarded, readActionParams, InvalidActionRequest, type GuardDeps } from "@/lib/action";
import { DATA_SURFACES } from "@/lib/read";

const NO_STORE = { "cache-control": "no-store" };

export interface ServiceNowProblem { code: string; message: string }

export interface ServiceNowHeldBack {
  eventId: string;
  kind: string;
  externalRef: string;
  attempts: number;
  reason: string | null;
  lastError: string | null;
  createdAt: string;
}

export interface ServiceNowStatus {
  configured: boolean;
  enabled: boolean;
  problems: ServiceNowProblem[];
  mapping: {
    instanceHost: string | null;
    table: string | null;
    fields: Record<string, string>;
    approvedValues: string[];
    rejectedValues: string[];
    tokenRef: string | null;
    callbacks: "signed" | "off";
    callbackSecretRef: string | null;
  } | null;
  mirror: { records: number; waiting: number; pendingUpdates: number; heldBack: number; conflicts: number };
  heldBack: ServiceNowHeldBack[];
  updatedAt: string | null;
  updatedBy: string | null;
  docSource: { url: string; retrievedAt: string };
}

/** GET /api/integrations/servicenow: whether ServiceNow is on, what is missing, delivery health. */
export function guardedServiceNowStatus(deps: GuardDeps = {}) {
  return guarded(
    { action: "integrations:servicenow", capability: DATA_SURFACES.integrationsServiceNowApi.capability },
    async ({ client, tenantRef, principalId }) => {
      const status = (await serviceNowStatus(client, { tenantRef, principalId })) as ServiceNowStatus;
      return Response.json({ servicenow: status, generatedAt: new Date().toISOString() }, { headers: NO_STORE });
    },
    deps,
  );
}

/** PUT /api/integrations/servicenow: store the mapping (configuration). An incomplete
 * mapping is stored and leaves ServiceNow off; a secret value is refused. */
export function guardedServiceNowConfigure(deps: GuardDeps = {}) {
  return guarded(
    { action: "integrations:servicenow:configure", capability: "configuration", recordAttempt: true },
    async ({ client, tenantRef, principalId, request }) => {
      const body = await readActionParams(request);
      if (body.config === null || typeof body.config !== "object" || Array.isArray(body.config)) throw new InvalidActionRequest();
      try {
        const { problems } = await saveServiceNowConfig(client, { tenantRef, config: body.config, requestedBy: principalId });
        return Response.json({ enabled: problems.length === 0, problems }, { headers: NO_STORE });
      } catch (error) {
        if (error instanceof Error && (error as { code?: string }).code === "invalid") {
          return Response.json({ error: error.message }, { status: 400, headers: NO_STORE });
        }
        throw error;
      }
    },
    deps,
  );
}
