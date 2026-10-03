import {
  ApprovalClosedError,
  ApprovalExpiredError,
  ApprovalNotFoundError,
  ApprovalReasonRequiredError,
  PromotionRefusedError,
  SelfApprovalError,
  approveRequest,
  rejectRequest,
  requestApproval,
} from "../../engine/govern/approvals.mjs";
import { applyDisposition } from "../../engine/govern/disposition.mjs";
import { appendEvidence } from "../../engine/govern/evidence.mjs";
import { approveBootstrapPlan, executeBootstrap } from "../../engine/bootstrap/execute.mjs";
import { BootstrapJournal, migrateBootstrapJournal } from "../../engine/bootstrap/journal.mjs";
import { firstCollectReadiness, selectWorkloads, SETUP_SCOPES } from "../../engine/bootstrap/onboarding.mjs";
import { planBootstrap } from "../../engine/bootstrap/plan.mjs";
import { capabilityForJobKind } from "../../engine/authz/jobCapabilities.mjs";
import { enqueue, listJobs, summarizeJobs } from "../../engine/jobs/queue.mjs";
import { connect } from "../../engine/store/db.mjs";
import { updateSchedule, validateSchedule } from "../../engine/schedules/cadence.mjs";
import { acknowledgeForecastWarning } from "../../engine/schedules/forecast.mjs";

import { AUTHENTICATED_EMAIL_HEADER } from "@/lib/cloudflare-access";
import { CAPABILITIES_HEADER, PRINCIPAL_ID_HEADER } from "@/lib/principal";
import { approvalTtlMs, databaseUrl, tenantRef } from "@/lib/runtime-config";
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
  };
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
        return await deny("capability");
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
      const job = (await enqueue(client, {
        kind: spec.jobKind,
        params: await readActionParams(request),
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
    async ({ client, principalId, request }) => {
      const body = await readActionParams(request);
      const { driftId, action, reason, expiresAt } = body;

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
      } catch {
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

export function guardedJobList(
  deps: GuardDeps = {},
): (request: Request) => Promise<Response> {
  return guarded(
    { action: "jobs:list", capability: "read" },
    async ({ client, tenantRef, request }) => {
      const requestedLimit = Number(new URL(request.url).searchParams.get("limit") ?? 100);
      const limit = Number.isSafeInteger(requestedLimit) && requestedLimit > 0
        ? requestedLimit : 100;
      const rows = (await listJobs(client, { limit })) as Record<
        string,
        unknown
      >[];
      // Task-130: requester, plan, baseline and changes resolved to names.
      const summarized = (await summarizeJobs(client, { tenantRef, jobs: rows })) as Record<string, unknown>[];
      return Response.json(
        { generatedAt: new Date().toISOString(), jobs: summarized.map(normalizeJob) },
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
      return Response.json({ job: normalizeJob(summarized) }, { headers: NO_STORE });
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
export function guardedApprovalDecision(
  decision: "approve" | "reject",
  deps: GuardDeps = {},
): (request: Request) => Promise<Response> {
  return guarded(
    { action: `approvals:${decision}`, capability: "approve", recordAttempt: true },
    async ({ client, principalId, tenantRef: tenant, request }) => {
      const segments = new URL(request.url).pathname.split("/").filter(Boolean);
      const id = segments.at(-2) ?? "";
      if (!UUID_PATTERN.test(id)) return notFound();

      try {
        if (decision === "approve") {
          const { job } = (await approveRequest(client, {
            tenantRef: tenant,
            id,
            decidedBy: principalId,
          })) as { job: Record<string, unknown> };
          return Response.json(
            { job: normalizeJob(job) },
            { status: 202, headers: NO_STORE },
          );
        }

        const body = await readActionParams(request);
        const rejected = (await rejectRequest(client, {
          tenantRef: tenant,
          id,
          decidedBy: principalId,
          reason: body.reason,
        })) as Record<string, unknown>;
        return Response.json(
          { approvalRequest: normalizeApprovalRequest(rejected) },
          { headers: NO_STORE },
        );
      } catch (error) {
        if (error instanceof ApprovalNotFoundError) return notFound();
        if (error instanceof SelfApprovalError) return forbidden();
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
