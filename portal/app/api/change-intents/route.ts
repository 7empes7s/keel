import { guardedChangeIntentCreate, guardedChangeIntentList } from "@/lib/change-intents";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// Roadmap task-93: approved emergency changes declare approve rather than read, like the
// approval inbox: approving a deviation is an approver's decision, not a reader's view.
export const GET = guardedChangeIntentList();
export const POST = guardedChangeIntentCreate();
