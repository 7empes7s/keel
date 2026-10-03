import { connection } from "next/server";

import { ApprovalInbox } from "@/components/approval-inbox";
import { DataUnavailable } from "@/components/data-unavailable";
import { PageHeader } from "@/components/page-header";
import {
  getApprovalInboxData,
  requireApprovalInboxAccess,
} from "@/lib/approval-inbox";

export default async function ApprovalsPage() {
  // The approval guard is intentionally before connection() and the loader: a pure
  // approver may enter this surface, while every other principal is refused without a
  // database connection or approval-detail signal.
  await requireApprovalInboxAccess();
  await connection();

  try {
    const data = await getApprovalInboxData();
    return (
      <>
        <PageHeader
          description="Review pending operator requests and retain a newest-first decision record."
          section="Approvals"
          generatedAt={data.generatedAt}
          marker="Approval required"
          title="Approvals"
        />
        <ApprovalInbox history={data.history} pending={data.pending} />
      </>
    );
  } catch {
    return (
      <>
        <PageHeader
          description="Review pending operator requests and retain a newest-first decision record."
          section="Approvals"
          marker="Approval required"
          title="Approvals"
        />
        <DataUnavailable surface="Approval inbox" />
      </>
    );
  }
}
