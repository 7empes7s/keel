"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

import { postAction } from "@/lib/action-client";
import { formatTimestamp } from "@/lib/presentation";
import type { SnapshotOption } from "@/lib/portal-jobs";

function describeSnapshot(snapshot: SnapshotOption): string {
  const captured = formatTimestamp(snapshot.completedAt ?? snapshot.startedAt);
  return `${captured} — ${snapshot.resourceCount.toLocaleString("en-GB")} resources`;
}

// Create-from-snapshot control (plan task 16). Enqueues a baseline-create job through
// the guarded action API; the new idempotency key per completed submission makes a
// double-submit return the same job while a genuinely new create enqueues a new one.
export function BaselineCreateForm({
  snapshots,
  disabled,
}: {
  snapshots: SnapshotOption[];
  disabled: boolean;
}) {
  const router = useRouter();
  const [snapshotId, setSnapshotId] = useState(snapshots[0]?.id ?? "");
  const [label, setLabel] = useState("");
  const [description, setDescription] = useState("");
  const [idempotencyKey, setIdempotencyKey] = useState(() => crypto.randomUUID());
  const [submitting, setSubmitting] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function submit() {
    if (!snapshotId) {
      setError("Choose a snapshot to create the baseline from.");
      return;
    }
    if (label.trim().length === 0) {
      setError("Name the baseline so it can be found again.");
      return;
    }

    setSubmitting(true);
    setMessage(null);
    setError(null);
    try {
      const { payload } = await postAction(
        "/api/actions/baseline",
        {
          snapshotId,
          label: label.trim(),
          ...(description.trim() ? { description: description.trim() } : {}),
        },
        idempotencyKey,
      );
      const job = payload.job as { id: string };
      setMessage(`Baseline creation queued (job ${job.id}). The new baseline becomes active when the job completes.`);
      setIdempotencyKey(crypto.randomUUID());
      setLabel("");
      setDescription("");
      router.refresh();
    } catch {
      setError("The baseline creation could not be queued.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <section aria-labelledby="baseline-create-heading" className="report-section">
      <div className="section-heading-row report-heading">
        <div>
          <p className="section-kicker">Recovery point</p>
          <h2 id="baseline-create-heading">Create from snapshot</h2>
        </div>
      </div>

      {snapshots.length ? (
        <>
          <div className="filter-bar">
            <label className="filter-field">
              <span>Snapshot</span>
              <select
                disabled={disabled || submitting}
                onChange={(event) => setSnapshotId(event.target.value)}
                value={snapshotId}
              >
                {snapshots.map((snapshot) => (
                  <option key={snapshot.id} value={snapshot.id}>
                    {describeSnapshot(snapshot)}
                  </option>
                ))}
              </select>
            </label>
            <label className="filter-field">
              <span>Label</span>
              <input
                disabled={disabled || submitting}
                onChange={(event) => setLabel(event.target.value)}
                placeholder="e.g. post-audit-2026-q3"
                value={label}
              />
            </label>
            <label className="filter-field">
              <span>Description</span>
              <input
                disabled={disabled || submitting}
                onChange={(event) => setDescription(event.target.value)}
                placeholder="Optional context for this baseline"
                value={description}
              />
            </label>
          </div>
          <div>
            <button
              disabled={disabled || submitting}
              onClick={() => void submit()}
              type="button"
            >
              Create baseline
            </button>
          </div>
        </>
      ) : (
        <p className="empty-state">
          No completed snapshots are available. Run a collection before creating a baseline.
        </p>
      )}

      {message ? <p aria-live="polite" className="action-message">{message}</p> : null}
      {error ? <p className="action-error" role="alert">{error}</p> : null}
    </section>
  );
}
