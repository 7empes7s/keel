import { guardedNotificationList, guardedNotificationCreate } from "@/lib/notifications";
import { DATA_SURFACES, guardedRead } from "@/lib/read";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const GET = guardedRead(DATA_SURFACES.channelsApi, guardedNotificationList("channels", DATA_SURFACES.channelsApi));
export const POST = guardedNotificationCreate("channels", DATA_SURFACES.channelsApi);
