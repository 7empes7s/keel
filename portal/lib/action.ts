import {
  ApprovalClosedError,
  ApprovalExpiredError,
  ApprovalNotFoundError,
  ApprovalReasonRequiredError,
  ApprovalRequestRefusedError,
  ApprovalScopeError,
  PromotionRefusedError,
  SelfApprovalError,
  approveRequest,
  rejectRequest,
  requestApproval,
} from "../../engine/govern/approvals.mjs";
import { applyDisposition } from "../../engine/govern/disposition.mjs";
import { SameContentDriftError } from "../../engine/store/openDrift.mjs";
import { RestoreSettingsPathError } from "../../engine/restore/credentialPaths.mjs";
import { acceptServiceChange } from "../../engine/govern/workloadApproved.mjs";
import { resolveAlert } from "../../engine/notify/alerts.mjs";
import { appendEvidence } from "../../engine/govern/evidence.mjs";
import { approveBootstrapPlan, executeBootstrap } from "../../engine/bootstrap/execute.mjs";
import { BootstrapJournal, migrateBootstrapJournal } from "../../engine/bootstrap/journal.mjs";
import { firstCollectReadiness, selectWorkloads, SETUP_SCOPES } from "../../engine/bootstrap/onboarding.mjs";
import { planBootstrap } from "../../engine/bootstrap/plan.mjs";
import { capabilityForJobKind } from "../../engine/authz/jobCapabilities.mjs";
import { enqueue, listJobs, summarizeJobs } from "../../engine/jobs/queue.mjs";
import { connect } from "@/lib/db";
import { updateSchedule, validateSchedule } from "../../engine/schedules/cadence.mjs";
import { acknowledgeForecastWarning } from "../../engine/schedules/forecast.mjs";

import { AUTHENTICATED_EMAIL_HEADER } from "@/lib/cloudflare-access";
import { CAPABILITIES_HEADER, PRINCIPAL_ID_HEADER, entityScopeFrom } from "@/lib/principal";
import { captureApprovalScope } from "../../engine/authz/entityScope.mjs";
import { approvalTtlMs, databaseUrl, tenantRef } from "@/lib/runtime-config";
import { withSavedChangeNames } from "@/lib/saved-names";
import { EMPTY_REFERENCES, type RowReferences } from "@/lib/sentences";
import { canProvision, setupHost, type SetupHost } from "@/lib/setup-host";

// §2.3, plan task 13: the one guarded action API. Every mutating route is built from
// guarded()/guardedAction(). The wrapper resolves the downstreamed principal, checks the
// route's declared capability, enforces the approval requirement, records the attempt,
// and only then lets the route act — using the wrapper's own database handle, so a route
// that forgets the wrapper has no handle and cannot write. Authorisation lives here, in
// the job path, never in the UI. Every denial is a detail-free 403, and every denial is
// recorded in the evidence chain.

export const IDEMPOTENCY_KEY_HEADER = "idempotency-key";
export const ATTEMPT_EVIDENCE_KIND = "action-attempt";

const NO_STORE = { "cache-control": "no-store" } as const;

export class InvalidActionRequest extends Error {}

/** 409 for a change that records no change (engine/store/openDrift.mjs). The message
 * names no setting or id, so it says nothing about what exists. */
export function noChange(error: Error): Response {
  return Response.json(
    { error: "no_change", message: error.message },
    { status: 409, headers: NO_STORE },
  );
}

interface KeelClient {
  query(
    text: string,
    values?: unknown[],
  ): Promise<{ rows: Record<string, unknown>[] }>;
  end(): Promise<void>;
}

export interface GuardSpec {
  // Recorded name of the action, e.g. "collect" or "baseline-activate".
  action: string;
  // Capability the principal must hold. A route that declares none declares no check —
  // the suite's mutation (remove the check from one route) exists to catch exactly that.
  capability?: string;
  // Further capabilities the principal must also hold, checked the same way.
  alsoRequires?: string[];
  // Job kind an approval of this action will mint. Required when requiresApproval is
  // set: the approval request stores it so approve mints the right kind of job.
  jobKind?: string;
  requiresApproval?: boolean;
  // Mutating routes record the attempt before acting; read routes do not.
  recordAttempt?: boolean;
  // Task 90: the capability may be held through an entity-scoped grant. Only set where
  // the handler's engine call re-checks the entity scope itself (approval decisions).
  entityScoped?: boolean;
}

export interface GuardContext {
  client: KeelClient;
  principalId: string;
  capabilities: string[];
  tenantRef: string;
  request: Request;
}

export type GuardHandler = (context: GuardContext) => Promise<Response>;

export interface GuardDeps {
  connect?: (url: string) => Promise<unknown>;
  databaseUrl?: () => string;
  tenantRef?: () => string;
}

