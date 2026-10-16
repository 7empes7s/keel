"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

import { postAction } from "@/lib/action-client";
import { toast } from "@/lib/toast";

// Per-baseline activate control (plan task 16). Activation requires approval: the
// route answers 202 with an approval request and NO baseline changes, so the control
// reports "pending approval" — never that activation happened.
export function ActivateBaseline({
  baselineId,
  disabled,
}: {
  baselineId: string;
  disabled: boolean;
}) {
  const router = useRouter();
  const [idempotencyKey, setIdempotencyKey] = useState(() => crypto.randomUUID());
  const [submitting, setSubmitting] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function requestActivation() {
    setSubmitting(true);
    setMessage(null);
    setError(null);
    try {
      const { payload } = await postAction(
        "/api/actions/baseline/activate",
        { baselineId },
        idempotencyKey,
      );
      if (payload.approvalRequest) {
        setMessage("Sent for approval. The approved setup in use stays the same until someone approves.");
        toast({ tone: "info", title: "Sent for approval", detail: "The approved setup in use stays the same until someone approves.", href: "/approvals", hrefLabel: "Open approvals" });
        setIdempotencyKey(crypto.randomUUID());
        router.refresh();
      } else {
        setError("Keel did not get an approval request back. Nothing changed.");
      }
    } catch {
      setError("Keel could not send this for approval. Nothing changed.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <span className="activate-control">
      <button
        aria-busy={submitting || undefined}
        className="btn btn-sm"
        disabled={disabled || submitting}
        onClick={() => void requestActivation()}
        type="button"
      >
        Use this one
      </button>
      {message ? <small aria-live="polite" className="action-message">{message}</small> : null}
      {error ? <small className="action-error" role="alert">{error}</small> : null}
    </span>
  );
}
