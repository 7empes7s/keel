import type { VerdictTone } from "@/components/verdict";
import { ago } from "@/lib/presentation";

// Gap 2 of the site permissions audit: each SharePoint site's stored permissions, read
// from the latest workload read of `sharepoint-site-settings`. App grants are read
// today; SharePoint groups and role assignments show as "not read yet" until the
// workload stores them as the `siteGroups` and `roleAssignments` site fields.

export const SITES_WORKLOAD = "sharepoint-site-settings";

// observed: read and stored. denied/failed: the read was refused or broke. unknown: the
// read ran but said nothing. not-read: KEEL does not read this part of a site yet.
export type PartStatus = "observed" | "denied" | "failed" | "unknown" | "not-read";

export interface PermissionPart<T> {
  status: PartStatus;
  httpStatus: number | null;
  entries: T[] | null;
}

export interface AppGrant {
  id: string | null;
  roles: string[];
  applications: { id: string | null; displayName: string | null }[];
}

// Groups and role assignments, in the shape the SharePoint read is expected to store.
// Only the parts this view shows are typed; the rest stays in the stored row.
export interface SiteGroup {
  id: string | null;
  name: string | null;
  roles: string[];
  members: number | null;
}

export interface RoleAssignment {
  id: string | null;
  name: string | null;
  kind: string | null;
  roles: string[];
}

export interface SitePermissions {
  siteId: string;
  displayName: string | null;
  webUrl: string | null;
  appGrants: PermissionPart<AppGrant>;
  groups: PermissionPart<SiteGroup>;
  roleAssignments: PermissionPart<RoleAssignment>;
}

export interface SitesRun {
  id: string;
  outcome: "complete" | "complete-empty" | "partial" | "failed" | "disabled";
  observedTo: string;
  capped?: boolean;
}

export interface SitePermissionsData {
  generatedAt: string;
  // The newest read that stored sites; null when none has.
  run: SitesRun | null;
  // The newest read of any outcome, when it is newer than `run` (it failed or was off).
  latest: SitesRun | null;
  sites: SitePermissions[];
}

type Coverage = Record<string, { status?: string; httpStatus?: number | null } | undefined>;

const text = (value: unknown): string | null => (typeof value === "string" && value.length > 0 ? value : null);
const strings = (value: unknown): string[] => (Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : []);
const record = (value: unknown): Record<string, unknown> => (value && typeof value === "object" ? value as Record<string, unknown> : {});

function part<T>(fields: Record<string, unknown>, coverage: Coverage, name: string, map: (entry: Record<string, unknown>) => T): PermissionPart<T> {
  const entry = coverage[name];
  if (!entry) return { status: "not-read", httpStatus: null, entries: null };
  const httpStatus = Number.isInteger(entry.httpStatus) ? entry.httpStatus as number : null;
  if (entry.status === "denied" || entry.status === "failed") return { status: entry.status, httpStatus, entries: null };
  if (entry.status !== "observed") return { status: "unknown", httpStatus, entries: null };
  const value = fields[name];
  return { status: "observed", httpStatus: null, entries: Array.isArray(value) ? value.map((item) => map(record(item))) : [] };
}

/** One stored site row (resource key `site:<id>`) as the view shows it. */
export function sitePermissionsFrom(resourceKey: string, fieldsValue: unknown, coverageValue: unknown): SitePermissions {
  const fields = record(fieldsValue);
  const coverage = record(coverageValue) as Coverage;
  return {
    siteId: resourceKey.replace(/^site:/, ""),
    displayName: text(fields.displayName) ?? text(fields.name),
    webUrl: text(fields.webUrl),
    appGrants: part(fields, coverage, "appPermissionGrants", (grant) => ({
      id: text(grant.id),
      roles: strings(grant.roles),
      applications: (Array.isArray(grant.applications) ? grant.applications : []).map((application) => ({
        id: text(record(application).id),
        displayName: text(record(application).displayName),
      })),
    })),
    groups: part(fields, coverage, "siteGroups", (group) => ({
      id: group.id === undefined || group.id === null ? null : String(group.id),
      name: text(group.displayName) ?? text(group.title) ?? text(group.name),
      roles: strings(group.roles),
      members: Array.isArray(group.members) ? group.members.length : null,
    })),
    roleAssignments: part(fields, coverage, "roleAssignments", (assignment) => {
      const principal = record(assignment.principal);
      return {
        id: assignment.id === undefined || assignment.id === null ? null : String(assignment.id),
        name: text(principal.displayName) ?? text(principal.title) ?? text(assignment.displayName) ?? text(assignment.loginName),
        kind: text(principal.kind) ?? text(assignment.kind),
        roles: strings(assignment.roles),
      };
    }),
  };
}

const ROLE_LABELS: Record<string, string> = {
  read: "Read",
  write: "Read and write",
  manage: "Manage lists",
  owner: "Owner",
  fullcontrol: "Full control",
};