function forbidden(): Response {
  return Response.json(
    { error: "forbidden" },
    { status: 403, headers: NO_STORE },
  );
}

function notFound(): Response {
  return Response.json(
    { error: "not_found" },
    { status: 404, headers: NO_STORE },
  );
}

function iso(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const date = value instanceof Date ? value : new Date(String(value));
  return Number.isNaN(date.valueOf()) ? null : date.toISOString();
}

export function normalizeJob(row: Record<string, unknown>) {
  return {
    id: String(row.id),
    kind: String(row.kind),
    status: String(row.status),
    params: row.params ?? {},
    result: row.result ?? null,
    error: row.error ?? null,
    requestedBy: String(row.requested_by),
    idempotencyKey: (row.idempotency_key as string | null) ?? null,
    workerId: (row.worker_id as string | null) ?? null,
    heartbeatAt: iso(row.heartbeat_at),
    createdAt: iso(row.created_at),
    startedAt: iso(row.started_at),
    finishedAt: iso(row.finished_at),
    references: (row.references as RowReferences | undefined) ?? EMPTY_REFERENCES,
    progress: jobProgress(row.progress),
  };
}

/** One type's read in a backup job: its outcome, count, timing and a short error. */
export interface TypeProgress {
  outcome: string;
  itemCount?: number | null;
  startedAt?: string | null;
  completedAt?: string | null;
  httpStatus?: number | null;
  error?: string | null;
  throttles?: number;
  // Content backups: each item not read in full (at most 50) and how many there were.
  reasons?: string[];
  reasonCount?: number;
}

/** A backup job's progress by type: written live by the job, or read from its snapshot. */
export interface JobProgress {
  types: Record<string, TypeProgress>;
  updatedAt: string | null;
  source: "live" | "snapshot";
}

function jobProgress(value: unknown): JobProgress | null {
  const progress = typeof value === "string" ? (() => { try { return JSON.parse(value); } catch { return null; } })() : value;
  if (!progress || typeof progress !== "object" || Array.isArray(progress)) return null;
  const { types, updatedAt, source } = progress as Record<string, unknown>;
  if (!types || typeof types !== "object" || Array.isArray(types)) return null;
  const entries = Object.entries(types as Record<string, unknown>)
    .filter((entry): entry is [string, TypeProgress] => Boolean(entry[1]) && typeof (entry[1] as TypeProgress).outcome === "string" && (entry[1] as TypeProgress).outcome !== "not-requested");
  return {
    types: Object.fromEntries(entries.map(([type, entry]) => [type, {
      outcome: entry.outcome,
      itemCount: Number.isSafeInteger(entry.itemCount) ? entry.itemCount : null,
      startedAt: typeof entry.startedAt === "string" ? entry.startedAt : null,
      completedAt: typeof entry.completedAt === "string" ? entry.completedAt : null,
      httpStatus: Number.isSafeInteger(entry.httpStatus) ? entry.httpStatus : null,
      error: typeof entry.error === "string" ? entry.error : null,
      ...(Number.isSafeInteger(entry.throttles) ? { throttles: entry.throttles } : {}),
      ...listedReasons(entry.reasons, entry.reasonCount),
    }])),
    updatedAt: typeof updatedAt === "string" ? updatedAt : null,
    source: source === "snapshot" ? "snapshot" : "live",
  };
}

/** A content workload's unread items: at most 50 strings, and the total when known. */
function listedReasons(reasons: unknown, count?: unknown): { reasons?: string[]; reasonCount?: number } {
  if (!Array.isArray(reasons)) return {};
  const listed = reasons.filter((reason): reason is string => typeof reason === "string" && reason.length > 0).slice(0, 50).map((reason) => reason.slice(0, 300));
  if (!listed.length) return {};
  const total = Number.isSafeInteger(count) && Number(count) >= listed.length ? Number(count) : Math.max(listed.length, reasons.length);
  return { reasons: listed, reasonCount: total };
}

const SNAPSHOT_LINE = /snapshot ([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}) complete/i;

const CONTENT_OUTCOMES: Record<string, string> = { succeeded: "complete", failed: "failed", partial: "partial", skipped: "unavailable", disabled: "disabled" };

/** The service and content backups record one row per workload as each finishes; a job
 *  shows the rows written while it ran. Pinned to the tenant, and read-only. */
