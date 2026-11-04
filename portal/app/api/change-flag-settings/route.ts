import { guardedFlagSettingsRead, guardedFlagSettingsUpdate } from "@/lib/change-flag-settings";
import { DATA_SURFACES, guardedRead } from "@/lib/read";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const GET = guardedRead(DATA_SURFACES.changeFlagSettingsApi, guardedFlagSettingsRead());
export const POST = guardedFlagSettingsUpdate();
