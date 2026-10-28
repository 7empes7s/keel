import { connection } from "next/server";
import { headers } from "next/headers";

import { AnonymityNote } from "@/components/anonymity-note";
import { DataUnavailable } from "@/components/data-unavailable";
import { ChangeList } from "@/components/baselines/change-list";
import { PageHeader } from "@/components/page-header";
import { Verdict } from "@/components/verdict";
import { getAnonymitySetting } from "@/lib/anonymity";
import { setupStatus } from "@/lib/baselines-view";
import { changesVerdict } from "@/lib/changes-view";
import { CAPABILITIES_HEADER } from "@/lib/principal";
import { displayItems, getDriftData } from "@/lib/portal-data";
import { DATA_SURFACES, requireReadAccess } from "@/lib/read";
import { getServiceChanges } from "@/lib/service-changes";
import type { DriftData, DriftRecord } from "@/lib/types";

const DESCRIPTION = "What changed in the tenant since the approved setup. Accept what was meant to happen, undo what was not.";

export default async function DriftPage() {
  await connection();
  const access = await requireReadAccess(DATA_SURFACES.driftPage);
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
  const verdict = changesVerdict(items, data.baseline?.setAt ?? null, data.generatedAt);
  return (
    <>
      <PageHeader description={DESCRIPTION} generatedAt={data.generatedAt} section="Baselines" status={data.baseline ? setupStatus(data.baseline, data.items) : undefined} title="Changes" />
      <Verdict
        action={data.baseline ? null : { label: "Create an approved setup", href: "/baselines/new" }}
        text={verdict.text}
        tone={verdict.tone}
      />
      <AnonymityNote setting={anonymity} />
      {data.baseline || serviceChanges.length ? (
        <div data-layer="explanation">
          <ChangeList
            baseline={data.baseline}
            capabilities={capabilities}
            items={items}
            now={data.generatedAt}
            scopeNote={data.scope ? `You see changes to resources owned by ${data.scope.entities.join(" and ")} only. A central administrator reviews the rest of this tenant.` : null}
            summary={data.summary}
          />
        </div>
      ) : null}
    </>
  );
}
