import { headers } from "next/headers";
import { connection } from "next/server";

import { DashboardView } from "@/components/dashboard/dashboard-view";
import { DataUnavailable } from "@/components/data-unavailable";
import { PageHeader } from "@/components/page-header";
import { approvalInboxAccess, getPendingApprovalCount } from "@/lib/approval-inbox";
import { getDashboardData } from "@/lib/portal-data";
import { DATA_SURFACES, requireReadAccess } from "@/lib/read";
import type { DashboardData } from "@/lib/types";

export default async function Home() {
  await connection();
  await requireReadAccess(DATA_SURFACES.dashboardPage);

  let data: DashboardData;
  try {
    data = await getDashboardData();
  } catch {
    return (
      <>
        <PageHeader
          description="Is this tenant protected right now, and what needs you?"
          section="Overview"
          title="Overview"
        />
        <DataUnavailable surface="The overview" />
      </>
    );
  }

  const requestHeaders = await headers();
  let pendingApprovals: number | null = null;
  if (approvalInboxAccess(requestHeaders)) {
    try {
      pendingApprovals = await getPendingApprovalCount();
    } catch {
      pendingApprovals = null;
    }
  }

  return <DashboardView data={data} pendingApprovals={pendingApprovals} />;
}
