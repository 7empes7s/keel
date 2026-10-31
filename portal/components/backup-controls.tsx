"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";

import { Icon } from "@/components/shell/icons";
import { Popover } from "@/components/shell/popover";
import { Badge, type BadgeTone } from "@/components/ui/badge";
import { postAction } from "@/lib/action-client";
import { TIERS, activeRunSentence, tierLabel, type ActiveTierRun, type ActiveTierRuns, type TierSummary } from "@/lib/protect-view";
import { toast } from "@/lib/toast";

// "Back up now" (plan task 16). Each request enqueues one backup job for a tier; the
// worker dispatches to the existing tiered collection script, so what runs here is
// exactly what the tier's schedule runs. The header menu, the tier strip, a kind's row
// and the selection bar all share this one action.
// Runs this page queued since the server last said what is in progress, shared by every
// Back up button on the page (the panel, the tier card, the header menu), so a run queued
// from one turns all of them off at once. The server's answer replaces them on refresh.
let localRuns: ActiveTierRuns = {};
const localListeners = new Set<() => void>();
function setLocalRuns(next: ActiveTierRuns) {
  localRuns = next;
  for (const listener of localListeners) listener();
}
function subscribeLocalRuns(listener: () => void) {
  localListeners.add(listener);
  return () => {
    localListeners.delete(listener);
    // Leaving the page forgets them; the next page load reads the server's answer.
    if (localListeners.size === 0) localRuns = {};
  };
}
const NO_RUNS: ActiveTierRuns = {};

// `stamp` is the server render time: every fresh server answer forgets local runs, even
// when its list of runs looks the same (a run that ended before the refresh came back).
export function useBackup(active: ActiveTierRuns = NO_RUNS, stamp?: string) {
  const router = useRouter();
  // One key per tier, renewed once that tier's request is accepted, so a double click
  // or a replayed request returns the job already queued.
  const keys = useRef<Record<string, string>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const queued = useSyncExternalStore(subscribeLocalRuns, () => localRuns, () => NO_RUNS);
  const activeKey = `${stamp ?? ""}|${JSON.stringify(active)}`;
  const seenKey = useRef(activeKey);
  useEffect(() => {
    if (seenKey.current === activeKey) return;
    seenKey.current = activeKey;
    setLocalRuns({});
  }, [activeKey]);

  /** The tier's backup that is queued or running now, if any. */
  function runOf(tier: string): ActiveTierRun | null {
    return queued[tier] ?? active[tier] ?? null;
  }

  async function backUp(tiers: string[], source: string) {
    setBusy(source);
    setError(null);
    const failed: string[] = [];
    for (const tier of tiers) {
      keys.current[tier] ??= crypto.randomUUID();
      try {
        const { payload } = await postAction("/api/actions/backup", { tier }, keys.current[tier]);
        const job = payload.job as { id: string; status: string; createdAt: string | null; startedAt: string | null };
        const status = job.status === "running" ? "running" : "queued";
        const href = `/jobs/${encodeURIComponent(job.id)}`;
        if (payload.alreadyActive === true) {
          // A second press, from here or from anyone else: the run already waiting is kept.
          toast({ tone: "info", title: `${tierLabel(tier)} backup is already ${status === "running" ? "running" : "queued"}`, detail: "Keel does not start the same tier twice. Follow the run on its page.", href, hrefLabel: "View job" });
        } else {
          toast({ title: `${tierLabel(tier)} backup queued`, detail: "It starts when a worker is free and only reads your tenant; nothing changes.", href, hrefLabel: "View job" });
        }
        setLocalRuns({ ...localRuns, [tier]: { jobId: job.id, status, since: (status === "running" ? job.startedAt : job.createdAt) ?? new Date().toISOString() } });
        keys.current[tier] = crypto.randomUUID();
      } catch {
        failed.push(tierLabel(tier));
      }
    }
    if (failed.length) {
      const message = `Keel could not queue the ${failed.join(" and ")} backup. Try again in a minute.`;
      setError(message);
      // The inline line can sit behind an open panel; the toast is always on top.
      toast({ tone: "warning", title: "Backup not queued", detail: message });
    }
    setBusy(null);
    router.refresh();
  }

  const feedback = error ? <p className="action-error" role="alert">{error}</p> : null;
  return { backUp, busy, feedback, runOf };
}

/** "Queued" or "Running" for a tier's button while its backup is in progress. */
export function runWord(run: ActiveTierRun): string {
  return run.status === "running" ? "Running" : "Queued";
}

/** The header's one "Back up now" menu: every tier, or one. Amber only when something
 *  failed or is out of date, so the page has one amber action at most. */
