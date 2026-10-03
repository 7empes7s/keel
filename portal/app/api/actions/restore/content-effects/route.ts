import { ContentEffectApprovalError, approveContentEffects } from "../../../../../../engine/safety/contentEffects.mjs";

import { guarded, readActionParams } from "@/lib/action";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const NO_STORE = { "cache-control": "no-store" } as const;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Roadmap task-66: the SEPARATE high-impact approval of a dry run's content effects
// (retention-reducing, hold-releasing, externally-sharing, irreversible). It binds to
// the digest of exactly the effects the approver reviewed; the engine re-checks the
// approver's current approve grant and refuses the requester approving their own.
export const POST = guarded(
  { action: "restore-content-effects-approve", capability: "approve", recordAttempt: true },
  async ({ client, principalId, tenantRef, request }) => {
    const { artifactId, effectsDigest, justification } = await readActionParams(request);
    if (typeof artifactId !== "string" || !UUID_PATTERN.test(artifactId) || typeof effectsDigest !== "string") {
      return Response.json({ error: "invalid_request" }, { status: 400, headers: NO_STORE });
    }
    try {
      const approval = await approveContentEffects(client, {
        tenantRef, artifactId, approverId: principalId, effectsDigest, justification,
      });
      return Response.json({ approval: { id: approval.id, approvedBy: approval.approved_by, effectsDigest } }, { headers: NO_STORE });
    } catch (error) {
      if (error instanceof ContentEffectApprovalError) {
        return Response.json({ error: "refused", message: error.message }, { status: 409, headers: NO_STORE });
      }
      throw error;
    }
  },
);