async function workloadProgress(client: KeelClient, tenantRef: string, row: Record<string, unknown>): Promise<unknown> {
  const started = row.started_at ? new Date(String(row.started_at)) : null;
  if (!started || Number.isNaN(started.valueOf())) return null;
  const until = row.finished_at ? new Date(new Date(String(row.finished_at)).valueOf() + 60_000) : new Date();
  const tenant = typeof (row.params as Record<string, unknown> | null)?.tenantRef === "string" ? String((row.params as Record<string, unknown>).tenantRef) : tenantRef;
  try {
    if (row.kind === "workload-collect") {
      const { rows } = await client.query(
        `SELECT c.workload, c.outcome, c.observed_from, c.observed_to, c.digest,
                (SELECT count(*)::int FROM workload_observation o WHERE o.collection_id = c.id) AS settings
           FROM workload_collection c
          WHERE c.tenant_ref = $1 AND c.created_at >= $2 AND c.created_at <= $3
          ORDER BY c.created_at`,
        [tenant, started.toISOString(), until.toISOString()],
      );
      if (!rows.length) return null;
      return {
        source: "live", updatedAt: until.toISOString(),
        types: Object.fromEntries(rows.map((entry) => {
          const reasons = Array.isArray((entry.digest as Record<string, unknown> | null)?.reasons) ? ((entry.digest as Record<string, unknown>).reasons as unknown[]) : [];
          return [`workload:${entry.workload}`, {
            outcome: entry.outcome === "disabled" ? "disabled" : String(entry.outcome),
            itemCount: Number(entry.settings ?? 0),
            startedAt: entry.observed_from ? new Date(String(entry.observed_from)).toISOString() : null,
            completedAt: entry.observed_to ? new Date(String(entry.observed_to)).toISOString() : null,
            error: reasons.length ? reasons.map((reason) => typeof reason === "string" ? reason : JSON.stringify(reason)).join("\n").slice(0, 500) : null,
          }];
        })),
      };
    }
    if (row.kind === "content-collect") {
      const { rows } = await client.query(
        `SELECT workload, outcome, items, reasons, started_at, completed_at FROM content_run
          WHERE tenant_ref = $1 AND started_at >= $2 AND started_at <= $3 ORDER BY started_at`,
        [tenant, started.toISOString(), until.toISOString()],
      );
      if (!rows.length) return null;
      return {
        source: "live", updatedAt: until.toISOString(),
        types: Object.fromEntries(rows.map((entry) => [`content:${entry.workload}`, {
          outcome: CONTENT_OUTCOMES[String(entry.outcome)] ?? "failed",
          itemCount: Number(entry.items ?? 0),
          startedAt: entry.started_at ? new Date(String(entry.started_at)).toISOString() : null,
          completedAt: entry.completed_at ? new Date(String(entry.completed_at)).toISOString() : null,
          error: Array.isArray(entry.reasons) && entry.reasons.length ? entry.reasons.map(String).join("\n").slice(0, 500) : null,
          ...listedReasons(Array.isArray(entry.reasons) ? entry.reasons.map((reason: unknown) => (typeof reason === "string" ? reason : JSON.stringify(reason))) : null),
        }])),
      };
    }
  } catch {
    return null;
  }
  return null;
}

/** A job's progress by type or workload: live from the job, or from what it wrote. */
async function snapshotProgress(client: KeelClient, tenantRef: string, row: Record<string, unknown>): Promise<unknown> {
  if (!row.progress && ["workload-collect", "content-collect"].includes(String(row.kind))) return workloadProgress(client, tenantRef, row);
  if (row.progress || !["backup", "collect"].includes(String(row.kind))) return row.progress ?? null;
  const result = (row.result ?? {}) as Record<string, unknown>;
  const snapshotId = typeof result.snapshotId === "string" ? result.snapshotId : SNAPSHOT_LINE.exec(`${result.stdout ?? ""}\n${row.error ?? ""}`)?.[1];
  if (!snapshotId || !UUID_PATTERN.test(snapshotId)) return null;
  try {
    const { rows } = await client.query(`SELECT coverage_digest, completed_at FROM snapshot WHERE id = $1 AND tenant_ref = $2`, [snapshotId, tenantRef]);
    const digest = rows[0]?.coverage_digest;
    if (!digest || typeof digest !== "object") return null;
    return { types: digest, updatedAt: rows[0].completed_at ? new Date(String(rows[0].completed_at)).toISOString() : null, source: "snapshot" };
  } catch {
    return null;
  }
}

export function normalizeApprovalRequest(row: Record<string, unknown>) {
  return {
    id: String(row.id),
    action: String(row.action),
    params: row.params ?? {},
    requestedBy: String(row.requested_by),
    justification: (row.justification as string | null) ?? null,
    status: String(row.status),
    decidedBy: (row.decided_by as string | null) ?? null,
    decidedAt: iso(row.decided_at),
    reason: (row.reason as string | null) ?? null,
    createdAt: iso(row.created_at),
    expiresAt: iso(row.expires_at),
    // Gap B11: "worker" (approval queues the job) or "cli" (an operator runs it).
    executor: row.executor === "cli" ? "cli" : "worker",
  };
}

