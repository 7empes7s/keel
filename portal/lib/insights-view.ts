// Insights (insights track A7 and A8): what changed in a period and where to start. Built
// from one change feed read (lib/change-feed.ts) and the risk flags on its rows
// (engine/insights/flags.mjs). The wording lives in engine/insights/view.mjs, so the
// weekly summary says the same thing; this module types it for the page, the UI harness
// and the tests.
import {
  changeHref as engineChangeHref, changesByService as engineChangesByService, insightsVerdict as engineVerdict,
  quietServices as engineQuietServices, startSentence as engineStartSentence, whereToStart as engineWhereToStart,
} from "../../engine/insights/view.mjs";
import {
  FEED_PERIODS, feedGroups, isFlagged,
  type ChangeFeedData, type FeedFlag, type FeedNextStep, type FeedPeriod, type FeedRow, type FeedSource,
} from "@/lib/change-feed-view";

export const INSIGHTS_PERIODS = FEED_PERIODS;
// A week is the question the page answers first.
export const DEFAULT_INSIGHTS_PERIOD: FeedPeriod = "7";

/** The period from the address, or a week. */
export function readInsightsPeriod(value: string | null | undefined): FeedPeriod {
  return INSIGHTS_PERIODS.includes(value as FeedPeriod) ? (value as FeedPeriod) : DEFAULT_INSIGHTS_PERIOD;
}

export type InsightsTone = "urgent" | "soon" | "fine";

/**
 * The page's one sentence: how many changes, and how many need a look.
 * "143 changes in the last 7 days; 4 need a look." / "…; none flagged." When the feed
 * hit its limit the count is a floor, so it says "At least". The weekly summary says the
 * same sentence (engine/insights/view.mjs).
 */
export function insightsVerdict(feed: Pick<ChangeFeedData, "rows" | "truncated">, period: FeedPeriod): { text: string; tone: InsightsTone } {
  return engineVerdict(feed, period) as { text: string; tone: InsightsTone };
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
  // What to do next, or how it was dealt with (engine/insights/nextSteps.mjs).
  nextStep: FeedNextStep | null;
  // Flagged and nobody has dealt with it yet.
  needsLook: boolean;
}

/** Where a change is listed: Every change, for the same period, found by its name. */
export function changeHref(row: FeedRow, period: FeedPeriod): string {
  return engineChangeHref(row, period);
}

/** One change as a sentence: who did what to which object, and when. Never an id. */
export function startSentence(row: FeedRow, now: string): string {
  return engineStartSentence(row, now);
}

/**
 * Where to start: flagged changes first, those still needing a look before those someone
 * dealt with, each most severe then newest; then changes to critical or high kinds that
 * no rule flagged, most urgent then newest.
 */
export function whereToStart(rows: readonly FeedRow[], period: FeedPeriod, now: string): { flagged: StartItem[]; watch: StartItem[] } {
  return engineWhereToStart([...rows], period, now) as { flagged: StartItem[]; watch: StartItem[] };
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
  return engineChangesByService([...rows], period) as ShapeBar[];
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
  return engineQuietServices([...rows]) as string[];
}

/** The record layer: the window read, the counts per source and whether the limit hit. */
export function insightsRecord(feed: Pick<ChangeFeedData, "rows" | "since" | "until" | "truncated">): {
  window: string; sources: Record<FeedSource, number>; limitNote: string | null;
} {
  const sources: Record<FeedSource, number> = { drift: 0, service: 0, backup: 0, audit: 0 };
  for (const row of feed.rows) sources[row.source] = (sources[row.source] ?? 0) + 1;
  return {
    window: `${feed.since} to ${feed.until}`,
    sources,
    limitNote: feed.truncated ? `Showing the newest ${feed.rows.length.toLocaleString("en-GB")} changes.` : null,
  };
}
