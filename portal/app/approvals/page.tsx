import { connection } from "next/server";

import { ApprovalInbox } from "@/components/approval-inbox";
import { DataUnavailable } from "@/components/data-unavailable";
import { PageHeader } from "@/components/page-header";
import { Verdict } from "@/components/verdict";
import {
  getApprovalInboxData,
  requireApprovalInboxAccess,
} from "@/lib/approval-inbox";

export default async function ApprovalsPage() {
  // The approval guard is intentionally before connection() and the loader: a pure
  // approver may enter this surface, while every other principal is refused without a
  // database connection or approval-detail signal.
  const scope = await requireApprovalInboxAccess();
  await connection();

  try {
    const data = await getApprovalInboxData(scope);
    return (
      <>
        <PageHeader
          description="Restores, roll-backs and baseline changes wait here for someone other than the requester."
          section="Approvals"
          generatedAt={data.generatedAt}
          title="Approvals"
        />
        <Verdict
          text={data.pending.length === 0
            ? "Nothing is waiting for your decision."
            : `${data.pending.length} ${data.pending.length === 1 ? "request is" : "requests are"} waiting for you.`}
          tone={data.pending.length ? "attention" : "good"}
        />
        <div data-layer="explanation">
          <ApprovalInbox history={data.history} now={data.generatedAt} pending={data.pending} />
        </div>
      </>
    );
  } catch {
    return (
      <>
        <PageHeader
          description="Restores, roll-backs and baseline changes wait here for someone other than the requester."
          section="Approvals"
          title="Approvals"
        />
        <DataUnavailable surface="The approval inbox" />
      </>
    );
  }
}
