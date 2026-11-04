// Server loader for the Overview's "flagged changes this week" row (insights track A7).
// Read-only: one change feed read for the last 7 days (engine/insights/feed.mjs), which
// carries each row's next step. Never calls Microsoft. Tenant-wide, so callers admit
// central readers only.
import { loadChangeFeed } from "../../engine/insights/feed.mjs";

import { isFlagged, needsLook, type FeedRow } from "@/lib/change-feed-view";
import { connect } from "@/lib/db";
import type { FlaggedThisWeek } from "@/lib/types";
import { databaseUrl, tenantRef } from "@/lib/runtime-config";

interface KeelClient {
  query(text: string, values?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
  end(): Promise<void>;
}

export const FLAGGED_WEEK_DAYS = 7;

/** How many changes of the last 7 days a rule flagged, and how many of those still need a
 *  look (needsLook, the rule Insights and Every change count with). */
export async function getFlaggedThisWeek({ now = new Date() }: { now?: Date } = {}): Promise<FlaggedThisWeek> {
  const client = (await connect(databaseUrl())) as KeelClient;
  try {
    const ref = tenantRef();
    const feed = (await loadChangeFeed(client, { tenantRef: ref, now, days: FLAGGED_WEEK_DAYS })) as { rows: FeedRow[] };
    return { flagged: feed.rows.filter(isFlagged).length, needsLook: feed.rows.filter(needsLook).length };
  } finally {
    await client.end();
  }
}
