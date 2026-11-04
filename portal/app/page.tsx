import { headers } from "next/headers";
import { connection } from "next/server";

import { DashboardView } from "@/components/dashboard/dashboard-view";
import { DataUnavailable } from "@/components/data-unavailable";
import { PageHeader } from "@/components/page-header";
import { approvalInboxScope } from "@/lib/approval-inbox";
import { getFlaggedThisWeek } from "@/lib/insights";
import { pendingApprovalCount } from "@/lib/pending-approvals";
import { PRINCIPAL_ID_HEADER } from "@/lib/principal";
import { getDashboardData } from "@/lib/portal-data";
import { DATA_SURFACES, requireReadAccess } from "@/lib/read";
import type { DashboardData, FlaggedThisWeek } from "@/lib/types";

export default async function Home() {
  await connection();
  const access = await requireReadAccess(DATA_SURFACES.dashboardPage);

  // The flagged-changes row counts the reader's own feed rows (the Overview admits central
  // readers only today, so that is every row). It never holds up the Overview: an error
  // leaves the row out.
  const flagged: Promise<FlaggedThisWeek | null> = getFlaggedThisWeek({ scope: access.scope }).catch(() => null);
  let data: DashboardData;
  try {
    data = { ...(await getDashboardData()), flaggedThisWeek: await flagged };
  } catch {
    return (
      <>
        <PageHeader
          description="Is this tenant protected right now, and what needs you?"
          section="Dashboards"
          title="Overview"
        />
        <DataUnavailable surface="The overview" />
      </>
    );
  }

  const requestHeaders = await headers();
  let pendingApprovals: number | null = null;
  const approverScope = approvalInboxScope(requestHeaders);
  if (approverScope) {
    try {
      // The same request-cached count the menu reads: one count per page load.
      pendingApprovals = await pendingApprovalCount(approverScope, requestHeaders.get(PRINCIPAL_ID_HEADER));
    } catch {
      pendingApprovals = null;
    }
  }

  return <DashboardView data={data} pendingApprovals={pendingApprovals} />;
}
