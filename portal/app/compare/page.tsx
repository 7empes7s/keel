import { connection } from "next/server";

import { CompareView } from "@/components/compare-view";
import { DataUnavailable } from "@/components/data-unavailable";
import { PageHeader } from "@/components/page-header";
import { Verdict } from "@/components/verdict";
import { getCompareData } from "@/lib/compare";
import { compareInputFrom, compareVerdict, type CompareData } from "@/lib/compare-view";
import { DATA_SURFACES, requireReadAccess } from "@/lib/read";

const DESCRIPTION = "Put two snapshots side by side, or two tenants: settings, workload settings and stored content.";

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
  const verdict = compareVerdict(data);
  return (
    <>
      <PageHeader description={DESCRIPTION} generatedAt={data.generatedAt} section="Baselines" title="Compare" />
      <Verdict text={verdict.text} tone={verdict.tone} />
      <div data-layer="explanation">
        <CompareView data={data} />
      </div>
    </>
  );
}
