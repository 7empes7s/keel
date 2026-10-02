import { headers } from "next/headers";
import { connection } from "next/server";
import { GET as loadEvidence } from "@/app/api/evidence/route";
import { GET as loadIntegrity } from "@/app/api/evidence/verify/route";
import { DataUnavailable } from "@/components/data-unavailable";
import { ChainIndicator, EvidenceTimeline } from "@/components/evidence-timeline";
import { PageHeader } from "@/components/page-header";
import type { ChainIntegrity, EvidenceData } from "@/lib/evidence";
import { DATA_SURFACES, requireReadAccess } from "@/lib/read";

export default async function EvidencePage({ searchParams }: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  await connection();
  await requireReadAccess(DATA_SURFACES.evidencePage);
  const input = await searchParams;
  const query = new URLSearchParams();
  for (const key of ["kind", "from", "to", "before", "limit"]) {
    if (typeof input[key] === "string" && input[key]) query.set(key, input[key]);
  }
  const requestHeaders = await headers();
  let data: EvidenceData | null = null;
  let integrity: ChainIntegrity | null = null;
  let invalid = false;
  try {
    const response = await loadEvidence(new Request(`http://localhost/api/evidence?${query}`, { headers: requestHeaders }));
    invalid = response.status === 400;
    if (response.ok) data = await response.json();
  } catch { /* Render an explicit unavailable state. */ }
  try {
    const response = await loadIntegrity(new Request("http://localhost/api/evidence/verify", { headers: requestHeaders }));
    if (response.ok) integrity = await response.json();
  } catch { /* Never present failed verification requests as a valid chain. */ }
  return <>
    <PageHeader eyebrow="Governance" title="Evidence" description="Decision history, newest first by sequence. Dates are UTC; range endpoints are inclusive." generatedAt={data?.generatedAt} />
    <ChainIndicator integrity={integrity} />
    <form action="/evidence" className="evidence-filters">
      <label><span>Kind</span> <input name="kind" defaultValue={query.get("kind") ?? ""} placeholder="policy-evaluation" /></label>
      <label><span>From (UTC date or ISO timestamp)</span> <input name="from" defaultValue={query.get("from") ?? ""} placeholder="2026-09-01" /></label>
      <label><span>To (UTC date or ISO timestamp)</span> <input name="to" defaultValue={query.get("to") ?? ""} placeholder="2026-09-30T23:59:59Z" /></label>
      {query.has("limit") ? <input type="hidden" name="limit" value={query.get("limit")!} /> : null}
      <button className="secondary-action" type="submit">Filter and verify chain</button>
    </form>
    {invalid ? <p className="action-error" role="alert">Invalid filters. Use UTC dates or ISO timestamps, an ordered date range, and a limit from 1 to 200.</p> : data ? <EvidenceTimeline data={data} query={query.toString()} /> : <DataUnavailable surface="Evidence" />}
  </>;
}
