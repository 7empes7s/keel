import Link from "next/link";

import { PagedRows } from "@/components/list/paged-rows";
import { RecoveryCompletion } from "@/components/recovery-completion";
import { RecordField, TechnicalDetails } from "@/components/technical-details";
import { Badge } from "@/components/ui/badge";
import { formatTimestamp } from "@/lib/presentation";
import { followUpHref, followUpName, followUpWhen } from "@/lib/restore-follow-ups-view";
import type { OpenFollowUpWork, RestoreFollowUp } from "@/lib/types";

// Every restore that still has follow-up steps open (new secrets, consent, a service
// check), however old, so finishing one never depends on its job still being in the
// recent list. The steps themselves are closed on the restore's job page. The totals are
// the shared counts Overview and the menu show. UI audit B10 and D13: each card is named
// by its restore and says when that restore ran, and the list has pages.
const SORTS = [
  { key: "when", label: "When", desc: true },
  { key: "steps", label: "Open steps", desc: true },
  { key: "name", label: "Name" },
];

export function RestoreFollowUps({ work, now, canRestore = false }: { work: OpenFollowUpWork; now: string; canRestore?: boolean }) {
  if (work.steps === 0) return null;
  const { steps, restores, cards } = work;
  return (
    <section aria-labelledby="restore-follow-ups-heading" className="report-section" id="follow-up">
      <div className="section-heading-row report-heading">
        <div>
          <p className="section-kicker">Waiting on you</p>
          <h2 id="restore-follow-ups-heading">Follow-up after restores</h2>
        </div>
        <span className="result-count">
          {steps} {steps === 1 ? "step" : "steps"} on {restores} {restores === 1 ? "restore" : "restores"}
        </span>
      </div>
      {cards.length < restores ? (
        <p className="follow-up-shown" role="status">Showing the newest {cards.length} of {restores} restores.</p>
      ) : null}
      <PagedRows
        label="Restores with follow-up steps"
        listClassName="activity-list"
        noun={{ one: "restore", many: "restores" }}
        prefix="follow-up-"
        rows={cards.map((card) => {
          const name = followUpName(card);
          const when = followUpWhen(card, now);
          return {
            id: card.restoreRef,
            node: <FollowUpCard canRestore={canRestore} card={card} name={name} now={now} />,
            text: name,
            values: { when: when.at, steps: card.pending, name },
          };
        })}
        sorts={SORTS}
      />
    </section>
  );
}

function FollowUpCard({ card, name, now, canRestore }: { card: RestoreFollowUp; name: string; now: string; canRestore: boolean }) {
  const href = followUpHref(card);
  const when = followUpWhen(card, now);
  const open = `${card.pending} follow-up ${card.pending === 1 ? "step" : "steps"} open`;
  return (
    <li className="activity-item follow-up-card" data-restore={card.restoreRef}>
      <div className="activity-main">
        {href ? (
          <Link className="activity-title" href={href}>{name}</Link>
        ) : (
          <p className="activity-title">{name}</p>
        )}
        <p className="activity-meta">
          <Badge tone="soon">{open}</Badge>{" "}
          <time dateTime={when.at} title={formatTimestamp(when.at)}>{when.words}</time>
          {card.enforced && card.jobStatus === "failed" ? " · the restore did not finish, so check what went back" : null}
        </p>
      </div>
      <TechnicalDetails summary={`Technical details: ${name}`}>
        <RecordField label="Restore reference" value={card.restoreRef} />
        <RecordField label="Job ID" usage={<>use with <code>GET /api/jobs/&lt;id&gt;</code></>} value={card.jobId} />
        <RecordField copy={false} label="Open steps" value={card.pending} />
        <RecordField copy={false} label="Restore finished" value={card.restoredAt ?? null} />
        <RecordField copy={false} label="Oldest open step opened" value={card.since} />
      </TechnicalDetails>
      {href ? null : (
        // Run outside the portal: no job page to open, so its steps open here.
        <details className="follow-up-steps">
          <summary>Show the steps</summary>
          <RecoveryCompletion canComplete={canRestore} restoreRef={card.restoreRef} />
        </details>
      )}
    </li>
  );
}
