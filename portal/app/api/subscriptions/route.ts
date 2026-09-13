import { guardedNotificationList, guardedNotificationCreate } from "@/lib/notifications";
import { DATA_SURFACES, guardedRead } from "@/lib/read";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const GET = guardedRead(DATA_SURFACES.subscriptionsApi, guardedNotificationList("subscriptions", DATA_SURFACES.subscriptionsApi));
export const POST = guardedNotificationCreate("subscriptions", DATA_SURFACES.subscriptionsApi);
