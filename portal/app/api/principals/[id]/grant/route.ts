import { guardedPrincipalWrite } from "@/lib/principals";
import { DATA_SURFACES } from "@/lib/read";
export const runtime = "nodejs";
export const POST = guardedPrincipalWrite("grant", DATA_SURFACES.principalGrantApi);
