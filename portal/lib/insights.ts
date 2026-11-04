// Server loader for the Overview's "flagged changes this week" row (insights track A7).
// Read-only: one change feed read for the last 7 days (engine/insights/feed.mjs) and one
// read of the open alerts on the same settings, on one connection. Never calls Microsoft.
// A reader scoped to some entities counts only drift rows their entities own (issue #981).
import { loadChangeFeed } from "../../engine/insights/feed.mjs";

import { isFlagged, type FeedRow } from "@/lib/change-feed-view";
import { connect } from "@/lib/db";
import type { EntityScope } from "@/lib/principal";
import type { FlaggedThisWeek } from "@/lib/types";
import { databaseUrl, tenantRef } from "@/lib/runtime-config";

interface KeelClient {
  query(text: string, values?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
  end(): Promise<void>;
}

export const FLAGGED_WEEK_DAYS = 7;

// An alert is still open until it is resolved or suppressed (acknowledged ones still show
// under Alerts). An alert names its setting by resource_key, the same key a feed row
// carries for its object.
const OPEN_ALERT_KEYS_SQL = `
  SELECT DISTINCT resource_key FROM alert
   WHERE tenant_ref = $1 AND state IN ('open', 'reopened', 'acknowledged') AND resource_key = ANY($2::text[])`;

/** How many changes of the last 7 days a rule flagged, and how many of those an open alert
 *  already covers. Names are not needed for counting, so none are read. */
export async function getFlaggedThisWeek({ now = new Date(), scope = { central: true, entities: [] } }: { now?: Date; scope?: EntityScope } = {}): Promise<FlaggedThisWeek> {
  const client = (await connect(databaseUrl())) as KeelClient;
  try {
    const ref = tenantRef();
    const feed = (await loadChangeFeed(client, { tenantRef: ref, now, days: FLAGGED_WEEK_DAYS, scope })) as { rows: FeedRow[] };
    const flagged = feed.rows.filter(isFlagged);
    if (!flagged.length) return { flagged: 0, alerted: 0 };
    const keys = [...new Set(flagged.map((row) => row.object.key))];
    const alertedKeys = new Set((await client.query(OPEN_ALERT_KEYS_SQL, [ref, keys])).rows.map((row) => String(row.resource_key)));
    // Audit feed rows use Microsoft's target id, while their alerts use the object's
    // natural key. The durable source link also covers flags folded into baseline drift.
    const alertedSources = new Set((await client.query(`SELECT DISTINCT e.source_id FROM change_flag_event e
      JOIN alert a ON a.id=e.alert_id AND a.tenant_ref=e.tenant_ref
      WHERE e.tenant_ref=$1 AND e.source_id=ANY($2::text[]) AND e.resolved_at IS NULL
        AND e.alert_occurrence=a.occurrence AND a.state IN ('open','reopened','acknowledged')`,
    [ref, flagged.map((row) => row.id)])).rows.map((row) => String(row.source_id)));
    return { flagged: flagged.length, alerted: flagged.filter((row) => alertedKeys.has(row.object.key) || alertedSources.has(row.id)).length };
  } finally {
    await client.end();
  }
}
