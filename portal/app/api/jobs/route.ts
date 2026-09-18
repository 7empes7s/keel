import { guardedJobList } from "@/lib/action";
import { DATA_SURFACES, guardedRead } from "@/lib/read";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export const GET = guardedRead(DATA_SURFACES.jobsApi, guardedJobList());
