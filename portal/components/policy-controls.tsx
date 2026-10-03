"use client";

import { useState } from "react";

import { PolicyActivation } from "@/components/policy-preview";
import { ConfirmButton } from "@/components/ui/confirm-button";
import type { ActivationPreview } from "@/lib/policies";
import { toast } from "@/lib/toast";

// Roadmap task-130: pause, resume and turn a policy on or off through the existing
// guarded routes (POST /api/policies/<id>/enabled and /clear-pause). The routes
// re-check the policies capability and, for automatic roll-back, the run-as account.
// Roadmap task-92: an automatic roll-back policy that is off is turned on only from an
// activation preview (PolicyActivation); the enabled route refuses it otherwise.
export function PolicyControls({ policyId, name, enabled, paused, automatic = false, now, initialPreview = null }: {
  policyId: string; name: string; enabled: boolean; paused: boolean; automatic?: boolean; now?: string; initialPreview?: ActivationPreview | null;
}) {
  const [busy, setBusy] = useState<string | null>(null);
  if (automatic && !enabled) return <PolicyActivation initialPreview={initialPreview} name={name} now={now ?? new Date().toISOString()} policyId={policyId} />;

  async function post(path: string, body: Record<string, unknown> | undefined, success: string, key: string) {
    setBusy(key);
    try {
      const response = await fetch(`/api/policies/${encodeURIComponent(policyId)}/${path}`, {
        method: "POST",
        headers: { "content-type": "application/json", "idempotency-key": crypto.randomUUID() },
        body: JSON.stringify(body ?? {}),
      });
      if (!response.ok) {
        toast({
          tone: "warning",
          title: "Not changed",
          detail: response.status === 409 ? "The account this policy acts as can no longer roll back changes." : "The policy could not be changed.",
        });
        return;
      }
      toast({ title: success });
      // A full reload: these controls also render outside an app router (page tests).
      window.location.reload();
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="form-actions policy-controls">
      {paused ? (
        <button className="btn btn-secondary btn-sm" disabled={busy !== null} onClick={() => void post("clear-pause", undefined, "Policy resumed", "resume")} type="button">
          Resume
        </button>
      ) : null}
      {enabled ? (
        <ConfirmButton
          confirmLabel="Turn off"
          description={<p>{name} stops acting on new changes until it is turned on again.</p>}
          disabled={busy !== null}
          onConfirm={() => post("enabled", { enabled: false }, "Policy turned off", "off")}
          size="sm"
          title={`Turn off ${name}?`}
        >
          Turn off
        </ConfirmButton>
      ) : (
        <button className="btn btn-secondary btn-sm" disabled={busy !== null} onClick={() => void post("enabled", { enabled: true }, "Policy turned on", "on")} type="button">
          Turn on
        </button>
      )}
    </div>
  );
}
