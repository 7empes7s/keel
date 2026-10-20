// Gap 2 of the site permissions audit: the Sites pages' loader. Read-only: it reads the
// stored SharePoint workload reads and never calls Microsoft. Callers check `read` first.
import { connect } from "@/lib/db";

import { databaseUrl, tenantRef } from "@/lib/runtime-config";
import { idNames } from "@/lib/saved-names";
import {
  SITES_WORKLOAD, sitePermissionsFrom, siteName, type SitePermissionsData, type SitesRun,
} from "@/lib/site-permissions-view";
import { siteChangeFrom, type SiteChangesData } from "@/lib/site-changes-view";

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
    // Discovery stops at its site cap and says so; the list is then incomplete.
    capped: (row.digest as { discovery?: { capped?: unknown } } | null)?.discovery?.capped === true,
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
    `SELECT id, outcome, observed_to, digest FROM workload_collection
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
    return await withAppNames(client, tenantRef(), await loadSitePermissions(client, { tenantRef: tenantRef(), siteId, now }));
  } finally {
    await client.end();
  }
}

/**
 * Graph can leave out the name of an app with site access. Such an app is named by its
 * app id from the newest backup of enterprise apps and app registrations, so the page
 * reads "Contoso HR", not "An app with no name".
 */
export async function withAppNames(client: KeelClient, tenant: string, data: SitePermissionsData): Promise<SitePermissionsData> {
  const ids = data.sites.flatMap((site) => (site.appGrants.entries ?? []).flatMap((grant) =>
    grant.applications.flatMap((application) => (!application.displayName && application.id ? [application.id] : []))));
  if (!ids.length) return data;
  const names = await idNames(client, tenant, ids);
  const nameOf = (id: string | null) => (id ? names.ids[id.toLowerCase()] ?? null : null);
  return {
    ...data,
    sites: data.sites.map((site) => !site.appGrants.entries ? site : {
      ...site,
      appGrants: {
        ...site.appGrants,
        entries: site.appGrants.entries.map((grant) => ({
          ...grant,
          applications: grant.applications.map((application) => application.displayName ? application : { ...application, displayName: nameOf(application.id) }),
        })),
      },
    }),
  };
}

/**
 * Changes to SharePoint site settings found within `days`, the newest per site or the
 * tenant's sharing settings, newest first, each with its site's name and its alert.
 * The name comes from the read that found the change, or the one before it when the
 * site is gone.
 */
export async function loadSiteChanges(
  client: KeelClient,
  { tenantRef: tenant, now = new Date(), days = 30, limit = 50 }: { tenantRef: string; now?: Date; days?: number; limit?: number },
): Promise<SiteChangesData> {
  const since = new Date(now.getTime() - days * 24 * 60 * 60 * 1000);
  const { rows } = await client.query(
    `SELECT * FROM (
       SELECT DISTINCT ON (d.resource_key)
              d.id, d.resource_key, d.change_type, d.fields, d.blast_radius, d.collection_id, d.previous_collection_id,
              c.observed_to, COALESCE(cur.fields, prev.fields) AS site_fields, a.id AS alert_id, a.state AS alert_state
         FROM workload_drift d
         JOIN workload_collection c ON c.id = d.collection_id
         LEFT JOIN workload_observation cur ON cur.collection_id = d.collection_id AND cur.resource_key = d.resource_key
         LEFT JOIN workload_observation prev ON prev.collection_id = d.previous_collection_id AND prev.resource_key = d.resource_key
         LEFT JOIN alert a ON a.tenant_ref = d.tenant_ref AND a.resource_key = d.workload || ':' || d.resource_key
                          AND a.control = 'baseline' AND a.condition = 'drift'
        WHERE d.tenant_ref = $1 AND d.workload = $2 AND c.observed_to >= $3
        ORDER BY d.resource_key, c.observed_to DESC, d.detected_at DESC
     ) newest
     ORDER BY observed_to DESC, resource_key LIMIT $4`,
    [tenant, SITES_WORKLOAD, since, limit],
  );
  return { days, changes: rows.map(siteChangeFrom) };
}

export async function getSiteChanges(now: Date = new Date()): Promise<SiteChangesData> {
  const client = (await connect(databaseUrl())) as KeelClient;
  try {
    return await loadSiteChanges(client, { tenantRef: tenantRef(), now });
  } finally {
    await client.end();
  }
}
