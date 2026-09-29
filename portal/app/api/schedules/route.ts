import { guardedScheduleUpdate } from "@/lib/action";
import { DATA_SURFACES, guardedRead } from "@/lib/read";
import { guardedScheduleList } from "@/lib/schedules";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const GET = guardedRead(DATA_SURFACES.schedulesApi, guardedScheduleList());
export const POST = guardedScheduleUpdate();
