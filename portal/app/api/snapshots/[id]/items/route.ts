import { dataResponse } from "@/lib/api-response";
import { getRestoreResources } from "@/lib/portal-data";
import { DATA_SURFACES, guardedRead } from "@/lib/read";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// The items one backup holds, by name and kind: the Incidents page lists them so an
// investigator picks harmful items to leave out instead of typing stored keys. Read
// only, scoped to this tenant's backup (another tenant's id reads as empty).
export const GET = guardedRead(DATA_SURFACES.snapshotItemsApi, async (request) => {
  const id = new URL(request.url).pathname.split("/").at(-2) ?? "";
  if (!UUID.test(id)) return Response.json({ error: "invalid_request" }, { status: 400, headers: { "cache-control": "no-store" } });
  return dataResponse(() => getRestoreResources(id));
});
