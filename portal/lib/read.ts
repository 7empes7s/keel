import { headers } from "next/headers";
import { forbidden } from "next/navigation";

import { CAPABILITIES_HEADER, PRINCIPAL_ID_HEADER, entityScopeFrom, type EntityScope } from "@/lib/principal";

const NO_STORE = { "cache-control": "no-store" } as const;

interface HeaderSource {
  get(name: string): string | null;
}

export const DATA_SURFACES = {
  schedulesApi: { capability: "read", source: "api/schedules/route.ts" },
  schedulesPage: { capability: "read", source: "schedules/page.tsx" },
  evidenceApi: { capability: "read", source: "api/evidence/route.ts" },
  evidenceVerifyApi: { capability: "read", source: "api/evidence/verify/route.ts" },
  evidencePage: { capability: "read", source: "evidence/page.tsx" },
  principalsApi: { capability: "users", source: "api/principals/route.ts" },
  principalsPage: { capability: "users", source: "principals/page.tsx" },
  principalGrantApi: { capability: "roles", source: "api/principals/[id]/grant/route.ts" },
  principalRevokeApi: { capability: "roles", source: "api/principals/[id]/revoke/route.ts" },
  principalDisableApi: { capability: "users", source: "api/principals/[id]/disable/route.ts" },
  channelsApi: { capability: "configuration", source: "api/channels/route.ts" },
  subscriptionsApi: { capability: "configuration", source: "api/subscriptions/route.ts" },
  deliveriesApi: { capability: "read", source: "api/deliveries/route.ts" },
  notificationsPage: { capability: "read", source: "notifications/page.tsx" },
  integrationsApi: { capability: "read", source: "api/integrations/route.ts" },
  integrationsQuarantinedApi: {
    capability: "read",
    source: "api/integrations/[id]/quarantined/route.ts",
  },
  integrationsPage: { capability: "read", source: "integrations/page.tsx" },
  policiesApi: { capability: "policies", source: "api/policies/route.ts" },
  policyApi: { capability: "policies", source: "api/policies/[id]/route.ts" },
  policyEnabledApi: { capability: "policies", source: "api/policies/[id]/enabled/route.ts" },
  policyClearPauseApi: { capability: "policies", source: "api/policies/[id]/clear-pause/route.ts" },
  policyActivationPreviewApi: { capability: "policies", source: "api/policies/[id]/activation-preview/route.ts" },
  policyActivateApi: { capability: "policies", source: "api/policies/[id]/activate/route.ts" },
  policiesPage: { capability: "policies", source: "policies/page.tsx" },
  policyPage: { capability: "policies", source: "policies/[id]/page.tsx" },
  dashboardApi: {
    capability: "read",
    source: "api/dashboard/route.ts",
  },
  coverageApi: {
    capability: "read",
    source: "api/coverage/route.ts",
  },
  // Task 90: entityScoped surfaces filter their rows (and counts) by the reader's
  // entities in the server loader, so an entity-scoped reader is admitted. Every other
  // surface admits central (tenant-wide) holders only.
  driftApi: {
    capability: "read",
    source: "api/drift/route.ts",
    entityScoped: true,
  },
  baselinesApi: {
    capability: "read",
    source: "api/baselines/route.ts",
  },
  jobsApi: {
    capability: "read",
    source: "api/jobs/route.ts",
  },
  jobApi: {
    capability: "read",
    source: "api/jobs/[id]/route.ts",
  },
  restoreSelectionApi: {
    capability: "read",
    source: "api/actions/restore/selection/route.ts",
  },
  restoreDryRunArtifactApi: {
    capability: "read",
    source: "api/actions/restore/dry-run/[id]/route.ts",
  },
  restoreCompletionApi: {
    capability: "read",
    source: "api/actions/restore/completion/[ref]/route.ts",
  },
  remediateSelectionApi: {
    capability: "read",
    source: "api/actions/remediate/selection/route.ts",
  },
  dashboardPage: {
    capability: "read",
    source: "page.tsx",
  },
  coveragePage: {
    capability: "read",
    source: "coverage/page.tsx",
  },
  driftPage: {
    capability: "read",
    source: "drift/page.tsx",
    entityScoped: true,
  },
  baselinesPage: {
    capability: "read",
    source: "baselines/page.tsx",
  },
  benchmarksPage: {
    capability: "read",
    source: "benchmarks/page.tsx",
  },
  jobsPage: {
    capability: "read",
    source: "jobs/page.tsx",
  },
  jobPage: {
    capability: "read",
    source: "jobs/[id]/page.tsx",
  },
  backupsPage: {
    capability: "read",
    source: "backups/page.tsx",
  },
  restorePage: {
    capability: "read",
    source: "restore/page.tsx",
  },
  incidentsPage: {
    capability: "read",
    source: "incidents/page.tsx",
  },
  protectPage: {
    capability: "read",
    source: "protect/page.tsx",
  },
  activityPage: {
    capability: "read",
    source: "activity/page.tsx",
  },
  // Task-73: measured recovery point and recovery time.
  resiliencePage: {
    capability: "read",
    source: "resilience/page.tsx",
  },
  // Task-76: setup shows which grants exist and who started a provisioning run.
  setupApi: { capability: "configuration", source: "api/setup/route.ts" },
  setupPage: { capability: "configuration", source: "setup/page.tsx" },
  // Task-83: the alerts inbox. Acknowledging and resolving are separate guarded actions.
  alertsApi: { capability: "read", source: "api/alerts/route.ts" },
  alertsPage: { capability: "read", source: "alerts/page.tsx" },
  // Task-100: the value report. Entity-scoped readers see only outcomes their entities
  // own; the engine applies the scope before counting, and tenant-wide sections are
  // withheld from them.
  reportsPage: { capability: "read", source: "reports/page.tsx", entityScoped: true },
  valueReportApi: { capability: "read", source: "api/reports/value/route.ts", entityScoped: true },
} as const;