export async function readActionParams(
  request: Request,
): Promise<Record<string, unknown>> {
  const text = await request.text();
  if (text.trim() === "") return {};

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new InvalidActionRequest("request body must be valid JSON");
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new InvalidActionRequest("request body must be a JSON object");
  }
  return parsed as Record<string, unknown>;
}

export function guarded(
  spec: GuardSpec,
  handler: GuardHandler,
  deps: GuardDeps = {},
): (request: Request) => Promise<Response> {
  const connectDb = deps.connect ?? (connect as (url: string) => Promise<unknown>);
  const resolveDatabaseUrl = deps.databaseUrl ?? databaseUrl;
  const resolveTenantRef = deps.tenantRef ?? tenantRef;

  return async function guardedRoute(request: Request): Promise<Response> {
    // Identity is read from the headers downstreamed by proxy.ts — the one module that
    // resolves identity. The middleware overwrites any caller-supplied value, so these
    // headers are the verified principal, never client input.
    const principalId = request.headers.get(PRINCIPAL_ID_HEADER);
    const email = request.headers.get(AUTHENTICATED_EMAIL_HEADER);
    const capabilities = (request.headers.get(CAPABILITIES_HEADER) ?? "")
      .split(" ")
      .filter((capability) => capability.length > 0);
    const actor = principalId ?? email ?? "unauthenticated";

    const client = (await connectDb(resolveDatabaseUrl())) as KeelClient;
    try {
      const deny = async (reason: string): Promise<Response> => {
        try {
          await appendEvidence(client, {
            tenantRef: resolveTenantRef(),
            kind: ATTEMPT_EVIDENCE_KIND,
            subject: { action: spec.action, decision: "denied", reason },
            actor,
          });
        } catch (error) {
          console.error(
            "[keel-portal] failed to record a denied action attempt",
            error,
          );
        }
        return forbidden();
      };

      // Authentication is not authorisation: no downstreamed principal, no action.
      // Every `return await` here matters: bare `return deny(...)` would let the
      // finally block end the client while the denial is still being recorded.
      if (!principalId) return await deny("no-principal");
      if (spec.capability !== undefined && !capabilities.includes(spec.capability)) {
        const scope = spec.entityScoped ? entityScopeFrom(request.headers, spec.capability) : null;
        if (!scope || scope.entities.length === 0) return await deny("capability");
      }
      if (spec.alsoRequires?.some((capability) => !capabilities.includes(capability))) {
        return await deny("capability");
      }
      // §3.3, plan task 14: a requiresApproval action can never be enqueued directly —
      // requesting it creates an approval_request, and only a separate approve decision
      // by a different principal mints the job. The request is recorded in the evidence
      // chain by requestApproval itself.
      if (spec.requiresApproval) {
        const { justification, ...params } = await readActionParams(request);
        const approvalRequest = (await requestApproval(client, {
          tenantRef: resolveTenantRef(),
          action: spec.jobKind ?? spec.action,
          params,
          requestedBy: principalId,
          justification:
            typeof justification === "string" ? justification : null,
          ttlMs: approvalTtlMs(),
          entityScope: await approvalScopeFor(client, resolveTenantRef(), params),
        })) as Record<string, unknown>;
        return Response.json(
          { approvalRequest: normalizeApprovalRequest(approvalRequest) },
          { status: 202, headers: NO_STORE },
        );
      }

      if (spec.recordAttempt) {
        await appendEvidence(client, {
          tenantRef: resolveTenantRef(),
          kind: ATTEMPT_EVIDENCE_KIND,
          subject: { action: spec.action, decision: "attempted" },
          actor,
        });
      }

      return await handler({
        client,
        principalId,
        capabilities,
        tenantRef: resolveTenantRef(),
        request,
      });
    } catch (error) {
      if (error instanceof InvalidActionRequest) {
        return Response.json(
          { error: "invalid_request" },
          { status: 400, headers: NO_STORE },
        );
      }
      // Gap B11: the requester no longer resolves to an enabled principal, so no
      // request is created that could never be carried out.
      if (error instanceof ApprovalRequestRefusedError) return forbidden();
      // A change whose setting holds the same values as the approved setup: nothing
      // to accept, roll back, preview or approve. Said plainly, never a 503.
      if (error instanceof SameContentDriftError) return noChange(error);
      // The server's restore settings path is one the worker would refuse: nothing is
      // queued, and the operator is told in plain words which setting to fix.
      if (error instanceof RestoreSettingsPathError) {
        return Response.json(
          { error: "restore_settings_path", message: error.message },
          { status: 503, headers: NO_STORE },
        );
      }
      console.error(`[keel-portal] guarded action ${spec.action} failed`, error);
      return Response.json(
        { error: "unavailable" },
        { status: 503, headers: NO_STORE },
      );
    } finally {
      await client.end();
    }
  };
}

