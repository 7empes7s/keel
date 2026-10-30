import { guardedScubaListUpdate } from "@/lib/scuba-lists";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export const POST = guardedScubaListUpdate();
