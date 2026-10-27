import { headers } from "next/headers";
import { connection } from "next/server";

import { GET as loadEvidence } from "@/app/api/evidence/route";
import { GET as loadIntegrity } from "@/app/api/evidence/verify/route";
import { GET as loadJobs } from "@/app/api/jobs/route";
import { ActivityPage as ActivityBody } from "@/components/activity/activity-page";
import { AnonymityNote } from "@/components/anonymity-note";
import { DataUnavailable } from "@/components/data-unavailable";
import { JobRefresher } from "@/components/job-refresher";
import { PageHeader } from "@/components/page-header";
import { type ActivityNames, actorsForFilter, entrySubjectKey, getActivityNames } from "@/lib/activity-names";
import { getAnonymitySetting } from "@/lib/anonymity";
import { ACTIVITY_KINDS, OUTCOMES, activityCounts, activityStatus, parseFilters, rangeBounds } from "@/lib/activity-view";
import type { ChainIntegrity, EvidenceData } from "@/lib/evidence";
import type { JobsData } from "@/lib/portal-jobs";
import { DATA_SURFACES, requireReadAccess } from "@/lib/read";

const TITLE = "Activity";
const DESCRIPTION = "Everything Keel did and who decided what, newest first.";

// Activity (portal audit, pick A): jobs and the audit record as one timeline by day.
// The filters in the address narrow what the guarded API handlers load, exactly as
// the pages they replaced did; the client body filters the same way, so a tile or a
// picker reads the same whichever side applied it.
export default async function ActivityPage({ searchParams }: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  await connection();
  const access = await requireReadAccess(DATA_SURFACES.activityPage);
  const input = await searchParams;
  const value = (key: string) => (typeof input[key] === "string" && input[key] ? String(input[key]) : null);
  const filters = parseFilters(value);
  const before = value("before") && /^[1-9][0-9]*$/.test(value("before")!) ? value("before") : null;
  const bounds = rangeBounds(filters.range);
  const requestHeaders = await headers();

  const jobQuery = new URLSearchParams({ limit: "100" });
  if (filters.what.length) jobQuery.set("kind", filters.what.flatMap((key) => ACTIVITY_KINDS[key].jobs).join(",") || "none");
  if (filters.outcomes.length) jobQuery.set("status", filters.outcomes.flatMap((key) => OUTCOMES[key].jobStatuses).join(",") || "none");
  const evidenceQuery = new URLSearchParams();
  if (filters.what.length) evidenceQuery.set("kind", filters.what.flatMap((key) => ACTIVITY_KINDS[key].records).join(",") || "none");
  if (bounds) { evidenceQuery.set("from", bounds.from); evidenceQuery.set("to", bounds.to); }
  // While names are hidden a "Who" filter holds code names: read them back to the stored actors.
  if (filters.who.length) evidenceQuery.set("actor", (await actorsForFilter(filters.who).catch(() => filters.who)).join(","));
  if (before) evidenceQuery.set("before", before);
  // A job filter with no job kinds (drills) or an outcome only jobs have skips that side.
  const wantJobs = filters.show !== "records" && !before && jobQuery.get("kind") !== "none" && jobQuery.get("status") !== "none";
  const wantRecords = filters.show !== "jobs" && evidenceQuery.get("kind") !== "none" && (!filters.outcomes.length || filters.outcomes.some((key) => key === "failed" || key === "refused" || key === "recorded"));

  let jobs: JobsData | null = null;
  let evidence: EvidenceData | null = null;
  let integrity: ChainIntegrity | null = null;
  try {
    if (wantJobs) {
      const response = await loadJobs(new Request(`http://localhost/api/jobs?${jobQuery}`, { headers: requestHeaders }));
      if (!response.ok) throw new Error("jobs unavailable");
      jobs = await response.json() as JobsData;
    }
    if (wantRecords) {
      const response = await loadEvidence(new Request(`http://localhost/api/evidence?${evidenceQuery}`, { headers: requestHeaders }));
      if (!response.ok) throw new Error("audit record unavailable");
      evidence = await response.json() as EvidenceData;
    }
    const verify = await loadIntegrity(new Request("http://localhost/api/evidence/verify", { headers: requestHeaders }));
    if (verify.ok) integrity = await verify.json() as ChainIntegrity;
  } catch {
    return <><PageHeader description={DESCRIPTION} section="Audit log" title={TITLE} /><DataUnavailable surface="Activity" /></>;
  }

  const generatedAt = jobs?.generatedAt ?? evidence?.generatedAt ?? new Date().toISOString();
  let names: ActivityNames = { people: {}, names: {} };
  try {
    const entries = evidence?.entries ?? [];
    const actors = new Set(entries.map((entry) => entry.actor));
    for (const who of filters.who) actors.add(who);
    names = await getActivityNames([...actors], entries.map((entry) => entrySubjectKey(entry.subject)), entries);
  } catch { /* Actors and objects are then named in general words. */ }
  const anonymity = await getAnonymitySetting();
  const allJobs = jobs?.jobs ?? [];
  const status = wantJobs ? activityStatus(activityCounts(allJobs, generatedAt)) : undefined;

  return <>
    <PageHeader description={DESCRIPTION} generatedAt={generatedAt} section="Audit log" status={status} title={TITLE} />
    <ActivityBody
      canBackup={access.capabilities.includes("backup")}
      entries={names.entries ?? evidence?.entries ?? []}
      integrity={integrity}
      jobs={allJobs}
      names={names.names}
      nextBefore={evidence?.nextBefore ?? null}
      notice={<AnonymityNote setting={anonymity} />}
      now={generatedAt}
      people={names.people}
    />
    <JobRefresher active={allJobs.some((job) => job.status === "queued" || job.status === "running")} />
  </>;
}
