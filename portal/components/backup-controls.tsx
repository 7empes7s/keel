"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";

import { postAction } from "@/lib/action-client";

const TIERS = [
  {
    id: "tier1",
    label: "Tier 1",
    description: "Critical, frequently changing configuration",
  },
  {
    id: "tier2",
    label: "Tier 2",
    description: "Important configuration on a slower cadence",
  },
  {
    id: "tier3",
    label: "Tier 3",
    description: "Rarely changing reference data",
  },
] as const;

// "Back up now" controls (plan task 16). Each button enqueues one backup job for its
// tier; the worker dispatches to the existing tiered collection script, so what runs
// here is exactly what the tiered schedule runs.
export function BackupControls({ disabled }: { disabled: boolean }) {
  const router = useRouter();
  const [idempotencyKeys, setIdempotencyKeys] = useState<Record<string, string>>(() =>
    Object.fromEntries(TIERS.map((tier) => [tier.id, crypto.randomUUID()])),
  );
  const [submittingTier, setSubmittingTier] = useState<string | null>(null);
  const [jobId, setJobId] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function backUpNow(tier: string) {
    setSubmittingTier(tier);
    setMessage(null);
    setJobId(null);
    setError(null);
    try {
      const { payload } = await postAction(
        "/api/actions/backup",
        { tier },
        idempotencyKeys[tier],
      );
      const job = payload.job as { id: string };
      setJobId(job.id);
      setMessage(`${tier} backup queued (job ${job.id}). View the job for progress.`);
      setIdempotencyKeys((current) => ({ ...current, [tier]: crypto.randomUUID() }));
      router.refresh();
    } catch {
      setError(`The ${tier} backup could not be queued.`);
    } finally {
      setSubmittingTier(null);
    }
  }

  return (
    <section aria-labelledby="backup-now-heading" className="report-section">
      <div className="section-heading-row report-heading">
        <div>
          <p className="section-kicker">On demand</p>
          <h2 id="backup-now-heading">Back up now</h2>
        </div>
      </div>

      <div className="filter-bar">
        {TIERS.map((tier) => (
          <div className="filter-field" key={tier.id}>
            <span>{tier.description}</span>
            <button
              disabled={disabled || submittingTier !== null}
              onClick={() => void backUpNow(tier.id)}
              type="button"
            >
              Back up {tier.label}
            </button>
          </div>
        ))}
      </div>

      {message ? <p aria-live="polite" className="action-message">{message} {jobId ? <Link href={`/jobs/${encodeURIComponent(jobId)}`}>View job</Link> : null}</p> : null}
      {error ? <p className="action-error" role="alert">{error}</p> : null}
    </section>
  );
}
