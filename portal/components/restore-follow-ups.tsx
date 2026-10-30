import Link from "next/link";

import { RecordField, TechnicalDetails } from "@/components/technical-details";
import { AlertRow } from "@/components/ui/alert-list";
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

/** The open steps in one count, for the top of the other Restore pages. */
export function followUpTotals(followUps: RestoreFollowUp[]): { steps: number; restores: number } {
  return { steps: followUps.reduce((sum, entry) => sum + entry.pending, 0), restores: followUps.length };
}

/** One alert at the top of Restore configurations while steps are open; nothing otherwise. */
export function RestoreFollowUpsAlert({ followUps }: { followUps: RestoreFollowUp[] }) {
  const { steps, restores } = followUpTotals(followUps);
  if (steps === 0) return null;
  return (
    <div className="ui-alerts restore-follow-ups-alert">
      <AlertRow
        as="div"
        item={{
          key: "restore-follow-ups",
          tone: "soon",
          icon: "clock",
          title: `${steps} follow-up ${steps === 1 ? "step is" : "steps are"} still open from ${restores === 1 ? "a past restore" : `${restores} past restores`}`,
          todo: "Finish them by hand, such as a new secret or a service check, so each restore counts as done.",
          action: { label: "See follow-up steps", href: "/restore/follow-ups" },
        }}
      />
    </div>
  );
}
