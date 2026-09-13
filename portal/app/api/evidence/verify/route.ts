import { guardedEvidenceVerify } from "@/lib/evidence";
import { DATA_SURFACES, guardedRead } from "@/lib/read";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const GET = guardedRead(DATA_SURFACES.evidenceVerifyApi, guardedEvidenceVerify());
