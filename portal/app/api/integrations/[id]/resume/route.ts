import { guardedIntegrationLifecycle } from "@/lib/integrations";
export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const POST = guardedIntegrationLifecycle("resume");
