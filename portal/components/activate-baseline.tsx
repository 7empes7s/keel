"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

import { postAction } from "@/lib/action-client";

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
        setMessage("Activation requested — pending approval. The active baseline has not changed.");
        setIdempotencyKey(crypto.randomUUID());
        router.refresh();
      } else {
        setError("Unexpected response: activation did not produce an approval request.");
      }
    } catch {
      setError("The activation request could not be created.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <span className="activate-control">
      <button
        disabled={disabled || submitting}
        onClick={() => void requestActivation()}
        type="button"
      >
        Activate
      </button>
      {message ? <small aria-live="polite" className="action-message">{message}</small> : null}
      {error ? <small className="action-error" role="alert">{error}</small> : null}
    </span>
  );
}