// Roadmap task-76: a collection is how KEEL first reads the tenant, so the portal starts
// one only once the read grants are confirmed (see engine/bootstrap/onboarding.mjs).
const COLLECTION_JOB_KINDS = new Set(["collect", "backup"]);

export interface ActionSpec {
  action: string;
  jobKind: string;
  requiresApproval: boolean;
  // false: the route takes no parameters and always enqueues `{}`, so the job runs on the
  // server-side defaults. A body that sets any field is refused (issue #411).
  acceptsParams?: boolean;
  // The only body fields the route passes on as job params. Any other field is refused,
  // so a caller cannot steer the job at a server file through `config` (issue #411).
  allowedParams?: readonly string[];
}

// The standard mutating route: parse the JSON body as job params and enqueue exactly one
// job of the declared kind. A replayed request carrying the same idempotency key returns
// the existing job instead of starting a second one (§3.1). The capability checked here
// is NOT declared per route: it comes from engine/authz/jobCapabilities.mjs, the single
// source of truth the worker re-checks at execution (plan task 25). A route whose
// jobKind has no mapping is denied by default, never silently unchecked.
export function guardedAction(
  spec: ActionSpec,
  deps: GuardDeps = {},
): (request: Request) => Promise<Response> {
  const capability =
    capabilityForJobKind(spec.jobKind) ?? `unmapped-job-kind:${spec.jobKind}`;
  return guarded(
    {
      action: spec.action,
      capability,
      jobKind: spec.jobKind,
      requiresApproval: spec.requiresApproval,
      recordAttempt: true,
    },
    async ({ client, principalId, tenantRef: tenant, request }) => {
      if (COLLECTION_JOB_KINDS.has(spec.jobKind)) {
        const readiness = await firstCollectReadiness(client, { tenantRef: tenant });
        if (!readiness.allowed) {
          return Response.json(
            { error: "setup_incomplete", missing: readiness.missing },
            { status: 409, headers: NO_STORE },
          );
        }
      }
      const params = await readActionParams(request);
      if (spec.acceptsParams === false && Object.keys(params).length > 0) {
        throw new InvalidActionRequest("this action takes no parameters");
      }
      const allowed = spec.allowedParams;
      if (allowed) {
        const extra = Object.keys(params).filter((key) => !allowed.includes(key));
        if (extra.length > 0) {
          throw new InvalidActionRequest(`this action takes only: ${allowed.join(", ")}`);
        }
      }
      const job = (await enqueue(client, {
        kind: spec.jobKind,
        params: spec.acceptsParams === false ? {} : params,
        requestedBy: principalId,
        idempotencyKey: request.headers.get(IDEMPOTENCY_KEY_HEADER) ?? undefined,
        notBefore: undefined,
      })) as Record<string, unknown>;
      return Response.json(
        { job: normalizeJob(job) },
        { status: 202, headers: NO_STORE },
      );
    },
    deps,
  );
}

// Drift dispositions (accept/ignore) are synchronous single-row governance writes, not
// jobs — the job-kind list is deliberately closed and has no dispose kind. The wrapper
// still owns the database handle and the capability check.
export function guardedDispose(
  deps: GuardDeps = {},
): (request: Request) => Promise<Response> {
  return guarded(
    { action: "dispose", capability: "dispose-accept", recordAttempt: true },
    async ({ client, principalId, tenantRef: tenant, request }) => {
      const body = await readActionParams(request);
      const { driftId, serviceChangeId, action, reason, expiresAt } = body;

      // A service setting change (Exchange, SharePoint, Teams, ...) is accepted into
      // that service's approved setup; it has no ignore. Its alert is settled with it.
      if (serviceChangeId !== undefined) {
        if (typeof serviceChangeId !== "string" || serviceChangeId.length === 0 || driftId !== undefined) {
          throw new InvalidActionRequest("serviceChangeId is a change id, and is sent without driftId");
        }
        if (action !== "accept") throw new InvalidActionRequest("a service setting change can only be accepted");
        if (typeof reason !== "string" || reason.trim().length === 0) throw new InvalidActionRequest("reason is required");
        let accepted: { alertId: string | null };
        try {
          accepted = await acceptServiceChange(client, { tenantRef: tenant, changeId: serviceChangeId, actor: principalId, reason });
        } catch {
          return Response.json({ error: "invalid_request" }, { status: 400, headers: NO_STORE });
        }
        if (accepted.alertId) {
          try {
            await resolveAlert(client, { tenantRef: tenant, alertId: accepted.alertId, actor: principalId, reason: `Accepted into the approved setup: ${reason.trim()}` });
          } catch {
            // The next read matches the approved setup and resolves it.
          }
        }
        return Response.json({ accepted }, { headers: NO_STORE });
      }

      if (typeof driftId !== "string" || driftId.length === 0) {
        throw new InvalidActionRequest("driftId is required");
      }
      if (action !== "accept" && action !== "ignore") {
        throw new InvalidActionRequest("action must be accept or ignore");
      }
      if (typeof reason !== "string" || reason.length === 0) {
        throw new InvalidActionRequest("reason is required");
      }

      let disposition: unknown;
      try {
        disposition = await applyDisposition(client, {
          driftId,
          action,
          actor: principalId,
          reason,
          expiresAt: typeof expiresAt === "string" ? expiresAt : undefined,
        });
      } catch (error) {
        if (error instanceof SameContentDriftError) return noChange(error);
        // No detail about what exists.
        return Response.json(
          { error: "invalid_request" },
          { status: 400, headers: NO_STORE },
        );
      }
      return Response.json({ disposition }, { headers: NO_STORE });
    },
    deps,
  );
}

