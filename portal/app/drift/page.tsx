import { connection } from "next/server";
import { headers } from "next/headers";

import { DataUnavailable } from "@/components/data-unavailable";
import { DriftTable } from "@/components/drift-table";
import { PageHeader } from "@/components/page-header";
import { BaselineContext } from "@/components/baseline-context";
import { Verdict } from "@/components/verdict";
import { changesVerdict } from "@/lib/changes-view";
import { CAPABILITIES_HEADER } from "@/lib/principal";
import { displayItems, getDriftData } from "@/lib/portal-data";
import { DATA_SURFACES, requireReadAccess } from "@/lib/read";
import type { DriftData } from "@/lib/types";

const DESCRIPTION = "What changed in the tenant since the active baseline, and what to do about each change.";

export default async function DriftPage() {
  await connection();
  const access = await requireReadAccess(DATA_SURFACES.driftPage);
  const capabilities = ((await headers()).get(CAPABILITIES_HEADER) ?? "")
    .split(" ")
    .filter((capability) => capability.length > 0);

  let data: DriftData;
  try {
    data = await getDriftData(access.scope);
  } catch {
    return (
      <>
        <PageHeader description={DESCRIPTION} section="Changes" title="Changes" />
        <DataUnavailable surface="Changes" />
      </>
    );
  }

  const verdict = changesVerdict(data.items, data.baseline?.setAt ?? null, data.generatedAt);
  return (
    <>
      <PageHeader description={DESCRIPTION} generatedAt={data.generatedAt} section="Changes" title="Changes" />
      <Verdict
        action={data.baseline ? null : { label: "Set a baseline", href: "/baselines" }}
        text={verdict.text}
        tone={verdict.tone}
      />
      {data.baseline ? (
        <div data-layer="explanation">
          {data.scope ? (
            <p className="capture-note">
              You see changes to resources owned by {data.scope.entities.join(" and ")} only. Changes to
              other resources in this tenant are reviewed by a central administrator.
            </p>
          ) : null}
          <BaselineContext baseline={data.baseline} now={data.generatedAt} />
          <DriftTable capabilities={capabilities} items={displayItems(data.items)} now={data.generatedAt} summary={data.summary} />
        </div>
      ) : null}
    </>
  );
}
