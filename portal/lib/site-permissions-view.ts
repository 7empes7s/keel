import type { BadgeTone } from "@/components/ui/badge";
import type { VerdictTone } from "@/components/verdict";
import { ago } from "@/lib/presentation";
import { bytesWords } from "@/lib/record-values";

// The Sites pages: each SharePoint site with its backup, the apps that can reach it, its
// owners, groups and guests. Sites and app grants come from the daily
// `sharepoint-site-settings` read; backup, groups, owners and guests from the nightly
// content backup of sites (its stored items and the summary beside `site/permissions`).

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

// Who can reach a site, from the summary the nightly content backup saves beside its
// `site/permissions` item (engine/content/sharepointSites.mjs permissionsSummary).
export interface PermissionExposure {
  checked?: boolean;
  linkGrants?: { id: string; scope: string; type: string }[];
  everyone: { audience: string; roles: string[] }[] | null;
  links: { anyone: { view: number; edit: number; unknown?: number }; organisation: { view: number; edit: number; unknown?: number }; specificPeople: { view: number; edit: number; unknown?: number }; unknown: number };
}
export interface PeopleSummary {
  exposure?: PermissionExposure | null;
  // The site takes its roles from its parent site, so group roles are not its own.
  inherits: boolean;
  groups: { name: string | null; members: number | null; roles: string[] | null }[];
  owners: string[];
  ownerCount: number;
  people: number;
  guests: number;
  sharingLinks: number;
  uniqueLists: number;
  // When the backup stored this summary.
  readAt: string;
  // Owners matched by name to a user in the newest backup (engine/govern/ownerReview.mjs
  // classifyNamedOwners): which are turned off or guests. Absent when not checked.
  ownerCheck?: OwnerCheck | null;
}

export interface OwnerCheck {
  // "only-disabled": every owner is a user whose account is turned off.
  problem: "only-disabled" | "guest-owner" | null;
  disabled: string[];
  guests: string[];
}

// What the content backup holds for the site (container `site:<id>`).
export interface SiteBackup {
  items: number;
  bytes: number;
  lastStoredAt: string;
}

export interface SitePermissions {
  siteId: string;
  displayName: string | null;
  // The site's short name (its address part), which the backup scope also matches.
  name: string | null;
  webUrl: string | null;
  appGrants: PermissionPart<AppGrant>;
  backup: SiteBackup | null;
  people: PeopleSummary | null;
  // The site's own sharing setting (SharePoint admin centre), and the tenant's default
  // it is compared with. `value` is set only when the read observed it.
  sharing: SiteSharing;
}

export interface SiteSharing {
  status: PartStatus;
  value: string | null;
  // The tenant's own setting, which caps every site; null when it was not read.
  tenant: string | null;
  // The read is approved but the host names no PnP config for it.
  unconfigured?: boolean;
}

// The newest nightly backup of SharePoint sites (content_run, workload sharepoint-sites).
export interface SitesContentRun {
  outcome: string;
  completedAt: string;
  namePrefix: string | null;
  reasons: string[];
}

export interface SitesRun {
  id: string;
  outcome: "complete" | "complete-empty" | "partial" | "failed" | "disabled";
  observedTo: string;
  capped?: boolean;
}

export interface SitePermissionsData {
  oneDrives?: { name: string; exposure: PermissionExposure | null }[];
  generatedAt: string;
  // The newest read that stored sites; null when none has.
  run: SitesRun | null;
  // The newest read of any outcome, when it is newer than `run` (it failed or was off).
  latest: SitesRun | null;
  sites: SitePermissions[];
  // The newest content backup of sites; null when none has run.
  contentRun?: SitesContentRun | null;
  // The tenant's own sharing setting (SharePoint admin centre), when it was read.
  tenantSharing?: string | null;
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
    name: text(fields.name),
    webUrl: text(fields.webUrl),
    appGrants: part(fields, coverage, "appPermissionGrants", (grant) => ({
      id: text(grant.id),
      roles: strings(grant.roles),
      applications: (Array.isArray(grant.applications) ? grant.applications : []).map((application) => ({
        id: text(record(application).id),
        displayName: text(record(application).displayName),
      })),
    })),
    backup: null,
    people: null,
    sharing: sharingFrom(fields, coverage),
  };
}

