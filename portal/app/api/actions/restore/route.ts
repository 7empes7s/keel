import {
  getDryRunArtifact,
  validateArtifactForApproval,
} from "../../../../../engine/restore/dryRunArtifact.mjs";

import {
  guarded,
  InvalidActionRequest,
  normalizeApprovalRequest,
  readActionParams,
} from "@/lib/action";
import { approvalTtlMs } from "@/lib/runtime-config";
// requestApproval is imported directly (rather than via guardedAction/guarded's own
// requiresApproval shortcut) because this route must validate the referenced
// artifact BEFORE any request is created — see the comment below.
import { requestApproval } from "../../../../../engine/govern/approvals.mjs";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// §3.3, plan task 8: restore requires approval by default — but portal-design §4.1
// requires dry-run, rendered review and confirmation of the SAME immutable plan, with
// no direct path from selection to enforce. A raw selection may start a dry run
// (POST .../restore/dry-run) — it may never request enforce. This route is
// confirmation: it accepts only a reference to a completed dry-run artifact, never
// mutable restore parameters (no mode, no selection, no target config). The artifact
// is checked here — absent, incomplete, or refused is rejected before any approval
// request exists — and checked AGAIN inside approveRequest at decision time (in case
// it was refused between request and decision), and its digest and current-state
// fingerprint are recomputed a third time at execution (cli/keel-restore.mjs), which
// is the only point a live read of the target is possible.
export const POST = guarded(
  { action: "restore", capability: "restore", recordAttempt: false },
  async ({ client, principalId, tenantRef, request }) => {
    const body = await readActionParams(request);
    const { artifactId, justification } = body;
    const unexpected = Object.keys(body).filter(
      (key) => key !== "artifactId" && key !== "justification",
    );

    if (unexpected.length > 0) {
      throw new InvalidActionRequest(
        "restore confirmation may reference only artifactId and justification; mutable restore parameters require a new dry run",
      );
    }

    if (typeof artifactId !== "string" || artifactId.length === 0) {
      throw new InvalidActionRequest("artifactId is required — confirm a completed dry run, never a raw selection");
    }

    const artifact = await getDryRunArtifact(client, { id: artifactId, tenantRef });
    const validation = validateArtifactForApproval(artifact);
    if (!validation.ok) throw new InvalidActionRequest(validation.reason);

    const approvalRequest = (await requestApproval(client, {
      tenantRef,
      action: "restore",
      params: { artifactId },
      requestedBy: principalId,
      justification: typeof justification === "string" ? justification : null,
      ttlMs: approvalTtlMs(),
    })) as Record<string, unknown>;

    return Response.json(
      { approvalRequest: normalizeApprovalRequest(approvalRequest) },
      { status: 202, headers: { "cache-control": "no-store" } },
    );
  },
);
