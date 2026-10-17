import { headers } from "next/headers";
import { forbidden } from "next/navigation";

import { listApprovalRequests, summarizeApprovalRequests } from "../../engine/govern/approvals.mjs";
import { dryRunsAwaitingContentEffectApproval } from "../../engine/safety/contentEffects.mjs";
import { connect } from "../../engine/store/db.mjs";

import { holdsObjectId, type NamedKeys, namedSubject } from "@/lib/job-names";
import { PRINCIPAL_ID_HEADER, entityScopeFrom, type EntityScope } from "@/lib/principal";
import { databaseUrl, tenantRef } from "@/lib/runtime-config";
import { savedNames } from "@/lib/saved-names";
import { EMPTY_REFERENCES, type RowReferences } from "@/lib/sentences";

export const APPROVAL_INBOX_CAPABILITY = "approve";
export const APPROVAL_INBOX_LIMIT = 100;

const NO_STORE = { "cache-control": "no-store" } as const;

interface HeaderSource {
  get(name: string): string | null;
}

interface KeelClient {
  query(
    text: string,
    values?: unknown[],
  ): Promise<{ rows: Record<string, unknown>[] }>;
  end(): Promise<void>;
}

type UnknownRecord = Record<string, unknown>;

export interface ApprovalRequestRecord {
  id: string;
  action: string;
  params: unknown;
  requestedBy: string;
  justification: string | null;
  status: string;
  decidedBy: string | null;
  decidedAt: string | null;
  reason: string | null;
  createdAt: string | null;
  expiresAt: string | null;
  // Gap B11: who carries the request out once approved. Absent reads as "worker".
  executor?: "worker" | "cli";
  // Roadmap task-130: requester, decider, dry run, baseline and changes resolved to
  // names by the engine (one query per kind). Absent on rows read without it.
  references?: RowReferences;
}

export interface ApprovalInboxData {
  generatedAt: string;
  pending: ApprovalRequestRecord[];
  // Approved restores whose content effects still need their own approval. They wait
  // for a decision too, so they are listed and counted with `pending`, not in history.
  awaitingContentEffects: ApprovalRequestRecord[];
  history: ApprovalRequestRecord[];
}

/** Everything waiting for an approver: requests and content effects alike. */
export function waitingCount(data: Pick<ApprovalInboxData, "pending" | "awaitingContentEffects">): number {
  return data.pending.length + data.awaitingContentEffects.length;
}

function iso(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const date = value instanceof Date ? value : new Date(String(value));
  return Number.isNaN(date.valueOf()) ? null : date.toISOString();
}

// This is a dedicated approval capability boundary: approvers do not implicitly hold
// the portal's general read capability. It reads only downstreamed identity headers and
// must run before any approval loader opens a database connection.
//
// Task 90: an approver may hold `approve` centrally or only for some entities. The
// scope returned here is what the loaders pass to the engine's SQL inbox filter, so an
// entity approver never receives (or counts) another entity's request.
export function approvalInboxScope(requestHeaders: HeaderSource): EntityScope | null {
  if (requestHeaders.get(PRINCIPAL_ID_HEADER) === null) return null;
  const scope = entityScopeFrom(requestHeaders, APPROVAL_INBOX_CAPABILITY);
  return scope.central || scope.entities.length > 0 ? scope : null;
}

export function approvalInboxAccess(requestHeaders: HeaderSource): boolean {
  return approvalInboxScope(requestHeaders) !== null;
}

function approvalInboxForbidden(): Response {
  return Response.json(
    { error: "forbidden" },
    { status: 403, headers: NO_STORE },
  );
}

export type ApprovalInboxHandler = (request: Request, scope: EntityScope) => Promise<Response>;

export function guardedApprovalInbox(
  handler: ApprovalInboxHandler,
): (request: Request) => Promise<Response> {
  return async function guardedApprovalInboxRoute(request: Request): Promise<Response> {
    const scope = approvalInboxScope(request.headers);
    if (!scope) return approvalInboxForbidden();
    return handler(request, scope);
  };
}

// The server page shares the route's approval-only boundary. forbidden() produces the
// detail-free HTTP 403 response before the page's loader can expose tenant data.
export async function requireApprovalInboxAccess(): Promise<EntityScope> {
  const scope = approvalInboxScope(await headers());
  if (!scope) forbidden();
  return scope;
}

const CENTRAL_SCOPE: EntityScope = { central: true, entities: [] };

export function normalizeApprovalRequest(row: UnknownRecord): ApprovalRequestRecord {
  return {
    id: String(row.id),
    action: String(row.action),
    params: row.params ?? {},
    requestedBy: String(row.requested_by),
    justification: (row.justification as string | null) ?? null,
    status: String(row.effective_status ?? row.status),
    decidedBy: (row.decided_by as string | null) ?? null,
    decidedAt: iso(row.decided_at),
    reason: (row.reason as string | null) ?? null,
    createdAt: iso(row.created_at),
    expiresAt: iso(row.expires_at),
    executor: row.executor === "cli" ? "cli" : "worker",
    references: (row.references as RowReferences | undefined) ?? EMPTY_REFERENCES,
  };
}

