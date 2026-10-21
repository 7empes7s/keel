import { guardedEscalationToggle } from "@/lib/notifications";
export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const POST = guardedEscalationToggle(true);
