import { DATA_SURFACES, guardedRead } from "@/lib/read";
import { guardedSetupState } from "@/lib/setup";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export const GET = guardedRead(DATA_SURFACES.setupApi, guardedSetupState());
