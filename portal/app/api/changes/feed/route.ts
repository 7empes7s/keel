import { dataResponse } from "@/lib/api-response";
import { getChangeFeed } from "@/lib/change-feed";
import { feedGroups, feedScopeNote, readFeedGrouping } from "@/lib/change-feed-view";
import { DATA_SURFACES, guardedRead } from "@/lib/read";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const number = (value: string | null) => (value === null || value === "" ? undefined : Number(value));

// GET /api/changes/feed?by=day|type|service|priority|person&days=30&limit=500: every
// change, drift and audit event in the tenant as one row each, newest first, and the
// same rows grouped. Read-only. An entity-scoped reader gets only drift rows for settings
// their entities own, and `scope` and `scopeNote` say so.
export const GET = guardedRead(
  DATA_SURFACES.changeFeedApi,
  async (request, access) => {
    const params = new URL(request.url).searchParams;
    const by = params.get("by");
    if (by !== null && readFeedGrouping(by) !== by) {
      return Response.json({ error: "unknown_grouping", groupings: ["day", "type", "service", "priority", "person"] }, { status: 400, headers: { "cache-control": "no-store" } });
    }
    const grouping = readFeedGrouping(by);
    return dataResponse(async () => {
      const feed = await getChangeFeed({ days: number(params.get("days")), limit: number(params.get("limit")), scope: access.scope });
      return { ...feed, scopeNote: feedScopeNote(feed.scope), by: grouping, total: feed.rows.length, groups: feedGroups(feed.rows, grouping).map(({ rows, ...group }) => ({ ...group, rowIds: rows.map((row) => row.id) })) };
    });
  },
);