export function BackUpNow({ disabled, urgent, active = NO_RUNS, now }: { disabled: boolean; urgent: boolean; active?: ActiveTierRuns; now?: string }) {
  const { backUp, busy, feedback, runOf } = useBackup(active, now);
  // "All tiers" asks only for the tiers not already queued or running.
  const all = TIERS.map((tier) => tier.id).filter((tier) => !runOf(tier));
  return (
    <span className="pt-backup-now">
      <span className="pt-split">
        <button
          aria-busy={busy === "all" || undefined}
          className={urgent ? "btn btn-primary primary" : "btn"}
          disabled={disabled || busy !== null || all.length === 0}
          onClick={() => void backUp(all, "all")}
          title={all.length === 0 ? "Every tier is already queued or running" : undefined}
          type="button"
        >
          <Icon name="play" />Back up now
        </button>
        <Popover
          button={<Icon name="chevron-down" />}
          buttonClassName={urgent ? "btn btn-primary primary pt-split-more" : "btn pt-split-more"}
          label="Choose what to back up"
          title="Back up now"
        >
          {(close) => (
            <ul className="more-list">
              <li><button className="more-item" disabled={disabled || busy !== null || all.length === 0} onClick={() => { close(); void backUp(all, "all"); }} type="button">All tiers</button></li>
              {TIERS.map((tier) => {
                const run = runOf(tier.id);
                return (
                  <li key={tier.id}><button className="more-item" disabled={disabled || busy !== null || run !== null} onClick={() => { close(); void backUp([tier.id], tier.id); }} type="button">{tier.label} only{run ? ` (${runWord(run).toLowerCase()})` : ""}</button></li>
                );
              })}
            </ul>
          )}
        </Popover>
      </span>
      {feedback}
    </span>
  );
}

function tierBadge(tier: TierSummary, run: ActiveTierRun | null): { tone: BadgeTone; label: string } {
  // A run in progress is the news, whatever the schedule's last run did.
  if (run) return { tone: "low", label: runWord(run) };
  const status = tier.schedule?.last_status;
  if (!tier.schedule) return { tone: "neutral", label: "No schedule" };
  if (!tier.schedule.enabled) return { tone: "neutral", label: "Turned off" };
  if (status === "failed") return { tone: "urgent", label: "Failed" };
  if (status === "partial") return { tone: "soon", label: "Partly done" };
  if (status === "running" || status === "queued") return { tone: "low", label: "Running" };
  if (status) return { tone: "fine", label: "Finished" };
  return { tone: "neutral", label: "Not run yet" };
}

/** The three tiers in one strip: what each holds, its last and next run, and an outlined
 *  "Back up" per tier. The schedule itself is changed on Schedules. */
export function TierStrip({ disabled, tiers, canEditSchedules = false, now, active = NO_RUNS }: {
  disabled: boolean;
  tiers?: TierSummary[];
  canEditSchedules?: boolean;
  now?: string;
  active?: ActiveTierRuns;
}) {
  const { backUp, busy, feedback, runOf } = useBackup(active, now);
  const cells = tiers ?? TIERS.map((tier) => ({ ...tier, schedule: null, next: "", last: "", failed: false }));
  return (
    <section aria-labelledby="backup-now-heading" className="pt-section">
      <h2 className="visually-hidden" id="backup-now-heading">When each tier is backed up</h2>
      <div className="pt-tiers">
        {cells.map((tier) => {
          const run = runOf(tier.id);
          const badge = tierBadge(tier, run);
          const jobId = tier.schedule?.last_job_id;
          return (
            <div className={`pt-tier ${tier.id}-card`} data-run={run?.status} data-tone={tier.failed && !run ? "urgent" : undefined} key={tier.id}>
              <span className="pt-tier-head">
                <b>{tier.label}</b>
                <Badge tone={badge.tone}>{badge.label}</Badge>
              </span>
              <span className="pt-tier-about">{tier.description.charAt(0).toUpperCase() + tier.description.slice(1)}.</span>
              {run ? (
                <span className="tier-run" role="status">
                  <Icon name="refresh" />
                  <Link href={`/jobs/${encodeURIComponent(run.jobId)}`}>{activeRunSentence(run, now ?? new Date().toISOString())}</Link>
                </span>
              ) : null}
              {tier.next ? <span className="tier-next">{tier.next}</span> : null}
              {tier.last ? (
                <span className={tier.failed ? "tier-last tier-last-failed" : "tier-last"}>
                  {jobId ? <Link href={`/jobs/${encodeURIComponent(jobId)}`}>{tier.last}</Link> : tier.last}
                </span>
              ) : null}
              <span className="pt-tier-actions">
                <button
                  aria-busy={busy === tier.id || undefined}
                  aria-label={run ? `${tier.label} backup is ${runWord(run).toLowerCase()}` : `Back up ${tier.label}`}
                  className="btn btn-sm"
                  disabled={disabled || busy !== null || run !== null}
                  onClick={() => void backUp([tier.id], tier.id)}
                  type="button"
                >
                  <Icon name={run ? "refresh" : "play"} />{run ? runWord(run) : "Back up"}
                </button>
                {canEditSchedules ? <Link className="btn btn-sm btn-ghost" href={tier.schedule ? `/schedules?open=${encodeURIComponent(tier.schedule.id)}` : "/schedules"}>Change schedule</Link> : null}
              </span>
            </div>
          );
        })}
      </div>
      {feedback}
    </section>
  );
}
