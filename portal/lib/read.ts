import { headers } from "next/headers";
import { forbidden } from "next/navigation";

import { CAPABILITIES_HEADER, PRINCIPAL_ID_HEADER } from "@/lib/principal";

const NO_STORE = { "cache-control": "no-store" } as const;

interface HeaderSource {
  get(name: string): string | null;
}

export const DATA_SURFACES = {
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
  driftApi: {
    capability: "read",
    source: "api/drift/route.ts",
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
  },
  baselinesPage: {
    capability: "read",
    source: "baselines/page.tsx",
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
} as const;

export type DataSurface = (typeof DATA_SURFACES)[keyof typeof DATA_SURFACES];

export interface ReadAccess {
  principalId: string;
  capabilities: string[];
}

function capabilitiesFrom(headers: HeaderSource): string[] {
  return (headers.get(CAPABILITIES_HEADER) ?? "")
    .split(" ")
    .filter((capability) => capability.length > 0);
}

// Identity is downstreamed only by proxy.ts after Cloudflare Access verification and
// principal resolution. This guard deliberately reads no database: a refusal must be
// final before a tenant-data loader can expose an error or an existence signal.
export function readAccess(
  requestHeaders: HeaderSource,
  surface: DataSurface,
): ReadAccess | null {
  const principalId = requestHeaders.get(PRINCIPAL_ID_HEADER);
  const capabilities = capabilitiesFrom(requestHeaders);
  if (!principalId || !capabilities.includes(surface.capability)) return null;
  return { principalId, capabilities };
}

function readForbidden(): Response {
  return Response.json(
    { error: "forbidden" },
    { status: 403, headers: NO_STORE },
  );
}

export type ReadHandler = (request: Request) => Promise<Response>;

// The route wrapper owns the authorization boundary. Its handler is not called until
// a resolved principal has a current read grant, so handlers may safely open their
// database connection only after this point.
export function guardedRead(
  surface: DataSurface,
  handler: ReadHandler,
): (request: Request) => Promise<Response> {
  return async function guardedReadRoute(request: Request): Promise<Response> {
    if (!readAccess(request.headers, surface)) return readForbidden();
    return handler(request);
  };
}

// Server-rendered pages use the same header check before invoking any data loader.
// forbidden() produces the detail-free HTTP 403 response for an App Router page.
export async function requireReadAccess(surface: DataSurface): Promise<ReadAccess> {
  const access = readAccess(await headers(), surface);
  if (!access) forbidden();
  return access;
}