// Before the per-site sharing read is switched on, the engine records the field as
// unknown with no answer from Microsoft: that is "not read yet", not a gap in a read.
function sharingFrom(fields: Record<string, unknown>, coverage: Coverage): SiteSharing {
  const entry = coverage.sharingCapability as { status?: string; operation?: string | null; reason?: string } | undefined;
  const value = text(fields.sharingCapability);
  if (entry?.status === "observed" && value) return { status: "observed", value, tenant: null };
  if (entry?.status === "denied" || entry?.status === "failed") return { status: entry.status, value: null, tenant: null };
  const notRead = !entry || !entry.operation || /not live-qualified|not read/i.test(entry.reason ?? "");
  const unconfigured = /powershellConfigs\.sharepoint/.test(entry?.reason ?? "");
  return { status: notRead ? "not-read" : "unknown", value: null, tenant: null, ...(unconfigured ? { unconfigured } : {}) };
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


// ---------------------------------------------------------------------------
// Each site's standing, as badges a person can scan: backup, app access, people and
// guests. Problems sort first everywhere (`siteRank`).

export interface SiteStatus {
  key: string;
  label: string;
  tone: BadgeTone;
  // One plain sentence; shown under the badge on the site's page.
  detail: string | null;
  // A raw error from Microsoft, shown only when someone expands it.
  error?: string | null;
  fix?: { label: string; href: string } | null;
}

const TONE_RANK: Record<BadgeTone, number> = { urgent: 0, soon: 1, low: 2, neutral: 3, fine: 4 };

/** True when the newest backup's name filter takes this site in (no filter: every site). */
export function inBackupScope(site: SitePermissions, run: SitesContentRun | null | undefined): boolean {
  const prefix = run?.namePrefix?.toLowerCase();
  return !prefix || [site.displayName, site.name].some((name) => name?.toLowerCase().startsWith(prefix));
}

// The backup names a site that was not fully read as "<name>: N part(s) not fully read, ...".
function siteReason(site: SitePermissions, run: SitesContentRun | null | undefined): string | null {
  const label = `${site.displayName ?? site.webUrl ?? site.siteId}: `;
  const reason = run?.reasons.find((entry) => entry.startsWith(label));
  return reason ? reason.slice(label.length) : null;
}

export function backupStatus(site: SitePermissions, run: SitesContentRun | null | undefined): SiteStatus & { at: string | null } {
  const held = site.backup?.lastStoredAt ?? null;
  if (run && !inBackupScope(site, run)) {
    return { key: "outside", label: "Not backed up", tone: "soon", at: held, detail: `The backup only takes sites whose names start with ${run.namePrefix}.` };
  }
  if (!run && !site.backup) return { key: "none", label: "Not backed up yet", tone: "soon", at: null, detail: "The nightly backup of sites has not run yet." };
  if (run?.outcome === "failed") {
    return { key: "failed", label: "Backup failed", tone: "urgent", at: held, detail: "The last nightly backup of sites failed, so this site's backup may be out of date.", error: run.reasons[0] ?? null };
  }
  const reason = siteReason(site, run);
  if (reason) return { key: "partial", label: "Partly backed up", tone: "soon", at: run?.completedAt ?? held, detail: "Some parts of this site were not read last night.", error: reason };
  if (!site.backup) return { key: "none", label: "Not backed up yet", tone: "soon", at: null, detail: "No backup holds this site yet. The next nightly backup reads it." };
  return { key: "ok", label: "Backed up", tone: "fine", at: run?.completedAt ?? held, detail: null };
}

const FULL_ROLES = ["fullcontrol", "owner"];
export const fullControlApps = (site: SitePermissions) => (site.appGrants.entries ?? []).filter((grant) => grant.roles.some((role) => FULL_ROLES.includes(role.toLowerCase()))).length;

export function appStatus(site: SitePermissions): SiteStatus {
  const grants = site.appGrants;
  if (grants.status !== "observed") {
    return { key: "unknown", label: "Unknown", tone: grants.status === "denied" || grants.status === "failed" ? "soon" : "neutral", detail: partProblem(grants.status, "app access") };
  }
  const total = grants.entries!.length;
  if (!total) return { key: "none", label: "No apps", tone: "fine", detail: "No app has been given access to this site." };
  const full = fullControlApps(site);
  return full
    ? { key: "full", label: `${count(total, "app", "apps")}, ${full} full control`, tone: "soon", detail: `${count(full, "app has", "apps have")} full control: it can read, change and delete everything on the site.` }
    : { key: "some", label: count(total, "app", "apps"), tone: "low", detail: `${count(total, "app has", "apps have")} been given access to this site.` };
}

/** Owners, groups and people, or why they are not known. */
export function peopleStatus(site: SitePermissions, run: SitesContentRun | null | undefined): SiteStatus {
  const people = site.people;
  if (people) {
    if (!people.ownerCount) return { key: "no-owner", label: "No owner", tone: "urgent", detail: "Nobody owns this site: no site admin and no member of an owners group." };
    const check = people.ownerCheck;
    if (check?.problem === "only-disabled") {
      return { key: "disabled-owners", label: "Only disabled owners", tone: "urgent", detail: `Every owner's account is turned off (${check.disabled.slice(0, 3).join(", ")}), so nobody can manage this site.` };
    }
    if (check?.problem === "guest-owner") {
      return { key: "guest-owner", label: count(check.guests.length, "guest owner", "guest owners"), tone: "soon", detail: `${check.guests.slice(0, 3).join(", ")} ${check.guests.length === 1 ? "is a guest" : "are guests"} from outside your organisation.` };
    }
    return { key: "owned", label: count(people.ownerCount, "owner", "owners"), tone: "fine", detail: null };
  }
  if (run && !inBackupScope(site, run)) return { key: "not-read", label: "Not read", tone: "neutral", detail: "Owners, groups and guests are read with the backup, which skips this site." };
  const reason = siteReason(site, run);
  if (reason && /\bpermissions: denied\b/.test(reason)) {
    return {
      key: "denied", label: "Not allowed", tone: "soon", error: reason,
      detail: "Microsoft refused KEEL's Collector app. It needs the SharePoint permission Sites.FullControl.All with admin consent.",
      fix: { label: "Check app permissions", href: "/setup" },
    };
  }
  return { key: "pending", label: "Read tonight", tone: "neutral", detail: "Owners, groups and guests are read with the nightly backup and show after the next one." };
}

/** Guests and sharing links, from the site's own groups. Null when not read. */
export function externalStatus(site: SitePermissions): SiteStatus | null {
  const people = site.people;
  if (!people) return null;
  if (people.guests) {
    return { key: "guests", label: count(people.guests, "guest", "guests"), tone: "soon", detail: `${count(people.guests, "person from outside your organisation has", "people from outside your organisation have")} access${people.sharingLinks ? `, and ${count(people.sharingLinks, "sharing link exists", "sharing links exist")}` : ""}.` };
  }
  if (people.sharingLinks) return { key: "links", label: count(people.sharingLinks, "sharing link", "sharing links"), tone: "low", detail: `${count(people.sharingLinks, "file or folder is", "files or folders are")} shared by link. No guests are members.` };
  return { key: "none", label: "No guests", tone: "fine", detail: "Nobody from outside your organisation is in this site's groups." };
}

/** Groups and people in a few words: "3 groups · 12 people". */
export function groupsWords(site: SitePermissions): string | null {
  const people = site.people;
  if (!people) return null;
  return `${count(people.groups.length, "group", "groups")} · ${count(people.people, "person", "people")}`;
}

export function backupWords(site: SitePermissions): string | null {
  return site.backup ? `${count(site.backup.items, "content item", "content items")} · ${bytesWords(site.backup.bytes)}` : null;
}

/** 0 is the most urgent. A site's rank is its worst badge. */
export function siteRank(site: SitePermissions, run: SitesContentRun | null | undefined): number {
  const tones = [backupStatus(site, run), appStatus(site), peopleStatus(site, run), externalStatus(site), sharingStatus(site), exposureStatus(site.people?.exposure)].filter(Boolean).map((status) => TONE_RANK[status!.tone]);
  return Math.min(...tones);
}

/** Problems first, then by name. */
export function sitesInOrder(sites: SitePermissions[], run: SitesContentRun | null | undefined): SitePermissions[] {
  return [...sites].sort((a, b) => siteRank(a, run) - siteRank(b, run) || siteName(a).localeCompare(siteName(b), "en-GB", { sensitivity: "base" }));
}

// The list's tiles. Picking several shows sites in any of them (lib/filter-set.ts).
export const SITE_TILES = [
  { key: "everyone", label: "Open to everyone", icon: "person", test: (site: SitePermissions) => Boolean(site.people?.exposure?.everyone?.length) },
  { key: "anyone-links", label: "Anyone links", icon: "link", test: (site: SitePermissions) => anyoneLinks(site.people?.exposure) > 0 },
  { key: "attention", label: "Need attention", icon: "alert", test: (site: SitePermissions, run: SitesContentRun | null | undefined) => siteRank(site, run) <= TONE_RANK.soon },
  { key: "unprotected", label: "Not backed up", icon: "backup", test: (site: SitePermissions, run: SitesContentRun | null | undefined) => ["outside", "none", "failed"].includes(backupStatus(site, run).key) },
  { key: "apps", label: "Apps with access", icon: "link", test: (site: SitePermissions) => (site.appGrants.entries?.length ?? 0) > 0 },
  { key: "guests", label: "Guests or links", icon: "person", test: (site: SitePermissions) => Boolean(site.people && (site.people.guests || site.people.sharingLinks)) },
  { key: "wider", label: "Shared wider than default", icon: "link", test: (site: SitePermissions) => sharingStatus(site).key === "wider" },
  { key: "no-owner", label: "No owner", icon: "x-circle", test: (site: SitePermissions) => site.people?.ownerCount === 0 || site.people?.ownerCheck?.problem === "only-disabled" },
] as const;

const SHARING_WORDS: Record<string, string> = {
  disabled: "Only people in your organisation",
  existingexternalusersharingonly: "Existing guests only",
  externalusersharingonly: "Guests who sign in",
  externaluserandguestsharing: "Anyone, including links that need no sign-in",
};

// Short badge labels, from closed to open.
const SHARING_SHORT: Record<string, string> = {
  disabled: "Organisation only",
  existingexternalusersharingonly: "Existing guests",
  externalusersharingonly: "New and existing guests",
  externaluserandguestsharing: "Anyone with the link",
};
const SHARING_ORDER = ["disabled", "existingexternalusersharingonly", "externalusersharingonly", "externaluserandguestsharing"];

/** The tenant's sharing setting in words. */
export function tenantSharingWords(value: string | null | undefined): string | null {
  if (!value) return null;
  return SHARING_WORDS[value.toLowerCase()] ?? roleLabel(value);
}

/** How open a sharing setting is: 0 (organisation only) to 3 (anyone); -1 when unknown. */
export function sharingLevel(value: string | null | undefined): number {
  return value ? SHARING_ORDER.indexOf(value.toLowerCase()) : -1;
}

/** A sharing setting as a short badge label. */
export function sharingShort(value: string | null | undefined): string | null {
  if (!value) return null;
  return SHARING_SHORT[value.toLowerCase()] ?? roleLabel(value);
}

/**
 * The site's own sharing setting against the tenant's default. More open than the
 * default is urgent: SharePoint is meant to cap a site at the tenant's setting, so it
 * needs a person. Anyone-links are worth a look even when the tenant allows them.
 */
export function sharingStatus(site: SitePermissions): SiteStatus {
  const { status, value, tenant } = site.sharing;
  if (status === "denied") return { key: "unknown", label: "Not allowed", tone: "soon", detail: "Microsoft refused to show this site's sharing setting to KEEL." };
  if (status === "failed") return { key: "unknown", label: "Read failed", tone: "soon", detail: "Reading this site's sharing setting failed." };
  if (status === "not-read" && site.sharing.unconfigured) {
    return { key: "not-read", label: "Not set up", tone: "soon", detail: "The sharing read is approved, but the server has no SharePoint sign-in set up for it, so it did not run." };
  }
  if (status === "not-read") return { key: "not-read", label: "Not read yet", tone: "neutral", detail: "KEEL starts reading each site's own sharing setting once that read is approved for this tenant." };
  if (status !== "observed" || !value) return { key: "unknown", label: "Unknown", tone: "neutral", detail: "Microsoft did not list this site's sharing setting." };
  const level = sharingLevel(value);
  const tenantLevel = sharingLevel(tenant);
  const label = sharingShort(value)!;
  const words = tenantSharingWords(value);
  const tenantWords = tenantSharingWords(tenant);
  if (level >= 0 && tenantLevel >= 0 && level > tenantLevel) {
    return { key: "wider", label, tone: "urgent", detail: `More open than your organisation's default (${tenantWords}). This site allows: ${words}.` };
  }
  const compared = tenantLevel < 0 || level < 0 ? "" : level < tenantLevel ? ` Stricter than your organisation's default (${tenantWords}).` : " Same as your organisation's default.";
  if (level === 3) return { key: "anyone", label, tone: "soon", detail: `Files can be shared with links that work without signing in.${compared}` };
  if (level === 0) return { key: "internal", label, tone: "fine", detail: `Only people in your organisation can be given access.${compared}` };
  return { key: "guests", label, tone: "low", detail: `This site allows: ${words}.${compared}` };
}

export const anyoneLinks = (exposure: PermissionExposure | null | undefined) => exposure ? exposure.links.anyone.view + exposure.links.anyone.edit + (exposure.links.anyone.unknown ?? 0) : 0;
const everyoneEdits = (exposure: PermissionExposure) => exposure.everyone?.some((grant) => grant.roles.some((role) => /^(edit|contribute|full control|design|write|owner|fullcontrol)$/i.test(role)));
export function exposureStatus(exposure: PermissionExposure | null | undefined): SiteStatus {
  if (!exposure) return { key: "unchecked", label: "Not checked in this backup", tone: "neutral", detail: "Everyone grants and link scope were not checked in this backup." };
  const links = anyoneLinks(exposure);
  const open = Boolean(exposure.everyone?.length);
  const edit = everyoneEdits(exposure);
  const facts = [open ? `Everyone in the company can ${edit ? "edit" : "access"} this site.` : null, links ? `${count(links, "link anyone can open", "links anyone can open")}.` : null].filter(Boolean);
  if (facts.length) return { key: "open", label: open ? "Open to everyone" : "Anyone links", tone: edit || links ? "urgent" : "soon", detail: facts.join(" ") + (exposure.checked === false ? " Some access was not checked in this backup." : "") };
  if (exposure.everyone === null || exposure.checked === false || exposure.links.unknown > 0) return { key: "unchecked", label: "Not checked in this backup", tone: "neutral", detail: "Everyone grants or link scope were not fully checked in this backup." };
  return { key: "checked", label: "No Everyone grants or anyone links", tone: "fine", detail: "No Everyone grants or anyone links found in the permissions read." };
}

export function everyoneStatus(exposure: PermissionExposure | null | undefined): SiteStatus {
  if (!exposure) return exposureStatus(null);
  const status = exposureStatus({ ...exposure, links: { ...exposure.links, anyone: { view: 0, edit: 0 }, unknown: 0 } });
  return status.key === "checked" ? { ...status, label: "No Everyone grants", detail: "No Everyone grants found on this site." } : status;
}

export function linkScopeStatus(exposure: PermissionExposure | null | undefined): SiteStatus {
  if (!exposure) return exposureStatus(null);
  const { links } = exposure;
  const words = (scope: { view: number; edit: number; unknown?: number }) => `${scope.view} view, ${scope.edit} edit${scope.unknown ? `, ${scope.unknown} unknown access` : ""}`;
  return { key: "links", label: links.unknown ? "Scope not fully checked" : count(anyoneLinks(exposure), "anyone link", "anyone links"), tone: anyoneLinks(exposure) ? "urgent" : links.unknown ? "neutral" : "fine", detail: `Anyone: ${words(links.anyone)}. Organisation: ${words(links.organisation)}. Specific people: ${words(links.specificPeople)}. Unknown scope: ${links.unknown}.` };
}

export function sitesVerdict(data: SitePermissionsData): { text: string; tone: VerdictTone } {
  const exposures = [...data.sites.map((site) => site.people?.exposure), ...(data.oneDrives ?? []).map((drive) => drive.exposure)];
  const open = exposures.filter((exposure) => exposure?.everyone?.length).length;
  const anyone = exposures.filter((exposure) => anyoneLinks(exposure) > 0).length;
  const incomplete = exposures.some((exposure) => !exposure || exposure.everyone === null || exposure.checked === false || exposure.links.unknown > 0);
  const findings = [
    open ? `${count(open, "site or OneDrive is", "sites or OneDrives are")} open to everyone in the company` : null,
    anyone ? `${count(anyone, open ? "has" : "site or OneDrive has", open ? "have" : "sites or OneDrives have")} links anyone can open` : null,
  ].filter(Boolean);
  if (open || anyone) return { text: `${findings.join("; ")}.${incomplete ? " Others were not checked." : ""}`, tone: anyone || exposures.some((e) => e && everyoneEdits(e)) || data.sites.some((site) => site.people?.ownerCount === 0 || sharingStatus(site).key === "wider") || data.contentRun?.outcome === "failed" ? "critical" : "attention" };
  if (!data.run) {
    if (data.latest?.outcome === "disabled") return { text: "Sites are not read yet: the SharePoint read is switched off until it is approved for this tenant.", tone: "attention" };
    if (data.latest) return { text: "The last SharePoint read failed, so the list of sites is unknown.", tone: "critical" };
    return { text: "KEEL has not read your SharePoint sites yet.", tone: "attention" };
  }
  const run = data.contentRun ?? null;
  if (run?.outcome === "failed") return { text: "Last night's backup of sites failed. Sites may be missing recent changes.", tone: "critical" };
  const sites = data.sites;
  const noOwner = sites.filter((site) => site.people?.ownerCount === 0).length;
  const disabledOwners = sites.filter((site) => site.people?.ownerCount && site.people.ownerCheck?.problem === "only-disabled").length;
  const unprotected = sites.filter((site) => ["outside", "none"].includes(backupStatus(site, run).key)).length;
  const partial = sites.filter((site) => backupStatus(site, run).key === "partial").length;
  const unreadable = sites.filter((site) => site.appGrants.status === "denied" || site.appGrants.status === "failed").length;
  const wider = sites.filter((site) => sharingStatus(site).key === "wider").length;
  const problems = [
    noOwner ? `${count(noOwner, "site has", "sites have")} no owner` : null,
    disabledOwners ? `${count(disabledOwners, "site has", "sites have")} only disabled owners` : null,
    wider ? `${count(wider, "site is", "sites are")} shared more widely than your organisation's default` : null,
    unprotected ? `${count(unprotected, "site is", "sites are")} not backed up` : null,
    partial ? `${count(partial, "site was", "sites were")} only partly backed up` : null,
    unreadable ? `app access on ${count(unreadable, "site", "sites")} could not be read` : null,
  ].filter(Boolean) as string[];
  if (problems.length) {
    const text = problems.slice(0, 2).join(", and ");
    return { text: `${text[0].toUpperCase()}${text.slice(1)}.`, tone: noOwner || disabledOwners || wider ? "critical" : "attention" };
  }
  if (data.run.capped) return { text: `Only the first ${count(sites.length, "site was", "sites were")} read; the read stops there, so other sites are missing.`, tone: "attention" };
  if (data.latest) return { text: `The newest SharePoint read did not finish; this shows the one from ${ago(data.run.observedTo, data.generatedAt)}.`, tone: "attention" };
  if (!sites.length) return { text: "The last SharePoint read found no sites.", tone: "good" };
  if (incomplete) return { text: "Everyone grants and link scope were not checked in this backup for some sites or OneDrives.", tone: "attention" };
  const withApps = sites.filter((site) => (site.appGrants.entries?.length ?? 0) > 0).length;
  return {
    text: `All ${count(sites.length, "site is", "sites are")} backed up and owned${withApps ? `; ${count(withApps, "has", "have")} apps with access` : ""}.`,
    tone: "good",
  };
}

export function siteVerdict(site: SitePermissions, run: SitesContentRun | null | undefined): { text: string; tone: VerdictTone } {
  const exposure = exposureStatus(site.people?.exposure);
  if (exposure.key === "open") return { text: exposure.detail!, tone: exposure.tone === "urgent" || site.people?.ownerCount === 0 || sharingStatus(site).key === "wider" || backupStatus(site, run).key === "failed" ? "critical" : "attention" };
  const backup = backupStatus(site, run);
  if (backup.key === "failed") return { text: "The last backup of this site failed, so it may be missing recent changes.", tone: "critical" };
  const people = peopleStatus(site, run);
  const external = externalStatus(site);
  const full = fullControlApps(site);
  const sharing = sharingStatus(site);
  const problems = [
    people.key === "no-owner" ? "nobody owns this site" : null,
    people.key === "disabled-owners" ? "every owner's account is turned off" : null,
    people.key === "guest-owner" ? "a guest from outside your organisation owns it" : null,
    sharing.key === "wider" ? "it is shared more widely than your organisation's default" : null,
    ["outside", "none"].includes(backup.key) ? "it is not backed up" : null,
    backup.key === "partial" ? "parts of it were not backed up last night" : null,
    full ? `${count(full, "app has", "apps have")} full control` : null,
    external?.key === "guests" ? `${count(site.people!.guests, "guest has", "guests have")} access` : null,
    site.appGrants.status === "denied" || site.appGrants.status === "failed" ? "its app access could not be read" : null,
  ].filter(Boolean) as string[];
  if (problems.length) {
    const text = problems.slice(0, 2).join(", and ");
    return { text: `${text[0].toUpperCase()}${text.slice(1)}.`, tone: people.key === "no-owner" || people.key === "disabled-owners" || sharing.key === "wider" ? "critical" : "attention" };
  }
  if (people.key !== "owned") return { text: "Backed up. Owners, groups and guests are not known yet.", tone: "attention" };
  if (exposure.key === "unchecked") return { text: "Everyone grants and link scope were not checked in this backup.", tone: "attention" };
  const apps = site.appGrants.entries?.length ?? 0;
  return { text: apps ? `Backed up and owned, with no guests; ${count(apps, "app has", "apps have")} access.` : "Backed up and owned, with no guests and no apps. Nothing needs you here.", tone: "good" };
}
