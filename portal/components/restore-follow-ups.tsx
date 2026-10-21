import Link from "next/link";

import { RecordField, TechnicalDetails } from "@/components/technical-details";
import { ago, formatTimestamp } from "@/lib/presentation";
import type { RestoreFollowUp } from "@/lib/types";

// Every restore that still has follow-up steps open (new secrets, consent, a service
// check), however old, so finishing one never depends on its job still being in the
// recent list. The steps themselves are closed on the restore's job page.
export function RestoreFollowUps({ followUps, now }: { followUps: RestoreFollowUp[]; now: string }) {
  if (followUps.length === 0) return null;
  const total = followUps.reduce((sum, entry) => sum + entry.pending, 0);
  return (
    <section aria-labelledby="restore-follow-ups-heading" className="report-section" id="follow-up">
      <div className="section-heading-row report-heading">
        <div>
          <p className="section-kicker">Waiting on you</p>
          <h2 id="restore-follow-ups-heading">Follow-up after restores</h2>
        </div>
        <span className="result-count">{total} {total === 1 ? "step" : "steps"}</span>
      </div>
      <ul className="activity-list">
        {followUps.map((entry) => (
          <li className="activity-item" key={entry.restoreRef}>
            <div className="activity-main">
              {entry.jobId ? (
                <Link className="activity-title" href={`/jobs/${encodeURIComponent(entry.jobId)}`}>
                  {entry.pending} follow-up {entry.pending === 1 ? "step" : "steps"} still open
                </Link>
              ) : (
                <span className="activity-title">{entry.pending} follow-up {entry.pending === 1 ? "step" : "steps"} still open</span>
              )}
              <p className="activity-meta">
                From a restore <time dateTime={entry.since} title={formatTimestamp(entry.since)}>{ago(entry.since, now)}</time>
              </p>
            </div>
            <TechnicalDetails>
              <RecordField label="Restore reference" value={entry.restoreRef} />
              <RecordField label="Job ID" usage={<>use with <code>GET /api/jobs/&lt;id&gt;</code></>} value={entry.jobId} />
              <RecordField copy={false} label="Open steps" value={entry.pending} />
              <RecordField copy={false} label="Restore finished" value={entry.since} />
            </TechnicalDetails>
          </li>
        ))}
      </ul>
    </section>
  );
}
