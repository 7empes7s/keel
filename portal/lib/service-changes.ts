// Service setting changes for the Changes page. Read-only: it reads stored workload
// drift (engine/govern/workloadDrift.mjs) and never calls Microsoft. Callers check
// `read` first; only a central administrator sees them, as the settings are tenant-wide.
import { connect } from "@/lib/db";

import { databaseUrl, tenantRef } from "@/lib/runtime-config";
import { serviceChangeFrom } from "@/lib/service-changes-view";
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
export async function loadServiceChanges(
  client: KeelClient,
  { tenantRef: tenant, now = new Date(), days = 30, limit = 200 }: { tenantRef: string; now?: Date; days?: number; limit?: number },
): Promise<DriftRecord[]> {
  const since = new Date(now.getTime() - days * 24 * 60 * 60 * 1000);
  const { rows } = await client.query(
    `SELECT * FROM (
       SELECT DISTINCT ON (d.workload, d.resource_key)
              d.id, d.workload, d.resource_key, d.change_type, d.fields, d.blast_radius, d.collection_id, d.previous_collection_id,
              c.observed_to, cur.fields AS current_fields, prev.fields AS previous_fields, a.id AS alert_id, a.state AS alert_state
         FROM workload_drift d
         JOIN workload_collection c ON c.id = d.collection_id
         LEFT JOIN workload_observation cur ON cur.collection_id = d.collection_id AND cur.resource_key = d.resource_key
         LEFT JOIN workload_observation prev ON prev.collection_id = d.previous_collection_id AND prev.resource_key = d.resource_key
         LEFT JOIN alert a ON a.tenant_ref = d.tenant_ref AND a.resource_key = d.workload || ':' || d.resource_key
                          AND a.control = 'baseline' AND a.condition = 'drift'
        WHERE d.tenant_ref = $1 AND c.observed_to >= $2
        ORDER BY d.workload, d.resource_key, c.observed_to DESC, d.detected_at DESC
     ) newest
     WHERE alert_state IS NULL OR alert_state = ANY($3::text[])
     ORDER BY observed_to DESC, workload, resource_key LIMIT $4`,
    [tenant, since, LISTED, limit],
  );
  return rows.map(serviceChangeFrom);
}

export async function getServiceChanges(now: Date = new Date()): Promise<DriftRecord[]> {
  const client = (await connect(databaseUrl())) as KeelClient;
  try {
    return await loadServiceChanges(client, { tenantRef: tenantRef(), now });
  } finally {
    await client.end();
  }
}
