import { remediationSelection } from "@/lib/remediation-preview";
import { DATA_SURFACES, guardedRead } from "@/lib/read";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export const POST = guardedRead(DATA_SURFACES.remediateSelectionApi, remediationSelection());
