// Insights (insights track A7 and A8): what changed in a period and where to start. Built
// from one change feed read (lib/change-feed.ts) and the risk flags on its rows
// (engine/insights/flags.mjs). Pure, so the page, the UI harness and the tests share it.
import { SERVICES as FEED_SERVICES } from "../../engine/insights/taxonomy.mjs";
import {
  FEED_PERIODS, feedFlags, feedGroups, feedObjectName, feedPersonName, isFlagged,
  type ChangeFeedData, type FeedFlag, type FeedPeriod, type FeedPriority, type FeedRow, type FeedSource,
} from "@/lib/change-feed-view";
import { ago } from "@/lib/presentation";

export const INSIGHTS_PERIODS = FEED_PERIODS;
// A week is the question the page answers first.
export const DEFAULT_INSIGHTS_PERIOD: FeedPeriod = "7";

// What a reader with entity-scoped access sees instead of the page.
export const TENANT_WIDE_ONLY = "Insights covers every change in the tenant, so it needs tenant-wide read access. A central administrator can see it.";

/** The period from the address, or a week. */
export function readInsightsPeriod(value: string | null | undefined): FeedPeriod {
  return INSIGHTS_PERIODS.includes(value as FeedPeriod) ? (value as FeedPeriod) : DEFAULT_INSIGHTS_PERIOD;
}

const plural = (count: number, one: string, many: string) => `${count.toLocaleString("en-GB")} ${count === 1 ? one : many}`;

export type InsightsTone = "urgent" | "soon" | "fine";

/**
 * The page's one sentence: how many changes, and how many need a look.
 * "143 changes in the last 7 days; 4 need a look." / "…; none flagged." When the feed
 * hit its limit the count is a floor, so it says "At least".
 */
export function insightsVerdict(feed: Pick<ChangeFeedData, "rows" | "truncated">, period: FeedPeriod): { text: string; tone: InsightsTone } {
  const span = `in the last ${period} days`;
  if (!feed.rows.length) return { text: `No changes ${span}.`, tone: "fine" };
  const flagged = feed.rows.filter(isFlagged);
  const total = `${feed.truncated ? "At least " : ""}${plural(feed.rows.length, "change", "changes")}`;
  const sentence = (rest: string) => `${total.charAt(0).toUpperCase()}${total.slice(1)} ${span}; ${rest}.`;
  if (!flagged.length) return { text: sentence("none flagged"), tone: "fine" };
  const critical = flagged.some((row) => feedFlags(row).some((flag) => flag.severity === "critical"));
  return { text: sentence(`${flagged.length.toLocaleString("en-GB")} ${flagged.length === 1 ? "needs" : "need"} a look`), tone: critical ? "urgent" : "soon" };
}

export interface StartItem {
  id: string;
  // Flagged: a rule knows what it does. Watch: an unflagged change to a critical or high kind.
  reason: "flagged" | "watch";
  tone: "urgent" | "soon";
  // "Amara Okafor changed Block legacy auth, a Conditional Access policy, 2 hours ago."
  sentence: string;
  flags: FeedFlag[];
  objectName: string;
  who: string;
  when: string;
  occurredAt: string;
  href: string;
}

const SEVERITY_RANK: Record<FeedFlag["severity"], number> = { critical: 0, high: 1 };
const PRIORITY_RANK: Record<FeedPriority, number> = { critical: 0, high: 1, normal: 2, low: 3 };
const worstFlag = (row: FeedRow) => Math.min(...feedFlags(row).map((flag) => SEVERITY_RANK[flag.severity] ?? 2));
const newestFirst = (a: FeedRow, b: FeedRow) => b.occurredAt.localeCompare(a.occurredAt);

const VERBS: Record<FeedRow["change"], string> = { added: "added", modified: "changed", removed: "removed" };

function kindWords(typeName: string): string {
  // "a Conditional Access policy", "an app registration": a name that starts with a proper
  // noun keeps its capitals, as feedObjectName does.
  const [head, next] = typeName.split(" ");
  const common = /^[A-Z][a-z]+$/.test(head ?? "") && !/^[A-Z]/.test(next ?? "");
  const words = common ? typeName.charAt(0).toLowerCase() + typeName.slice(1) : typeName;
  return `${/^[aeiou]/i.test(words) ? "an" : "a"} ${words}`;
}

// "Sharing settings (SharePoint sharing settings)": a plural kind takes no article.
const objectWithKind = (name: string, typeName: string) => (/settings$/i.test(typeName) ? `${name} (${typeName})` : `${name}, ${kindWords(typeName)},`);

/** Where a change is listed: Every change, for the same period, found by its name. */
export function changeHref(row: FeedRow, period: FeedPeriod): string {
  const params = new URLSearchParams({ view: "feed" });
  if (period !== "30") params.set("days", period);
  params.set("q", feedObjectName(row).toLowerCase());
  return `/changes?${params.toString()}`;
}

