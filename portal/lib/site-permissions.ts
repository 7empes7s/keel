// Gap 2 of the site permissions audit: the Sites pages' loader. Read-only: it reads the
// stored SharePoint workload reads and never calls Microsoft. Callers check `read` first.
import { connect } from "@/lib/db";

import { databaseUrl, tenantRef } from "@/lib/runtime-config";
import { idNames } from "@/lib/saved-names";
import {
  SITES_WORKLOAD, sitePermissionsFrom, siteName,
  type PeopleSummary, type SiteBackup, type SitePermissionsData, type SitesContentRun, type SitesRun,
} from "@/lib/site-permissions-view";

// The nightly content backup of sites (engine/content/sharepointSites.mjs).
const CONTENT_WORKLOAD = "sharepoint-sites";

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
  if (!run) return { generatedAt: now.toISOString(), run: null, latest, sites: [], contentRun: null, tenantSharing: null };

  const { rows } = await client.query(
    `SELECT resource_key, fields, field_coverage FROM workload_observation
      WHERE collection_id = $1 AND ($2::text IS NULL AND resource_key LIKE 'site:%' OR resource_key = 'site:' || $2::text OR resource_key = 'tenant')`,
    [run.id, siteId],
  );
  const tenantRow = rows.find((row) => row.resource_key === "tenant");
  const sharing = (tenantRow?.field_coverage as Record<string, { status?: string }> | undefined)?.sharingCapability?.status === "observed"
    ? (tenantRow?.fields as Record<string, unknown>).sharingCapability : null;
  const backups = await loadSiteBackups(client, tenant, siteId);
  const sites = rows
    .filter((row) => row.resource_key !== "tenant")
    .map((row) => {
      const site = sitePermissionsFrom(String(row.resource_key), row.fields, row.field_coverage);
      return { ...site, backup: backups.held.get(site.siteId) ?? null, people: backups.people.get(site.siteId) ?? null };
    })
    .sort((a, b) => siteName(a).localeCompare(siteName(b), "en-GB", { sensitivity: "base" }) || a.siteId.localeCompare(b.siteId));
  return {
    generatedAt: now.toISOString(), run, latest, sites,
    contentRun: backups.run, tenantSharing: typeof sharing === "string" ? sharing : null,
  };
}

const num = (value: unknown) => (Number.isFinite(Number(value)) ? Number(value) : 0);
const iso = (value: unknown) => new Date(value as string | Date).toISOString();

function peopleFrom(value: unknown, readAt: string): PeopleSummary | null {
  const summary = value && typeof value === "object" ? value as Record<string, unknown> : null;
  if (!summary || !Array.isArray(summary.groups)) return null;
  return {
    inherits: summary.inherits === true,
    groups: summary.groups.map((group: Record<string, unknown>) => ({
      name: typeof group?.name === "string" ? group.name : null,
      members: Number.isInteger(group?.members) ? group.members as number : null,
      roles: Array.isArray(group?.roles) ? group.roles.filter((role): role is string => typeof role === "string") : null,
    })),
    owners: Array.isArray(summary.owners) ? summary.owners.filter((name): name is string => typeof name === "string") : [],
    ownerCount: num(summary.ownerCount),
    people: num(summary.people),
    guests: num(summary.guests),
    sharingLinks: num(summary.sharingLinks),
    uniqueLists: num(summary.uniqueLists),
    readAt,
  };
}

/**
 * What the nightly content backup holds per site: items and bytes stored, when it last
 * stored something, the owners/groups/guests summary saved beside `site/permissions`,
 * and the newest run of the sites backup. Empty when the content tables do not exist.
 */
export async function loadSiteBackups(client: KeelClient, tenant: string, siteId: string | null = null) {
  const held = new Map<string, SiteBackup>();
  const people = new Map<string, PeopleSummary>();
  const { rows: [tables] } = await client.query(
    "SELECT to_regclass('content_item') IS NOT NULL AS items, to_regclass('content_run') IS NOT NULL AS runs",
  );
  let run: SitesContentRun | null = null;
  if (tables?.runs) {
    const { rows: [row] } = await client.query(
      `SELECT outcome, completed_at, name_prefix, reasons FROM content_run
        WHERE tenant_ref = $1 AND workload = $2 ORDER BY completed_at DESC LIMIT 1`,
      [tenant, CONTENT_WORKLOAD],
    );
    if (row) {
      run = {
        outcome: String(row.outcome),
        completedAt: iso(row.completed_at),
        namePrefix: typeof row.name_prefix === "string" && row.name_prefix ? row.name_prefix : null,
        reasons: Array.isArray(row.reasons) ? row.reasons.filter((reason): reason is string => typeof reason === "string") : [],
      };
    }
  }
  if (!tables?.items) return { held, people, run };
  const container = siteId === null ? null : `site:${siteId}`;
  const [totals, summaries] = await Promise.all([
    client.query(
      `SELECT container, count(DISTINCT item_key) AS items, sum(bytes) AS bytes, max(created_at) AS last_stored
         FROM content_item
        WHERE tenant_ref = $1 AND workload = $2 AND ($3::text IS NULL AND container LIKE 'site:%' OR container = $3::text)
        GROUP BY container`,
      [tenant, CONTENT_WORKLOAD, container],
    ),
    client.query(
      `SELECT DISTINCT ON (container) container, metadata->'summary' AS summary, created_at
         FROM content_item
        WHERE tenant_ref = $1 AND workload = $2 AND item_key = 'site/permissions'
          AND ($3::text IS NULL AND container LIKE 'site:%' OR container = $3::text)
        ORDER BY container, created_at DESC`,
      [tenant, CONTENT_WORKLOAD, container],
    ),
  ]);
  for (const row of totals.rows) {
    held.set(String(row.container).replace(/^site:/, ""), { items: num(row.items), bytes: num(row.bytes), lastStoredAt: iso(row.last_stored) });
  }
  for (const row of summaries.rows) {
    const summary = peopleFrom(row.summary, iso(row.created_at));
    if (summary) people.set(String(row.container).replace(/^site:/, ""), summary);
  }
  return { held, people, run };
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
