import { listJobs, summarizeJobs } from "../../engine/jobs/queue.mjs";
import { listEligibleBaselineSnapshots } from "../../engine/govern/baseline.mjs";
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

export interface JobsData {
  generatedAt: string;
  jobs: JobRecord[];
}

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
    const rows = ((await listJobs(client, { limit: 100 })) as UnknownRecord[])
      .filter((row) => kinds.includes(String(row.kind)))
      .slice(0, limit);
    // Task-130: requester, plan, baseline and changes resolved to names.
    return ((await summarizeJobs(client, { tenantRef: tenantRef(), jobs: rows })) as UnknownRecord[]).map(normalizeJob);
  });
}

// The API job-history loaders intentionally open their own client only after the
// route-level read guard has admitted the caller.
export async function getJobsData(): Promise<JobsData> {
  return withClient(async (client) => {
    const rows = (await listJobs(client, { limit: 100 })) as UnknownRecord[];
    return {
      generatedAt: new Date().toISOString(),
      jobs: rows.map(normalizeJob),
    };
  });
}

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function getJobData(id: string): Promise<JobRecord | null> {
  if (!UUID_PATTERN.test(id)) return null;
  return withClient(async (client) => {
    const { rows } = await client.query(`SELECT * FROM job WHERE id = $1`, [id]);
    return rows[0] ? normalizeJob(rows[0]) : null;
  });
}

// Snapshots a baseline can be created from use the engine-owned whole-estate
// eligibility contract. This is presentation only: seedFromSnapshot enforces the
// same contract inside its transaction for every direct engine caller.
export async function getSnapshotOptions(limit = 50): Promise<SnapshotOption[]> {
  const ref = tenantRef();
  return withClient(async (client) => {
    const rows = await listEligibleBaselineSnapshots(client, { tenantRef: ref, limit });
    return rows.map((row: UnknownRecord) => ({
      id: String(row.id),
      startedAt: iso(row.started_at),
      completedAt: iso(row.completed_at),
      resourceCount: Number(row.resource_count ?? 0),
    }));
  });
}

export async function hasCompletedSnapshots(): Promise<boolean> {
  const ref = tenantRef();
  return withClient(async (client) => {
    const { rows } = await client.query(
      `SELECT EXISTS(
         SELECT 1
         FROM snapshot
         WHERE tenant_ref = $1 AND status = 'complete'
       ) AS has_completed_snapshots`,
      [ref],
    );
    return Boolean(rows[0]?.has_completed_snapshots);
  });
}

// Partial snapshots remain selectable for explicitly scoped restore work. Baseline
// creation is stricter because it establishes a whole-estate comparison point.
export async function getRestoreSnapshotOptions(limit = 50): Promise<SnapshotOption[]> {
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
