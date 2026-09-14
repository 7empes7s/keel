import { headers } from "next/headers";
import { forbidden } from "next/navigation";

import { listApprovalRequests } from "../../engine/govern/approvals.mjs";
import { connect } from "../../engine/store/db.mjs";

import { CAPABILITIES_HEADER, PRINCIPAL_ID_HEADER } from "@/lib/principal";
import { databaseUrl } from "@/lib/runtime-config";

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
}

export interface ApprovalInboxData {
  generatedAt: string;
  pending: ApprovalRequestRecord[];
  history: ApprovalRequestRecord[];
}

function capabilitiesFrom(requestHeaders: HeaderSource): string[] {
  return (requestHeaders.get(CAPABILITIES_HEADER) ?? "")
    .split(" ")
    .filter((capability) => capability.length > 0);
}

function iso(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const date = value instanceof Date ? value : new Date(String(value));
  return Number.isNaN(date.valueOf()) ? null : date.toISOString();
}

// This is a dedicated approval capability boundary: approvers do not implicitly hold
// the portal's general read capability. It reads only downstreamed identity headers and
// must run before any approval loader opens a database connection.
export function approvalInboxAccess(requestHeaders: HeaderSource): boolean {
  return (
    requestHeaders.get(PRINCIPAL_ID_HEADER) !== null
    && capabilitiesFrom(requestHeaders).includes(APPROVAL_INBOX_CAPABILITY)
  );
}

function approvalInboxForbidden(): Response {
  return Response.json(
    { error: "forbidden" },
    { status: 403, headers: NO_STORE },
  );
}

export type ApprovalInboxHandler = (request: Request) => Promise<Response>;

export function guardedApprovalInbox(
  handler: ApprovalInboxHandler,
): (request: Request) => Promise<Response> {
  return async function guardedApprovalInboxRoute(request: Request): Promise<Response> {
    if (!approvalInboxAccess(request.headers)) return approvalInboxForbidden();
    return handler(request);
  };
}

// The server page shares the route's approval-only boundary. forbidden() produces the
// detail-free HTTP 403 response before the page's loader can expose tenant data.
export async function requireApprovalInboxAccess(): Promise<void> {
  if (!approvalInboxAccess(await headers())) forbidden();
}

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

// This loader is intentionally separate from the guard. API and page callers invoke it
// only after the approval capability is admitted, and it exposes the engine's narrow
// review projection rather than credentials or any other database columns.
export async function getApprovalInboxData(): Promise<ApprovalInboxData> {
  return withClient(async (client) => {
    const pending = await listApprovalRequests(client, {
      statuses: ["pending"],
      limit: APPROVAL_INBOX_LIMIT,
    });
    const history = await listApprovalRequests(client, {
      statuses: ["approved", "rejected", "expired"],
      limit: APPROVAL_INBOX_LIMIT,
    });
    return {
      generatedAt: new Date().toISOString(),
      pending: pending.map(normalizeApprovalRequest),
      history: history.map(normalizeApprovalRequest),
    };
  });
}
