import { guardedPolicyActivate } from "@/lib/policies";
import { DATA_SURFACES } from "@/lib/read";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const POST = guardedPolicyActivate(DATA_SURFACES.policyActivateApi);