/** One change as a sentence: who did what to which object, and when. Never an id. */
export function startSentence(row: FeedRow, now: string): string {
  const name = feedObjectName(row);
  const who = row.person ? feedPersonName(row) : "Someone Keel could not name";
  return `${who} ${VERBS[row.change]} ${objectWithKind(name, row.typeName)} ${ago(row.occurredAt, now)}.`;
}

function startItem(row: FeedRow, reason: StartItem["reason"], period: FeedPeriod, now: string): StartItem {
  const flags = feedFlags(row);
  const critical = reason === "flagged" ? flags.some((flag) => flag.severity === "critical") : row.priority === "critical";
  return {
    id: row.id, reason, tone: critical ? "urgent" : "soon", sentence: startSentence(row, now), flags,
    objectName: feedObjectName(row), who: feedPersonName(row), when: ago(row.occurredAt, now), occurredAt: row.occurredAt,
    href: changeHref(row, period),
  };
}

/**
 * Where to start: flagged changes first, most severe then newest; then changes to
 * critical or high kinds that no rule flagged, most urgent then newest.
 */
export function whereToStart(rows: readonly FeedRow[], period: FeedPeriod, now: string): { flagged: StartItem[]; watch: StartItem[] } {
  const flagged = rows.filter(isFlagged).sort((a, b) => worstFlag(a) - worstFlag(b) || newestFirst(a, b));
  const watch = rows
    .filter((row) => !isFlagged(row) && (row.priority === "critical" || row.priority === "high"))
    .sort((a, b) => PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority] || newestFirst(a, b));
  return {
    flagged: flagged.map((row) => startItem(row, "flagged", period, now)),
    watch: watch.map((row) => startItem(row, "watch", period, now)),
  };
}

export interface ShapeBar { key: string; label: string; count: number; flagged: number; href: string }

/** Every UTC day of the period, oldest first, with how many changes each had. */
export function changesByDay(rows: readonly FeedRow[], period: FeedPeriod, now: string): { day: string; count: number }[] {
  const counts = new Map(feedGroups(rows, "day").map((group) => [group.key, group.count]));
  const today = Date.parse(`${now.slice(0, 10)}T00:00:00Z`);
  const days = Number(period);
  return Array.from({ length: days }, (_, index) => {
    const day = new Date(today - (days - 1 - index) * 86_400_000).toISOString().slice(0, 10);
    return { day, count: counts.get(day) ?? 0 };
  });
}

/** Changes by service, the busiest first; each opens Every change for the period, by service. */
export function changesByService(rows: readonly FeedRow[], period: FeedPeriod): ShapeBar[] {
  return feedGroups(rows, "service")
    .map((group) => ({
      key: group.key,
      label: group.label,
      count: group.count,
      flagged: group.rows.filter(isFlagged).length,
      href: `/changes?${new URLSearchParams({ view: "feed", ...(period !== "30" ? { days: period } : {}), group: "service" }).toString()}`,
    }))
    .sort((a, b) => b.count - a.count);
}

/** The people or apps who made the most changes, as the page names them (code names when
 *  names are hidden). Changes Keel could not tie to anyone are left out. */
export function topPeople(rows: readonly FeedRow[], limit = 5): { key: string; name: string; app: boolean; count: number; flagged: number }[] {
  return feedGroups(rows, "person")
    .filter((group) => group.key !== "unknown")
    .slice(0, limit)
    .map((group) => ({
      key: group.key,
      name: group.label,
      app: group.rows[0]?.person?.kind === "servicePrincipal",
      count: group.count,
      flagged: group.rows.filter(isFlagged).length,
    }));
}

/** Services Keel reads that had no change in the period. */
export function quietServices(rows: readonly FeedRow[]): string[] {
  const busy = new Set(rows.map((row) => row.service).filter(Boolean));
  return (FEED_SERVICES as readonly string[]).filter((service) => !busy.has(service));
}

/** The record layer: the window read, the counts per source and whether the limit hit. */
export function insightsRecord(feed: Pick<ChangeFeedData, "rows" | "since" | "until" | "truncated">): {
  window: string; sources: Record<FeedSource, number>; limitNote: string | null;
} {
  const sources: Record<FeedSource, number> = { drift: 0, service: 0, audit: 0 };
  for (const row of feed.rows) sources[row.source] = (sources[row.source] ?? 0) + 1;
  return {
    window: `${feed.since} to ${feed.until}`,
    sources,
    limitNote: feed.truncated ? `Showing the newest ${feed.rows.length.toLocaleString("en-GB")} changes.` : null,
  };
}
