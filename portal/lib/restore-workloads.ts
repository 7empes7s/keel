import { connect } from "@/lib/db";
import { workloadRestoreGuide } from "../../engine/coverage/coverageDoc.mjs";
import { typeInfo } from "../../engine/insights/taxonomy.mjs";

import { databaseUrl, tenantRef } from "@/lib/runtime-config";
import type { RestoreWorkload } from "@/lib/restore-workloads-view";

export type { RestoreWorkload, RestoreWorkloadWrite } from "@/lib/restore-workloads-view";

// The Restore page's other Microsoft 365 services. Entra ID and Intune come from the
// tenant snapshot; Exchange, SharePoint, Teams, Purview and Power Platform are backed
// up as workload collections (engine/collect/workloads), so the page reads those too.
// What KEEL can put back for each comes from the same declarations docs/coverage.md
// is generated from (engine/coverage/coverageDoc.mjs workloadRestoreGuide).

interface Client {
  query(text: string, values?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
  end(): Promise<void>;
}

const USABLE = new Set(["complete", "complete-empty", "partial"]);

function iso(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const date = value instanceof Date ? value : new Date(String(value));
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function reasonsOf(digest: unknown): string[] {
  const reasons = (digest as { reasons?: unknown } | null)?.reasons;
  return Array.isArray(reasons) ? reasons.map((reason) => (typeof reason === "string" ? reason : JSON.stringify(reason))) : [];
}

/** Every workload KEEL knows, with its newest backup on this tenant and what can be put back. */
export async function getRestoreWorkloads(): Promise<RestoreWorkload[]> {
  const ref = tenantRef();
  const client = (await connect(databaseUrl())) as Client;
  try {
    const { rows: [table] } = await client.query("SELECT to_regclass('workload_collection') IS NOT NULL AS present");
    const latest = new Map<string, Record<string, unknown>>();
    const usable = new Map<string, Record<string, unknown>>();
    if (table?.present) {
      const { rows: runs } = await client.query(
        `SELECT DISTINCT ON (workload) id, workload, outcome, observed_to, digest
           FROM workload_collection WHERE tenant_ref = $1
          ORDER BY workload, created_at DESC, id DESC`,
        [ref],
      );
      for (const row of runs) latest.set(String(row.workload), row);
      const { rows: backups } = await client.query(
        `SELECT DISTINCT ON (c.workload) c.id, c.workload, c.outcome, c.observed_to,
                (SELECT count(*)::int FROM workload_observation o WHERE o.collection_id = c.id) AS items
           FROM workload_collection c
          WHERE c.tenant_ref = $1 AND c.outcome = ANY($2::text[])
          ORDER BY c.workload, c.created_at DESC, c.id DESC`,
        [ref, [...USABLE]],
      );
      for (const row of backups) usable.set(String(row.workload), row);
    }
    return (workloadRestoreGuide() as Omit<RestoreWorkload, "service" | "backup" | "lastRun">[]).map((entry) => {
      const backupRow = usable.get(entry.workload);
      const runRow = latest.get(entry.workload);
      const backup = backupRow
        ? { collectionId: String(backupRow.id), takenAt: iso(backupRow.observed_to), items: Number(backupRow.items ?? 0), partial: backupRow.outcome === "partial" }
        : null;
      const lastRun = runRow && !USABLE.has(String(runRow.outcome))
        ? { collectionId: String(runRow.id), outcome: String(runRow.outcome), at: iso(runRow.observed_to), reasons: reasonsOf(runRow.digest) }
        : null;
      return { ...entry, service: typeInfo(entry.workload).service, backup, lastRun };
    });
  } finally {
    await client.end();
  }
}
