// Service setting changes for the Changes page. Read-only: it reads stored workload
// drift (engine/govern/workloadDrift.mjs) and never calls Microsoft. Callers check
// `read` first; only a central administrator sees them, as the settings are tenant-wide.
import { loadWorkloadSource } from "../../engine/restore/workloads/cmdletSettings.mjs";
import { workloadChoices } from "../../engine/restore/workloads/restoreChoices.mjs";

import { connect } from "@/lib/db";
import { PAGE_RESTORE_WORKLOADS } from "@/lib/restore-workloads-view";
import { databaseUrl, tenantRef } from "@/lib/runtime-config";
import { serviceChangeFrom, type UndoChoice } from "@/lib/service-changes-view";
import type { DriftRecord } from "@/lib/types";

interface KeelClient {
  query(text: string, values?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
  end(): Promise<void>;
}

// An alert in these states is still open: waiting for someone, or seen (acknowledged)
// and not yet resolved. Resolved and muted ones leave the list.
const LISTED = ["open", "reopened", "acknowledged"];

/**
 * Service setting changes still open: the newest change per resource found within
 * `days`, in every service, whose alert is open, reopened or acknowledged (or that
 * raised none). Newest first. Each carries the resource's name from the read that found it,
 * or from the read before it when the resource is gone.
 */
// Fields a read keeps for a restore but never shows: a SharePoint site template's whole XML
// (engine/collect/workloads/sharepointStructure.mjs, TEMPLATE_STORAGE_FIELDS) can be megabytes.
const STORED_ONLY = ["templateXml", "templateSha256", "templateBytes"];

export async function loadServiceChanges(
  client: KeelClient,
  { tenantRef: tenant, now = new Date(), days = 30, limit = 200 }: { tenantRef: string; now?: Date; days?: number; limit?: number },
): Promise<DriftRecord[]> {
  const since = new Date(now.getTime() - days * 24 * 60 * 60 * 1000);
  const { rows } = await client.query(
    `SELECT * FROM (
       SELECT DISTINCT ON (d.workload, d.resource_key)
              d.id, d.workload, d.resource_key, d.change_type, d.fields, d.blast_radius, d.collection_id, d.previous_collection_id, d.compared_with,
              c.observed_to, pc.observed_to AS previous_observed_to, cur.fields - $5::text[] AS current_fields, prev.fields - $5::text[] AS previous_fields, a.id AS alert_id, a.state AS alert_state
         FROM workload_drift d
         JOIN workload_collection c ON c.id = d.collection_id
         LEFT JOIN workload_collection pc ON pc.id = d.previous_collection_id
         LEFT JOIN workload_observation cur ON cur.collection_id = d.collection_id AND cur.resource_key = d.resource_key
         LEFT JOIN workload_observation prev ON prev.collection_id = d.previous_collection_id AND prev.resource_key = d.resource_key
         LEFT JOIN alert a ON a.tenant_ref = d.tenant_ref AND a.resource_key = d.workload || ':' || d.resource_key
                          AND a.control = 'baseline' AND a.condition = 'drift'
        WHERE d.tenant_ref = $1 AND c.observed_to >= $2
        ORDER BY d.workload, d.resource_key, c.observed_to DESC, d.detected_at DESC
     ) newest
     WHERE alert_state IS NULL OR alert_state = ANY($3::text[])
     ORDER BY observed_to DESC, workload, resource_key LIMIT $4`,
    [tenant, since, LISTED, limit, STORED_ONLY],
  );
  const choices = await undoChoices(client, tenant, rows);
  return rows.map((row) => serviceChangeFrom(row, choices.get(String(row.id)) ?? null));
}

interface ChoiceGroup { restorable: boolean; reason: string | null; items: { key: string; restorable: boolean; reason: string | null }[] }

/** For each change Keel might undo: what the Restore page offers for its resource from
 * the read that holds the earlier value, told what the newest read shows (so a removed
 * setting reads as deleted). Each read is loaded once. */
async function undoChoices(client: KeelClient, tenant: string, rows: Record<string, unknown>[]): Promise<Map<string, UndoChoice | null>> {
  const reads = new Map<string, Promise<unknown[] | null>>();
  const observations = (workload: string, collectionId: string) => {
    const key = `${workload}:${collectionId}`;
    if (!reads.has(key)) {
      reads.set(key, loadWorkloadSource(client, { tenantRef: tenant, collectionId, workload })
        .then((source: { observations: unknown[] } | null) => source?.observations ?? null));
    }
    return reads.get(key)!;
  };
  const found = new Map<string, UndoChoice | null>();
  for (const row of rows) {
    const workload = String(row.workload);
    if (!PAGE_RESTORE_WORKLOADS.includes(workload) || row.change_type === "added") continue;
    try {
      const before = await observations(workload, String(row.previous_collection_id));
      if (!before) { found.set(String(row.id), null); continue; }
      const now = await observations(workload, String(row.collection_id));
      const groups = workloadChoices(workload, before, now as null) as ChoiceGroup[];
      const group = groups.find((entry) => entry.items.some((item) => item.key === row.resource_key));
      const item = group?.items.find((entry) => entry.key === row.resource_key);
      found.set(String(row.id), group && item ? { restorable: group.restorable && item.restorable, reason: item.reason ?? group.reason } : null);
    } catch {
      found.set(String(row.id), null);
    }
  }
  return found;
}

export async function getServiceChanges(now: Date = new Date()): Promise<DriftRecord[]> {
  const client = (await connect(databaseUrl())) as KeelClient;
  try {
    return await loadServiceChanges(client, { tenantRef: tenantRef(), now });
  } finally {
    await client.end();
  }
}
