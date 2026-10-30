import { loadWorkloadSource } from "../../engine/restore/workloads/cmdletSettings.mjs";
import { perItemRequest, workloadChoices } from "../../engine/restore/workloads/restoreChoices.mjs";

import { PAGE_RESTORE_WORKLOADS, type WorkloadBackupPoint, type WorkloadChoiceGroup, type WorkloadChoices } from "@/lib/restore-workloads-view";

// What the Restore page offers for one service's backup: the backups to pick from and
// every object the chosen one holds (engine/restore/workloads/restoreChoices.mjs).

interface Client {
  query(text: string, values?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
}

const USABLE = ["complete", "complete-empty", "partial"];

/** True for a workload the page can start a restore for. */
export function pageRestorable(workload: string): boolean {
  return PAGE_RESTORE_WORKLOADS.includes(workload);
}

function iso(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const date = value instanceof Date ? value : new Date(String(value));
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

/** The backups of one workload on this tenant, newest first. */
export async function workloadBackups(client: Client, tenant: string, workload: string): Promise<WorkloadBackupPoint[]> {
  const { rows } = await client.query(
    `SELECT c.id, c.observed_to, (SELECT count(*)::int FROM workload_observation o WHERE o.collection_id = c.id) AS items
       FROM workload_collection c
      WHERE c.tenant_ref = $1 AND c.workload = $2 AND c.outcome = ANY($3::text[])
      ORDER BY c.created_at DESC, c.id DESC
      LIMIT 400`,
    [tenant, workload, USABLE],
  );
  return rows.map((row) => ({ collectionId: String(row.id), takenAt: iso(row.observed_to), items: Number(row.items ?? 0) }));
}

/** One backup of one workload on this tenant by its id, however old: the list above holds
 * only the newest 400, and an undo from the Changes page can restore from an approved
 * setup's read older than those. Null when it is not a usable backup of this workload here. */
export async function workloadBackup(client: Client, tenant: string, workload: string, collectionId: string): Promise<WorkloadBackupPoint | null> {
  const { rows: [row] } = await client.query(
    `SELECT c.id, c.observed_to, (SELECT count(*)::int FROM workload_observation o WHERE o.collection_id = c.id) AS items
       FROM workload_collection c
      WHERE c.tenant_ref = $1 AND c.workload = $2 AND c.outcome = ANY($3::text[]) AND c.id::text = $4`,
    [tenant, workload, USABLE, collectionId],
  );
  return row ? { collectionId: String(row.id), takenAt: iso(row.observed_to), items: Number(row.items ?? 0) } : null;
}

/** The choices for one workload, from `collectionId` or else its newest backup; null when there is none. */
export async function getWorkloadChoices(client: Client, tenant: string, workload: string, collectionId: string | null): Promise<WorkloadChoices | null> {
  if (!pageRestorable(workload)) return null;
  const newestBackups = await workloadBackups(client, tenant, workload);
  const listed = collectionId ? newestBackups.find((backup) => backup.collectionId === collectionId) : newestBackups[0];
  // A backup older than the list is still offered when asked for by id, at the list's end.
  const chosen = listed ?? (collectionId ? await workloadBackup(client, tenant, workload, collectionId) : null);
  if (!chosen) return null;
  const backups = listed ? newestBackups : [...newestBackups, chosen];
  const source = await loadWorkloadSource(client, { tenantRef: tenant, collectionId: chosen.collectionId, workload });
  if (!source) return null;
  const newest = backups[0].collectionId === chosen.collectionId
    ? null
    : await loadWorkloadSource(client, { tenantRef: tenant, collectionId: backups[0].collectionId, workload });
  const groups = workloadChoices(workload, source.observations, newest?.observations ?? null) as WorkloadChoiceGroup[];
  return { workload, backups, chosen, groups };
}

/** The dry-run requests for the chosen objects of a mailbox or team workload; null when one is not a mailbox or team. */
export function perItemRequests(workload: string, targets: string[]): { key: string; request: Record<string, string> }[] | null {
  const requests = targets.filter((key) => key !== "organization").map((key) => ({ key, request: perItemRequest(workload, key) as Record<string, string> | null }));
  if (requests.some((entry) => entry.request === null)) return null;
  return requests as { key: string; request: Record<string, string> }[];
}
