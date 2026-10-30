// Service setting changes for the Changes page. Read-only: it reads stored workload
// drift (engine/govern/workloadDrift.mjs) and never calls Microsoft. Callers check
// `read` first; only a central administrator sees them, as the settings are tenant-wide.
import { loadWorkloadSource } from "../../engine/restore/workloads/cmdletSettings.mjs";
import { workloadChoices } from "../../engine/restore/workloads/restoreChoices.mjs";
import { approvedDifferences } from "../../engine/govern/workloadDrift.mjs";

import { connect } from "@/lib/db";
import { PAGE_RESTORE_WORKLOADS } from "@/lib/restore-workloads-view";
import { databaseUrl, tenantRef } from "@/lib/runtime-config";
import { serviceChangeFrom, undoSource, type UndoChoice } from "@/lib/service-changes-view";
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
              c.observed_to, pc.observed_to AS previous_observed_to, ap.collection_id AS approved_collection_id, apc.observed_to AS approved_observed_to, aps.workload IS NOT NULL AS has_approved_setup, ap.fields - $5::text[] AS approved_fields, ap.field_coverage AS approved_coverage, cur.fields - $5::text[] AS current_fields, cur.field_coverage AS current_coverage, prev.fields - $5::text[] AS previous_fields, a.id AS alert_id, a.state AS alert_state
         FROM workload_drift d
         JOIN workload_collection c ON c.id = d.collection_id
         LEFT JOIN workload_collection pc ON pc.id = d.previous_collection_id
         LEFT JOIN workload_approved ap ON ap.tenant_ref = d.tenant_ref AND ap.workload = d.workload AND ap.resource_key = d.resource_key
         LEFT JOIN workload_collection apc ON apc.id = ap.collection_id
         LEFT JOIN workload_approved_setup aps ON aps.tenant_ref = d.tenant_ref AND aps.workload = d.workload
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
  return rows.map((row) => serviceChangeFrom({ ...row, approved_differences: againstApproved(row) }, choices.get(String(row.id)) ?? null));
}

/** A changed setting compared with the active approved setup now, rather than with the
 * value stored when the change was found: after a new baseline repointed the approved
 * setup, this is what an undo puts back. Null when there is no approved value to compare
 * with (no approved setup, or one that does not hold the resource) or the resource is gone. */
function againstApproved(row: Record<string, unknown>): unknown[] | null {
  if (row.change_type !== "modified" || !row.approved_collection_id || !row.approved_fields || !row.current_fields) return null;
  return approvedDifferences(
    String(row.workload),
    { fields: row.approved_fields, fieldCoverage: row.approved_coverage },
    { fields: row.current_fields, fieldCoverage: row.current_coverage },
  ) as unknown[] | null;
}

interface ChoiceGroup { restorable: boolean; reason: string | null; items: { key: string; restorable: boolean; reason: string | null }[] }

/** For each change Keel might undo: what the Restore page offers for its resource from
 * the read undo restores from (undoSource: the active approved setup's read, so a baseline
 * captured after the change wins over the value stored with it), told what the newest read shows (so a removed
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
    const source = undoSource(row).collectionId;
    if (!PAGE_RESTORE_WORKLOADS.includes(workload) || row.change_type === "added" || !source) continue;
    try {
      const before = await observations(workload, source);
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

/** The match percentage's base for services compared read to read, by workload:
 * how many settings the newest read found, and the open changes by kind. The changes are
 * counted here with no time window or row limit (unlike the list on the page), so a
 * difference that has stayed open for months still counts as not matching. */
export interface ServiceReadTotals {
  held: Record<string, number>;
  open: Record<string, Record<DriftRecord["changeType"], number>>;
}

export async function loadServiceReadTotals(client: KeelClient, tenant: string): Promise<ServiceReadTotals> {
  const { rows: heldRows } = await client.query(
    `WITH latest AS (
       SELECT DISTINCT ON (workload) id, workload FROM workload_collection
        WHERE tenant_ref = $1
        ORDER BY workload, created_at DESC, id DESC
     )
     SELECT latest.workload, count(o.*)::int AS count
       FROM latest LEFT JOIN workload_observation o ON o.collection_id = latest.id
      GROUP BY latest.workload`,
    [tenant],
  );
  // The same rule as loadServiceChanges: the newest change per resource, still open.
  const { rows: openRows } = await client.query(
    `SELECT workload, change_type, count(*)::int AS count FROM (
       SELECT DISTINCT ON (d.workload, d.resource_key) d.workload, d.change_type, a.state AS alert_state
         FROM workload_drift d
         JOIN workload_collection c ON c.id = d.collection_id
         LEFT JOIN alert a ON a.tenant_ref = d.tenant_ref AND a.resource_key = d.workload || ':' || d.resource_key
                          AND a.control = 'baseline' AND a.condition = 'drift'
        WHERE d.tenant_ref = $1
        ORDER BY d.workload, d.resource_key, c.observed_to DESC, d.detected_at DESC
     ) newest
     WHERE alert_state IS NULL OR alert_state = ANY($2::text[])
     GROUP BY workload, change_type`,
    [tenant, LISTED],
  );
  const open: ServiceReadTotals["open"] = {};
  for (const row of openRows) {
    const tally = open[String(row.workload)] ??= { added: 0, modified: 0, removed: 0 };
    const kind = String(row.change_type) as DriftRecord["changeType"];
    if (kind in tally) tally[kind] += Number(row.count ?? 0);
  }
  return { held: Object.fromEntries(heldRows.map((row) => [String(row.workload), Number(row.count ?? 0)])), open };
}

export async function getServiceReadTotals(): Promise<ServiceReadTotals> {
  const client = (await connect(databaseUrl())) as KeelClient;
  try {
    return await loadServiceReadTotals(client, tenantRef());
  } finally {
    await client.end();
  }
}

export async function getServiceChanges(now: Date = new Date()): Promise<DriftRecord[]> {
  const client = (await connect(databaseUrl())) as KeelClient;
  try {
    return await loadServiceChanges(client, { tenantRef: tenantRef(), now });
  } finally {
    await client.end();
  }
}
