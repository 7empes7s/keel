import { guardedPolicyUpdate } from "@/lib/policies";
import { DATA_SURFACES } from "@/lib/read";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const POST = guardedPolicyUpdate("clear-pause", DATA_SURFACES.policyClearPauseApi);
