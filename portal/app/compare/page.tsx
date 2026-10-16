import { connection } from "next/server";

import { CompareView } from "@/components/compare-view";
import { DataUnavailable } from "@/components/data-unavailable";
import { PageHeader } from "@/components/page-header";
import { Verdict } from "@/components/verdict";
import { quickComparisons } from "@/lib/baselines-view";
import { getCompareData } from "@/lib/compare";
import { compareInputFrom, compareVerdict, type CompareData } from "@/lib/compare-view";
import { getBaselinesData } from "@/lib/portal-data";
import { DATA_SURFACES, requireReadAccess } from "@/lib/read";

const DESCRIPTION = "Put two backups side by side, or two tenants: what was there before, what is there after.";

type SearchParams = Record<string, string | string[] | undefined>;

// Wave 2 CMP: comparing needs `read`, tenant-wide; the guard runs before any loader.
// Comparing is a GET: nothing on this page can change anything.
export default async function ComparePage({ searchParams }: { searchParams?: Promise<SearchParams> } = {}) {
  await connection();
  await requireReadAccess(DATA_SURFACES.comparePage);
  const input = compareInputFrom((await searchParams) ?? {});
  let data: CompareData;
  try {
    data = await getCompareData(input);
  } catch {
    return <><PageHeader description={DESCRIPTION} section="Baselines" title="Compare" /><DataUnavailable surface="Compare" /></>;
  }
  // The approved setup only adds a one-click pair; without it the page works the same.
  const active = await getBaselinesData().then((baselines) => baselines.baselines.find((baseline) => baseline.active) ?? null, () => null);
  const verdict = compareVerdict(data);
  return (
    <>
      <PageHeader description={DESCRIPTION} generatedAt={data.generatedAt} section="Baselines" title="Compare" />
      <Verdict text={verdict.text} tone={verdict.tone} />
      <div data-layer="explanation">
        <CompareView data={data} quick={quickComparisons(data.tenants.find((tenant) => tenant.own), active)} />
      </div>
    </>
  );
}
