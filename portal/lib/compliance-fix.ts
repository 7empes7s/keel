import { randomUUID } from "node:crypto";

import { fixFor, listFixCandidates } from "../../engine/benchmarks/fix.mjs";
import { enqueue, PORTAL_QUEUED_JOBS_PER_PRINCIPAL } from "../../engine/jobs/queue.mjs";
import { guarded, IDEMPOTENCY_KEY_HEADER, normalizeJob, readActionParams, type GuardDeps } from "@/lib/action";
import { queueableRestoreCredentialPaths } from "@/lib/restore-config";

const NO_STORE = { "cache-control": "no-store" };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Compliance, "Make it pass" (CoreView gap 6): plan the one-value restore a failing
// control's fix declares, for one object. Like every restore from the portal this only
// ever enqueues a DRY RUN: the worker reads the tenant, plans the one setting from the
// live object and persists an immutable artifact. Carrying it out needs the normal
// confirmation (POST /api/actions/restore with that artifact) and an approval by
// someone else. The request names a result and an object; the setting, its new value,
// the backup and the credentials are all the server's.
export function guardedComplianceFix(deps: GuardDeps & { credentialPaths?: () => { collectorConfig: string; targetConfig: string } } = {}) {
  return guarded({ action: "compliance:fix", capability: "restore", recordAttempt: true }, async ({ client, principalId, tenantRef, request }) => {
    const body = await readActionParams(request);
    const refuse = (error: string, status = 400) => Response.json({ error }, { status, headers: NO_STORE });
    const { evaluationId, naturalKey } = body;
    if (Object.keys(body).some((key) => key !== "evaluationId" && key !== "naturalKey")) return refuse("invalid_request");
    if (typeof evaluationId !== "string" || !UUID.test(evaluationId)) return refuse("invalid_request");
    if (typeof naturalKey !== "string" || naturalKey.length === 0 || naturalKey.length > 1024) return refuse("invalid_request");

    const { rows } = await client.query(
      "SELECT control_id, verdict FROM benchmark_evaluation WHERE id = $1 AND tenant_ref = $2",
      [evaluationId, tenantRef],
    );
    if (!rows[0]) return refuse("not_found", 404);
    // Only the newest result of a control is acted on: an older one may say "fails"
    // after a newer check passed.
    const { rows: newest } = await client.query(
      `SELECT id FROM benchmark_evaluation WHERE tenant_ref = $1 AND control_id = $2
        ORDER BY evaluated_at DESC, created_at DESC LIMIT 1`,
      [tenantRef, rows[0].control_id],
    );
    if (String(newest[0]?.id) !== evaluationId) return refuse("not_newest", 409);
    if (rows[0].verdict !== "fail") return refuse("not_failing", 409);
    const controlId = String(rows[0].control_id);
    if (!fixFor(controlId)) return refuse("no_fix", 409);
    const candidates = (await listFixCandidates(client, { tenantRef, controlId, limit: 1000 })) as { naturalKey: string }[];
    if (!candidates.some((candidate) => candidate.naturalKey === naturalKey)) return refuse("not_a_candidate", 409);

    const { collectorConfig, targetConfig } = (deps.credentialPaths ?? queueableRestoreCredentialPaths)();
    const job = (await enqueue(client, {
      kind: "restore",
      params: { complianceFix: { controlId, naturalKey }, collectorConfig, targetConfig, artifactId: randomUUID() },
      requestedBy: principalId,
      idempotencyKey: request.headers.get(IDEMPOTENCY_KEY_HEADER) ?? undefined,
      notBefore: undefined,
      maxQueuedForRequester: PORTAL_QUEUED_JOBS_PER_PRINCIPAL,
    })) as Record<string, unknown>;
    const artifactId = (job.params as Record<string, unknown>)?.artifactId;
    if (typeof artifactId !== "string" || artifactId.length === 0) throw new Error("compliance fix job is missing its artifact id");
    return Response.json({ job: normalizeJob(job), artifactId }, { status: 202, headers: NO_STORE });
  }, deps);
}
