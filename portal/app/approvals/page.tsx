import { connection } from "next/server";

import { ApprovalInbox } from "@/components/approval-inbox";
import { DataUnavailable } from "@/components/data-unavailable";
import { PageHeader } from "@/components/page-header";
import { Verdict } from "@/components/verdict";
import {
  getApprovalInboxData,
  requireApprovalInboxAccess,
  waitingCount,
} from "@/lib/approval-inbox";

export default async function ApprovalsPage() {
  // The approval guard is intentionally before connection() and the loader: a pure
  // approver may enter this surface, while every other principal is refused without a
  // database connection or approval-detail signal.
  const scope = await requireApprovalInboxAccess();
  await connection();

  try {
    const data = await getApprovalInboxData(scope);
    const waiting = waitingCount(data);
    return (
      <>
        <PageHeader
          description="Restores, roll-backs and baseline changes wait here for someone other than the requester."
          section="Inbox"
          generatedAt={data.generatedAt}
          title="Approvals"
        />
        <Verdict
          text={waiting === 0
            ? "Nothing is waiting for your decision."
            : `${waiting} ${waiting === 1 ? "request is" : "requests are"} waiting for you.`}
          tone={waiting ? "attention" : "good"}
        />
        <div data-layer="explanation">
          <ApprovalInbox
            awaitingContentEffects={data.awaitingContentEffects}
            history={data.history}
            now={data.generatedAt}
            pending={data.pending}
          />
        </div>
      </>
    );
  } catch {
    return (
      <>
        <PageHeader
          description="Restores, roll-backs and baseline changes wait here for someone other than the requester."
          section="Inbox"
          title="Approvals"
        />
        <DataUnavailable surface="The approval inbox" />
      </>
    );
  }
}
