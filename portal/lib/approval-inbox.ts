import { headers } from "next/headers";
import { forbidden } from "next/navigation";

import { listApprovalRequests, summarizeApprovalRequests } from "../../engine/govern/approvals.mjs";
import { resolvePrincipals } from "../../engine/govern/references.mjs";
import { getDryRunArtifact } from "../../engine/restore/dryRunArtifact.mjs";
import { dryRunsAwaitingContentEffectApproval } from "../../engine/safety/contentEffects.mjs";
import { connect } from "@/lib/db";

import { itemKindName, itemService } from "@/lib/baselines-view";
import { fieldWords, valueWords } from "@/lib/changes-view";
import { diffPayloads } from "@/lib/drift-diff";
import { recordsNoChange } from "../../engine/store/openDrift.mjs";
import { templateFamilyOf } from "../../engine/insights/taxonomy.mjs";
import { DRIFT_TEMPLATE_FAMILY_SQL } from "../../engine/insights/templateAreas.mjs";
import { holdsObjectId, type NamedKeys, namedResource, namedSubject } from "@/lib/job-names";
import { PRINCIPAL_ID_HEADER, entityScopeFrom, type EntityScope } from "@/lib/principal";
import { databaseUrl, tenantRef } from "@/lib/runtime-config";
import { savedNames } from "@/lib/saved-names";
import { EMPTY_REFERENCES, type EngineRef, type RowReferences } from "@/lib/sentences";

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
  // Two-person rule: how many approvals the request needs (1 for most) and who has
  // signed so far, by name. Absent on rows read without it.
  requiredApprovals?: number;
  signoffs?: EngineRef[];
  // What approving would change, in words, for the requests that wait (never for
  // history). Null when the request has no preview Keel can read.
  preview?: ApprovalPreview | null;
}

/** One setting a request would change: before and after as a person reads them. */
export interface ApprovalChange {
  name: string;
  kind: string;
  // What happens to it, when there are no field values to show.
  line: string | null;
  fields: { field: string; now: string; after: string }[];
  moreFields: number;
}

export interface ApprovalPreview {
  total: number;
  services: { name: string; count: number }[];
  changes: ApprovalChange[];
  more: number;
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
    requiredApprovals: Math.max(1, Number(row.required_approvals ?? 1) || 1),
    signoffs: [],
  };
}

const PREVIEW_CHANGES = 5;
const PREVIEW_FIELDS = 3;
const EDGE_RESULT_PREFIX = "edge:";

function keyType(naturalKey: string): string {
  return naturalKey.split(":")[0] ?? naturalKey;
}

/** One setting a preview lists: its stored type, and the template family its saved copy
 * carries (an Intune antivirus policy is a Defender setting). */
function keyItem(key: string, names: NamedKeys): { resourceType: string; templateFamily: string | null } {
  return { resourceType: names[key]?.resourceType ?? keyType(key), templateFamily: names[key]?.templateFamily ?? null };
}

function servicesOf(items: { resourceType: string; templateFamily?: string | null }[]): ApprovalPreview["services"] {
  const counts = new Map<string, number>();
  for (const item of items) {
    const name = itemService(item).name;
    counts.set(name, (counts.get(name) ?? 0) + 1);
  }
  return [...counts.entries()].map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
}

/** A drift row as a listed setting: its type and the template family either copy carries. */
function driftItem(row: UnknownRecord): { resourceType: string; templateFamily: string | null } {
  const read = typeof row.template_family === "string" && row.template_family ? row.template_family : null;
  return { resourceType: String(row.resource_type), templateFamily: read ?? templateFamilyOf(row.after_payload) ?? templateFamilyOf(row.before_payload) };
}

