import { guardedApprovalDecision } from "@/lib/action";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// §3.3, plan task 14: approving a request mints the job it asked for.
export const POST = guardedApprovalDecision("approve");