/**
 * Each change a request rolls back, named by the name its backup holds, so the title
 * reads "Roll back 2 changes, including Finance (group)", never an id. A change whose
 * object has no saved name keeps a null name. Pure, so it is tested directly.
 */
export function withChangeNames(request: ApprovalRequestRecord, names: NamedKeys): ApprovalRequestRecord {
  const refs = request.references;
  if (!refs?.changes.length) return request;
  return {
    ...request,
    references: {
      ...refs,
      changes: refs.changes.map((change) => {
        if (!change?.readable || !change.naturalKey) return change;
        const name = namedSubject(change.naturalKey, names, change.resourceType);
        return name.includes("Unnamed ") || holdsObjectId(name) ? change : { ...change, name };
      }),
    },
  };
}

async function withClient<T>(operation: (client: KeelClient) => Promise<T>): Promise<T> {
  const client = (await connect(databaseUrl())) as KeelClient;
  try {
    return await operation(client);
  } finally {
    await client.end();
  }
}

function artifactIdOf(row: UnknownRecord): string | null {
  const params = row.params as { artifactId?: unknown } | null | undefined;
  return typeof params?.artifactId === "string" ? params.artifactId : null;
}

// An approved restore whose dry run carries content effects nobody has approved yet
// cannot run, so it still waits on an approver. Only tenant-wide approvers can approve
// content effects, so only they are shown these.
async function awaitingContentEffectIds(
  client: KeelClient,
  scope: EntityScope,
  decided: UnknownRecord[],
): Promise<Set<string>> {
  if (!scope.central) return new Set();
  const restores = decided.filter((row) => row.action === "restore" && String(row.effective_status ?? row.status) === "approved");
  const waiting = await dryRunsAwaitingContentEffectApproval(client, {
    tenantRef: tenantRef(),
    artifactIds: restores.map(artifactIdOf).filter((id): id is string => id !== null),
  });
  return new Set(restores.filter((row) => waiting.has(artifactIdOf(row) ?? "")).map((row) => String(row.id)));
}

// This loader is intentionally separate from the guard. API and page callers invoke it
// only after the approval capability is admitted, and it exposes the engine's narrow
// review projection rather than credentials or any other database columns.
export async function getApprovalInboxData(scope: EntityScope = CENTRAL_SCOPE): Promise<ApprovalInboxData> {
  return withClient(async (client) => {
    const pending = await listApprovalRequests(client, {
      statuses: ["pending"],
      limit: APPROVAL_INBOX_LIMIT,
      approverScope: scope,
    });
    const history = await listApprovalRequests(client, {
      statuses: ["approved", "rejected", "expired"],
      limit: APPROVAL_INBOX_LIMIT,
      approverScope: scope,
    });
    const awaiting = await awaitingContentEffectIds(client, scope, history);
    // One query per reference kind for both lists together.
    const summarized: ApprovalRequestRecord[] = ((await summarizeApprovalRequests(client, { tenantRef: tenantRef(), requests: [...pending, ...history] })) as UnknownRecord[])
      .map(normalizeApprovalRequest);
    // One query for the saved names of every change both lists roll back.
    const names = await savedNames(client, tenantRef(), summarized.flatMap((request) => (request.references?.changes ?? []).map((change) => change?.naturalKey)));
    const named = summarized.map((request) => withChangeNames(request, names));
    const decided = named.slice(pending.length);
    return {
      generatedAt: new Date().toISOString(),
      pending: named.slice(0, pending.length),
      awaitingContentEffects: decided.filter((request) => awaiting.has(request.id)),
      history: decided.filter((request) => !awaiting.has(request.id)),
    };
  });
}

// The sidebar badge and the Overview: how many requests and content effects wait on an
// approver. Callers check approvalInboxAccess first; this reads only the count, never
// request detail.
export async function getPendingApprovalCount(scope: EntityScope = CENTRAL_SCOPE): Promise<number> {
  return withClient(async (client) => {
    const pending = await listApprovalRequests(client, {
      statuses: ["pending"],
      limit: APPROVAL_INBOX_LIMIT,
      approverScope: scope,
    });
    // The same window the inbox lists, so the badge and the page agree.
    const decided = scope.central
      ? await listApprovalRequests(client, { statuses: ["approved", "rejected", "expired"], limit: APPROVAL_INBOX_LIMIT, approverScope: scope })
      : [];
    return pending.length + (await awaitingContentEffectIds(client, scope, decided)).size;
  });
}
