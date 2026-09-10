import { listJobs } from "../../engine/jobs/queue.mjs";
import { connect } from "../../engine/store/db.mjs";

import { normalizeJob } from "@/lib/action";
import { databaseUrl, tenantRef } from "@/lib/runtime-config";

// Plan task 16: the server-side data layer for the baselines and backups action
// surfaces. Lives apart from portal-data.ts (which serves the read-only report pages)
// so each surface's queries stay in one place; both read through the same
// runtime-config database handle as the rest of the portal.

interface KeelClient {
  query(
    text: string,
    values?: unknown[],
  ): Promise<{ rows: Record<string, unknown>[] }>;
  end(): Promise<void>;
}

type UnknownRecord = Record<string, unknown>;

function iso(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const date = value instanceof Date ? value : new Date(String(value));
  return Number.isNaN(date.valueOf()) ? null : date.toISOString();
}

// The normalized shape is exactly what GET /api/jobs serves, so the pages render the
// same job a client-side poll of the API would return.
export type JobRecord = ReturnType<typeof normalizeJob>;

export interface SnapshotOption {
  id: string;
  startedAt: string | null;
  completedAt: string | null;
  resourceCount: number;
}

async function withClient<T>(operation: (client: KeelClient) => Promise<T>): Promise<T> {
  const client = (await connect(databaseUrl())) as KeelClient;
  try {
    return await operation(client);
  } finally {
    await client.end();
  }
}

// Recent jobs of the given kinds, newest first. listJobs reads the newest 100; the
// kind filter and limit narrow that window per surface.
export async function getRecentJobs(
  kinds: string[],
  limit = 25,
): Promise<JobRecord[]> {
  return withClient(async (client) => {
    const rows = (await listJobs(client, { limit: 100 })) as UnknownRecord[];
    return rows
      .filter((row) => kinds.includes(String(row.kind)))
      .slice(0, limit)
      .map(normalizeJob);
  });
}

// Snapshots a baseline can be created from: completed collections for this tenant,
// newest first, with their captured resource counts.
export async function getSnapshotOptions(limit = 50): Promise<SnapshotOption[]> {
  const ref = tenantRef();
  return withClient(async (client) => {
    const { rows } = await client.query(
      `SELECT s.id, s.started_at, s.completed_at, count(rv.id)::int AS resource_count
       FROM snapshot s
       LEFT JOIN resource_version rv ON rv.snapshot_id = s.id
       WHERE s.tenant_ref = $1 AND s.status = 'complete'
       GROUP BY s.id
       ORDER BY s.started_at DESC
       LIMIT $2`,
      [ref, limit],
    );
    return rows.map((row) => ({
      id: String(row.id),
      startedAt: iso(row.started_at),
      completedAt: iso(row.completed_at),
      resourceCount: Number(row.resource_count ?? 0),
    }));
  });
}
