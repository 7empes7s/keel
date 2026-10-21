import { connection } from "next/server";

import { DataUnavailable } from "@/components/data-unavailable";
import { PageHeader } from "@/components/page-header";
import { DownloadMenu } from "@/components/value-report/download-menu";
import { ValueReportPage } from "@/components/value-report/value-report-page";
import { DATA_SURFACES, requireReadAccess } from "@/lib/read";
import { getReportOwners, getValueReport } from "@/lib/value-report";
import { parseEntity, resolvePeriod, valueStatus, type ValueReport } from "@/lib/value-report-view";

const DESCRIPTION = "What Keel put back and checked, which security checks were fixed, and how fast recovery was, for a period you choose.";

// Value report (portal audit, pick A: dashboard of charts). Reading needs `read`; an
// entity-scoped reader is admitted and sees only what their entities own (the engine
// applies the scope before counting). The guard runs before any loader.
export default async function ReportsPage({ searchParams }: { searchParams: Promise<{ period?: string; entity?: string }> }) {
  await connection();
  const access = await requireReadAccess(DATA_SURFACES.reportsPage);
  const params = await searchParams;
  const period = resolvePeriod(params.period, new Date());
  const entity = parseEntity(params.entity);
  let report: ValueReport;
  try {
    report = await getValueReport({ scope: access.scope, period, entity });
  } catch {
    return <><PageHeader description={DESCRIPTION} section="Reports" title="Value report" /><DataUnavailable surface="Value report" /></>;
  }
  const owners = await getReportOwners(access.scope);
  return (
    <>
      <PageHeader actions={<DownloadMenu />} description={DESCRIPTION} generatedAt={report.generatedAt} section="Reports" status={valueStatus(report)} title="Value report" />
      <ValueReportPage data={{ report, period, entity, owners }} />
    </>
  );
}
