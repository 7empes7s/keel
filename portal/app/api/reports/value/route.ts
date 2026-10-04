import { DATA_SURFACES, guardedRead } from "@/lib/read";
import { getValueReport, reportCsv } from "@/lib/value-report";
import { parseEntity, parsePeriod, type ValueReport } from "@/lib/value-report-view";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const NO_STORE = { "cache-control": "no-store" } as const;

// Roadmap task-100: the value report export. Same guard and scope as the page; the
// file carries its period, scope, counting rules, evidence chain head and digest.
export const GET = guardedRead(DATA_SURFACES.valueReportApi, async (request, access) => {
  const url = new URL(request.url);
  const period = parsePeriod(url.searchParams.get("period"));
  const entity = parseEntity(url.searchParams.get("entity"));
  const format = url.searchParams.get("format") === "csv" ? "csv" : "json";
  let report: ValueReport;
  try {
    report = await getValueReport({ scope: access.scope, period, entity });
  } catch {
    return Response.json({ error: "unavailable" }, { status: 503, headers: NO_STORE });
  }
  const name = `keel-value-report-${report.period.from.slice(0, 10)}-${report.period.to.slice(0, 10)}`;
  if (format === "csv") {
    return new Response(reportCsv(report), {
      headers: { ...NO_STORE, "content-type": "text/csv; charset=utf-8", "content-disposition": `attachment; filename="${name}.csv"` },
    });
  }
  return Response.json(report, { headers: { ...NO_STORE, "content-disposition": `attachment; filename="${name}.json"` } });
});
