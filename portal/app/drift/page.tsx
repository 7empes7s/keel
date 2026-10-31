import { connection } from "next/server";
import { headers } from "next/headers";

import { AnonymityNote } from "@/components/anonymity-note";
import { ChangeFeed } from "@/components/baselines/change-feed";
import { ChangesViews } from "@/components/baselines/changes-views";
import { DataUnavailable } from "@/components/data-unavailable";
import { ChangeList } from "@/components/baselines/change-list";
import { PageHeader } from "@/components/page-header";
import { Verdict } from "@/components/verdict";
import { getAnonymitySetting } from "@/lib/anonymity";
import { setupStatus } from "@/lib/baselines-view";
import { getChangeFeed } from "@/lib/change-feed";
import { FEED_PERIODS, type FeedPeriod } from "@/lib/change-feed-view";
import { changesVerdict } from "@/lib/changes-view";
import { CAPABILITIES_HEADER } from "@/lib/principal";
import { displayItems, getDriftData } from "@/lib/portal-data";
import { DATA_SURFACES, requireReadAccess } from "@/lib/read";
import { getServiceChanges } from "@/lib/service-changes";
import type { DriftData, DriftRecord } from "@/lib/types";

const DESCRIPTION = "What changed in the tenant since the approved setup. Accept what was meant to happen, undo what was not.";

const FEED_DESCRIPTION = "Every change Keel found in the tenant, from backups, service reads and the Microsoft audit log, grouped the way you choose.";

const first = (value: string | string[] | undefined) => (Array.isArray(value) ? value[0] : value);

export default async function DriftPage({ searchParams }: { searchParams?: Promise<Record<string, string | string[] | undefined>> } = {}) {
  await connection();
  const access = await requireReadAccess(DATA_SURFACES.driftPage);
  const input = (await searchParams) ?? {};
  if (access.scope.central && first(input.view) === "feed") {
    const wanted = first(input.days);
    const period: FeedPeriod = FEED_PERIODS.includes(wanted as FeedPeriod) ? (wanted as FeedPeriod) : "30";
    try {
      const [feed, anonymity] = await Promise.all([getChangeFeed({ days: Number(period) }), getAnonymitySetting()]);
      return (
        <>
          <PageHeader description={FEED_DESCRIPTION} generatedAt={feed.generatedAt} section="Baselines" title="Changes" />
          <ChangesViews current="feed" />
          <AnonymityNote setting={anonymity} />
          <div data-layer="explanation">
            <ChangeFeed feed={feed} period={period} />
          </div>
        </>
      );
    } catch {
      return (
        <>
          <PageHeader description={FEED_DESCRIPTION} section="Baselines" title="Changes" />
          <ChangesViews current="feed" />
          <DataUnavailable surface="Every change" />
        </>
      );
    }
  }
  const capabilities = ((await headers()).get(CAPABILITIES_HEADER) ?? "")
    .split(" ")
    .filter((capability) => capability.length > 0);

  let data: DriftData;
  // Service settings (Exchange, SharePoint, Teams, Purview, Power Platform) are
  // tenant-wide, so only a central administrator sees their changes.
  let serviceChanges: DriftRecord[];
  try {
    [data, serviceChanges] = await Promise.all([
      getDriftData(access.scope),
      access.scope.central ? getServiceChanges() : Promise.resolve([]),
    ]);
  } catch {
    return (
      <>
        <PageHeader description={DESCRIPTION} section="Baselines" title="Changes" />
        <DataUnavailable surface="Changes" />
      </>
    );
  }

  // One list for every service: approved-setup changes and service setting changes.
  const items = [...displayItems(data.items), ...serviceChanges];
  const anonymity = await getAnonymitySetting();
  // With a list, the list draws the verdict, so it counts the same filtered changes as the tiles.
  const notice = <AnonymityNote setting={anonymity} />;
  const verdict = changesVerdict(items, data.baseline?.setAt ?? null, data.generatedAt);
  return (
    <>
      <PageHeader description={DESCRIPTION} generatedAt={data.generatedAt} section="Baselines" status={data.baseline ? setupStatus(data.baseline, data.items) : undefined} title="Changes" />
      {access.scope.central ? <ChangesViews current="open" /> : null}
      {data.baseline || serviceChanges.length ? (
        <ChangeList
          baseline={data.baseline}
          capabilities={capabilities}
          items={items}
          notice={notice}
          now={data.generatedAt}
          scopeNote={data.scope ? `You see changes to resources owned by ${data.scope.entities.join(" and ")} only. A central administrator reviews the rest of this tenant.` : null}
          summary={data.summary}
        />
      ) : (
        <>
          <Verdict
            action={data.baseline ? null : { label: "Create an approved setup", href: "/baselines/new" }}
            text={verdict.text}
            tone={verdict.tone}
          />
          {notice}
        </>
      )}
    </>
  );
}
