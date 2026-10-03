import { guardedPolicyActivationPreview } from "@/lib/policies";
import { DATA_SURFACES } from "@/lib/read";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const POST = guardedPolicyActivationPreview(DATA_SURFACES.policyActivationPreviewApi);
