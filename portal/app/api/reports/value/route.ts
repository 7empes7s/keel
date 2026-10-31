import { DATA_SURFACES, guardedRead } from "@/lib/read";
import { getValueReport, reportCsv } from "@/lib/value-report";
import { valueReportXlsx } from "@/lib/value-report-export";
import { parseEntities, resolvePeriod, type ValueReport } from "@/lib/value-report-view";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const NO_STORE = { "cache-control": "no-store" } as const;

// Roadmap task-100: the value report export. Same guard and scope as the page; the
// file carries its period, scope, counting rules, evidence chain head and digest.
// `format=csv`, `xlsx` (a workbook in the page's words) or JSON by default.
export const GET = guardedRead(DATA_SURFACES.valueReportApi, async (request, access) => {
  const url = new URL(request.url);
  const period = resolvePeriod(url.searchParams.get("period"), new Date());
  const entities = parseEntities(url.searchParams.get("entity"));
  const asked = url.searchParams.get("format");
  const format = asked === "csv" || asked === "xlsx" ? asked : "json";
  let report: ValueReport;
  try {
    report = await getValueReport({ scope: access.scope, period, entities });
  } catch (error) {
    console.error("[keel-portal] 503 value report failed", error);
    return Response.json({ error: "unavailable" }, { status: 503, headers: NO_STORE });
  }
  const name = `keel-value-report-${report.period.from.slice(0, 10)}-${report.period.to.slice(0, 10)}`;
  if (format === "xlsx") {
    return new Response(valueReportXlsx(report) as BodyInit, {
      headers: { ...NO_STORE, "content-type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", "content-disposition": `attachment; filename="${name}.xlsx"` },
    });
  }
  if (format === "csv") {
    return new Response(reportCsv(report), {
      headers: { ...NO_STORE, "content-type": "text/csv; charset=utf-8", "content-disposition": `attachment; filename="${name}.csv"` },
    });
  }
  return Response.json(report, { headers: { ...NO_STORE, "content-disposition": `attachment; filename="${name}.json"` } });
});
