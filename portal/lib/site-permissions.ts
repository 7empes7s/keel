// Gap 2 of the site permissions audit: the Sites pages' loader. Read-only: it reads the
// stored SharePoint workload reads and never calls Microsoft. Callers check `read` first.
import { classifyNamedOwners, loadOwnerDirectory } from "../../engine/govern/ownerReview.mjs";
import { connect } from "@/lib/db";

import { databaseUrl, tenantRef } from "@/lib/runtime-config";
import { idNames } from "@/lib/saved-names";
import {
  SITES_WORKLOAD, sitePermissionsFrom, siteName,
  type OwnerCheck, type PermissionExposure, type PeopleSummary, type SiteBackup, type SitePermissionsData, type SitesContentRun, type SitesRun,
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
  // One after another: both share one connection, and pg warns (pg 9 will refuse)
  // when a second query is sent before the first has answered.
  const storedRow = await runs(STORED);
  const newestRow = await runs(null);
  const run = runFrom(storedRow);
  const newest = runFrom(newestRow);
  const latest = newest && newest.id !== run?.id ? newest : null;
  const backups = await loadSiteBackups(client, tenant, siteId);
  if (!run) return { generatedAt: now.toISOString(), run: null, latest, sites: [], contentRun: backups.run, tenantSharing: null, ...(backups.oneDrives.length ? { oneDrives: backups.oneDrives } : {}) };

  const { rows } = await client.query(
    `SELECT resource_key, fields, field_coverage FROM workload_observation
      WHERE collection_id = $1 AND ($2::text IS NULL AND resource_key LIKE 'site:%' OR resource_key = 'site:' || $2::text OR resource_key = 'tenant')`,
    [run.id, siteId],
  );
  const tenantRow = rows.find((row) => row.resource_key === "tenant");
  const sharing = (tenantRow?.field_coverage as Record<string, { status?: string }> | undefined)?.sharingCapability?.status === "observed"
    ? (tenantRow?.fields as Record<string, unknown>).sharingCapability : null;
  const sites = rows
    .filter((row) => row.resource_key !== "tenant")
    .map((row) => {
      const site = sitePermissionsFrom(String(row.resource_key), row.fields, row.field_coverage);
      return {
        ...site, backup: backups.held.get(site.siteId) ?? null, people: backups.people.get(site.siteId) ?? null,
        // Each site is compared with the tenant default it was read with.
        sharing: { ...site.sharing, tenant: typeof sharing === "string" ? sharing : null },
      };
    })
    .sort((a, b) => siteName(a).localeCompare(siteName(b), "en-GB", { sensitivity: "base" }) || a.siteId.localeCompare(b.siteId));
  return {
    generatedAt: now.toISOString(), run, latest, sites,
    oneDrives: backups.oneDrives,
    contentRun: backups.run, tenantSharing: typeof sharing === "string" ? sharing : null,
  };
}

const num = (value: unknown) => (Number.isFinite(Number(value)) ? Number(value) : 0);
const iso = (value: unknown) => new Date(value as string | Date).toISOString();