export const JOB_STATUSES = ["queued", "running", "succeeded", "failed", "cancelled"] as const;

export function guardedJobList(
  deps: GuardDeps = {},
): (request: Request) => Promise<Response> {
  return guarded(
    { action: "jobs:list", capability: "read" },
    async ({ client, tenantRef, request }) => {
      const params = new URL(request.url).searchParams;
      const requestedLimit = Number(params.get("limit") ?? 100);
      const limit = Number.isSafeInteger(requestedLimit) && requestedLimit > 0
        ? requestedLimit : 100;
      // Activity filters: `kind` and `status` are comma-separated lists, narrowed in the
      // query so a filtered page is never short because busier jobs crowded the window.
      const list = (key: string, allowed?: readonly string[]) => {
        const values = (params.get(key) ?? "").split(",").map((value) => value.trim()).filter(Boolean);
        if (!values.length) return null;
        if (values.some((value) => !/^[a-z][a-z0-9-]*$/.test(value) || (allowed && !allowed.includes(value)))) throw new InvalidActionRequest();
        return values;
      };
      const kinds = list("kind");
      const statuses = list("status", JOB_STATUSES);
      const rows = (await listJobs(client, { limit, kinds, statuses })) as Record<
        string,
        unknown
      >[];
      // Task-130: requester, plan, baseline and changes resolved to names.
      const summarized = (await summarizeJobs(client, { tenantRef, jobs: rows })) as Record<string, unknown>[];
      // Roll backs name their changes by the saved name, never an id.
      const jobs = await withSavedChangeNames(client, tenantRef, summarized.map(normalizeJob));
      return Response.json(
        { generatedAt: new Date().toISOString(), jobs },
        { headers: NO_STORE },
      );
    },
    deps,
  );
}

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Schedule edits are local configuration writes, using the scheduler's own validation
// and update boundary. Tenant ownership is checked before handing it a schedule id.
export function guardedScheduleUpdate(deps: GuardDeps = {}) {
  return guarded(
    { action: "schedules:update", capability: "configuration", recordAttempt: true },
    async ({ client, principalId, tenantRef, request }) => {
      const { id, ...changes } = await readActionParams(request);
      if (typeof id !== "string" || !UUID_PATTERN.test(id)) return notFound();
      const { rows: [row] } = await client.query(
        "SELECT * FROM schedule WHERE id = $1 AND tenant_ref = $2", [id, tenantRef],
      );
      if (!row) return notFound();
      // Roadmap task-110: acknowledging a measured load warning is its own request. It
      // never changes the cadence, and the engine re-checks the configuration grant.
      if ("acknowledgeForecast" in changes) {
        if (Object.keys(changes).length !== 1) throw new InvalidActionRequest();
        try {
          const acknowledgement = await acknowledgeForecastWarning(client, { id: principalId }, {
            tenantRef, scheduleId: id, codes: changes.acknowledgeForecast,
          });
          return Response.json({ acknowledgement }, { headers: NO_STORE });
        } catch (error) {
          const message = error instanceof Error ? error.message : "";
          if (message === "not authorized to edit schedules") return forbidden();
          if (message === "schedule not found") return notFound();
          if (message === "forecast_warning_not_current" || message === "invalid forecast warning codes") {
            return Response.json({ error: message }, { status: 400, headers: NO_STORE });
          }
          throw error;
        }
      }
      const cadence = changes.cadence as Record<string, unknown> | null | undefined;
      if (!Object.keys(changes).length
        || Object.keys(changes).some((key) => !["cadence", "cron_override", "enabled"].includes(key))
        || ("enabled" in changes && typeof changes.enabled !== "boolean")
        || ("cron_override" in changes && changes.cron_override !== null && typeof changes.cron_override !== "string")
        || ("cadence" in changes && (!cadence || typeof cadence !== "object" || Array.isArray(cadence)
          || Object.keys(cadence).some((key) => !["every", "n", "atTime"].includes(key))
          || !["hour", "day", "week"].includes(String(cadence.every))
          || (cadence.atTime != null && typeof cadence.atTime !== "string")))) {
        throw new InvalidActionRequest();
      }
      try {
        const candidate = { ...row, ...changes };
        // Keep the builder's saved cadence valid even while raw cron takes precedence.
        validateSchedule({ ...candidate, cron_override: null });
        validateSchedule(candidate);
      } catch (error) {
        return Response.json({ error: error instanceof Error ? error.message : "invalid_schedule" },
          { status: 400, headers: NO_STORE });
      }
      try {
        const schedule = await updateSchedule(client, { id: principalId }, id, changes);
        return Response.json({ schedule }, { headers: NO_STORE });
      } catch (error) {
        if (error instanceof Error && error.message === "not authorized to edit schedules") return forbidden();
        throw error;
      }
    },
    deps,
  );
}

