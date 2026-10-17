import { randomUUID } from "node:crypto";

import { enqueue } from "../../../../../../../engine/jobs/queue.mjs";

import {
  guarded,
  IDEMPOTENCY_KEY_HEADER,
  InvalidActionRequest,
  normalizeJob,
  readActionParams,
} from "@/lib/action";
import { pageRestorable, perItemRequests, workloadBackups } from "@/lib/restore-workload-choices";
import { PER_ITEM_WORKLOADS } from "@/lib/restore-workloads-view";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// A workload restore's first half from the Restore page: one recorded backup of one
// workload and the objects chosen from it start a dry run, never a write. The job
// carries only these validated fields and the artifact id; the worker turns them into
// `keel-restore.mjs --workload` (a dry run only), and the result is sent for approval
// through POST /api/actions/restore like every other restore.
//
// Mailboxes and teams are planned one per dry run, so several chosen mailboxes or
// teams start several dry runs, each sent for approval on its own. The
// organization-wide Exchange settings ride along with the first chosen mailbox.
// The answer is always { runs: [{ target, job, artifactId }] }.
const MAX_PER_ITEM = 20;
export const POST = guarded(
  { action: "restore:workload-dry-run", capability: "restore", recordAttempt: true },
  async ({ client, principalId, tenantRef, request }) => {
    const body = await readActionParams(request);
    const unexpected = Object.keys(body).filter((key) => !["workload", "collectionId", "targets"].includes(key));
    if (unexpected.length > 0) {
      throw new InvalidActionRequest("a workload restore dry run takes only workload, collectionId and targets");
    }
    const { workload, collectionId, targets } = body;
    if (typeof workload !== "string" || !pageRestorable(workload)) {
      throw new InvalidActionRequest("this service is not restored from the Restore page");
    }
    if (typeof collectionId !== "string" || collectionId.length === 0) {
      throw new InvalidActionRequest("collectionId is required");
    }
    if (
      !Array.isArray(targets)
      || targets.length === 0
      || targets.length > 200
      || targets.some((key) => typeof key !== "string" || key.length === 0 || key.length > 512)
    ) {
      throw new InvalidActionRequest("targets must name between 1 and 200 objects from the backup");
    }
    const backups = await workloadBackups(client, tenantRef, workload);
    if (!backups.some((backup) => backup.collectionId === collectionId)) {
      throw new InvalidActionRequest("that backup is not one of this service's backups on this tenant");
    }

    const unique = [...new Set(targets as string[])];
    const idempotencyKey = request.headers.get(IDEMPOTENCY_KEY_HEADER) ?? undefined;
    const runs: { target: string | null; job: unknown; artifactId: string }[] = [];
    const start = async (target: string | null, workloadRestore: Record<string, unknown>, index: number) => {
      const artifactId = randomUUID();
      const job = (await enqueue(client, {
        kind: "restore",
        params: { workloadRestore, artifactId },
        requestedBy: principalId,
        // One key per run, so a retried request finds the same jobs again.
        idempotencyKey: idempotencyKey === undefined ? undefined : index === 0 ? idempotencyKey : `${idempotencyKey}:${index}`,
        notBefore: undefined,
      })) as Record<string, unknown>;
      const persisted = (job.params as Record<string, unknown> | undefined)?.artifactId;
      runs.push({ target, job: normalizeJob(job), artifactId: typeof persisted === "string" ? persisted : artifactId });
    };

    if (PER_ITEM_WORKLOADS.includes(workload)) {
      const items = perItemRequests(workload, unique);
      if (!items) throw new InvalidActionRequest("choose mailboxes or teams from this backup");
      if (items.length === 0) throw new InvalidActionRequest("the organization-wide settings are put back together with a mailbox; choose a mailbox too");
      if (items.length > MAX_PER_ITEM) throw new InvalidActionRequest(`choose at most ${MAX_PER_ITEM} at a time`);
      const organization = unique.includes("organization");
      for (const [index, item] of items.entries()) {
        const withOrganization = organization && index === 0;
        await start(item.key, {
          workload, collectionId, ...item.request,
          // Ticking the tenant-wide object is the person's explicit choice to plan it.
          ...(withOrganization ? { includeOrganization: true, allowTenantWide: true } : {}),
        }, index);
      }
    } else {
      await start(null, { workload, collectionId, targets: unique }, 0);
    }

    return Response.json(
      { runs },
      { status: 202, headers: { "cache-control": "no-store" } },
    );
  },
);
