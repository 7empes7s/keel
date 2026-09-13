import { guardedPolicyList, guardedPolicyCreate } from "@/lib/policies";
import { DATA_SURFACES, guardedRead } from "@/lib/read";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const GET = guardedRead(DATA_SURFACES.policiesApi, guardedPolicyList());
export const POST = guardedPolicyCreate(DATA_SURFACES.policiesApi);
