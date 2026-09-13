import { guardedNotificationList } from "@/lib/notifications";
import { DATA_SURFACES, guardedRead } from "@/lib/read";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const GET = guardedRead(DATA_SURFACES.deliveriesApi, guardedNotificationList("deliveries", DATA_SURFACES.deliveriesApi));
