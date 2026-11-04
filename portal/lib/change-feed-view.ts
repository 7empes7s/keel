// The change feed (insights track, IN-FEED) as the portal shows it: every change, drift
// and audit event as one row (engine/insights/feed.mjs), grouped by day, type, service,
// priority or person. Pure, so server pages, the API and client lists share it.
import { FEED_GROUPINGS, groupChangeFeed } from "../../engine/insights/feedGroups.mjs";
import { feedFlags as engineFlags, feedObjectName as engineObjectName, feedPersonName as enginePersonName } from "../../engine/insights/view.mjs";
import { csvLine } from "@/lib/csv";

export type FeedSource = "drift" | "service" | "backup" | "audit";
export type FeedGrouping = "day" | "type" | "service" | "priority" | "person";
export type FeedPriority = "critical" | "high" | "normal" | "low";

export interface FeedPerson {
  kind: "user" | "servicePrincipal";
  // A Microsoft object id: shown only under Technical details.
  id: string;
  // The name from the backup, a code name when names are hidden, or null when unknown.
  name: string | null;
  pseudonym?: boolean;
}

// What a change does, when a rule knows it (engine/insights/flags.mjs): "Turned off:
// Require MFA for admins." Names in the sentence are as the page shows them.
export interface FeedFlag {
  key: string;
  severity: "critical" | "high";
  sentence: string;
}

export interface FeedRow {
  id: string;
  source: FeedSource;
  occurredAt: string;
  day: string;
  type: string;
  // The kind the row is listed as (an Intune antivirus policy is a Defender endpoint
  // security policy); the same as `type` for every other row.
  kind?: string;
  // What this object is ("Built-in admin role"); kindName names its kind ("Admin role").
  typeName: string;
  kindName?: string;
  service: string | null;
  priority: FeedPriority;
  priorityReason: string | null;
  object: { key: string; name: string | null; status: "found" | "deleted" | "unknown" };
  change: "added" | "modified" | "removed";
  // The audit log's own words for what happened ("Add member to group"), if any.
  activity: string | null;
  person: FeedPerson | null;
  // Empty when no rule flags the change; absent on rows read before flags existed.
  flags?: FeedFlag[];
}

export interface FeedGroup {
  key: string;
  label: string;
  count: number;
  priorities: Record<FeedPriority, number>;
  rows: FeedRow[];
}

export interface ChangeFeedData {
  generatedAt: string;
  since: string;
  until: string;
  rows: FeedRow[];
  // More rows exist in the window than were read.
  truncated: boolean;
  // Set when the reader is scoped to some entities: the rows are only drift rows for
  // settings those entities own (issue #981).
  scope?: { central: false; entities: string[] } | null;
}

/** What an entity-scoped reader of the change feed is told is left out, in Open changes'
 *  words. Never a count of the rows left out. */
export function feedScopeNote(scope: ChangeFeedData["scope"]): string | null {
  if (!scope) return null;
  return `You see changes to settings owned by ${scope.entities.join(" and ")} only. A central administrator reviews tenant-wide changes (service settings, sites and the audit log).`;
}

// The periods the page offers, in days; 30 is the default.
export const FEED_PERIODS = ["7", "30", "90"] as const;
export type FeedPeriod = (typeof FEED_PERIODS)[number];

export const FEED_GROUPING_KEYS = FEED_GROUPINGS as readonly FeedGrouping[];

export const FEED_GROUPING_LABELS: Record<FeedGrouping, string> = {
  day: "Day",
  type: "Type",
  service: "Service",
  priority: "Priority",
  person: "Who",
};

export const PRIORITY_WORDS: Record<FeedPriority, string> = { critical: "Critical", high: "High", normal: "Normal", low: "Low" };

export const SOURCE_WORDS: Record<FeedSource, { label: string; about: string }> = {
  drift: { label: "Approved setup", about: "Found by a backup: differs from the approved setup" },
  service: { label: "Service read", about: "Found by a service settings read: differs from the read before" },
  backup: { label: "Content backup", about: "Found by a content backup: who can reach a site or OneDrive differs from the backup before" },
  audit: { label: "Audit log", about: "Recorded by the Microsoft audit log" },
};

