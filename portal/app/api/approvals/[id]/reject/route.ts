import { guardedApprovalDecision } from "@/lib/action";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// §3.3, plan task 14: rejecting a request closes it without minting a job.
export const POST = guardedApprovalDecision("reject");