export interface DataSurface {
  readonly capability: string;
  readonly source: string;
  readonly entityScoped?: boolean;
}

export interface ReadAccess {
  principalId: string;
  // Central (tenant-wide) capabilities only; entity-scoped ones never enable a control.
  capabilities: string[];
  // Where the reader holds the surface's capability. Loaders of entityScoped surfaces
  // pass it to the SQL that selects and counts rows; it is never applied client-side.
  scope: EntityScope;
}

// Identity is downstreamed only by proxy.ts after Cloudflare Access verification and
// principal resolution. This guard deliberately reads no database: a refusal must be
// final before a tenant-data loader can expose an error or an existence signal.
export function readAccess(
  requestHeaders: HeaderSource,
  surface: DataSurface,
): ReadAccess | null {
  const principalId = requestHeaders.get(PRINCIPAL_ID_HEADER);
  if (!principalId) return null;
  const capabilities = (requestHeaders.get(CAPABILITIES_HEADER) ?? "")
    .split(" ")
    .filter((capability) => capability.length > 0);
  const scope = entityScopeFrom(requestHeaders, surface.capability);
  if (scope.central) return { principalId, capabilities, scope };
  if (surface.entityScoped === true && scope.entities.length > 0) return { principalId, capabilities, scope };
  return null;
}

function readForbidden(): Response {
  return Response.json(
    { error: "forbidden" },
    { status: 403, headers: NO_STORE },
  );
}

export type ReadHandler = (request: Request, access: ReadAccess) => Promise<Response>;

// The route wrapper owns the authorization boundary. Its handler is not called until
// a resolved principal has a current read grant, so handlers may safely open their
// database connection only after this point.
export function guardedRead(
  surface: DataSurface,
  handler: ReadHandler,
): (request: Request) => Promise<Response> {
  return async function guardedReadRoute(request: Request): Promise<Response> {
    const access = readAccess(request.headers, surface);
    if (!access) return readForbidden();
    return handler(request, access);
  };
}

// Server-rendered pages use the same header check before invoking any data loader.
// forbidden() produces the detail-free HTTP 403 response for an App Router page.
export async function requireReadAccess(surface: DataSurface): Promise<ReadAccess> {
  const access = readAccess(await headers(), surface);
  if (!access) forbidden();
  return access;
}
