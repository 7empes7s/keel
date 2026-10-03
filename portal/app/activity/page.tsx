import { headers } from "next/headers";
import Link from "next/link";
import { connection } from "next/server";

import { GET as loadEvidence } from "@/app/api/evidence/route";
import { GET as loadIntegrity } from "@/app/api/evidence/verify/route";
import { GET as loadJobs } from "@/app/api/jobs/route";
import { ActivityTimeline, IntegrityNote, activityVerdict, mergeActivity } from "@/components/activity-timeline";
import { DataUnavailable } from "@/components/data-unavailable";
import { JobRefresher } from "@/components/job-refresher";
import { PageHeader } from "@/components/page-header";
import { Verdict } from "@/components/verdict";
import type { ChainIntegrity, EvidenceData } from "@/lib/evidence";
import { getPrincipalNames } from "@/lib/portal-data";
import type { JobsData } from "@/lib/portal-jobs";
import { DISPLAY_ENUMS } from "@/lib/presentation";
import { DATA_SURFACES, requireReadAccess } from "@/lib/read";
import type { Ref } from "@/lib/types";

const DESCRIPTION = "What KEEL has done and who decided what, newest first.";

// Roadmap task-130: Jobs and the audit record merge into one Activity timeline. The
// existing guarded API handlers load each part, exactly as the pages they replace did.
export default async function ActivityPage({ searchParams }: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  await connection();
  await requireReadAccess(DATA_SURFACES.activityPage);
  const input = await searchParams;
  const value = (key: string) => (typeof input[key] === "string" && input[key] ? String(input[key]) : null);
  const show = value("show") === "jobs" || value("show") === "records" ? value("show")! : "all";
  const query = new URLSearchParams();
  for (const key of ["kind", "from", "to", "before"]) if (value(key)) query.set(key, value(key)!);
  const requestHeaders = await headers();

  let jobs: JobsData | null = null;
  let evidence: EvidenceData | null = null;
  let integrity: ChainIntegrity | null = null;
  let invalid = false;
  try {
    // A record filter or page narrows the timeline to the audit record.
    if (show !== "records" && !query.has("kind") && !query.has("before")) {
      const response = await loadJobs(new Request("http://localhost/api/jobs?limit=50", { headers: requestHeaders }));
      if (!response.ok) throw new Error("jobs unavailable");
      jobs = await response.json() as JobsData;
    }
    if (show !== "jobs") {
      const response = await loadEvidence(new Request(`http://localhost/api/evidence?${query}`, { headers: requestHeaders }));
      invalid = response.status === 400;
      if (response.ok) evidence = await response.json() as EvidenceData;
      else if (!invalid) throw new Error("audit record unavailable");
      const verify = await loadIntegrity(new Request("http://localhost/api/evidence/verify", { headers: requestHeaders }));
      if (verify.ok) integrity = await verify.json() as ChainIntegrity;
    }
  } catch {
    return <><PageHeader section="Activity" title="Activity" description={DESCRIPTION} /><DataUnavailable surface="Activity" /></>;
  }

  const generatedAt = jobs?.generatedAt ?? evidence?.generatedAt ?? new Date().toISOString();
  let people: Record<string, Ref> = {};
  try {
    people = await getPrincipalNames([...new Set((evidence?.entries ?? []).map((entry) => entry.actor))]);
  } catch { /* Actors fall back to their recorded value. */ }
  const items = mergeActivity(jobs?.jobs ?? [], evidence?.entries ?? []);
  const older = new URLSearchParams(query);
  if (evidence?.nextBefore) older.set("before", evidence.nextBefore);
  older.set("show", "records");
  const failedRecently = (jobs?.jobs ?? []).some((job) => job.status === "failed");

  return <>
    <PageHeader section="Activity" title="Activity" description={DESCRIPTION} generatedAt={generatedAt} />
    <Verdict
      text={jobs ? activityVerdict(jobs.jobs, generatedAt) : "Showing the audit record: who did what, newest first."}
      tone={failedRecently ? "attention" : "good"}
    />
    <div data-layer="explanation">
      {show !== "jobs" ? <IntegrityNote integrity={integrity} /> : null}
      <form action="/activity" className="evidence-filters">
        <label className="filter-field"><span>Show</span>
          <select defaultValue={show} name="show">
            <option value="all">Everything</option>
            <option value="jobs">Jobs only</option>
            <option value="records">Audit record only</option>
          </select>
        </label>
        <label className="filter-field"><span>Kind of record</span>
          <select defaultValue={query.get("kind") ?? ""} name="kind">
            <option value="">Any</option>
            {Object.entries(DISPLAY_ENUMS.evidenceKind).map(([code, label]) => <option key={code} value={code}>{label}</option>)}
          </select>
        </label>
        <label className="filter-field"><span>From (UTC date)</span><input defaultValue={query.get("from") ?? ""} name="from" placeholder="2026-09-01" /></label>
        <label className="filter-field"><span>To (UTC date)</span><input defaultValue={query.get("to") ?? ""} name="to" placeholder="2026-09-30" /></label>
        <button className="btn btn-secondary btn-sm" type="submit">Apply</button>
      </form>
      {invalid ? <p className="action-error" role="alert">Those filters could not be used. Use UTC dates such as 2026-09-01, with the start before the end.</p> : (
        <ActivityTimeline items={items} now={generatedAt} people={people} />
      )}
      <nav aria-label="Activity pages" className="pagination-links">
        {query.has("before") ? <Link className="secondary-action" href="/activity?show=records">Newest entries</Link> : null}
        {evidence?.nextBefore ? <Link className="secondary-action" href={`/activity?${older}`}>Older audit entries</Link> : null}
      </nav>
      <JobRefresher active={(jobs?.jobs ?? []).some((job) => job.status === "queued" || job.status === "running")} />
    </div>
  </>;
}
