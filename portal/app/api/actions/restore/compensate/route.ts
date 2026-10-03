import { randomUUID } from "node:crypto";

import { enqueue } from "../../../../../../engine/jobs/queue.mjs";
import { getDryRunArtifact } from "../../../../../../engine/restore/dryRunArtifact.mjs";

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

// Roadmap task-70: plan the compensation of one promoted restore. Like the forward
// dry-run route, this only ever enqueues a DRY RUN: the worker re-reads the target,
// plans the inverse from that restore's own journal and persists an immutable
// compensation artifact. Executing it needs the normal confirmation and approval
// (POST /api/actions/restore with the new artifact id) — there is no undo shortcut.
export const POST = guarded(
  { action: "restore:compensate", capability: "restore", recordAttempt: true },
  async ({ client, principalId, tenantRef, request }) => {
    const body = await readActionParams(request);
    const { restoreArtifactId } = body;
    const unexpected = Object.keys(body).filter((key) => key !== "restoreArtifactId");
    if (unexpected.length > 0) {
      throw new InvalidActionRequest("a compensation is planned from the restore's artifact alone");
    }
    if (typeof restoreArtifactId !== "string" || !UUID_PATTERN.test(restoreArtifactId)) {
      throw new InvalidActionRequest("restoreArtifactId must be the id of a promoted restore's dry-run artifact");
    }
    // Tenant-scoped: another tenant's restore is indistinguishable from none.
    const forward = await getDryRunArtifact(client, { id: restoreArtifactId, tenantRef });
    if (!forward) throw new InvalidActionRequest("no restore artifact with that id");

    const artifactId = randomUUID();
    const job = (await enqueue(client, {
      kind: "restore",
      params: { compensates: restoreArtifactId, artifactId },
      requestedBy: principalId,
      idempotencyKey: request.headers.get(IDEMPOTENCY_KEY_HEADER) ?? undefined,
      notBefore: undefined,
    })) as Record<string, unknown>;

    const persistedArtifactId = (job.params as Record<string, unknown>)?.artifactId;
    if (typeof persistedArtifactId !== "string" || persistedArtifactId.length === 0) {
      throw new Error("compensation dry-run job is missing its artifact id");
    }
    return Response.json(
      { job: normalizeJob(job), artifactId: persistedArtifactId },
      { status: 202, headers: { "cache-control": "no-store" } },
    );
  },
);
