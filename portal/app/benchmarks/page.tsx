import { connection } from "next/server";

import { CompliancePage, ExportEvidence } from "@/components/compliance/compliance-page";
import { DataUnavailable } from "@/components/data-unavailable";
import { PageHeader } from "@/components/page-header";
import { complianceCounts, complianceStatus } from "@/lib/compliance-view";
import { getComplianceData } from "@/lib/portal-data";
import { DATA_SURFACES, requireReadAccess } from "@/lib/read";
import type { ComplianceData } from "@/lib/types";

const DESCRIPTION = "Which security controls pass on this tenant, what each result rests on, and where backups are kept.";

// Compliance (portal audit, pick A on a desktop and B on a phone): controls grouped by
// service with count tiles that filter, a panel per control with its linked changes,
// and Grant or renew an exception as the one amber action on a failing control.
export default async function BenchmarksPage() {
  await connection();
  const access = await requireReadAccess(DATA_SURFACES.benchmarksPage);

  let data: ComplianceData;
  try {
    data = await getComplianceData();
  } catch {
    return (
      <>
        <PageHeader description={DESCRIPTION} section="Baselines" title="Compliance" />
        <DataUnavailable surface="Compliance" />
      </>
    );
  }

  return (
    <>
      <PageHeader
        actions={<ExportEvidence />}
        description={DESCRIPTION}
        generatedAt={data.generatedAt}
        section="Baselines"
        status={complianceStatus(complianceCounts(data.findings))}
        title="Compliance"
      />
      <CompliancePage canConfigure={access.capabilities.includes("configuration")} canRestore={access.capabilities.includes("restore")} data={data} now={data.generatedAt} />
    </>
  );
}
