import { dataResponse } from "@/lib/api-response";
import { askInputFrom } from "@/lib/ask-view";
import { getAskData } from "@/lib/portal-data";
import { DATA_SURFACES, guardedRead } from "@/lib/read";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// Roadmap task-99: GET /api/ask?q=... (a question) or ?intent=...&period=...&entity=...
// (a structured request). Read-only; the reader's scope comes from the proxy headers.
export const GET = guardedRead(
  DATA_SURFACES.askApi,
  async (request, access) => {
    const params = Object.fromEntries(new URL(request.url).searchParams.entries());
    return dataResponse(() => getAskData(access.scope, askInputFrom(params)));
  },
);
