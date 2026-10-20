import { headers } from "next/headers";
import { connection } from "next/server";

import { ApprovalInbox } from "@/components/approval-inbox";
import { DataUnavailable } from "@/components/data-unavailable";
import { PageHeader } from "@/components/page-header";
import {
  getApprovalInboxData,
  requireApprovalInboxAccess,
} from "@/lib/approval-inbox";
import { approvalCounts, approvalsStatus } from "@/lib/approval-view";
import { PRINCIPAL_ID_HEADER } from "@/lib/principal";

const TITLE = "Approvals";
const DESCRIPTION = "Restores, undo changes and approved-setup switches wait here for someone other than the person who asked.";

export default async function ApprovalsPage() {
  // The approval guard is intentionally before connection() and the loader: a pure
  // approver may enter this surface, while every other principal is refused without a
  // database connection or approval-detail signal.
  const scope = await requireApprovalInboxAccess();
  await connection();
  const viewerId = (await headers()).get(PRINCIPAL_ID_HEADER);

  try {
    const data = await getApprovalInboxData(scope);
    const status = approvalsStatus(approvalCounts(data, data.generatedAt));
    return (
      <>
        <PageHeader
          description={DESCRIPTION}
          section="Inbox"
          generatedAt={data.generatedAt}
          status={status}
          title={TITLE}
        />
        <ApprovalInbox
          awaitingContentEffects={data.awaitingContentEffects}
          history={data.history}
          now={data.generatedAt}
          pending={data.pending}
          viewerId={viewerId}
        />
      </>
    );
  } catch {
    return (
      <>
        <PageHeader description={DESCRIPTION} section="Inbox" title={TITLE} />
        <DataUnavailable surface="The approval inbox" />
      </>
    );
  }
}