function peopleFrom(value: unknown, readAt: string): PeopleSummary | null {
  const summary = value && typeof value === "object" ? value as Record<string, unknown> : null;
  if (!summary || !Array.isArray(summary.groups)) return null;
  return {
    exposure: summary.exposure && typeof summary.exposure === "object" ? summary.exposure as PermissionExposure : null,
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
  const oneDrives: { name: string; exposure: PermissionExposure | null }[] = [];
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
  if (!tables?.items) return { held, people, run, oneDrives };
  if (siteId === null) {
    const drives = await client.query(`SELECT container, metadata FROM (
      SELECT DISTINCT ON (container, item_key) container, metadata FROM content_item
      WHERE tenant_ref = $1 AND workload = 'onedrive' AND metadata->>'kind' = 'drive-record'
      ORDER BY container, item_key, created_at DESC
    ) latest WHERE coalesce(metadata->>'deleted', 'false') <> 'true'`, [tenant]);
    const seenLinks = new Map<string, Set<string>>();
    const byDrive = new Map<string, { name: string; exposure: PermissionExposure | null }>();
    for (const row of drives.rows) {
      const meta = row.metadata as { ownerName?: string; exposure?: PermissionExposure };
      const key = String(row.container);
      let drive = byDrive.get(key);
      if (!drive) {
        drive = { name: meta.ownerName ? `${meta.ownerName}’s OneDrive` : "OneDrive", exposure: { checked: true, everyone: [], links: { anyone: { view: 0, edit: 0 }, organisation: { view: 0, edit: 0 }, specificPeople: { view: 0, edit: 0 }, unknown: 0 } } };
        byDrive.set(key, drive);
      }
      if (!meta.exposure) drive.exposure!.checked = false;
      if (drive.exposure && meta.exposure) {
        drive.exposure.everyone!.push(...(meta.exposure.everyone ?? []));
        if (meta.exposure.linkGrants) {
          const seen = seenLinks.get(key) ?? new Set<string>();
          seenLinks.set(key, seen);
          for (const link of meta.exposure.linkGrants) {
            if (seen.has(link.id)) continue;
            seen.add(link.id);
            const scope = ({ anonymous: "anyone", organization: "organisation", users: "specificPeople" } as const)[link.scope as "anonymous" | "organization" | "users"];
            if (scope && (link.type === "view" || link.type === "edit")) drive.exposure.links[scope][link.type]++;
            else if (scope) drive.exposure.links[scope].unknown = (drive.exposure.links[scope].unknown ?? 0) + 1;
            else drive.exposure.links.unknown++;
          }
        } else {
          for (const scope of ["anyone", "organisation", "specificPeople"] as const) for (const access of ["view", "edit"] as const) drive.exposure.links[scope][access] += meta.exposure.links[scope][access];
        }
      }
    }
    oneDrives.push(...byDrive.values());
  }
  const container = siteId === null ? null : `site:${siteId}`;
  // One after another, on the one connection (see loadSitePermissions).
  const totals = await client.query(
    `SELECT container, count(DISTINCT item_key) AS items, sum(bytes) AS bytes, max(created_at) AS last_stored
       FROM content_item
      WHERE tenant_ref = $1 AND workload = $2 AND ($3::text IS NULL AND container LIKE 'site:%' OR container = $3::text)
      GROUP BY container`,
    [tenant, CONTENT_WORKLOAD, container],
  );
  const summaries = await client.query(
    `SELECT DISTINCT ON (container) container, metadata->'summary' AS summary, created_at
       FROM content_item
      WHERE tenant_ref = $1 AND workload = $2 AND item_key = 'site/permissions'
        AND ($3::text IS NULL AND container LIKE 'site:%' OR container = $3::text)
      ORDER BY container, created_at DESC`,
    [tenant, CONTENT_WORKLOAD, container],
  );
  for (const row of totals.rows) {
    held.set(String(row.container).replace(/^site:/, ""), { items: num(row.items), bytes: num(row.bytes), lastStoredAt: iso(row.last_stored) });
  }
  for (const row of summaries.rows) {
    const summary = peopleFrom(row.summary, iso(row.created_at));
    if (summary) people.set(String(row.container).replace(/^site:/, ""), summary);
  }
  return { held, people, run, oneDrives };
}

export async function getSitePermissions(siteId: string | null = null, now: Date = new Date()): Promise<SitePermissionsData> {
  const client = (await connect(databaseUrl())) as KeelClient;
  try {
    const data = await withAppNames(client, tenantRef(), await loadSitePermissions(client, { tenantRef: tenantRef(), siteId, now }));
    return withOwnerChecks(data, await loadOwnerDirectory(client, { tenantRef: tenantRef() }) as OwnerDirectory);
  } finally {
    await client.end();
  }
}

/** engine/govern/ownerReview.mjs loadOwnerDirectory(). */
export interface OwnerDirectory {
  snapshotId: string | null;
  complete: boolean;
  users: Map<string, { name: string | null; disabled: boolean; guest: boolean }>;
}

/**
 * Each site's owners checked against the users in the newest backup: owners whose
 * account is turned off, and guests. Owners are known to a site only by name, so a
 * name counts only when exactly one user has it. Nothing changes without users.
 */
export function withOwnerChecks(data: SitePermissionsData, directory: OwnerDirectory): SitePermissionsData {
  if (!directory.users.size) return data;
  return {
    ...data,
    sites: data.sites.map((site) => {
      if (!site.people?.ownerCount) return site;
      const check = classifyNamedOwners({ names: site.people.owners, count: site.people.ownerCount }, directory) as OwnerCheck & { matched: number };
      return { ...site, people: { ...site.people, ownerCheck: { problem: check.problem, disabled: check.disabled, guests: check.guests } } };
    }),
  };
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
