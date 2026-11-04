import type { BadgeTone } from "@/components/ui/badge";
import type { VerdictTone } from "@/components/verdict";
import type { IconName } from "@/components/shell/icons";
import { setupPermissionHref } from "@/lib/backup-failure";
import type { FilterTile } from "@/lib/filter-set";
import { siteName, type SitePermissionsData } from "@/lib/site-permissions-view";

// The Owner review page (issue #964): which Microsoft 365 groups and teams, app
// registrations, enterprise apps and SharePoint sites have no working owner. The
// groups and apps come from engine/govern/ownerReview.mjs (the newest complete
// backup's owner reads and users); sites from the Sites page's own reader, with
// the same disabled and guest check for owners Keel can match to a user. Read only.

export type OwnerKind = "group" | "team" | "application" | "servicePrincipal" | "site";
export type OwnerProblem = "no-owner" | "only-disabled" | "guest-owner" | "read-failed" | "not-read" | "fine";
export type OwnerState = "working" | "disabled" | "guest" | "gone" | "unknown" | "app";

export interface ReviewOwner {
  id: string | null;
  name: string | null;
  state: OwnerState;
}

export interface OwnerCounts {
  total: number;
  working: number;
  disabled: number;
  guests: number;
  gone: number;
  unknown: number;
}

export interface OwnerReviewItem {
  kind: OwnerKind;
  id: string;
  appId: string | null;
  // The backup's key for the setting, or the site's address; record layer only.
  naturalKey: string | null;
  name: string | null;
  problem: OwnerProblem;
  owners: ReviewOwner[];
  counts: OwnerCounts;
  readFailure: { outcome: string; httpStatus: number | null; graphCode: string | null; error: string | null } | null;
  readAt: string | null;
}

export type ReadKind = "group" | "application" | "servicePrincipal";

export interface OwnerRead {
  family: string;
  // The Microsoft permission the owner read needs, for the Setup link.
  permission: string | null;
  snapshotId: string | null;
  readAt: string | null;
  failed: number;
  refused: number;
  notRead: number;
}

/** engine/govern/ownerReview.mjs ownerReview(). */
export interface EngineOwnerReview {
  generatedAt: string;
  directory: { snapshotId: string | null; readAt: string | null; complete: boolean; users: number };
  reads: Record<ReadKind, OwnerRead>;
  skipped: { microsoft: number; unknownPublisher: number; otherType: number };
  completeness: string;
  items: (Omit<OwnerReviewItem, "kind"> & { kind: Exclude<OwnerKind, "site"> })[];
}

export interface OwnerReviewData extends Omit<EngineOwnerReview, "items"> {
  items: OwnerReviewItem[];
  // Sites come from the nightly backup's owner summary; `unread` have none yet.
  sites: { readAt: string | null; checked: number; unread: number };
}

export const KIND_ORDER: OwnerKind[] = ["group", "team", "application", "servicePrincipal", "site"];

export const KIND_WORDS: Record<OwnerKind, { one: string; many: string; heading: string; icon: IconName }> = {
  group: { one: "group", many: "groups", heading: "Microsoft 365 groups", icon: "person" },
  team: { one: "team", many: "teams", heading: "Teams", icon: "person" },
  application: { one: "app registration", many: "app registrations", heading: "App registrations", icon: "link" },
  servicePrincipal: { one: "enterprise app", many: "enterprise apps", heading: "Enterprise apps", icon: "link" },
  site: { one: "site", many: "sites", heading: "SharePoint sites", icon: "link" },
};

// The words for each read kind when its owners could not be read.
const READ_WORDS: Record<ReadKind, string> = { group: "groups and teams", application: "app registrations", servicePrincipal: "enterprise apps" };

export const PROBLEMS: Record<OwnerProblem, { label: string; tone: BadgeTone; icon: IconName; rank: number }> = {
  "no-owner": { label: "No owner", tone: "urgent", icon: "x-circle", rank: 0 },
  "only-disabled": { label: "Only disabled owners", tone: "urgent", icon: "x-circle", rank: 1 },
  "guest-owner": { label: "Guest owner", tone: "soon", icon: "person", rank: 2 },
  "read-failed": { label: "Owners could not be read", tone: "soon", icon: "alert", rank: 3 },
  "not-read": { label: "Owners not read", tone: "neutral", icon: "clock", rank: 4 },
  fine: { label: "Has a working owner", tone: "fine", icon: "check-circle", rank: 5 },
};

/** No working owner: nobody, or only owners whose accounts are turned off. */
export const noWorkingOwner = (item: Pick<OwnerReviewItem, "problem">) => item.problem === "no-owner" || item.problem === "only-disabled";

