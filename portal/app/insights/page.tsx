import { connection } from "next/server";

import { AnonymityNote } from "@/components/anonymity-note";
import { DataUnavailable } from "@/components/data-unavailable";
import { InsightsBody } from "@/components/insights/insights-body";
import { PageHeader } from "@/components/page-header";
import { Verdict } from "@/components/verdict";
import { getAnonymitySetting } from "@/lib/anonymity";
import { getChangeFeed } from "@/lib/change-feed";
import { TENANT_WIDE_ONLY, readInsightsPeriod } from "@/lib/insights-view";
import { DATA_SURFACES, requireReadAccess } from "@/lib/read";

const DESCRIPTION = "What changed in the tenant in a period, which changes to look at first, and where the changes came from.";

const first = (value: string | string[] | undefined) => (Array.isArray(value) ? value[0] : value);

// Insights (insights track A7 and A8). The same read access as Changes › Every change: the
// change feed is tenant-wide, so a reader with entity-scoped access only gets a plain
// sentence and no feed read. One feed read per request; no per-row queries.
export default async function InsightsPage({ searchParams }: { searchParams?: Promise<Record<string, string | string[] | undefined>> } = {}) {
  await connection();
  const access = await requireReadAccess(DATA_SURFACES.insightsPage);
  if (!access.scope.central) {
    return (
      <>
        <PageHeader description={DESCRIPTION} section="Dashboards" title="Insights" />
        <Verdict text={TENANT_WIDE_ONLY} tone="neutral" />
      </>
    );
  }
  const period = readInsightsPeriod(first(((await searchParams) ?? {}).days));
  try {
    const [feed, anonymity] = await Promise.all([getChangeFeed({ days: Number(period) }), getAnonymitySetting()]);
    return (
      <>
        <PageHeader description={DESCRIPTION} generatedAt={feed.generatedAt} section="Dashboards" title="Insights" />
        <AnonymityNote setting={anonymity} />
        <InsightsBody feed={feed} period={period} />
      </>
    );
  } catch {
    return (
      <>
        <PageHeader description={DESCRIPTION} section="Dashboards" title="Insights" />
        <DataUnavailable surface="Insights" />
      </>
    );
  }
}
