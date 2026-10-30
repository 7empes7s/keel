import { guardedRestoreApprovalsRead, guardedRestoreApprovalsUpdate } from "@/lib/restore-approvals";
import { DATA_SURFACES, guardedRead } from "@/lib/read";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export const GET = guardedRead(DATA_SURFACES.restoreApprovalsApi, guardedRestoreApprovalsRead());
// Turning a service's restore approval on or off needs `policies`, checked in the guard.
export const POST = guardedRestoreApprovalsUpdate();
