import { connection } from "next/server";

import { DataUnavailable } from "@/components/data-unavailable";
import { PageHeader } from "@/components/page-header";
import { ValueReportView } from "@/components/value-report-view";
import { Verdict } from "@/components/verdict";
import { DATA_SURFACES, requireReadAccess } from "@/lib/read";
import { getValueReport } from "@/lib/value-report";
import { parseEntity, parsePeriod, valueVerdict, type ValueReport } from "@/lib/value-report-view";

const DESCRIPTION = "What KEEL put back and checked, which failing controls were fixed, and how long recovery took, for a period you choose.";

// Roadmap task-100: the verified outcome and value report. Reading needs `read`; an
// entity-scoped reader is admitted and sees only what their entities own (the engine
// applies the scope before counting). The guard runs before any loader.
export default async function ReportsPage({ searchParams }: { searchParams: Promise<{ period?: string; entity?: string }> }) {
  await connection();
  const access = await requireReadAccess(DATA_SURFACES.reportsPage);
  const params = await searchParams;
  const period = parsePeriod(params.period);
  const entity = parseEntity(params.entity);
  let report: ValueReport;
  try {
    report = await getValueReport({ scope: access.scope, period, entity });
  } catch {
    return <><PageHeader description={DESCRIPTION} section="Activity" title="Value report" /><DataUnavailable surface="Value report" /></>;
  }
  const verdict = valueVerdict(report);
  return (
    <>
      <PageHeader description={DESCRIPTION} generatedAt={report.generatedAt} section="Activity" title="Value report" />
      <Verdict headline={verdict.headline} text={verdict.text} tone={verdict.tone} />
      <div data-layer="explanation">
        <ValueReportView data={{ report, period, entity }} />
      </div>
    </>
  );
}