// The list's filter tiles. Picking several shows items in any of them (lib/filter-set.ts).
export const OWNER_TILES: (FilterTile<OwnerReviewItem> & { label: string; small: string; icon: IconName })[] = [
  { key: "no-owner", label: "No owner", small: "Nobody owns it", icon: "x-circle", test: (item) => item.problem === "no-owner" },
  { key: "only-disabled", label: "Only disabled owners", small: "Every owner is turned off", icon: "x-circle", test: (item) => item.problem === "only-disabled" },
  { key: "guest-owner", label: "Guest owners", small: "Owned by someone outside", icon: "person", test: (item) => item.problem === "guest-owner" },
  { key: "unread", label: "Could not be read", small: "Owners are not known", icon: "alert", test: (item) => item.problem === "read-failed" || item.problem === "not-read" },
];

const count = (n: number, one: string, many: string) => `${n.toLocaleString("en-GB")} ${n === 1 ? one : many}`;

function names(owners: ReviewOwner[], state: OwnerState): string {
  const list = owners.filter((owner) => owner.state === state).map((owner) => owner.name ?? "an unnamed account");
  if (list.length <= 2) return list.join(" and ");
  return `${list.slice(0, 2).join(", ")} and ${list.length - 2} more`;
}

export function itemName(item: Pick<OwnerReviewItem, "name" | "kind">): string {
  return item.name ?? `A ${KIND_WORDS[item.kind].one} with no name`;
}

/** The problem in words, for the list row. */
export function problemWords(item: OwnerReviewItem): string {
  const { counts, owners } = item;
  switch (item.problem) {
    case "no-owner":
      if (counts.gone) return counts.gone === 1 ? "No owner: its only owner no longer exists." : `No owner: its ${counts.gone} owners no longer exist.`;
      return item.kind === "site" ? "Nobody owns it: no site admin and no member of an owners group." : "Nobody owns it.";
    case "only-disabled":
      return `Every owner's account is turned off: ${names(owners, "disabled")}.`;
    case "guest-owner":
      return counts.working === 0
        ? `Only a guest from outside your organisation owns it: ${names(owners, "guest")}.`
        : `A guest from outside your organisation is an owner: ${names(owners, "guest")}.`;
    case "read-failed":
      return item.readFailure && [401, 403].includes(item.readFailure.httpStatus ?? 0)
        ? "Owners could not be read: Microsoft refused the read."
        : "Owners could not be read: the read did not finish.";
    case "not-read":
      return "Owners were not read in the last backup.";
    case "fine":
      return counts.total ? `${count(counts.total, "owner", "owners")}, at least one working.` : "Has a working owner.";
  }
}

const ENTRA = "https://entra.microsoft.com/#view";

/** Where to fix the owners: Entra ID's owners page, or the site's page in Keel. */
export function itemLink(item: OwnerReviewItem): { label: string; href: string; external: boolean } | null {
  const id = encodeURIComponent(item.id);
  switch (item.kind) {
    case "group":
    case "team":
      return { label: "Open owners in Entra ID", href: `${ENTRA}/Microsoft_AAD_IAM/GroupDetailsMenuBlade/~/Owners/groupId/${id}`, external: true };
    case "application":
      return item.appId ? { label: "Open owners in Entra ID", href: `${ENTRA}/Microsoft_AAD_RegisteredApps/ApplicationMenuBlade/~/Owners/appId/${encodeURIComponent(item.appId)}`, external: true } : null;
    case "servicePrincipal":
      return item.appId ? { label: "Open owners in Entra ID", href: `${ENTRA}/Microsoft_AAD_IAM/ManagedAppMenuBlade/~/Owners/objectId/${id}/appId/${encodeURIComponent(item.appId)}`, external: true } : null;
    case "site":
      return { label: "Open the site", href: `/sites/${id}`, external: false };
  }
}

/** Problems first, then by name. */
export function itemsInOrder(items: OwnerReviewItem[]): OwnerReviewItem[] {
  return [...items].sort((a, b) => PROBLEMS[a.problem].rank - PROBLEMS[b.problem].rank
    || KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind)
    || itemName(a).localeCompare(itemName(b), "en-GB", { sensitivity: "base" }));
}

const EMPTY_COUNTS: OwnerCounts = { total: 0, working: 0, disabled: 0, guests: 0, gone: 0, unknown: 0 };

/**
 * Sites as review items, from the Sites reader. A site whose owners the nightly
 * backup has not read yet is counted as unread, not listed.
 */
export function siteItems(data: SitePermissionsData | null): { items: OwnerReviewItem[]; unread: number; readAt: string | null } {
  if (!data) return { items: [], unread: 0, readAt: null };
  const items: OwnerReviewItem[] = [];
  let unread = 0;
  for (const site of data.sites) {
    const people = site.people;
    if (!people) { unread += 1; continue; }
    const check = people.ownerCheck ?? null;
    const disabled = new Set(check?.disabled ?? []);
    const guests = new Set(check?.guests ?? []);
    const owners: ReviewOwner[] = people.owners.map((name) => ({ id: null, name, state: disabled.has(name) ? "disabled" : guests.has(name) ? "guest" : "working" }));
    const problem: OwnerProblem = !people.ownerCount ? "no-owner" : check?.problem ?? "fine";
    items.push({
      kind: "site",
      id: site.siteId,
      appId: null,
      naturalKey: site.webUrl,
      name: siteName(site),
      problem,
      owners,
      counts: {
        ...EMPTY_COUNTS,
        total: people.ownerCount,
        disabled: disabled.size,
        guests: guests.size,
        working: Math.max(0, people.ownerCount - disabled.size - guests.size),
      },
      readFailure: null,
      readAt: people.readAt,
    });
  }
  return { items, unread, readAt: data.contentRun?.completedAt ?? null };
}

