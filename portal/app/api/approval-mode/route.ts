import { guardedApprovalModeRead, guardedApprovalModeUpdate } from "@/lib/approval-mode";
import { DATA_SURFACES, guardedRead } from "@/lib/read";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export const GET = guardedRead(DATA_SURFACES.approvalModeApi, guardedApprovalModeRead());
// Changing the approval mode needs `policies`, checked in the guard.
export const POST = guardedApprovalModeUpdate();
