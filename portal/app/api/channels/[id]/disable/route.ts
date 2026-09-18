import { guardedNotificationUpdate } from "@/lib/notifications";
export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const POST = guardedNotificationUpdate("channels");
