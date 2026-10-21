import { guardedNotificationUpdate, guardedSubscriptionPatch } from "@/lib/notifications";
export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const DELETE = guardedNotificationUpdate("subscriptions");
export const PATCH = guardedSubscriptionPatch();
