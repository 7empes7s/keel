// Gap 2 of the site permissions audit: the Sites pages' loader. Read-only: it reads the
// stored SharePoint workload reads and never calls Microsoft. Callers check `read` first.
import { connect } from "../../engine/store/db.mjs";

import { databaseUrl, tenantRef } from "@/lib/runtime-config";
import {
  SITES_WORKLOAD, sitePermissionsFrom, siteName, type SitePermissionsData, type SitesRun,
} from "@/lib/site-permissions-view";

interface KeelClient {
  query(text: string, values?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
  end(): Promise<void>;
}

const STORED = ["complete", "complete-empty", "partial"];

function runFrom(row: Record<string, unknown> | undefined): SitesRun | null {
  if (!row) return null;
  return {
    id: String(row.id),
    outcome: row.outcome as SitesRun["outcome"],
    observedTo: new Date(row.observed_to as string | Date).toISOString(),
  };
}

/**
 * The newest SharePoint read that stored sites, with every site's permissions, or only
 * `siteId`'s when given. The newest read of any outcome is reported too when it is
 * newer, so a failed or switched-off read is never hidden behind older data.
 */
export async function loadSitePermissions(
  client: KeelClient,
  { tenantRef: tenant, siteId = null, now = new Date() }: { tenantRef: string; siteId?: string | null; now?: Date },
): Promise<SitePermissionsData> {
  const runs = async (outcomes: string[] | null) => (await client.query(
    `SELECT id, outcome, observed_to FROM workload_collection
      WHERE tenant_ref = $1 AND workload = $2 AND ($3::text[] IS NULL OR outcome = ANY($3::text[]))
      ORDER BY created_at DESC, observed_to DESC LIMIT 1`,
    [tenant, SITES_WORKLOAD, outcomes],
  )).rows[0];
  const [storedRow, newestRow] = await Promise.all([runs(STORED), runs(null)]);
  const run = runFrom(storedRow);
  const newest = runFrom(newestRow);
  const latest = newest && newest.id !== run?.id ? newest : null;
  if (!run) return { generatedAt: now.toISOString(), run: null, latest, sites: [] };

  const { rows } = await client.query(
    `SELECT resource_key, fields, field_coverage FROM workload_observation
      WHERE collection_id = $1 AND ($2::text IS NULL AND resource_key LIKE 'site:%' OR resource_key = 'site:' || $2::text)`,
    [run.id, siteId],
  );
  const sites = rows
    .map((row) => sitePermissionsFrom(String(row.resource_key), row.fields, row.field_coverage))
    .sort((a, b) => siteName(a).localeCompare(siteName(b), "en-GB", { sensitivity: "base" }) || a.siteId.localeCompare(b.siteId));
  return { generatedAt: now.toISOString(), run, latest, sites };
}

export async function getSitePermissions(siteId: string | null = null, now: Date = new Date()): Promise<SitePermissionsData> {
  const client = (await connect(databaseUrl())) as KeelClient;
  try {
    return await loadSitePermissions(client, { tenantRef: tenantRef(), siteId, now });
  } finally {
    await client.end();
  }
}
