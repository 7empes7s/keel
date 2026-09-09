import { guardedJobList } from "@/lib/action";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export const GET = guardedJobList();