export function guardedJobShow(
  deps: GuardDeps = {},
): (request: Request) => Promise<Response> {
  return guarded(
    { action: "jobs:show", capability: "read" },
    async ({ client, tenantRef, request }) => {
      const id =
        new URL(request.url).pathname.split("/").filter(Boolean).pop() ?? "";
      if (!UUID_PATTERN.test(id)) return notFound();

      const { rows } = await client.query(`SELECT * FROM job WHERE id = $1`, [
        id,
      ]);
      if (!rows[0]) return notFound();
      const [summarized] = (await summarizeJobs(client, { tenantRef, jobs: rows })) as Record<string, unknown>[];
      const progress = await snapshotProgress(client, tenantRef, summarized);
      return Response.json({ job: normalizeJob({ ...summarized, progress }) }, { headers: NO_STORE });
    },
    deps,
  );
}

// Plan task 14 steps 3-4: the approval decision endpoints. Both are guarded at the
// `approver` capability (server-side, never only in the UI); the engine additionally
// refuses self-approval and decisions against closed or expired requests. Every
// refusal is detail-free: 404 for anything that does not exist or is not a pending
// request the caller may see, 403 for a capability or self-approval refusal, 409 for
// a request that is already decided or expired.
// Task 90: the resources a requested action concerns, captured server-side with their
// current ownership so a later change of owner or grant is caught at decision time.
// Only drift-scoped requests (driftIds) name resources today; every other request
// carries no captured scope and stays decidable by central approvers only.
async function approvalScopeFor(client: KeelClient, tenant: string, params: Record<string, unknown>): Promise<unknown> {
  const driftIds = Array.isArray(params.driftIds)
    ? params.driftIds.filter((id): id is string => typeof id === "string" && UUID_PATTERN.test(id))
    : [];
  if (driftIds.length === 0) return null;
  const { rows } = await client.query(
    `SELECT resource_type, natural_key, detected_at FROM drift
      WHERE tenant_ref = $1 AND id = ANY($2::uuid[]) ORDER BY id`,
    [tenant, driftIds],
  );
  const scope = (await captureApprovalScope(client, {
    tenantRef: tenant,
    resources: rows.map((row) => ({ resourceType: row.resource_type, naturalKey: row.natural_key, asOf: row.detected_at })),
  })) as { centralOnly: boolean };
  // A drift id that is not this tenant's (or not a drift at all) makes the request central-only.
  return rows.length === new Set(driftIds).size ? scope : { ...scope, centralOnly: true };
}

