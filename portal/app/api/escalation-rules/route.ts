import { guardedEscalationCreate, guardedEscalationList } from "@/lib/notifications";
import { DATA_SURFACES, guardedRead } from "@/lib/read";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const GET = guardedRead(DATA_SURFACES.escalationRulesApi, guardedEscalationList(DATA_SURFACES.escalationRulesApi));
export const POST = guardedEscalationCreate(DATA_SURFACES.escalationRulesApi);
