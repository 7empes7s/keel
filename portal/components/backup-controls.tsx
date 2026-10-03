"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";

import { ScheduleEditor } from "@/components/schedule-editor";
import { postAction } from "@/lib/action-client";
import { TIERS, tierLabel, type ProtectProblem, type TierSummary } from "@/lib/protect-view";
import { toast } from "@/lib/toast";

// "Back up now" (plan task 16). Each request enqueues one backup job for a tier; the
// worker dispatches to the existing tiered collection script, so what runs here is
// exactly what the tier's schedule runs. The tier cards and the problem list's retry
// share this one action.
function useBackup() {
  const router = useRouter();
  const [idempotencyKeys, setIdempotencyKeys] = useState<Record<string, string>>(() =>
    Object.fromEntries(TIERS.map((tier) => [tier.id, crypto.randomUUID()])),
  );
  const [submitting, setSubmitting] = useState<string | null>(null);
  const [queued, setQueued] = useState<{ tier: string; jobId: string } | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function backUp(tier: string, source: string) {
    setSubmitting(source);
    setQueued(null);
    setError(null);
    try {
      const { payload } = await postAction("/api/actions/backup", { tier }, idempotencyKeys[tier]);
      const job = payload.job as { id: string };
      setQueued({ tier, jobId: job.id });
      toast({ title: `${tierLabel(tier)} backup queued`, detail: "It only reads your tenant; nothing changes.", href: `/jobs/${encodeURIComponent(job.id)}`, hrefLabel: "View job" });
      setIdempotencyKeys((current) => ({ ...current, [tier]: crypto.randomUUID() }));
      router.refresh();
    } catch {
      setError(`KEEL could not queue the ${tierLabel(tier)} backup. Try again in a minute.`);
    } finally {
      setSubmitting(null);
    }
  }

  const feedback = <>
    {queued ? (
      <p aria-live="polite" className="action-message">
        {tierLabel(queued.tier)} backup queued. <Link href={`/jobs/${encodeURIComponent(queued.jobId)}`}>View job</Link>
      </p>
    ) : null}
    {error ? <p className="action-error" role="alert">{error}</p> : null}
  </>;
  return { backUp, submitting, feedback };
}

export function BackupControls({ disabled, tiers, canEditSchedules = false }: {
  disabled: boolean;
  tiers?: TierSummary[];
  canEditSchedules?: boolean;
}) {
  const { backUp, submitting, feedback } = useBackup();
  const cards = tiers ?? TIERS.map((tier) => ({ ...tier, schedule: null, next: "", last: "", failed: false }));

  return (
    <section aria-labelledby="backup-now-heading" className="report-section">
      <div className="section-heading-row report-heading">
        <div>
          <p className="section-kicker">Tiers</p>
          <h2 id="backup-now-heading">When each tier is backed up</h2>
        </div>
      </div>

      <div className="tier-cards">
        {cards.map((tier) => (
          <div className={`tier-card ${tier.id}-card${tier.failed ? " tier-card-failed" : ""}`} key={tier.id}>
            <strong>{tier.label}</strong>
            <span>{tier.description.charAt(0).toUpperCase() + tier.description.slice(1)}.</span>
            {tier.next ? <span className="tier-next">{tier.next}</span> : null}
            {tier.last ? <span className={tier.failed ? "tier-last tier-last-failed" : "tier-last"}>{tier.last}</span> : null}
            <button
              aria-busy={submitting === tier.id || undefined}
              className="btn btn-primary"
              disabled={disabled || submitting !== null}
              onClick={() => void backUp(tier.id, tier.id)}
              type="button"
            >
              Back up {tier.label}
            </button>
            {canEditSchedules && tier.schedule ? (
              <ScheduleEditor key={`${tier.schedule.id}:${tier.schedule.next_due_at}:${tier.schedule.enabled}`} schedule={tier.schedule} />
            ) : null}
          </div>
        ))}
      </div>
      {feedback}
    </section>
  );
}

const PROBLEM_TITLE: Record<string, string> = {
  failed: "Failed",
  stale: "Out of date",
  never: "Never backed up",
};

/** Failed, out-of-date and never-backed-up types by name, each with a retry. */
export function ProblemList({ problems, disabled }: { problems: ProtectProblem[]; disabled: boolean }) {
  const { backUp, submitting, feedback } = useBackup();
  if (problems.length === 0) return null;
  return (
    <section aria-labelledby="protect-problems-heading" className="report-section">
      <div className="section-heading-row report-heading">
        <div>
          <p className="section-kicker">Needs attention</p>
          <h2 id="protect-problems-heading">Types that are not backed up properly</h2>
        </div>
        <span className="result-count">{problems.length} {problems.length === 1 ? "type" : "types"}</span>
      </div>
      <ul className="item-list protect-problems">
        {problems.map((problem) => (
          <li className={`protect-problem problem-${problem.health}`} key={problem.type}>
            <div>
              <strong>{problem.name}</strong>
              <span className={`state-badge problem-badge problem-${problem.health}`}>{PROBLEM_TITLE[problem.health]}</span>
              <p>{problem.sentence}</p>
            </div>
            {problem.tier ? (
              <button
                aria-busy={submitting === problem.type || undefined}
                aria-label={`Retry the backup of ${problem.name} (${tierLabel(problem.tier)})`}
                className="btn btn-secondary btn-sm"
                disabled={disabled || submitting !== null}
                onClick={() => void backUp(problem.tier!, problem.type)}
                type="button"
              >
                Retry backup
              </button>
            ) : null}
          </li>
        ))}
      </ul>
      {feedback}
    </section>
  );
}
