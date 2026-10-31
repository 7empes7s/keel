"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useRef, useState } from "react";

import { Icon } from "@/components/shell/icons";
import { Popover } from "@/components/shell/popover";
import { Badge, type BadgeTone } from "@/components/ui/badge";
import { postAction } from "@/lib/action-client";
import type { RetryPlan } from "@/lib/backup-failure";
import { TIERS, tierLabel, type TierSummary } from "@/lib/protect-view";
import { toast } from "@/lib/toast";

// "Back up now" (plan task 16). Each request enqueues one backup job for a tier; the
// worker dispatches to the existing tiered collection script, so what runs here is
// exactly what the tier's schedule runs. The header menu, the tier strip, a kind's row
// and the selection bar all share this one action.
export function useBackup() {
  const router = useRouter();
  // One key per tier, renewed once that tier's request is accepted, so a double click
  // or a replayed request returns the job already queued.
  const keys = useRef<Record<string, string>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function backUp(tiers: string[], source: string) {
    setBusy(source);
    setError(null);
    const failed: string[] = [];
    for (const tier of tiers) {
      keys.current[tier] ??= crypto.randomUUID();
      try {
        const { payload } = await postAction("/api/actions/backup", { tier }, keys.current[tier]);
        const job = payload.job as { id: string };
        toast({ title: `${tierLabel(tier)} backup queued`, detail: "It only reads your tenant; nothing changes.", href: `/jobs/${encodeURIComponent(job.id)}`, hrefLabel: "View job" });
        keys.current[tier] = crypto.randomUUID();
      } catch {
        failed.push(tierLabel(tier));
      }
    }
    if (failed.length) setError(`Keel could not queue the ${failed.join(" and ")} backup. Try again in a minute.`);
    setBusy(null);
    router.refresh();
  }

  // Retry one failed kind (portal audit, issue 10): its tier's backup, the service
  // settings backup for a workload kind, or a full read for a kind with no tier.
  async function retry(plan: RetryPlan, name: string, source: string) {
    if (plan.kind === "tier") return backUp([plan.tier], source);
    const [path, label] = plan.kind === "workloads"
      ? ["/api/actions/workload-collect", "Service settings backup"]
      : ["/api/actions/collect", "Full backup"];
    setBusy(source);
    setError(null);
    keys.current[plan.kind] ??= crypto.randomUUID();
    try {
      const { payload } = await postAction(path, {}, keys.current[plan.kind]);
      const job = payload.job as { id: string };
      toast({ title: `${label} queued`, detail: `It reads ${name} again. It only reads your tenant; nothing changes.`, href: `/jobs/${encodeURIComponent(job.id)}`, hrefLabel: "View job" });
      keys.current[plan.kind] = crypto.randomUUID();
    } catch {
      setError(`Keel could not queue the ${label.toLowerCase()}. Try again in a minute.`);
    }
    setBusy(null);
    router.refresh();
  }

  const feedback = error ? <p className="action-error" role="alert">{error}</p> : null;
  return { backUp, retry, busy, feedback };
}

/** The header's one "Back up now" menu: every tier, or one. Amber only when something
 *  failed or is out of date, so the page has one amber action at most. */
export function BackUpNow({ disabled, urgent }: { disabled: boolean; urgent: boolean }) {
  const { backUp, busy, feedback } = useBackup();
  const all = TIERS.map((tier) => tier.id);
  return (
    <span className="pt-backup-now">
      <span className="pt-split">
        <button
          aria-busy={busy === "all" || undefined}
          className={urgent ? "btn btn-primary primary" : "btn"}
          disabled={disabled || busy !== null}
          onClick={() => void backUp(all, "all")}
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
              <li><button className="more-item" disabled={disabled || busy !== null} onClick={() => { close(); void backUp(all, "all"); }} type="button">All tiers</button></li>
              {TIERS.map((tier) => (
                <li key={tier.id}><button className="more-item" disabled={disabled || busy !== null} onClick={() => { close(); void backUp([tier.id], tier.id); }} type="button">{tier.label} only</button></li>
              ))}
            </ul>
          )}
        </Popover>
      </span>
      {feedback}
    </span>
  );
}

function tierBadge(tier: TierSummary): { tone: BadgeTone; label: string } {
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
export function TierStrip({ disabled, tiers, canEditSchedules = false }: {
  disabled: boolean;
  tiers?: TierSummary[];
  canEditSchedules?: boolean;
}) {
  const { backUp, busy, feedback } = useBackup();
  const cells = tiers ?? TIERS.map((tier) => ({ ...tier, schedule: null, next: "", last: "", failed: false, partial: false }));
  return (
    <section aria-labelledby="backup-now-heading" className="pt-section">
      <h2 className="visually-hidden" id="backup-now-heading">When each tier is backed up</h2>
      <div className="pt-tiers">
        {cells.map((tier) => {
          const badge = tierBadge(tier);
          const jobId = tier.schedule?.last_job_id;
          return (
            <div className={`pt-tier ${tier.id}-card`} data-tone={tier.failed ? "urgent" : tier.partial ? "soon" : undefined} key={tier.id}>
              <span className="pt-tier-head">
                <b>{tier.label}</b>
                <Badge tone={badge.tone}>{badge.label}</Badge>
              </span>
              <span className="pt-tier-about">{tier.description.charAt(0).toUpperCase() + tier.description.slice(1)}.</span>
              {tier.next ? <span className="tier-next">{tier.next}</span> : null}
              {tier.last ? (
                <span className={tier.failed ? "tier-last tier-last-failed" : tier.partial ? "tier-last tier-last-partial" : "tier-last"}>
                  {jobId ? <Link href={`/jobs/${encodeURIComponent(jobId)}`}>{tier.last}</Link> : tier.last}
                </span>
              ) : null}
              <span className="pt-tier-actions">
                <button
                  aria-busy={busy === tier.id || undefined}
                  aria-label={`Back up ${tier.label}`}
                  className="btn btn-sm"
                  disabled={disabled || busy !== null}
                  onClick={() => void backUp([tier.id], tier.id)}
                  type="button"
                >
                  <Icon name="play" />Back up
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
