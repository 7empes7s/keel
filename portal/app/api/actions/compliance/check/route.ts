import { guardedComplianceCheck } from "@/lib/compliance-check";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export const POST = guardedComplianceCheck();
