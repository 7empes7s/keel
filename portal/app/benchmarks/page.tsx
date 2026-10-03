import { connection } from "next/server";

import { ComplianceReport } from "@/components/compliance-report";
import { DataUnavailable } from "@/components/data-unavailable";
import { PageHeader } from "@/components/page-header";
import { Verdict } from "@/components/verdict";
import { complianceVerdict } from "@/lib/compliance-view";
import { getComplianceData } from "@/lib/portal-data";
import { DATA_SURFACES, requireReadAccess } from "@/lib/read";
import type { ComplianceData } from "@/lib/types";

const DESCRIPTION = "How the tenant measures against the controls KEEL checks, what each finding rests on, and where backups are kept.";

// Roadmap task-87: control findings against the baseline, linked to changes, backups
// and pending restores only when they rest on the same collection.
export default async function BenchmarksPage() {
  await connection();
  await requireReadAccess(DATA_SURFACES.benchmarksPage);

  let data: ComplianceData;
  try {
    data = await getComplianceData();
  } catch {
    return (
      <>
        <PageHeader description={DESCRIPTION} section="Changes" title="Compliance" />
        <DataUnavailable surface="Compliance" />
      </>
    );
  }
  const verdict = complianceVerdict(data);

  return (
    <>
      <PageHeader description={DESCRIPTION} generatedAt={data.generatedAt} section="Changes" title="Compliance" />
      <Verdict text={verdict.text} tone={verdict.tone} />
      <div data-layer="explanation">
        <ComplianceReport data={data} now={data.generatedAt} />
      </div>
    </>
  );
}
