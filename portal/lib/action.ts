import { applyDisposition } from "../../engine/govern/disposition.mjs";
import { appendEvidence } from "../../engine/govern/evidence.mjs";
import { capabilityForJobKind } from "../../engine/authz/jobCapabilities.mjs";
import { enqueue, listJobs } from "../../engine/jobs/queue.mjs";
import { connect } from "../../engine/store/db.mjs";

import { AUTHENTICATED_EMAIL_HEADER } from "@/lib/cloudflare-access";
import { CAPABILITIES_HEADER, PRINCIPAL_ID_HEADER } from "@/lib/principal";
import { databaseUrl, tenantRef } from "@/lib/runtime-config";

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
  requiresApproval?: boolean;
  // Mutating routes record the attempt before acting; read routes do not.
  recordAttempt?: boolean;
}

export interface GuardContext {
  client: KeelClient;
  principalId: string;
  capabilities: string[];
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
    createdAt: iso(row.created_at),
    startedAt: iso(row.started_at),
    finishedAt: iso(row.finished_at),
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
      // §3.3: a requiresApproval action can never be enqueued directly. Task 14 builds
      // the approval_request path that replaces this denial.
      if (spec.requiresApproval) return await deny("requires-approval");

      if (spec.recordAttempt) {
        await appendEvidence(client, {
          tenantRef: resolveTenantRef(),
          kind: ATTEMPT_EVIDENCE_KIND,
          subject: { action: spec.action, decision: "attempted" },
          actor,
        });
      }

      return await handler({ client, principalId, capabilities, request });
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
      requiresApproval: spec.requiresApproval,
      recordAttempt: true,
    },
    async ({ client, principalId, request }) => {
      const job = (await enqueue(client, {
        kind: spec.jobKind,
        params: await readActionParams(request),
        requestedBy: principalId,
        idempotencyKey: request.headers.get(IDEMPOTENCY_KEY_HEADER) ?? undefined,
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
    async ({ client }) => {
      const rows = (await listJobs(client, { limit: 100 })) as Record<
        string,
        unknown
      >[];
      return Response.json(
        { generatedAt: new Date().toISOString(), jobs: rows.map(normalizeJob) },
        { headers: NO_STORE },
      );
    },
    deps,
  );
}

const JOB_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function guardedJobShow(
  deps: GuardDeps = {},
): (request: Request) => Promise<Response> {
  return guarded(
    { action: "jobs:show", capability: "read" },
    async ({ client, request }) => {
      const id =
        new URL(request.url).pathname.split("/").filter(Boolean).pop() ?? "";
      if (!JOB_ID_PATTERN.test(id)) return notFound();

      const { rows } = await client.query(`SELECT * FROM job WHERE id = $1`, [
        id,
      ]);
      if (!rows[0]) return notFound();
      return Response.json({ job: normalizeJob(rows[0]) }, { headers: NO_STORE });
    },
    deps,
  );
}