// A roll back puts each changed setting back as the approved setup holds it: "now" is
// what the tenant has, "after" is the approved value.
async function rollBackPreview(client: KeelClient, driftIds: string[]): Promise<ApprovalPreview | null> {
  if (driftIds.length === 0) return null;
  const { rows } = await client.query(
    `SELECT id::text AS id, natural_key, resource_type, change_type, before_payload, after_payload,
            before_hash, after_hash, same_content, ${DRIFT_TEMPLATE_FAMILY_SQL} AS template_family
       FROM drift d WHERE tenant_ref = $1 AND id::text = ANY($2::text[])`,
    [tenantRef(), driftIds],
  );
  const ordered = driftIds.map((id) => rows.find((row) => row.id === id)).filter((row): row is UnknownRecord => Boolean(row));
  const names = await savedNames(client, tenantRef(), ordered.map((row) => String(row.natural_key)));
  const changes = ordered.slice(0, PREVIEW_CHANGES).map((row) => {
    const key = String(row.natural_key);
    const type = String(row.resource_type);
    const base = { name: namedResource(key, names, type), kind: itemKindName(driftItem(row)) };
    if (row.change_type === "added") return { ...base, line: "Removed: it is not in the approved setup", fields: [], moreFields: 0 };
    if (row.change_type === "removed") return { ...base, line: "Put back as the approved setup holds it", fields: [], moreFields: 0 };
    // Only a stored fingerprint differed: approving would put back what is there.
    if (recordsNoChange(row)) return { ...base, line: "Nothing to roll back: it already holds the approved values", fields: [], moreFields: 0 };
    const diff = diffPayloads(row.before_payload, row.after_payload);
    const fields = diff.slice(0, PREVIEW_FIELDS).map((change) => ({
      field: fieldWords(change.path),
      now: change.kind === "removed" ? "not set" : valueWords((change as { after?: unknown }).after),
      after: change.kind === "added" ? "not set" : valueWords((change as { before?: unknown }).before),
    }));
    return { ...base, line: fields.length ? null : "Put back as the approved setup holds it", fields, moreFields: Math.max(0, diff.length - fields.length) };
  });
  return { total: ordered.length, services: servicesOf(ordered.map(driftItem)), changes, more: Math.max(0, ordered.length - changes.length) };
}

// A restore puts back every setting its dry run found it can apply, as the backup holds it.
async function restorePreview(client: KeelClient, artifactId: string): Promise<ApprovalPreview | null> {
  const artifact = (await getDryRunArtifact(client, { id: artifactId, tenantRef: tenantRef() })) as { results?: { applied?: { naturalKey: string }[] } } | null;
  const applied = (artifact?.results?.applied ?? []).map((entry) => entry.naturalKey).filter((key) => typeof key === "string" && !key.startsWith(EDGE_RESULT_PREFIX));
  if (applied.length === 0) return null;
  const names = await savedNames(client, tenantRef(), applied);
  const changes = applied.slice(0, PREVIEW_CHANGES).map((key) => ({
    name: namedResource(key, names, keyType(key)), kind: itemKindName(keyItem(key, names)), line: "Put back as the backup holds it", fields: [], moreFields: 0,
  }));
  return { total: applied.length, services: servicesOf(applied.map((key) => keyItem(key, names))), changes, more: Math.max(0, applied.length - changes.length) };
}

/** What approving would change, for a request that waits. A preview Keel cannot read
 * never blocks the inbox: the card then links to the full preview only. */
export async function approvalPreview(client: KeelClient, request: ApprovalRequestRecord): Promise<ApprovalPreview | null> {
  const params = (request.params ?? {}) as Record<string, unknown>;
  try {
    if (request.action === "remediate" && Array.isArray(params.driftIds)) {
      return await rollBackPreview(client, params.driftIds.filter((id): id is string => typeof id === "string"));
    }
    if (request.action === "restore" && typeof params.artifactId === "string" && request.references?.plan?.readable) {
      return await restorePreview(client, params.artifactId);
    }
  } catch {
    return null;
  }
  return null;
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
    // Two-person progress: the approvers who signed so far, by name (one query).
    const signoffIds = new Map([...pending, ...history].map((row) => [String(row.id), ((row.signoffs as string[] | null) ?? []).map(String)]));
    const signers = (await resolvePrincipals(client, [...signoffIds.values()].flat())) as Map<string, EngineRef>;
    const signed = named.map((request) => ({ ...request, signoffs: (signoffIds.get(request.id) ?? []).map((id) => signers.get(id) ?? { kind: "person", id, name: null, readable: false }) }));
    const decided = signed.slice(pending.length);
    const awaitingRequests = decided.filter((request) => awaiting.has(request.id));
    // What each waiting request would change, so the decision is made from it.
    const waiting: ApprovalRequestRecord[] = [];
    // Sequential: one client runs one query at a time.
    for (const request of [...signed.slice(0, pending.length), ...awaitingRequests]) waiting.push({ ...request, preview: await approvalPreview(client, request) });
    return {
      generatedAt: new Date().toISOString(),
      pending: waiting.slice(0, pending.length),
      awaitingContentEffects: waiting.slice(pending.length),
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
