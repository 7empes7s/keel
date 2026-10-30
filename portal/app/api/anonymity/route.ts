import { guardedAnonymityRead, guardedAnonymityUpdate } from "@/lib/anonymity";
import { DATA_SURFACES, guardedRead } from "@/lib/read";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export const GET = guardedRead(DATA_SURFACES.anonymityApi, guardedAnonymityRead());
// Turning "Hide people's names" on or off needs `users` (an admin), checked in the guard.
export const POST = guardedAnonymityUpdate();