export const CHANGE_WORDS: Record<FeedRow["change"], string> = { added: "Added", modified: "Changed", removed: "Removed" };

/** A grouping from the address, or the default (by day). */
export function readFeedGrouping(value: string | null | undefined): FeedGrouping {
  return FEED_GROUPING_KEYS.includes(value as FeedGrouping) ? (value as FeedGrouping) : "day";
}

export function feedGroups(rows: readonly FeedRow[], by: FeedGrouping): FeedGroup[] {
  return groupChangeFeed(rows, by) as FeedGroup[];
}

/** The object as a reader names it: never an id. */
export function feedObjectName(row: Pick<FeedRow, "object" | "typeName">): string {
  return engineObjectName(row);
}

export function feedPersonName(row: Pick<FeedRow, "person">): string {
  return enginePersonName(row);
}

/** "Today", "Yesterday" or the date in words, for a day group (UTC days). */
export function feedDayLabel(day: string, now: string): string {
  const today = now.slice(0, 10);
  const yesterday = new Date(Date.parse(`${today}T00:00:00Z`) - 86_400_000).toISOString().slice(0, 10);
  if (day === today) return "Today";
  if (day === yesterday) return "Yesterday";
  const date = new Date(`${day}T00:00:00Z`);
  return Number.isNaN(date.valueOf()) ? day : date.toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
}

/** The label a group shows: days in words, everything else as the engine names it. */
export function feedGroupLabel(group: Pick<FeedGroup, "key" | "label">, by: FeedGrouping, now: string): string {
  return by === "day" ? feedDayLabel(group.key, now) : group.label;
}

/** The row's flags, most severe first (the engine sends them so). */
export function feedFlags(row: Pick<FeedRow, "flags">): FeedFlag[] {
  return engineFlags(row) as FeedFlag[];
}

export const isFlagged = (row: Pick<FeedRow, "flags">): boolean => feedFlags(row).length > 0;

/** The address value of the Flagged filter: on or off. */
export function readFlaggedOnly(value: string | null | undefined): boolean {
  return value === "1";
}

/** One line per row, names as shown on the page (code names when names are hidden). */
export function feedCsv(rows: readonly FeedRow[]): string {
  const header = csvLine(["When (UTC)", "Service", "Type", "Name", "Change", "What happened", "What it does", "Who", "Priority", "Found by"]);
  const lines = rows.map((row) => csvLine([
    row.occurredAt, row.service ?? "Other", row.typeName, feedObjectName(row), CHANGE_WORDS[row.change],
    row.activity ?? "", feedFlags(row).map((flag) => flag.sentence).join(" "), feedPersonName(row), PRIORITY_WORDS[row.priority], SOURCE_WORDS[row.source].label,
  ]));
  return [header, ...lines].join("\n") + "\n";
}

/** The plain one-line summary of a feed: how many changes, how many need a look first,
 *  and how many a rule flagged for what they do. */
export function feedSummary(rows: readonly FeedRow[]): { text: string; tone: "urgent" | "soon" | "fine" } {
  if (!rows.length) return { text: "No changes found in this period.", tone: "fine" };
  const critical = rows.filter((row) => row.priority === "critical").length;
  const high = rows.filter((row) => row.priority === "high").length;
  const flagged = rows.filter(isFlagged).length;
  const total = `${rows.length} ${rows.length === 1 ? "change" : "changes"}`;
  const flags = flagged ? `, ${flagged} flagged for what ${flagged === 1 ? "it does" : "they do"}` : "";
  if (critical) return { text: `${total}, ${critical} critical${flags}: look at those first.`, tone: "urgent" };
  if (high) return { text: `${total}, ${high} high priority${flags}.`, tone: "soon" };
  return { text: `${total}, none critical or high priority.`, tone: "fine" };
}
