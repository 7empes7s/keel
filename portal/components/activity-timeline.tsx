import Link from "next/link";

import { JobStatusBadge } from "@/components/job-status-badge";
import { JobRecordFields } from "@/components/job-table";
import { RecordField, TechnicalDetails } from "@/components/technical-details";
import type { ChainIntegrity, EvidenceEntry } from "@/lib/evidence";
import type { JobRecord } from "@/lib/portal-jobs";
import { ago, formatTimestamp } from "@/lib/presentation";
import { evidenceSentence, jobName, jobStatusSentence, refLabel } from "@/lib/sentences";
import type { Ref } from "@/lib/types";

// Roadmap task-130, the Activity section: what KEEL did and who decided what, as one
// timeline of sentences with the actor and age. Ids, sequence numbers, worker ids and
// raw JSON are in each entry's record.

export type ActivityEntry =
  | { type: "job"; at: string | null; job: JobRecord }
  | { type: "record"; at: string | null; entry: EvidenceEntry };

/** Newest first, jobs and audit-record entries interleaved by time. */
export function mergeActivity(jobs: JobRecord[], entries: EvidenceEntry[]): ActivityEntry[] {
  return [
    ...jobs.map((job) => ({ type: "job" as const, at: job.finishedAt ?? job.startedAt ?? job.createdAt, job })),
    ...entries.map((entry) => ({ type: "record" as const, at: entry.occurred_at, entry })),
  ].sort((a, b) => String(b.at ?? "").localeCompare(String(a.at ?? "")));
}

/** "KEEL ran 14 jobs in the last day; 1 failed." */
export function activityVerdict(jobs: JobRecord[], now: string): string {
  const since = new Date(now).valueOf() - 24 * 60 * 60 * 1000;
  const recent = jobs.filter((job) => job.createdAt && new Date(job.createdAt).valueOf() >= since);
  const failed = recent.filter((job) => job.status === "failed").length;
  if (recent.length === 0) return "KEEL ran no jobs in the last day.";
  return `KEEL ran ${recent.length} ${recent.length === 1 ? "job" : "jobs"} in the last day${failed ? `; ${failed} failed` : ", none failed"}.`;
}

/** The audit record's integrity, in words; the raw verification result is in the record. */
export function integritySentence(integrity: ChainIntegrity | null): string {
  if (integrity === null) return "The audit record's integrity could not be checked right now.";
  if (integrity.ok) {
    const pending = integrity.unanchoredRecords ?? 0;
    return `The audit record is intact and verified against an external copy${pending ? `; ${pending} newer ${pending === 1 ? "entry is" : "entries are"} waiting for the next copy` : ""}.`;
  }
  if (integrity.status === "unanchored") return "The audit record has not been copied externally yet, so it cannot be verified.";
  return "The audit record failed its integrity check. Investigate before trusting who-did-what records.";
}

export function IntegrityNote({ integrity }: { integrity: ChainIntegrity | null }) {
  return (
    <section className={`evidence-integrity ${integrity === null ? "" : integrity.ok ? "evidence-intact" : "evidence-broken"}`} role="status">
      <p>{integritySentence(integrity)}</p>
      <TechnicalDetails summary="Technical details for this check">
        <RecordField copy={false} label="Verification result" value={integrity ? JSON.stringify(integrity) : "unavailable"} />
        <RecordField copy={false} label="Anchored through sequence" value={integrity?.anchoredThroughSeq ?? null} />
        <RecordField copy={false} label="Checked with" value="GET /api/evidence/verify" />
      </TechnicalDetails>
    </section>
  );
}

export function ActivityTimeline({ items, people, now }: { items: ActivityEntry[]; people: Record<string, Ref>; now: string }) {
  if (items.length === 0) return <p className="empty-state">Nothing matches these filters.</p>;
  const actorName = (actor: string) => people[actor]?.name ?? actor;
  return (
    <ol className="activity-list">
      {items.map((item) => item.type === "job" ? (
        <li className={`activity-item job-row job-row-${item.job.status}`} key={`job:${item.job.id}`}>
          <div className="activity-main">
            <Link className="activity-title" href={`/jobs/${encodeURIComponent(item.job.id)}`}>{jobName(item.job)}</Link>
            <p className="activity-meta">
              <JobStatusBadge status={item.job.status} />{" "}
              <time dateTime={item.at ?? undefined} title={formatTimestamp(item.at)}>{jobStatusSentence(item.job, now)}</time>
              {" · asked by "}{refLabel(item.job.references?.people.requested_by, "an unknown account")}
            </p>
          </div>
          <TechnicalDetails><JobRecordFields job={item.job} /></TechnicalDetails>
        </li>
      ) : (
        <li className="activity-item activity-record" key={`record:${item.entry.seq}`}>
          <div className="activity-main">
            <p className="activity-title">{evidenceSentence(item.entry, actorName(item.entry.actor))}</p>
            <p className="activity-meta">
              Recorded <time dateTime={item.at ?? undefined} title={formatTimestamp(item.at)}>{ago(item.at, now)}</time>
            </p>
          </div>
          <TechnicalDetails>
            <RecordField copy={false} label="Evidence sequence" value={item.entry.seq} />
            <RecordField copy={false} label="Kind" value={item.entry.kind} />
            <RecordField label="Actor" value={item.entry.actor} />
            <RecordField copy={false} label="Occurred at" value={item.entry.occurred_at} />
            <RecordField copy={false} label="Subject" value={JSON.stringify(item.entry.subject, null, 2)} />
          </TechnicalDetails>
        </li>
      ))}
    </ol>
  );
}