export function guardedApprovalDecision(
  decision: "approve" | "reject",
  deps: GuardDeps = {},
): (request: Request) => Promise<Response> {
  return guarded(
    { action: `approvals:${decision}`, capability: "approve", recordAttempt: true, entityScoped: true },
    async ({ client, principalId, tenantRef: tenant, request }) => {
      const segments = new URL(request.url).pathname.split("/").filter(Boolean);
      const id = segments.at(-2) ?? "";
      if (!UUID_PATTERN.test(id)) return notFound();

      try {
        if (decision === "approve") {
          const { job, signoffs, approvers, requiredApprovals } = (await approveRequest(client, {
            tenantRef: tenant,
            id,
            decidedBy: principalId,
            enforceScope: true,
            approverScope: entityScopeFrom(request.headers, "approve"),
          })) as { job: Record<string, unknown> | null; signoffs?: number; approvers?: string[]; requiredApprovals?: number };
          // Gap B11: a CLI-executed request is approved without queuing a job. Under the
          // two-person rule a first approval is recorded and the request stays pending:
          // the answer says how far along it is, so the inbox can say so too.
          return Response.json(
            { job: job ? normalizeJob(job) : null, signoffs: signoffs ?? approvers?.length ?? 1, requiredApprovals: requiredApprovals ?? 1 },
            { status: 202, headers: NO_STORE },
          );
        }

        const body = await readActionParams(request);
        const rejected = (await rejectRequest(client, {
          tenantRef: tenant,
          id,
          decidedBy: principalId,
          reason: body.reason,
          enforceScope: true,
          approverScope: entityScopeFrom(request.headers, "approve"),
        })) as Record<string, unknown>;
        return Response.json(
          { approvalRequest: normalizeApprovalRequest(rejected) },
          { headers: NO_STORE },
        );
      } catch (error) {
        if (error instanceof ApprovalNotFoundError) return notFound();
        if (error instanceof SelfApprovalError) return forbidden();
        // Task 90: outside the request's entity scope. The answer names who can decide
        // it (a central approver), never the entity or resources it concerns.
        if (error instanceof ApprovalScopeError) {
          return Response.json(
            { error: "forbidden", handoff: error.handoff ?? "central" },
            { status: 403, headers: NO_STORE },
          );
        }
        if (error instanceof ApprovalReasonRequiredError) {
          return Response.json(
            { error: "invalid_request" },
            { status: 400, headers: NO_STORE },
          );
        }
        if (
          error instanceof ApprovalClosedError
          || error instanceof ApprovalExpiredError
          // Plan task 8: a restore promotion whose dry-run artifact is absent,
          // incomplete, refused, or failed fails closed the same way a closed or
          // expired request does — a conflict, not a mint.
          || error instanceof PromotionRefusedError
        ) {
          return Response.json(
            { error: "conflict" },
            { status: 409, headers: NO_STORE },
          );
        }
        throw error;
      }
    },
    deps,
  );
}

const ARTIFACT_ID_PATTERN = /^[0-9a-f]{64}$/;

export interface SetupDeps extends GuardDeps {
  host?: () => SetupHost;
}

// Roadmap task-76: start or resume a setup run. The plan is derived here from the
// host's readers, never accepted from the request; approving binds this principal to
// that exact plan (task-75 hashes the whole approval), and a resume runs only an
// approval the same principal made. Starting needs configuration and approve; the
// engine journal re-checks both grants from the database before every step, so a
// stale session or a revoked grant stops the run with its progress kept.
export function guardedSetup(deps: SetupDeps = {}) {
  const resolveHost = deps.host ?? setupHost;
  return guarded(
    { action: "setup", capability: "configuration", alsoRequires: ["approve"], recordAttempt: true },
    async ({ client, principalId, tenantRef: tenant, request }) => {
      const body = await readActionParams(request);
      const host = resolveHost();
      if (!canProvision(host)) {
        return Response.json({ error: "provisioning_unavailable" }, { status: 409, headers: NO_STORE });
      }
      await migrateBootstrapJournal(client);
      const journal = new BootstrapJournal({ client, tenantRef: tenant, principalId });
      let artifactId: string;
      try {
        if (body.resume !== undefined) {
          if (typeof body.resume !== "string" || !ARTIFACT_ID_PATTERN.test(body.resume)) {
            throw new InvalidActionRequest("resume must name a setup run");
          }
          artifactId = body.resume;
        } else {
          const scope = body.scope;
          if (typeof scope !== "string" || !Object.hasOwn(SETUP_SCOPES, scope)) {
            throw new InvalidActionRequest("scope must be read or restore");
          }
          let workloads: string[];
          try {
            workloads = selectWorkloads(scope, body.workloads) as string[];
          } catch {
            throw new InvalidActionRequest("unknown workload for this scope");
          }
          // planBootstrap is JavaScript; its JSDoc-inferred option types are too narrow.
          const plan = await planBootstrap({
            tenantRef: tenant,
            workloads,
            readAdapters: host.readers,
            operatorPrincipalId: host.operatorPrincipalId,
          } as unknown as Parameters<typeof planBootstrap>[0]);
          artifactId = (await approveBootstrapPlan({
            journal, plan, credentials: host.credentials, adapters: host.adapters,
            build: host.build, qualificationMode: host.qualificationMode,
          })) as string;
        }
        const result = (await executeBootstrap({
          journal, artifactId, adapters: host.adapters, build: host.build, qualificationMode: host.qualificationMode,
        })) as { status: string; stepId?: string };
        return Response.json(
          { run: { artifactId, status: result.status, stepId: result.stepId ?? null } },
          { headers: NO_STORE },
        );
      } catch (error) {
        if (error instanceof InvalidActionRequest) throw error;
        const message = error instanceof Error ? error.message : "";
        if (/not authorized/.test(message)) return forbidden();
        if (/immutable approved artifact required|immutable artifact mismatch/.test(message)) return notFound();
        // The journal keeps what happened; the page reads it back.
        return Response.json({ error: "setup_stopped" }, { status: 409, headers: NO_STORE });
      }
    },
    deps,
  );
}