/** The engine's review plus sites, in the order the page shows them. */
export function shapeOwnerReview(review: EngineOwnerReview, sites: SitePermissionsData | null): OwnerReviewData {
  const site = siteItems(sites);
  return {
    ...review,
    items: itemsInOrder([...(review.items as OwnerReviewItem[]), ...site.items]),
    sites: { readAt: site.readAt, checked: site.items.length, unread: site.unread },
  };
}

export interface UnreadNote {
  kind: ReadKind;
  // "Owners could not be read for apps", never "no owner".
  text: string;
  detail: string;
  fix: { label: string; href: string } | null;
}

/** For each kind whose owners could not be read (or never were), what to say and how to fix it. */
export function unreadNotes(data: Pick<OwnerReviewData, "reads">): UnreadNote[] {
  const notes: UnreadNote[] = [];
  for (const kind of ["group", "application", "servicePrincipal"] as ReadKind[]) {
    const read = data.reads[kind];
    const what = READ_WORDS[kind];
    const fix = read.permission ? { label: `Check ${read.permission} in Setup`, href: setupPermissionHref(read.permission) } : null;
    if (!read.snapshotId) {
      notes.push({ kind, text: `Owners have not been read for ${what} yet`, detail: "No backup has read them. They are read with the next full backup.", fix: null });
      continue;
    }
    if (read.refused) {
      notes.push({
        kind,
        text: `Owners could not be read for ${what}`,
        detail: `Microsoft refused the owner read for ${count(read.refused, READ_ONE[kind], what)}${read.permission ? `. Keel's backup app needs ${read.permission}` : ""}. They are not counted as having no owner.`,
        fix,
      });
    } else if (read.failed) {
      notes.push({ kind, text: `Owners could not be read for ${count(read.failed, READ_ONE[kind], what)}`, detail: "The owner read did not finish. They are not counted as having no owner, and the next backup tries again.", fix: null });
    }
  }
  return notes;
}

const READ_ONE: Record<ReadKind, string> = { group: "group or team", application: "app registration", servicePrincipal: "enterprise app" };

function list(parts: string[]): string {
  if (parts.length <= 1) return parts.join("");
  return `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}`;
}

/** The page's one sentence. */
export function ownerReviewVerdict(data: OwnerReviewData): { text: string; tone: VerdictTone; detail?: string } {
  const read = Object.values(data.reads).some((entry) => entry.snapshotId) || data.sites.checked > 0;
  if (!read) return { text: "Keel has not read any owners yet. Owners are read with the backup.", tone: "attention" };
  const without = data.items.filter(noWorkingOwner);
  const groups = without.filter((item) => item.kind === "group" || item.kind === "team").length;
  const apps = without.filter((item) => item.kind === "application" || item.kind === "servicePrincipal").length;
  const sites = without.filter((item) => item.kind === "site").length;
  const guests = data.items.filter((item) => item.problem === "guest-owner").length;
  const unread = unreadNotes(data);
  const detail = [
    guests ? `${count(guests, "has", "have")} a guest owner.` : null,
    unread.length ? `${unread.map((note) => note.text).join("; ")}.` : null,
  ].filter(Boolean).join(" ") || undefined;
  if (groups || apps || sites) {
    const parts = [groups ? count(groups, "group", "groups") : null, apps ? count(apps, "app", "apps") : null, sites ? count(sites, "site", "sites") : null].filter(Boolean) as string[];
    const total = groups + apps + sites;
    return { text: `${list(parts)} ${total === 1 ? "has" : "have"} no working owner.`, tone: "critical", detail };
  }
  if (guests) return { text: `Everything Keel checked has an owner, but ${count(guests, "is", "are")} owned by a guest.`, tone: "attention", detail: unread.length ? detail : undefined };
  if (unread.length) return { text: `No ownerless group, app or site found, but ${unread[0].text.charAt(0).toLowerCase()}${unread[0].text.slice(1)}.`, tone: "attention", detail };
  return { text: "Every group, app and site Keel checked has a working owner.", tone: "good" };
}

/** The page header's status chip. */
export function ownerReviewStatus(data: OwnerReviewData): { tone: "urgent" | "soon" | "fine"; label: string } {
  const verdict = ownerReviewVerdict(data);
  if (verdict.tone === "critical") return { tone: "urgent", label: `${count(data.items.filter(noWorkingOwner).length, "needs", "need")} an owner` };
  if (verdict.tone === "attention") return { tone: "soon", label: "Check owners" };
  return { tone: "fine", label: "All owned" };
}
