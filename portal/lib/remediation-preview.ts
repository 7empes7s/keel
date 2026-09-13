import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

import { runRemediate } from "../../cli/keel-remediate.mjs";
import { guarded, InvalidActionRequest, readActionParams, type GuardDeps } from "@/lib/action";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Same server-owned Collector default as the remediate worker. The request cannot
// supply credentials, tenant identity, a computed plan, or guard overrides.
function collectorConfig() {
  return JSON.parse(readFileSync("/etc/keel/tenant-target.json", "utf8"));
}

export function remediationSelection(deps: GuardDeps & {
  collectorConfig?: typeof collectorConfig;
  engineDependencies?: Record<string, unknown>;
} = {}) {
  return guarded(
    { action: "remediate:selection-preview", capability: "remediate", recordAttempt: false },
    async ({ client, tenantRef, request }) => {
      const { driftIds } = await readActionParams(request);
      if (!Array.isArray(driftIds) || driftIds.length === 0
        || driftIds.some((id) => typeof id !== "string" || !UUID.test(id))) {
        throw new InvalidActionRequest("driftIds must be a non-empty array of UUIDs");
      }
      const selected = [...new Set(driftIds)] as string[];
      const { rows } = await client.query(
        `SELECT d.id FROM drift d
         JOIN baseline b ON b.id = d.baseline_id
         WHERE d.id = ANY($1::uuid[]) AND d.tenant_ref = $2 AND b.tenant_ref = $2`,
        [selected, tenantRef],
      );
      if (rows.length !== selected.length) {
        return Response.json({ error: "not_found" }, {
          status: 404, headers: { "cache-control": "no-store" },
        });
      }
      const config = (deps.collectorConfig ?? collectorConfig)();
      const ref = `sha256:${createHash("sha256").update(config.tenantId).digest("hex").slice(0, 16)}`;
      if (ref !== tenantRef) throw new Error("remediation Collector tenant does not match portal tenant");

      const preview = await runRemediate({
        driftIds: selected,
        previewOnly: true,
        collectorConfig: config,
        targetConfig: undefined,
        mode: "dry-run",
        acceptDegradation: false,
        dependencies: {
          ...deps.engineDependencies,
          // Borrow the wrapper's connection; only the wrapper may close it.
          connect: async () => ({ query: client.query.bind(client), async end() {} }),
        },
        logger: { ...console, log() {} },
      });
      return Response.json({ ...preview, driftIds: selected }, {
        headers: { "cache-control": "no-store" },
      });
    },
    deps,
  );
}
