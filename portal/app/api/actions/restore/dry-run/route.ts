import { randomUUID } from "node:crypto";

import { enqueue } from "../../../../../../engine/jobs/queue.mjs";

import {
  guarded,
  IDEMPOTENCY_KEY_HEADER,
  InvalidActionRequest,
  normalizeJob,
  readActionParams,
} from "@/lib/action";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Plan task 8, step 2: the structural flow's first half. "A raw selection may start a
// dry run — never request enforce." This route enqueues exactly a dry run: params are
// built explicitly from validated fields below, never a raw passthrough of the
// request body, so there is no field the caller can set — mode included — that would
// turn this into an enforce request. cli/keel-worker.mjs's promotion branch requires
// params.mode === 'enforce' with params.artifactId as its ENTIRE payload; a job
// enqueued here can never take that shape.
//
// artifactId is generated here, before the dry run has even run, and returned to the
// caller so the portal can poll for it (GET .../dry-run/[id]) while the worker
// computes it — the same pattern as the client-generated idempotency key, just
// server-side because it becomes a database primary key.
export const POST = guarded(
  { action: "restore:dry-run", capability: "restore", recordAttempt: true },
  async ({ client, principalId, request }) => {
    const body = await readActionParams(request);
    const { snapshotId, selection, collectorConfig, targetConfig, incidentId } = body;
    const unexpected = Object.keys(body).filter(
      (key) => !["snapshotId", "selection", "collectorConfig", "targetConfig", "incidentId"].includes(key),
    );

    if (unexpected.length > 0) {
      throw new InvalidActionRequest(
        "a raw selection may start only a dry run; confirm a completed artifact separately",
      );
    }

    if (typeof snapshotId !== "string" || snapshotId.length === 0) {
      throw new InvalidActionRequest("snapshotId is required");
    }
    if (
      !Array.isArray(selection)
      || selection.length === 0
      || selection.some((key) => typeof key !== "string" || key.length === 0)
    ) {
      throw new InvalidActionRequest("selection must be a non-empty array of natural keys");
    }
    if (typeof collectorConfig !== "string" || collectorConfig.length === 0) {
      throw new InvalidActionRequest("collectorConfig is required");
    }
    if (typeof targetConfig !== "string" || targetConfig.length === 0) {
      throw new InvalidActionRequest("targetConfig is required");
    }

    // Roadmap task-71: optionally plan the dry run under an incident. Only the id
    // travels; the CLI re-derives the recovery point qualification, exclusions and
    // any override from the database, at the dry run and again at promotion.
    if (incidentId !== undefined && (typeof incidentId !== "string" || !UUID_PATTERN.test(incidentId))) {
      throw new InvalidActionRequest("incidentId must be an incident id");
    }

    const artifactId = randomUUID();
    const job = (await enqueue(client, {
      kind: "restore",
      params: {
        snapshotId, selection, collectorConfig, targetConfig, artifactId,
        ...(incidentId !== undefined ? { incidentId } : {}),
      },
      requestedBy: principalId,
      idempotencyKey: request.headers.get(IDEMPOTENCY_KEY_HEADER) ?? undefined,
      notBefore: undefined,
    })) as Record<string, unknown>;

    const persistedArtifactId = (job.params as Record<string, unknown>)?.artifactId;
    if (typeof persistedArtifactId !== "string" || persistedArtifactId.length === 0) {
      throw new Error("restore dry-run job is missing its artifact id");
    }

    return Response.json(
      { job: normalizeJob(job), artifactId: persistedArtifactId },
      { status: 202, headers: { "cache-control": "no-store" } },
    );
  },
);
