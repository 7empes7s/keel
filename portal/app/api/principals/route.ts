import { guardedPrincipalCreate, guardedPrincipalList } from "@/lib/principals";
import { DATA_SURFACES, guardedRead } from "@/lib/read";
export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const GET = guardedRead(DATA_SURFACES.principalsApi, guardedPrincipalList());
// Add a person with a first role: users and roles, checked inside the guard.
export const POST = guardedPrincipalCreate();