/** A Graph or SharePoint role in words; unknown roles keep their name, capitalised. */
export function roleLabel(role: string): string {
  const known = ROLE_LABELS[role.toLowerCase()];
  if (known) return known;
  const spaced = role.replace(/[_-]+/g, " ").replace(/([a-z])([A-Z])/g, "$1 $2").toLowerCase().trim();
  return spaced ? spaced[0].toUpperCase() + spaced.slice(1) : "Unnamed role";
}

export function rolesLabel(roles: string[]): string {
  return roles.length ? roles.map(roleLabel).join(", ") : "No role recorded";
}

export function appName(grant: AppGrant): string {
  const names = grant.applications.map((application) => application.displayName ?? "An app with no name");
  return names.length ? names.join(", ") : "An app KEEL could not name";
}

const count = (value: number, one: string, many: string) => `${value.toLocaleString("en-GB")} ${value === 1 ? one : many}`;

export function siteName(site: SitePermissions): string {
  return site.displayName ?? site.webUrl?.replace(/^https?:\/\//, "") ?? "A site with no name";
}

/** The web address without its scheme, for a second line under the name. */
export function siteAddress(site: SitePermissions): string | null {
  return site.webUrl?.replace(/^https?:\/\//, "") ?? null;
}

/** Why a part has no entries, in words. Null when it was read. */
export function partProblem(status: PartStatus, what: string): string | null {
  switch (status) {
    case "observed": return null;
    case "denied": return `KEEL was not allowed to read ${what}.`;
    case "failed": return `Reading ${what} failed.`;
    case "unknown": return `Microsoft did not say what ${what} are.`;
    case "not-read": return `KEEL does not read ${what} yet.`;
  }
}

/** The one line under a site in the list. */
export function siteLine(site: SitePermissions): string {
  const apps = site.appGrants.status === "observed"
    ? (site.appGrants.entries!.length ? `${count(site.appGrants.entries!.length, "app has", "apps have")} access` : "No app access")
    : "App access unknown";
  const groupsRead = site.groups.status === "observed" || site.roleAssignments.status === "observed";
  const people = groupsRead
    ? [
      site.groups.status === "observed" ? count(site.groups.entries!.length, "group", "groups") : null,
      site.roleAssignments.status === "observed" ? count(site.roleAssignments.entries!.length, "role given", "roles given") : null,
    ].filter(Boolean).join(", ")
    : "groups and roles not read yet";
  return `${apps} · ${people}`;
}

const unreadable = (site: SitePermissions) => site.appGrants.status === "denied" || site.appGrants.status === "failed";

export function sitesVerdict(data: SitePermissionsData): { text: string; tone: VerdictTone } {
  if (!data.run) {
    if (data.latest?.outcome === "disabled") return { text: "Site permissions are not read yet: the SharePoint read is switched off until it is approved for this tenant.", tone: "attention" };
    if (data.latest) return { text: "The last SharePoint read failed, so site permissions are unknown.", tone: "critical" };
    return { text: "KEEL has not read site permissions yet.", tone: "attention" };
  }
  const failing = data.sites.filter(unreadable).length;
  if (failing) return { text: `App access on ${count(failing, "site", "sites")} could not be read.`, tone: "attention" };
  if (data.run.capped) return { text: `Only the first ${count(data.sites.length, "site was", "sites were")} read; the read stops there, so other sites are missing.`, tone: "attention" };
  if (data.latest) return { text: `The newest SharePoint read did not finish; this shows the one from ${ago(data.run.observedTo, data.generatedAt)}.`, tone: "attention" };
  if (!data.sites.length) return { text: "The last SharePoint read found no sites.", tone: "good" };
  const withApps = data.sites.filter((site) => (site.appGrants.entries?.length ?? 0) > 0).length;
  return {
    text: `${count(data.sites.length, "site", "sites")} read; ${withApps ? `${count(withApps, "has", "have")} apps with access` : "no app has access to any"}.`,
    tone: "good",
  };
}

export function siteVerdict(site: SitePermissions): { text: string; tone: VerdictTone } {
  const grants = site.appGrants;
  if (grants.status === "denied" || grants.status === "failed") return { text: "App access to this site could not be read.", tone: "attention" };
  if (grants.status !== "observed") return { text: "KEEL does not know which apps can reach this site.", tone: "attention" };
  if (!grants.entries!.length) return { text: "No app has been given access to this site.", tone: "good" };
  const full = grants.entries!.filter((grant) => grant.roles.some((role) => ["fullcontrol", "owner"].includes(role.toLowerCase()))).length;
  const base = `${count(grants.entries!.length, "app has", "apps have")} access to this site`;
  return full ? { text: `${base}; ${count(full, "has", "have")} full control.`, tone: "attention" } : { text: `${base}.`, tone: "good" };
}
