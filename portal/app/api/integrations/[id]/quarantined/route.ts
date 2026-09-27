import { guardedIntegrationQuarantined } from "@/lib/integrations";
import { DATA_SURFACES, guardedRead } from "@/lib/read";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const GET = guardedRead(DATA_SURFACES.integrationsQuarantinedApi, guardedIntegrationQuarantined());
