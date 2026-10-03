"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

import { postAction } from "@/lib/action-client";
import { toast } from "@/lib/toast";

// Roadmap task-87: re-capture a baseline from a newer complete backup as a new version.
// The current version and everything it recorded are kept; the route re-checks
// baseline-create, so a read-only viewer sees this disabled and cannot replace it.
export function ResnapshotBaseline({
  baselineId,
  snapshotId,
  disabled,
  label,
}: {
  baselineId: string;
  snapshotId: string | null;
  disabled: boolean;
  label: string;
}) {
  const router = useRouter();
  const [idempotencyKey, setIdempotencyKey] = useState(() => crypto.randomUUID());
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function resnapshot() {
    if (!snapshotId) return;
    setSubmitting(true);
    setError(null);
    try {
      const { payload } = await postAction(
        "/api/actions/baseline",
        { snapshotId, supersedesBaselineId: baselineId },
        idempotencyKey,
      );
      const job = payload.job as { id?: string } | undefined;
      toast({
        title: `New version of “${label}” queued`,
        detail: "The current version and what it recorded are kept.",
        href: job?.id ? `/jobs/${encodeURIComponent(job.id)}` : "/activity",
        hrefLabel: "View job",
      });
      setIdempotencyKey(crypto.randomUUID());
      router.refresh();
    } catch {
      setError("The new version could not be queued.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <span className="activate-control">
      <button
        aria-busy={submitting || undefined}
        className="btn btn-secondary btn-sm"
        disabled={disabled || submitting || !snapshotId}
        onClick={() => void resnapshot()}
        title={snapshotId ? undefined : "No newer complete backup to capture from yet."}
        type="button"
      >
        Capture new version
      </button>
      {error ? <small className="action-error" role="alert">{error}</small> : null}
    </span>
  );
}
