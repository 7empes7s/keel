import { guardedPolicyDelete } from "@/lib/policies";
import { DATA_SURFACES } from "@/lib/read";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const POST = guardedPolicyDelete(DATA_SURFACES.policyDeleteApi);
