import { guardedServiceNowConfigure, guardedServiceNowStatus } from "@/lib/servicenow";
import { DATA_SURFACES, guardedRead } from "@/lib/read";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const GET = guardedRead(DATA_SURFACES.integrationsServiceNowApi, guardedServiceNowStatus());
export const PUT = guardedServiceNowConfigure();
